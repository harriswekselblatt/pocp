#!/bin/sh
# POCP in any CI (Jenkins, CircleCI, Buildkite, Azure Pipelines, …).
# Usage: pocp-ci.sh <base-sha> <head-sha> <test command…>
# Needs: Node 20+, a full clone (no shallow history), and the head commit checked out.
set -eu
: "${POCP_REF:?set POCP_REF to the POCP commit to run (pin it)}"
base="$1"; head="$2"; shift 2
npx --yes "github:harriswekselblatt/pocp#${POCP_REF}" ci-run --results ci-results.jsonl -- "$@"
npx --yes "github:harriswekselblatt/pocp#${POCP_REF}" verify "$base..$head" --require-coverage --rerun-unsigned --ci-results ci-results.jsonl \
  ${POCP_ACCEPT_POLICY:+--accept-policy-change} ${POCP_ACCEPT_TESTS:+--accept-test-change}
# The exit code is the answer: 0 verified, 1 blocked, 2 configuration error.
