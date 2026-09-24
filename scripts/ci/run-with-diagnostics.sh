#!/usr/bin/env bash
# Preserve the command's result, with one bounded annotation only on failure.
set +e
set -u
set -o pipefail
if (( $# < 2 )) || [[ ! "$1" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Usage: run-with-diagnostics.sh LABEL COMMAND [ARG ...]" >&2
  exit 2
fi
label=$1
shift
log=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/${label}.XXXXXX") || exit 1
trap 'rm -f -- "$log"' EXIT

"$@" 2>&1 | tee "$log"
statuses=("${PIPESTATUS[@]}")
status=${statuses[0]}
# A logging failure must not turn a successful command into a green CI step.
if (( status == 0 )); then status=${statuses[1]}; fi
if (( status != 0 )); then
  diagnostic=$(tail -n 25 "$log")
  diagnostic=${diagnostic:0:8000}
  diagnostic=${diagnostic:-No diagnostic output was captured.}
  diagnostic=${diagnostic//'%'/'%25'}
  diagnostic=${diagnostic//$'\r'/'%0D'}
  diagnostic=${diagnostic//$'\n'/'%0A'}
  printf '::error::%s failed (exit %s): %s\n' "$label" "$status" "$diagnostic"
fi
exit "$status"
