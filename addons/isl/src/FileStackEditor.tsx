/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {RangeInfo} from './TextEditable';
import type {FileStackState, Rev} from './stackEdit/fileStackState';
import type {Block, LineIdx} from 'shared/diff';

import {CommitTitle} from './CommitTitle';
import {Row, ScrollX, ScrollY} from './ComponentUtils';
import {TextEditable} from './TextEditable';
import {VSCodeCheckbox} from './VSCodeCheckbox';
import {t} from './i18n';
import {FlattenLine} from './linelog';
import deepEqual from 'fast-deep-equal';
import {Set as ImSet, Range, List} from 'immutable';
import React, {useState, useRef, useEffect, useLayoutEffect} from 'react';
import {mergeBlocks, collapseContextBlocks, diffBlocks, splitLines} from 'shared/diff';
import {unwrap} from 'shared/utils';

import './FileStackEditor.css';

export type Mode = 'unified-diff' | 'side-by-side-diff' | 'unified-stack';

type EditorRowProps = {
  /**
   * File stack to edit.
   *
   * Note: the editor for rev 1 might want to diff against rev 0 and rev 2,
   * and might have buttons to move lines to other revs. So it needs to
   * know the entire stack.
   */
  stack: FileStackState;

  /** Function to update the stack. */
  setStack: (stack: FileStackState) => void;

  /** Function to get the "title" of a rev. */
  getTitle?: (rev: Rev) => string;

  /**
   * Skip editing (or showing) given revs.
   * This is usually to skip rev 0 (public, empty) if it is absent.
   * In the side-by-side mode, rev 0 is shown it it is an existing empty file
   * (introduced by a previous public commit). rev 0 is not shown if it is
   * absent, aka. rev 1 added the file.
   */
  skip?: (rev: Rev) => boolean;

  /** Diff mode. */
  mode: Mode;

  /** Whehter to enable text editing. This will disable conflicting features. */
  textEdit: boolean;
};

type EditorProps = EditorRowProps & {
  /** The rev in the stack to edit. */
  rev: Rev;
};

