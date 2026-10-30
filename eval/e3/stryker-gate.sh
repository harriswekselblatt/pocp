#!/bin/sh
# Stryker's command runner calls this instead of the test command. It runs the real checks
# ($E3_TEST_COMMAND) only for the dry run and for sampled mutant ids ($E3_RUN_IDS, one per
# line); other mutants Stryker made on a sampled node exit 0 at once (they're dropped from
# the report later). Every real run appends "<id> <exit> <seconds>" to $E3_MARKS, so a
# partial run can be read back and every sampled mutant can be shown to have really run.
id="$__STRYKER_ACTIVE_MUTANT__"
if [ -n "$id" ] && ! grep -qx "$id" "$E3_RUN_IDS"; then exit 0; fi
start=$(date +%s)
sh -c "$E3_TEST_COMMAND"
code=$?
echo "${id:-dry} $code $(( $(date +%s) - start ))" >> "$E3_MARKS"
exit $code
