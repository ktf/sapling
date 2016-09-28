#!/usr/bin/env python
import json
import multiprocessing
import optparse
import os
import re
import subprocess
import sys

"""run a subset of tests that related to the current change

Optionally write result using JSON format. The JSON format can be parsed
by MercurialTestEngine.php
"""

reporoot = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))

def info(message):
    """print message to stderr"""
    sys.stderr.write(message)

def getrunner():
    """return the path of run-tests.py. best-effort"""
    runner = os.environ.get('MERCURIALRUNTEST', 'run-tests.py')
    if os.path.exists(runner):
        return runner
    # Search some common places for run-tests.py
    for prefix in ['..', os.path.expanduser('~')]:
        for hgrepo in ['hg', 'hg-crew', 'hg-committed']:
            path = os.path.abspath(os.path.join(prefix, hgrepo,
                                                'tests', 'run-tests.py'))
            if os.path.exists(path):
                return path
    return runner

def checkoutput(*args, **kwds):
    """like subprocess.checked_output, but raise RuntimeError and return
    stderr as a second value.
    """
    proc = subprocess.Popen(*args, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, **kwds)
    out, err = proc.communicate()
    retcode = proc.poll()
    if retcode:
        raise RuntimeError('%r exits with %d' % (args, retcode))
    return out, err

def changedfiles(rev='wdir() + .'):
    """return a list of paths (relative to repo root) that rev touches.
    by default, check the working directory and its parent.
    """
    cmd = ['hg', 'log', '-T', '{join(files,"\\0")}', '-r', rev]
    out, err = checkoutput(cmd, cwd=reporoot)
    return out.split('\0')

def words(path):
    """strip extension and split it to words.
    for example, 'a/b-c.txt' -> ['a', 'b', 'c']
    """
    return re.split('[^\w]+', os.path.splitext(path)[0])

def interestingtests():
    """return a list of interesting test filenames"""
    tests = [p for p in os.listdir(os.path.join(reporoot, 'tests'))
             if p.startswith('test-') and p[-2:] in ['py', '.t']]
    # Convert ['test-foo-bar.t', 'test-baz.t'] to [{'foo', 'bar'}, {'baz'}]
    testwords = [set(words(t)[1:]) for t in tests]
    # Include test-check*, except for test-check-code-hg.t used by arc lint.
    result = set([t for t in tests
                  if (t.startswith('test-check')
                      and t != 'test-check-code-hg.t')])
    # A test is interesting if there is a common word in both the path of the
    # changed source file and the name of the test file. For example:
    # - test-githelp.t is interesting if githelp.py is changed
    # - test-remotefilelog-sparse.t is interesting if sparse.py is changed
    # - test-remotefilelog-foo.t is interesting if remotefilelog/* is changed
    for path in changedfiles():
        if path.startswith('tests/test-'):
            # for a test file, do not enable other tests but only itself
            result.add(os.path.basename(path))
            continue
        result.update(t for t, s in zip(tests, testwords)
                      if any(c in s for c in words(path)))
    return result

def reporequires():
    """return a list of string, which are the requirements of the hg repo"""
    requirespath = os.path.join(reporoot, '.hg', 'requires')
    if os.path.exists(requirespath):
        return [s.rstrip() for s in open(requirespath, 'r')]
    return []

def runtests(tests=None):
    """run given tests

    Returns a tuple of (exitcode, report)
    exitcode will be 0 on success, and non-zero on failure
    report is a dictionary of test results.
    """
    cpucount = multiprocessing.cpu_count()
    cmd = [getrunner(), '-j%d' % cpucount, '-l', '--json']
    requires = reporequires()
    if 'lz4revlog' in requires:
        cmd += ['--extra-config-opt=extensions.lz4revlog=']
    if tests:
        cmd += tests

    # Include the repository root in PYTHONPATH so the unit tests will find
    # the extensions from the local repository, rather than the versions
    # already installed on the system.
    env = os.environ.copy()
    if 'PYTHONPATH' in env:
        existing_pypath = [env['PYTHONPATH']]
    else:
        existing_pypath = []
    env['PYTHONPATH'] = os.path.pathsep.join([reporoot] + existing_pypath)

    # Run the tests.
    #
    # We ignore KeyboardInterrupt while running the tests: when the user hits
    # Ctrl-C the interrupt will also be delivered to the test runner, which
    # should cause it to exit soon.  We want to wait for the test runner to
    # exit before we quit.  Otherwise may keep printing data even after we have
    # exited and returned control of the terminal to the user's shell.
    proc = subprocess.Popen(cmd, cwd=os.path.join(reporoot, 'tests'), env=env)
    interruptcount = 0
    maxinterrupts = 3
    while True:
        try:
            exitcode = proc.wait()
            break
        except KeyboardInterrupt:
            interruptcount += 1
            if interruptcount >= maxinterrupts:
                sys.stderr.write('Warning: test runner has not exited after '
                                 'multiple interrupts.  Giving up on it and '
                                 'quiting anyway.\n')
                raise

    try:
        reportpath = os.path.join(reporoot, 'tests', 'report.json')
        with open(reportpath) as rf:
            report_contents = rf.read()

        # strip the "testreport =" header which makes the JSON illegal
        report = json.loads(re.sub('^testreport =', '', report_contents))
        os.unlink(reportpath)
    except (EnvironmentError, ValueError) as ex:
        # If anything goes wrong parsing the report.json file, build our own
        # fake failure report, and make sure we have non-zero exit code.
        sys.stderr.write('warning: error reading results: %s\n' % (ex,))
        report = {'run-tests': {'result': 'failure'}}
        if exitcode == 0:
            exitcode = 1

    return exitcode, report

def main():
    op = optparse.OptionParser()
    opts, args = op.parse_args()
    jsonpath = args[0] if args else None

    tests = interestingtests()
    if tests:
        info('%d test%s to run: %s\n'
             % (len(tests), ('' if len(tests) == 1 else 's'), ' '.join(tests)))
        exitcode, report = runtests(tests)
    else:
        info('no tests to run\n')
        exitcode = 0
        report = {}

    if jsonpath:
        with open(jsonpath, 'w') as fp:
            json.dump(report, fp)
    return exitcode

if __name__ == '__main__':
    exitcode = main()
    sys.exit(exitcode)