export function FileStackEditor(props: EditorProps) {
  const mainContentRef = useRef<HTMLPreElement | null>(null);
  const [expandedLines, setExpandedLines] = useState<ImSet<LineIdx>>(ImSet);
  const [selectedLineIds, setSelectedLineIds] = useState<ImSet<string>>(ImSet);
  const [widthStyle, setWidthStyle] = useState<string>('unset');
  const {stack, rev, setStack, mode} = props;
  const readOnly = rev === 0;
  const textEdit = !readOnly && props.textEdit;
  const rangeInfos: RangeInfo[] = [];

  // Selection change is a document event, not a <pre> event.
  useEffect(() => {
    const handleSelect = () => {
      const selection = window.getSelection();
      if (
        textEdit ||
        selection == null ||
        mainContentRef.current == null ||
        !mainContentRef.current.contains(selection.anchorNode)
      ) {
        setSelectedLineIds(ids => (ids.isEmpty() ? ids : ImSet()));
        return;
      }
      const divs = mainContentRef.current.querySelectorAll<HTMLDivElement>('div[data-sel-id]');
      const selIds: Array<string> = [];
      for (const div of divs) {
        const child = div.lastChild;
        if (child && selection.containsNode(child, true)) {
          selIds.push(unwrap(div.dataset.selId));
        }
      }
      setSelectedLineIds(ImSet(selIds));
    };
    document.addEventListener('selectionchange', handleSelect);
    return () => {
      document.removeEventListener('selectionchange', handleSelect);
    };
  }, [textEdit]);

  if (mode === 'unified-stack') {
    return null;
  }

  // Diff with the left side.
  const bText = stack.getRev(rev);
  const bLines = splitLines(bText);
  const aLines = splitLines(stack.getRev(Math.max(0, rev - 1)));
  const abBlocks = diffBlocks(aLines, bLines);

  const leftMost = rev <= 1;
  const rightMost = rev + 1 >= stack.revLength;

  // For side-by-side diff, we also need to diff with the right side.
  let cbBlocks: Array<Block> = [];
  let blocks = abBlocks;
  if (!rightMost && mode === 'side-by-side-diff') {
    const cText = stack.getRev(rev + 1);
    const cLines = splitLines(cText);
    cbBlocks = diffBlocks(cLines, bLines);
    blocks = mergeBlocks(abBlocks, cbBlocks);
  }

  // Utility to get the "different" block containing the given b-side line number.
  // Used by side-by-side diff to highlight left and right gutters.
  const buildGetDifferentBlockFunction = (blocks: Array<Block>) => {
    let blockIdx = 0;
    return (bIdx: LineIdx): Block | null => {
      while (blockIdx < blocks.length && bIdx >= blocks[blockIdx][1][3]) {
        blockIdx++;
      }
      return blockIdx < blocks.length && blocks[blockIdx][0] === '!' ? blocks[blockIdx] : null;
    };
  };
  const getLeftDifferentBlock = buildGetDifferentBlockFunction(abBlocks);
  const getRightDifferentBlock = buildGetDifferentBlockFunction(cbBlocks);
  const blockToClass = (block: Block | null, add = true): ' add' | ' del' | ' change' | '' =>
    block == null ? '' : block[1][0] === block[1][1] ? (add ? ' add' : ' del') : ' change';

  // Collapse unchanged context blocks, preserving the context lines.
  const collapsedBlocks = collapseContextBlocks(blocks, (_aLine, bLine) =>
    expandedLines.has(bLine),
  );

  // We render 3 (or 5) columns as 3 <pre>s so they align vertically:
  // [left gutter] [left buttons] [main content] [right buttons] [right gutter].
  // The arrays below are the children of the <pre>s. One element per line per column.
  const leftGutter: JSX.Element[] = [];
  const leftButtons: JSX.Element[] = [];
  const mainContent: JSX.Element[] = [];
  const rightGutter: JSX.Element[] = [];
  const rightButtons: JSX.Element[] = [];
  const ribbons: JSX.Element[] = [];

  const handleContextExpand = (b1: LineIdx, b2: LineIdx) => {
    const newSet = expandedLines.union(Range(b1, b2));
    setExpandedLines(newSet);
  };

  const showLineButtons = !textEdit && !readOnly && mode === 'unified-diff';
  const pushLineButtons = (sign: '=' | '!' | '~', aIdx?: LineIdx, bIdx?: LineIdx) => {
    if (!showLineButtons) {
      return;
    }

    let leftButton: JSX.Element | string = ' ';
    let rightButton: JSX.Element | string = ' ';

    // Move one or more lines. If the current line is part of the selection,
    // Move all lines in the selection.
    const moveLines = (revOffset: number) => {
      // Figure out which lines to move on both sides.
      let aIdxToMove: ImSet<LineIdx> = ImSet();
      let bIdxToMove: ImSet<LineIdx> = ImSet();
      if (
        (aIdx != null && selectedLineIds.has(`a${aIdx}`)) ||
        (bIdx != null && selectedLineIds.has(`b${bIdx}`))
      ) {
        // Move selected multiple lines.
        aIdxToMove = aIdxToMove.withMutations(mut => {
          let set = mut;
          selectedLineIds.forEach(id => {
            if (id.startsWith('a')) {
              set = set.add(parseInt(id.slice(1)));
            }
          });
          return set;
        });
        bIdxToMove = bIdxToMove.withMutations(mut => {
          let set = mut;
          selectedLineIds.forEach(id => {
            if (id.startsWith('b')) {
              set = set.add(parseInt(id.slice(1)));
            }
          });
          return set;
        });
      } else {
        // Move a single line.
        if (aIdx != null) {
          aIdxToMove = aIdxToMove.add(aIdx);
        }
        if (bIdx != null) {
          bIdxToMove = bIdxToMove.add(bIdx);
        }
      }

      // Actually move the lines.
      const aRev = rev - 1;
      const bRev = rev;
      let currentAIdx = 0;
      let currentBIdx = 0;
      const newStack = stack.mapAllLines(line => {
        let newRevs = line.revs;
        if (line.revs.has(aRev)) {
          // This is a deletion.
          if (aIdxToMove.has(currentAIdx)) {
            if (revOffset > 0) {
              // Move deletion right - add it in bRev.
              newRevs = newRevs.add(bRev);
            } else {
              // Move deletion left - drop it from aRev.
              newRevs = newRevs.remove(aRev);
            }
          }
          currentAIdx += 1;
        }
        if (line.revs.has(bRev)) {
          // This is an insertion.
          if (bIdxToMove.has(currentBIdx)) {
            if (revOffset > 0) {
              // Move insertion right - drop it in bRev.
              newRevs = newRevs.remove(bRev);
            } else {
              // Move insertion left - add it to aRev.
              newRevs = newRevs.add(aRev);
            }
          }
          currentBIdx += 1;
        }
        return newRevs === line.revs ? line : line.set('revs', newRevs);
      });
      setStack(newStack);
    };

    const selected =
      aIdx != null
        ? selectedLineIds.has(`a${aIdx}`)
        : bIdx != null
        ? selectedLineIds.has(`b${bIdx}`)
        : false;

    if (!leftMost && sign === '!') {
      const title = selected
        ? t('Move selected line changes left')
        : t('Move this line change left');
      leftButton = (
        <span className="button" role="button" title={title} onClick={() => moveLines(-1)}>
          🡄
        </span>
      );
    }
    if (!rightMost && sign === '!') {
      const title = selected
        ? t('Move selected line changes right')
        : t('Move this line change right');
      rightButton = (
        <span className="button" role="button" title={title} onClick={() => moveLines(+1)}>
          🡆
        </span>
      );
    }

    const className = selected ? 'selected' : '';

    leftButtons.push(
      <div key={leftButtons.length} className={`${className} left`}>
        {leftButton}
      </div>,
    );
    rightButtons.push(
      <div key={rightButtons.length} className={`${className} right`}>
        {rightButton}
      </div>,
    );
  };

  let start = 0;
  const nextRangeId = (len: number): number => {
    const id = rangeInfos.length;
    const end = start + len;
    rangeInfos.push({start, end});
    start = end;
    return id;
  };
  const bLineSpan = (bLine: string): JSX.Element => {
    if (!textEdit) {
      return <span>{bLine}</span>;
    }
    const id = nextRangeId(bLine.length);
    return <span data-range-id={id}>{bLine}</span>;
  };

  collapsedBlocks.forEach(([sign, [a1, a2, b1, b2]]) => {
    if (sign === '~') {
      // Context line.
      leftGutter.push(
        <div key={a1} className="lineno">
          {' '}
        </div>,
      );
      rightGutter.push(
        <div key={b1} className="lineno">
          {' '}
        </div>,
      );
      mainContent.push(
        <div key={b1} className="context-button" onClick={() => handleContextExpand(b1, b2)}>
          {' '}
        </div>,
      );
      pushLineButtons(sign, a1, b1);
      if (textEdit) {
        // Still need to update rangeInfos.
        let len = 0;
        for (let bi = b1; bi < b2; ++bi) {
          len += bLines[bi].length;
        }
        nextRangeId(len);
      }
    } else if (sign === '=') {
      // Unchanged.
      for (let ai = a1; ai < a2; ++ai) {
        const bi = ai + b1 - a1;
        const leftIdx = mode === 'unified-diff' ? ai : bi;
        leftGutter.push(
          <div className="lineno" key={ai} data-span-id={`${rev}-${leftIdx}l`}>
            {leftIdx + 1}
          </div>,
        );
        rightGutter.push(
          <div className="lineno" key={bi} data-span-id={`${rev}-${bi}r`}>
            {bi + 1}
          </div>,
        );
        mainContent.push(
          <div key={bi} className="unchanged line">
            {bLineSpan(bLines[bi])}
          </div>,
        );
        pushLineButtons(sign, ai, bi);
      }
    } else if (sign === '!') {
      // Changed.
      if (mode === 'unified-diff') {
        // Deleted lines only show up in unified diff.
        for (let ai = a1; ai < a2; ++ai) {
          leftGutter.push(
            <div className="lineno" key={ai}>
              {ai + 1}
            </div>,
          );
          rightGutter.push(
            <div className="lineno" key={`a${ai}`}>
              {' '}
            </div>,
          );
          const selId = `a${ai}`;
          let className = 'del line';
          if (selectedLineIds.has(selId)) {
            className += ' selected';
          }

          pushLineButtons(sign, ai, undefined);
          mainContent.push(
            <div key={-ai} className={className} data-sel-id={selId}>
              {aLines[ai]}
            </div>,
          );
        }
      }
      for (let bi = b1; bi < b2; ++bi) {
        // Inserted lines show up in unified and side-by-side diffs.
        let leftClassName = 'lineno';
        if (mode === 'side-by-side-diff') {
          leftClassName += blockToClass(getLeftDifferentBlock(bi), true);
        }
        leftGutter.push(
          <div className={leftClassName} key={`b${bi}`} data-span-id={`${rev}-${bi}l`}>
            {mode === 'unified-diff' ? ' ' : bi + 1}
          </div>,
        );
        let rightClassName = 'lineno';
        if (mode === 'side-by-side-diff') {
          rightClassName += blockToClass(getRightDifferentBlock(bi), false);
        }
        rightGutter.push(
          <div className={rightClassName} key={bi} data-span-id={`${rev}-${bi}r`}>
            {bi + 1}
          </div>,
        );
        const selId = `b${bi}`;
        let lineClassName = 'line';
        if (mode === 'unified-diff') {
          lineClassName += ' add';
        } else if (mode === 'side-by-side-diff') {
          const lineNoClassNames = leftClassName + rightClassName;
          for (const name of [' change', ' add', ' del']) {
            if (lineNoClassNames.includes(name)) {
              lineClassName += name;
              break;
            }
          }
        }
        if (selectedLineIds.has(selId)) {
          lineClassName += ' selected';
        }
        pushLineButtons(sign, undefined, bi);
        mainContent.push(
          <div key={bi} className={lineClassName} data-sel-id={selId}>
            {bLineSpan(bLines[bi])}
          </div>,
        );
      }
    }
  });

  if (mode === 'side-by-side-diff' && rev > 0) {
    abBlocks.forEach(([sign, [a1, a2, b1, b2]]) => {
      if (sign === '!') {
        ribbons.push(
          <Ribbon
            a1={`${rev - 1}-${a1}r`}
            a2={`${rev - 1}-${a2 - 1}r`}
            b1={`${rev}-${b1}l`}
            b2={`${rev}-${b2 - 1}l`}
            outerContainerClass="file-stack-editor-outer-scroll-y"
            innerContainerClass="file-stack-editor"
            key={b1}
            className={b1 === b2 ? 'del' : a1 === a2 ? 'add' : 'change'}
          />,
        );
      }
    });
  }

  const handleTextChange = (value: string) => {
    const newStack = stack.editText(rev, value);
    setStack(newStack);
  };

  const handleXScroll: React.UIEventHandler<HTMLDivElement> = e => {
    // Dynamically decide between 'width: fit-content' and 'width: unset'.
    // Affects the position of the [->] "move right" button and the width
    // of the line background for LONG LINES.
    //
    //     |ScrollX width|
    // ------------------------------------------------------------------------
    //     |Editor width |              <- width: unset && scrollLeft == 0
    //     |Text width - could be long|    text could be longer
    //     |         [->]|                 "move right" button is visible
    // ------------------------------------------------------------------------
    // |Editor width |                  <- width: unset && scrollLeft > 0
    // |+/- highlight|                     +/- background covers partial text
    // |         [->]|                     "move right" at wrong position
    // ------------------------------------------------------------------------
    // |Editor width              | <- width: fit-content && scrollLeft > 0
    // |Text width - could be long|    long text width = editor width
    // |+/- highlight             |    +/- background covers all text
    // |                      [->]|    "move right" at the right side of text
    //
    const newWidthStyle = e.currentTarget?.scrollLeft > 0 ? 'fit-content' : 'unset';
    setWidthStyle(newWidthStyle);
  };

  const mainStyle: React.CSSProperties = {width: widthStyle};
  const mainContentPre = (
    <pre className="main-content" style={mainStyle} ref={mainContentRef}>
      {mainContent}
    </pre>
  );

  return (
    <div className="file-stack-editor-ribbon-no-clip">
      {ribbons}
      <ScrollY className="file-stack-editor-outer-scroll-y" hideBar={true} maxSize="70vh">
        <Row className="file-stack-editor">
          {showLineButtons && <pre className="column-left-buttons">{leftButtons}</pre>}
          <pre className="column-left-gutter">{leftGutter}</pre>
          <ScrollX hideBar={true} size={500} maxSize={500} onScroll={handleXScroll}>
            {textEdit ? (
              <TextEditable value={bText} rangeInfos={rangeInfos} onTextChange={handleTextChange}>
                {mainContentPre}
              </TextEditable>
            ) : (
              mainContentPre
            )}
          </ScrollX>
          <pre className="column-right-gutter">{rightGutter}</pre>
          {showLineButtons && <pre className="column-right-buttons">{rightButtons}</pre>}
        </Row>
      </ScrollY>
    </div>
  );
}

