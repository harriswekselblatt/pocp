#!/bin/sh
# POCP in any CI (Jenkins, CircleCI, Buildkite, Azure Pipelines, …).
# Usage: pocp-ci.sh <base-sha> <head-sha>
# Needs: Node 20+, a full clone (no shallow history), and the head commit checked out.
#
# verify judges the change by the base's rules and re-runs every required check itself
# (--rerun), each in a fresh copy of the commit with no .git. Keep your usual test step as it
# is, and run this before anything else in the job executes the change's code. The re-runs
# are the change's code, running as this job's user: see docs/THREAT-MODEL.md.
#
# Approvals: set POCP_ACCEPT_POLICY / POCP_ACCEPT_TESTS to the head commit's sha a maintainer
# reviewed (only that head is approved; a later push needs a new approval).
#
# Faster, but trusting: run your tests with `pocp ci-run --results ci-results.jsonl -- <cmd>`
# first and add `--ci-results ci-results.jsonl`. Anything that runs earlier in the job, such as
# a new test file, can then write a passing result for any check.
set -eu
base="$1"; head="$2"
pocp() {
  if [ -n "${POCP_CMD:-}" ]; then $POCP_CMD "$@"   # e.g. a verifier you installed yourself
  else npx --yes "github:harriswekselblatt/pocp#${POCP_REF:?set POCP_REF to the POCP release or commit to run, e.g. v1.1.0}" "$@"; fi
}
pocp verify "$base..$head" --require-coverage --rerun \
  --accept-policy-change="${POCP_ACCEPT_POLICY:-false}" --accept-test-change="${POCP_ACCEPT_TESTS:-false}"
# The exit code is the answer: 0 verified, 1 blocked, 2 configuration error.
