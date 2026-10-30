#!/bin/sh
# Every eval/ test: Node harnesses and the Python reference checker and task freezer.
# Runs every suite even when one fails, then exits non-zero if any did, so CI shows them all.
cd "$(dirname "$0")/.."
status=0
files=$(ls eval/lib/test/*.test.js eval/e1/test/*.test.js eval/e3/test/*.test.js eval/e4/test/*.test.js eval/e5/test/*.test.js 2>/dev/null || true)
if [ -n "$files" ]; then
  node --test $files || status=1
fi
for d in eval/reference eval/tasks eval/e4; do
  if ls "$d"/test_*.py >/dev/null 2>&1; then
    python3 -m unittest discover -s "$d" -p 'test_*.py' || status=1
  fi
done
exit $status