/** The unified stack view is different from other views. */
function FileStackEditorUnifiedStack(props: EditorRowProps) {
  type ClickPosition = {
    rev: Rev;
    lineIdx: LineIdx;
    checked?: boolean;
  };
  const [clickStart, setClickStart] = useState<ClickPosition | null>(null);
  const [clickEnd, setClickEnd] = useState<ClickPosition | null>(null);
  const [expandedLines, setExpandedLines] = useState<ImSet<LineIdx>>(ImSet);

  const {stack, setStack, textEdit} = props;
  const {skip, getTitle} = getSkipGetTitleOrDefault(props);

  const rangeInfos: Array<RangeInfo> = [];

  const lines = stack.convertToFlattenLines();
  const revs = stack.revs().filter(rev => !skip(rev));
  const lastRev = revs.at(-1) ?? -1;

  // RangeInfo handling required by TextEditable.
  let start = 0;
  const nextRangeId = (len: number): number => {
    const id = rangeInfos.length;
    const end = start + len;
    rangeInfos.push({start, end});
    start = end;
    return id;
  };

  // Append `baseName` with `color${rev % 4}`.
  const getColorClassName = (baseName: string, rev: number): string => {
    const colorIdx = rev % 4;
    return `${baseName} color${colorIdx}`;
  };

  // Header. Commit titles.
  const headerRows = revs.map(rev => {
    const padTds = revs.map(rev2 => (
      <th key={rev2} className={getColorClassName('pad', Math.min(rev2, rev))}></th>
    ));
    const title = getTitle(rev);
    return (
      <tr key={rev}>
        {padTds}
        <th className={getColorClassName('commit-title', rev)}>
          <CommitTitle commitMessage={title} tooltipPlacement="left" />
        </th>
      </tr>
    );
  });

  // Checkbox range selection.
  const getSelRanges = (start: ClickPosition | null, end: ClickPosition | null) => {
    // Minimal number sort. Note Array.sort is a string sort.
    const sort2 = (a: number, b: number) => (a < b ? [a, b] : [b, a]);

    // Selected range to highlight.
    let lineRange = Range(0, 0);
    let revRange = Range(0, 0);
    if (start != null && end != null) {
      const [rev1, rev2] = sort2(start.rev, end.rev);
      // Skip rev 0 (public, immutable).
      revRange = Range(Math.max(rev1, 1), rev2 + 1);
      const [lineIdx1, lineIdx2] = sort2(start.lineIdx, end.lineIdx);
      lineRange = Range(lineIdx1, lineIdx2 + 1);
    }
    return [lineRange, revRange];
  };
  const [selLineRange, selRevRange] = getSelRanges(clickStart, clickEnd ?? clickStart);

  const handlePointerDown = (
    lineIdx: LineIdx,
    rev: Rev,
    checked: boolean,
    e: React.PointerEvent,
  ) => {
    if (e.isPrimary) {
      setClickStart({lineIdx, rev, checked});
    }
  };
  const handlePointerMove = (lineIdx: LineIdx, rev: Rev, e: React.PointerEvent) => {
    if (e.isPrimary && clickStart != null) {
      const newClickEnd = {lineIdx, rev, checked: false};
      setClickEnd(v => (deepEqual(v, newClickEnd) ? v : newClickEnd));
    }
  };
  const handlePointerUp = (lineIdx: LineIdx, rev: Rev, e: React.PointerEvent) => {
    setClickEnd(null);
    if (e.isPrimary && clickStart != null) {
      const [lineRange, revRange] = getSelRanges(clickStart, {lineIdx, rev});
      setClickStart(null);
      const newStack = stack.mapAllLines((line, i) => {
        if (lineRange.contains(i)) {
          const newRevs = clickStart.checked
            ? line.revs.union(revRange)
            : line.revs.subtract(revRange);
          return line.set('revs', newRevs);
        } else {
          return line;
        }
      });
      setStack(newStack);
    }
  };

  // Context line analysis. We "abuse" the `collapseContextBlocks` by faking the `blocks`.
  const blocks: Array<Block> = [];
  const pushSign = (sign: '!' | '=', end: LineIdx) => {
    const lastBlock = blocks.at(-1);
    if (lastBlock == null) {
      blocks.push([sign, [0, end, 0, end]]);
    } else if (lastBlock[0] === sign) {
      lastBlock[1][1] = lastBlock[1][3] = end;
    } else {
      blocks.push([sign, [lastBlock[1][1], end, lastBlock[1][3], end]]);
    }
  };
  lines.forEach((line, i) => {
    const sign = line.revs.size >= revs.length ? '=' : '!';
    pushSign(sign, i + 1);
  });
  const collapsedBlocks = collapseContextBlocks(blocks, (_a, b) => expandedLines.contains(b));

  const handleContextExpand = (b1: LineIdx, b2: LineIdx) => {
    const newSet = expandedLines.union(Range(b1, b2));
    setExpandedLines(newSet);
  };

  // Body. Checkboxes + Line content, or "~~~~" context button.
  const bodyRows: JSX.Element[] = [];
  collapsedBlocks.forEach(([sign, [, , b1, b2]]) => {
    if (sign === '~') {
      const checkboxes = revs.map(rev => (
        <td key={rev} className={getColorClassName('', rev)}></td>
      ));

      bodyRows.push(
        <tr key={b1}>
          {checkboxes}
          <td className="context-button" onClick={() => handleContextExpand(b1, b2)}>
            <span> </span>
          </td>
        </tr>,
      );

      if (textEdit) {
        const len = Range(b1, b2).reduce((acc, i) => acc + unwrap(lines.get(i)).data.length, 0);
        nextRangeId(len);
      }

      return;
    }
    for (let i = b1; i < b2; ++i) {
      const line = unwrap(lines.get(i));
      const checkboxes = revs.map(rev => {
        const checked = line.revs.contains(rev);
        let className = 'checkbox' + (rev > 0 ? ' mutable' : ' immutable');
        if (selLineRange.contains(i) && selRevRange.contains(rev)) {
          className += clickStart?.checked ? ' add' : ' del';
        }
        return (
          <td
            key={rev}
            className={getColorClassName(className, rev)}
            onPointerDown={e => handlePointerDown(i, rev, !checked, e)}
            onPointerMove={e => handlePointerMove(i, rev, e)}
            onPointerUp={e => handlePointerUp(i, rev, e)}
            onDragStart={e => e.preventDefault()}>
            <VSCodeCheckbox
              tabIndex={-1}
              disabled={rev === 0}
              checked={checked}
              style={{pointerEvents: 'none'}}
            />
          </td>
        );
      });
      let tdClass = 'line';
      if (!line.revs.has(lastRev)) {
        tdClass += ' del';
      } else if (line.revs.size < revs.length) {
        tdClass += ' change';
      }
      const rangeId = textEdit ? nextRangeId(line.data.length) : undefined;
      bodyRows.push(
        <tr key={i}>
          {checkboxes}
          <td className={tdClass}>
            <span className="line" data-range-id={rangeId}>
              {line.data}
            </span>
          </td>
        </tr>,
      );
    }
  });

  let editor = (
    <table className="file-unified-stack-editor">
      <thead>{headerRows}</thead>
      <tbody>{bodyRows}</tbody>
    </table>
  );

  if (textEdit) {
    const textLines = lines.map(l => l.data).toArray();
    const text = textLines.join('');
    const handleTextChange = (newText: string) => {
      const immutableRev = 0;
      const immutableRevs: ImSet<Rev> = ImSet([immutableRev]);
      const newTextLines = splitLines(newText);
      const blocks = diffBlocks(textLines, newTextLines);
      const newFlattenLines: List<FlattenLine> = List<FlattenLine>().withMutations(mut => {
        let flattenLines = mut;
        blocks.forEach(([sign, [a1, a2, b1, b2]]) => {
          if (sign === '=') {
            flattenLines = flattenLines.concat(lines.slice(a1, a2));
          } else if (sign === '!') {
            // Plain text does not have "revs" info.
            // We just reuse the last line on the a-side. This should work fine for
            // single-line insertion or edits.
            const fallbackRevs: ImSet<Rev> =
              lines.get(Math.max(a1, a2 - 1))?.revs?.delete(immutableRev) ?? ImSet();
            // Public (immutableRev, rev 0) lines cannot be deleted. Enforce that.
            const aLines = Range(a1, a2)
              .map(ai => lines.get(ai))
              .filter(l => l != null && l.revs.contains(immutableRev))
              .map(l => (l as FlattenLine).set('revs', immutableRevs));
            // Newly added lines cannot insert to (immutableRev, rev 0) either.
            const bLines = Range(b1, b2).map(bi => {
              const data = newTextLines[bi] ?? '';
              const ai = bi - b1 + a1;
              const revs =
                (ai < a2 ? lines.get(ai)?.revs?.delete(immutableRev) : null) ?? fallbackRevs;
              return FlattenLine({data, revs});
            });
            flattenLines = flattenLines.concat(aLines).concat(bLines);
          }
        });
        return flattenLines;
      });
      const newStack = stack.fromFlattenLines(newFlattenLines, stack.revLength);
      setStack(newStack);
    };

    editor = (
      <TextEditable rangeInfos={rangeInfos} value={text} onTextChange={handleTextChange}>
        {editor}
      </TextEditable>
    );
  }

  return <ScrollY maxSize="70vh">{editor}</ScrollY>;
}

