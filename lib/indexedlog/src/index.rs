//! [u8] -> [u64] mapping. Insertion only.
//!
//! The index could be backed by a combination of an on-disk file, and in-memory content. Changes
//! to the index will be buffered in memory forever until an explicit flush. Internally, the index
//! uses base16 radix tree for keys and linked list of values, though it's possible to extend the
//! format to support other kinds of trees and values.
//!
//! File format:
//!
//! ```ignore
//! INDEX       := HEADER + ENTRY_LIST
//! HEADER      := '\0'  (takes offset 0, so 0 is not a valid offset for ENTRY)
//! ENTRY_LIST  := RADIX | ENTRY_LIST + ENTRY
//! ENTRY       := RADIX | LEAF | LINK | KEY | ROOT
//! RADIX       := '\2' + JUMP_TABLE (16 bytes) + PTR(LINK) + PTR(RADIX | LEAF) * N
//! LEAF        := '\3' + PTR(KEY) + PTR(LINK)
//! LINK        := '\4' + VLQ(VALUE) + PTR(NEXT_LINK | NULL)
//! KEY         := '\5' + VLQ(KEY_LEN) + KEY_BYTES
//! ROOT        := '\1' + PTR(RADIX) + ROOT_LEN (1 byte)
//!
//! PTR(ENTRY)  := VLQ(the offset of ENTRY)
//! ```
//!
//! Some notes about the format:
//!
//! - A "RADIX" entry has 16 children. This is mainly for source control hex hashes. The "N"
//!   in a radix entry could be less than 16 if some of the children are missing (ex. offset = 0).
//!   The corresponding jump table bytes of missing children are 0s. If child i exists, then
//!   `jumptable[i]` is the relative (to the beginning of radix entry) offset of PTR(child offset).
//! - A "ROOT" entry its length recorded as the last byte. Normally the root entry is written
//!   at the end. This makes it easier for the caller - it does not have to record the position
//!   of the root entry. The caller could optionally provide a root location.
//! - An entry has a 1 byte "type". This makes it possible to do a linear scan from the
//!   beginning of the file, instead of having to go through a root. Potentially useful for
//!   recovery purpose, or adding new entry types (ex. tree entries other than the 16-children
//!   radix entry, value entries that are not u64 linked list, key entries that refers external
//!   buffer).
//! - The "JUMP_TABLE" in "RADIX" entry stores relative offsets to the actual value of
//!   RADIX/LEAF offsets. It has redundant information. The more compact form is a 2-byte
//!   (16-bit) bitmask but that hurts lookup performance.

use std::collections::HashMap;
use std::io::{self, Write};
use std::io::ErrorKind::InvalidData;
use vlqencoding::{VLQDecodeAt, VLQEncode};

//// Structures related to file format

#[derive(Clone, PartialEq, Debug)]
struct Radix {
    pub offsets: [u64; 16],
    pub link_offset: u64,
}

#[derive(Clone, PartialEq, Debug)]
struct Leaf {
    pub key_offset: u64,
    pub link_offset: u64,
}

#[derive(Clone, PartialEq, Debug)]
struct Key {
    pub key: Vec<u8>, // base256
}

#[derive(Clone, PartialEq, Debug)]
struct Link {
    pub value: u64,
    pub next_link_offset: u64,
}

#[derive(Clone, PartialEq, Debug)]
struct Root {
    pub radix_offset: u64,
}

//// Serialization

// Offsets that are >= DIRTY_OFFSET refer to in-memory entries that haven't been
// written to disk. Offsets < DIRTY_OFFSET are on-disk offsets.
const DIRTY_OFFSET: u64 = 1u64 << 63;

const TYPE_HEAD: u8 = 0;
const TYPE_ROOT: u8 = 1;
const TYPE_RADIX: u8 = 2;
const TYPE_LEAF: u8 = 3;
const TYPE_LINK: u8 = 4;
const TYPE_KEY: u8 = 5;

/// Convert a possibly "dirty" offset to a non-dirty offset.
fn translate_offset(v: u64, offset_map: &HashMap<u64, u64>) -> u64 {
    if v >= DIRTY_OFFSET {
        // Should always find a value. Otherwise it's a programming error about write order.
        *offset_map.get(&v).unwrap()
    } else {
        v
    }
}

/// Check type for an on-disk entry
fn check_type(buf: &[u8], offset: usize, expected: u8) -> io::Result<()> {
    let typeint = *(buf.get(offset).ok_or(InvalidData)?);
    if typeint != expected {
        Err(InvalidData.into())
    } else {
        Ok(())
    }
}

