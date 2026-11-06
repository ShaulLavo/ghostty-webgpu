#!/usr/bin/env bash
set -euo pipefail
tool=$(cd "$(dirname "$0")" && pwd)
script=$(cat "$tool/run.sh")
exec bash -c "$script" "$tool/run.sh" "$@"