export function FileStackEditorRow(props: EditorRowProps) {
  if (props.mode === 'unified-stack') {
    return FileStackEditorUnifiedStack(props);
  }

  // skip rev 0, the "public" revision for unified diff.
  const {skip, getTitle} = getSkipGetTitleOrDefault(props);
  const revs = props.stack
    .revs()
    .slice(props.mode === 'unified-diff' ? 1 : 0)
    .filter(r => !skip(r));
  return (
    <ScrollX>
      <Row className="file-stack-editor-row">
        {revs.map(rev => {
          const title = getTitle(rev);
          return (
            <div key={rev}>
              <CommitTitle className="filerev-title" commitMessage={title} />
              <FileStackEditor rev={rev} {...props} />
            </div>
          );
        })}
      </Row>
    </ScrollX>
  );
}

function getSkipGetTitleOrDefault(props: EditorRowProps): {
  skip: (rev: Rev) => boolean;
  getTitle: (rev: Rev) => string;
} {
  const skip = props.skip ?? ((rev: Rev) => rev === 0);
  const getTitle = props.getTitle ?? (() => '');
  return {skip, getTitle};
}

/**
 * The "connector" between two editors.
 *
 * Takes 4 data-span-id attributes:
 *
 * +------------+        +------------+
 * | containerA |        | containerB |
 * |       +----+~~~~~~~~+----+       |
 * |       | a1 |        | b1 |       |
 * |       +----+        +----+       |
 * |       | .. | Ribbon | .. |       |
 * |       +----+        +----+       |
 * |       | a2 |        | b2 |       |
 * |       +----+~~~~~~~~+----+       |
 * |            |        |            |
 * +------------+        +------------+
 *
 * The ribbon is positioned relative to (outer) containerB,
 * the editor on the right side.
 *
 * The ribbon position will be recalculated if either containerA
 * or containerB gets resized or scrolled. Note there are inner
 * and outer containers. The scroll check is on the outer container
 * with the `overflow-y: auto`. The resize check is on the inner
 * container, since the outer container remains the same size
 * once overflowed.
 *
 * The ribbons are drawn outside the scroll container, and need
 * another container to have the `overflow: visible` behavior,
 * like:
 *
 *   <div style={{overflow: 'visible', position: 'relative'}}>
 *     <Ribbon />
 *     <ScrollY className="outerContainer">
 *        <Something className="innerContainer" />
 *     </ScrollY>
 *   </div>
 *
 * If one of a1 and a2 is missing, the a-side range is then
 * considered zero-height. This is useful for pure deletion
 * or insertion. Same for b1 and b2.
 */