impl Radix {
    fn read_from<B: AsRef<[u8]>>(buf: B, offset: u64) -> io::Result<Self> {
        let buf = buf.as_ref();
        let offset = offset as usize;
        let mut pos = 0;

        check_type(buf, offset, TYPE_RADIX)?;
        pos += 1;

        let jumptable = buf.get(offset + pos..offset + pos + 16).ok_or(InvalidData)?;
        pos += 16;

        let (link_offset, len) = buf.read_vlq_at(offset + pos)?;
        pos += len;

        let mut offsets = [0; 16];
        for i in 0..16 {
            if jumptable[i] != 0 {
                if jumptable[i] as usize != pos {
                    return Err(InvalidData.into());
                }
                let (v, len) = buf.read_vlq_at(offset + pos)?;
                offsets[i] = v;
                pos += len;
            }
        }

        Ok(Radix {
            offsets,
            link_offset,
        })
    }

    fn write_to<W: Write>(&self, writer: &mut W, offset_map: &HashMap<u64, u64>) -> io::Result<()> {
        // Approximate size good enough for an average radix entry
        let mut buf = Vec::with_capacity(1 + 16 + 5 * 17);

        buf.write_all(&[TYPE_RADIX])?;
        buf.write_all(&[0u8; 16])?;
        buf.write_vlq(translate_offset(self.link_offset, offset_map))?;

        for i in 0..16 {
            let v = self.offsets[i];
            if v != 0 {
                let v = translate_offset(v, offset_map);
                buf[1 + i] = buf.len() as u8; // update jump table
                buf.write_vlq(v)?;
            }
        }

        writer.write_all(&buf)
    }
}

impl Leaf {
    fn read_from<B: AsRef<[u8]>>(buf: B, offset: u64) -> io::Result<Self> {
        let buf = buf.as_ref();
        let offset = offset as usize;
        check_type(buf, offset, TYPE_LEAF)?;
        let (key_offset, len) = buf.read_vlq_at(offset + 1)?;
        let (link_offset, _) = buf.read_vlq_at(offset + len + 1)?;
        Ok(Leaf {
            key_offset,
            link_offset,
        })
    }

    fn write_to<W: Write>(&self, writer: &mut W, offset_map: &HashMap<u64, u64>) -> io::Result<()> {
        writer.write_all(&[TYPE_LEAF])?;
        writer.write_vlq(translate_offset(self.key_offset, offset_map))?;
        writer.write_vlq(translate_offset(self.link_offset, offset_map))?;
        Ok(())
    }
}

impl Link {
    fn read_from<B: AsRef<[u8]>>(buf: B, offset: u64) -> io::Result<Self> {
        let buf = buf.as_ref();
        let offset = offset as usize;
        check_type(buf, offset, TYPE_LINK)?;
        let (value, len) = buf.read_vlq_at(offset + 1)?;
        let (next_link_offset, _) = buf.read_vlq_at(offset + len + 1)?;
        Ok(Link {
            value,
            next_link_offset,
        })
    }

    fn write_to<W: Write>(&self, writer: &mut W, offset_map: &HashMap<u64, u64>) -> io::Result<()> {
        writer.write_all(&[TYPE_LINK])?;
        writer.write_vlq(self.value)?;
        writer.write_vlq(translate_offset(self.next_link_offset, offset_map))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    quickcheck! {
        fn test_radix_format_roundtrip(v: (u64, u64, u64, u64), link_offset: u64) -> bool {
            let mut offsets = [0; 16];
            offsets[(v.1 + v.2) as usize % 16] = v.0 % DIRTY_OFFSET;
            offsets[(v.0 + v.3) as usize % 16] = v.1 % DIRTY_OFFSET;
            offsets[(v.1 + v.3) as usize % 16] = v.2 % DIRTY_OFFSET;
            offsets[(v.0 + v.2) as usize % 16] = v.3 % DIRTY_OFFSET;

            let radix = Radix { offsets, link_offset };
            let mut buf = vec![1];
            radix.write_to(&mut buf, &HashMap::new()).expect("write");
            let radix1 = Radix::read_from(buf, 1).unwrap();
            radix1 == radix
        }

        fn test_leaf_format_roundtrip(key_offset: u64, link_offset: u64) -> bool {
            let key_offset = key_offset % DIRTY_OFFSET;
            let link_offset = link_offset % DIRTY_OFFSET;
            let leaf = Leaf { key_offset, link_offset };
            let mut buf = vec![1];
            leaf.write_to(&mut buf, &HashMap::new()).expect("write");
            let leaf1 = Leaf::read_from(buf, 1).unwrap();
            leaf1 == leaf
        }

        fn test_link_format_roundtrip(value: u64, next_link_offset: u64) -> bool {
            let next_link_offset = next_link_offset % DIRTY_OFFSET;
            let link = Link { value, next_link_offset };
            let mut buf = vec![1];
            link.write_to(&mut buf, &HashMap::new()).expect("write");
            let link1 = Link::read_from(buf, 1).unwrap();
            link1 == link
        }
    }
}
