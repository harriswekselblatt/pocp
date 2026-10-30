#!/bin/sh
# E3 end to end: enumerate → Stryker → POCP corpus replay → POCP's own operators →
# re-run disagreements once → records and RESULTS.md. Every step's command is printed.
#
#   STRYKER_DIR=<dir where `npm i @stryker-mutator/core@9.6.1` ran> [N=100] [SEED=20261028] [JOBS=4] [PARALLEL=1] [BATCH=...] eval/e3/run.sh
#
# Runs on a scratch clone of the current HEAD, so the working tree is never mutated.
set -eu
REPO=$(cd "$(dirname "$0")/../.." && pwd)
: "${STRYKER_DIR:?set STRYKER_DIR to a directory with @stryker-mutator/core installed (outside this repo)}"
N=${N:-100}
SEED=${SEED:-20261028}
JOBS=${JOBS:-4}
COMMIT=$(git -C "$REPO" rev-parse HEAD)
BATCH=${BATCH:-$(date -u +%Y-%m-%d)-e3-pilot-01}
RAW="$REPO/eval/results/E3/$BATCH"
WORK=${WORK:-$(mktemp -d)}
CLONE="$WORK/pocp"
STRYKER_VERSION=$(node -p "require('$STRYKER_DIR/node_modules/@stryker-mutator/core/package.json').version")

run() { echo "+ $*" >&2; "$@"; }
now() { node -e 'console.log(new Date().toISOString())'; }

mkdir -p "$RAW"
[ -d "$CLONE" ] || { run git clone -q "$REPO" "$CLONE"; run git -C "$CLONE" checkout -q "$COMMIT"; }
STARTED=$(now)

run node "$REPO/eval/e3/enumerate.js" --stryker "$STRYKER_DIR" --root "$CLONE" --n "$N" --seed "$SEED" --out "$RAW"

# PARALLEL=1 runs Stryker and the POCP replay at the same time (same load on both paths).
stryker_step() { t0=$(date +%s); run node "$REPO/eval/e3/run-stryker.js" --stryker "$STRYKER_DIR" --clone "$CLONE" --sample "$RAW/sample.json" --out "$RAW/stryker-report.json" --concurrency "$JOBS" || true; echo $(( $(date +%s) - t0 )) > "$RAW/.s_dur"; }
pocp_step() { t0=$(date +%s); run node "$REPO/eval/e3/run-pocp.js" --clone "$CLONE" --sample "$RAW/sample.json" --out "$RAW" --jobs "$JOBS" --name pocp-eval || true; echo $(( $(date +%s) - t0 )) > "$RAW/.p_dur"; }
if [ "${PARALLEL:-0}" = 1 ]; then stryker_step & pocp_step; wait; else stryker_step; pocp_step; fi
S_DUR=$(cat "$RAW/.s_dur"); P_DUR=$(cat "$RAW/.p_dur"); rm -f "$RAW/.s_dur" "$RAW/.p_dur"

t=$(date +%s)
(cd "$CLONE" && run node bin/pocp.js eval --mutants "$N" --seed "$SEED" --jobs "$JOBS" --save "$RAW/pocp-own.json") || true
O_DUR=$(( $(date +%s) - t ))

write_meta() {
  node -e '
    const [raw, commit, ver, sJobs, pJobs, started, sDur, pDur, oDur, srDur, prDur] = process.argv.slice(1);
    const os = require("os"); const fs = require("fs");
    const prev = fs.existsSync(raw + "/meta.json") ? JSON.parse(fs.readFileSync(raw + "/meta.json", "utf8")) : {};
    let sm = {}; try { sm = JSON.parse(fs.readFileSync(raw + "/stryker-report.json.meta.json", "utf8")); } catch {}
    const meta = { ...prev, pocp_commit: commit, stryker_version: ver, stryker_concurrency: Number(sJobs), pocp_jobs: Number(pJobs),
      started_at: prev.started_at || started, ended_at: new Date().toISOString(),
      stryker_duration_s: Number(sDur) || prev.stryker_duration_s, pocp_duration_s: Number(pDur) || prev.pocp_duration_s, own_duration_s: Number(oDur) || prev.own_duration_s,
      stryker_rerun_duration_s: srDur ? Number(srDur) : prev.stryker_rerun_duration_s ?? null, pocp_rerun_duration_s: prDur ? Number(prDur) : prev.pocp_rerun_duration_s ?? null,
      stryker_timeout_s: sm.timeout_s ?? null, stryker_dry_run_net_ms: sm.dry_run_net_ms ?? null,
      parallel: process.env.PARALLEL === "1", load_end: os.loadavg().map(x => Math.round(x)),
      os: os.platform() + " " + os.release(), cpus: os.cpus().length, node: process.version };
    fs.writeFileSync(raw + "/meta.json", JSON.stringify(meta, null, 2) + "\n");
  ' "$@"
}
VERIFIER=$(node -e "import('$REPO/eval/lib/pins.js').then(p => console.log(p.verifierHash('$CLONE')))")
write_meta "$RAW" "$COMMIT" "$STRYKER_VERSION" "$JOBS" "$JOBS" "$STARTED" "$S_DUR" "$P_DUR" "$O_DUR" "" ""
node -e "const f='$RAW/meta.json';const m=JSON.parse(require('fs').readFileSync(f));m.pocp_verifier_sha256='$VERIFIER';require('fs').writeFileSync(f,JSON.stringify(m,null,2)+'\n')"

# Re-run every disagreement once, on both paths.
run node "$REPO/eval/e3/report.js" --raw "$RAW" --batch "$BATCH" --clone "$CLONE" --disagreements "$RAW/disagreements.json"
if [ "$(node -p "require('$RAW/disagreements.json').length")" -gt 0 ]; then
  t=$(date +%s)
  run node "$REPO/eval/e3/run-stryker.js" --stryker "$STRYKER_DIR" --clone "$CLONE" --sample "$RAW/sample.json" --only "$RAW/disagreements.json" --out "$RAW/stryker-rerun.json" --concurrency "$JOBS" || true
  SR_DUR=$(( $(date +%s) - t ))
  t=$(date +%s)
  run node "$REPO/eval/e3/run-pocp.js" --clone "$CLONE" --sample "$RAW/sample.json" --only "$RAW/disagreements.json" --out "$RAW" --jobs "$JOBS" --name pocp-rerun || true
  PR_DUR=$(( $(date +%s) - t ))
  write_meta "$RAW" "$COMMIT" "$STRYKER_VERSION" "$JOBS" "$JOBS" "$STARTED" "$S_DUR" "$P_DUR" "$O_DUR" "$SR_DUR" "$PR_DUR"
fi

run node "$REPO/eval/e3/report.js" --raw "$RAW" --batch "$BATCH" --clone "$CLONE"
echo "raw: $RAW · clone kept at $CLONE"