function Ribbon(props: {
  a1: string;
  a2: string;
  b1: string;
  b2: string;
  outerContainerClass: string;
  innerContainerClass: string;
  className: string;
}) {
  type RibbonPos = {
    top: number;
    width: number;
    height: number;
    path: string;
  };
  const [pos, setPos] = useState<RibbonPos | null>(null);
  type E = HTMLElement;

  type Containers = {
    resize: E[];
    scroll: E[];
  };

  useLayoutEffect(() => {
    // Get the container elements and recaluclate positions.
    // Returns an empty array if the containers are not found.
    const repositionAndGetContainers = (): Containers | undefined => {
      // Find a1, a2, b1, b2. a2 and b2 are nullable.
      const select = (spanId: string): E | null =>
        spanId === ''
          ? null
          : document.querySelector(`.${props.outerContainerClass} [data-span-id="${spanId}"]`);
      const [a1, a2, b1, b2] = [props.a1, props.a2, props.b1, props.b2].map(select);
      const aEither = a1 ?? a2;
      const bEither = b1 ?? b2;
      if (aEither == null || bEither == null) {
        return;
      }

      // Find containers.
      const findContainer = (span: E, className: string): E | null => {
        for (let e: E | null = span; e != null; e = e.parentElement) {
          if (e.classList.contains(className)) {
            return e;
          }
        }
        return null;
      };
      const [outerA, outerB] = [aEither, bEither].map(e =>
        findContainer(e, props.outerContainerClass),
      );
      const [innerA, innerB] = [aEither, bEither].map(e =>
        findContainer(e, props.innerContainerClass),
      );
      if (outerA == null || outerB == null || innerA == null || innerB == null) {
        return;
      }

      // Recalculate positions. a2Rect and b2Rect are nullable.
      let newPos: RibbonPos | null = null;
      const [outerARect, outerBRect] = [outerA, outerB].map(e => e.getBoundingClientRect());
      const [a1Rect, a2Rect, b1Rect, b2Rect] = [a1, a2, b1, b2].map(
        e => e && e.getBoundingClientRect(),
      );
      const aTop = a1Rect?.top ?? a2Rect?.bottom;
      const bTop = b1Rect?.top ?? b2Rect?.bottom;
      const aBottom = a2Rect?.bottom ?? aTop;
      const bBottom = b2Rect?.bottom ?? bTop;
      const aRight = a1Rect?.right ?? a2Rect?.right;
      const bLeft = b1Rect?.left ?? b2Rect?.left;

      if (
        aTop != null &&
        bTop != null &&
        aBottom != null &&
        bBottom != null &&
        aRight != null &&
        bLeft != null
      ) {
        const top = Math.min(aTop, bTop) - outerBRect.top;
        const width = bLeft - aRight;
        const ay1 = Math.max(aTop - bTop, 0);
        const by1 = Math.max(bTop - aTop, 0);
        const height = Math.max(aBottom, bBottom) - Math.min(aTop, bTop);
        const ay2 = ay1 + aBottom - aTop;
        const by2 = by1 + bBottom - bTop;
        const mid = width / 2;

        // Discard overflow position.
        if (
          top >= 0 &&
          top + Math.max(ay2, by2) <= Math.max(outerARect.height, outerBRect.height)
        ) {
          const path = [
            `M 0 ${ay1}`,
            `C ${mid} ${ay1}, ${mid} ${by1}, ${width} ${by1}`,
            `L ${width} ${by2}`,
            `C ${mid} ${by2}, ${mid} ${ay2}, 0 ${ay2}`,
            `L 0 ${ay1}`,
          ].join(' ');
          newPos = {
            top,
            width,
            height,
            path,
          };
        }
      }

      setPos(pos => (deepEqual(pos, newPos) ? pos : newPos));

      return {
        scroll: [outerA, outerB],
        resize: [innerA, innerB],
      };
    };

    // Calcualte position now.
    const containers = repositionAndGetContainers();

    if (containers == null) {
      return;
    }

    // Observe resize and scrolling changes of the container.
    const observer = new ResizeObserver(() => repositionAndGetContainers());
    const handleScroll = () => {
      repositionAndGetContainers();
    };
    containers.resize.forEach(c => observer.observe(c));
    containers.scroll.forEach(c => c.addEventListener('scroll', handleScroll));

    return () => {
      observer.disconnect();
      containers.scroll.forEach(c => c.removeEventListener('scroll', handleScroll));
    };
  }, [
    props.a1,
    props.a2,
    props.b1,
    props.b2,
    props.outerContainerClass,
    props.innerContainerClass,
    props.className,
  ]);

  if (pos == null) {
    return null;
  }

  const style: React.CSSProperties = {
    top: pos.top,
    left: 1 - pos.width,
    width: pos.width,
    height: pos.height,
  };

  return (
    <svg className={`ribbon ${props.className}`} style={style}>
      <path d={pos.path} />
    </svg>
  );
}
