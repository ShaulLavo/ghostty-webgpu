import gzip
import re
import subprocess
import sys
from pathlib import Path


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], capture_output=True, check=True).stdout


def main():
    target = Path(sys.argv[1]).resolve()
    assert not git(target, 'status', '--porcelain'), 'Use a clean disposable control worktree'
    assert git(target, 'rev-parse', 'HEAD').decode().strip() == '46b13c56409d0022c8ff95bde33917aee0517d9f'
    archive = Path(__file__).resolve().parent.parent / 'baseline-2026-10/harness.patch.gz'
    patch = gzip.open(archive, 'rt').read()
    for name in re.findall(r'^diff --git i/(.*?) w/', patch, re.M):
        source = subprocess.run(['git', '-C', str(target), 'show', 'd2ed8989a:' + name], capture_output=True)
        if source.returncode == 0:
            (target / name).write_bytes(source.stdout)
    subprocess.run(['git', '-C', str(target), 'apply', '-'], input=patch, text=True, check=True)
    runner = target / 'scripts/renderer-benchmark.ts'
    runner.write_text(runner.read_text().replace("const candidates = [{ label: 'candidate', root }]", "const candidates = [{ label: 'candidate', root: process.env.F4_CANDIDATE_ROOT ?? root }]"))


if __name__ == '__main__':
    main()
