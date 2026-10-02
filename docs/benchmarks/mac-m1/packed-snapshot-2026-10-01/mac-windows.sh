#!/bin/bash
# NOT-PORTABLE: Requires owner Mac benchmark dirs, mise shims and Homebrew Node.
export PATH=$HOME/.local/share/mise/shims:$PATH
cd "$HOME/tmp/gw-bench/p283-bulk-snapshot/corrected" || exit
for spec in "17 ascii" "17 sgr" "1 ascii" "1 sgr"; do
  set -- $spec
  active=$(ps -axo pid,ppid,etime,command | command grep -E 'comparison-runner.mjs|paired-run.mjs|finish-windows.sh' | command grep -v grep || true)
  if test -n "$active"; then
    printf 'Mac benchmark slot occupied\n%s\n' "$active"
    exit 1
  fi
  printf 'Exclusive Mac benchmark slot confirmed for %s\n' "$spec"
  /usr/bin/caffeinate -d -u -t 1800 /opt/homebrew/bin/node paired-run.mjs "$1" "$2" > "paired-$1-$2.log" 2>&1
  code=$?
  tail -15 "paired-$1-$2.log"
  test "$code" = 0 || exit "$code"
done
