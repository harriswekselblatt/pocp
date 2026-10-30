#!/usr/bin/env python3
"""E4: real bug fixes from outside repositories. Applies eval/e4/FRAME.md mechanically.

Imports nothing from POCP (src/, bin/, bench/) and never runs `pocp`; the `pocp history`
comparison is a separate step (history.sh). Standard library only.

  python3 eval/e4/e4.py fetch                    # section 2: frozen/candidates.jsonl
  python3 eval/e4/e4.py sample                   # section 3: frozen/sample.json
  python3 eval/e4/e4.py select --work DIR        # section 4: frozen/selection.json
  python3 eval/e4/e4.py replay --work DIR --out F # section 5: one record per repository
"""
import argparse
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
FROZEN = os.path.join(HERE, "frozen")
SEED = 20261030
LANGUAGES = ["JavaScript", "TypeScript", "Python"]
PER_LANGUAGE = 5
WINDOW = ("2025-10-30", "2026-10-30")
QUERY = "language:{lang} stars:1000..5000 pushed:>=2025-10-30 archived:false fork:false"
INSTALL_LIMIT_S = 15 * 60
TEST_LIMIT_S = 5 * 60
CAP_S = 2 * 60 * 60

FIX_RE = re.compile(r"\b(fix|fixes|fixed|bug|regression)\b", re.I)
CODE_EXT = (".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts")
JS_EXT = "js|jsx|ts|tsx|mjs|cjs|mts|cts"
TEST_NAME = re.compile(r"(^test_.*\.py$|.*_test\.py$|.*\.(test|spec)\.(%s)$)" % JS_EXT)
TEST_DIRS = {"test", "tests", "__tests__", "spec"}
MANIFEST = re.compile(
    r"(^|/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|pyproject\.toml|setup\.py|setup\.cfg"
    r"|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile[^/]*)$"
)


# ---------- section 4 rules (pure, tested) ----------

def is_test_file(path):
    parts = path.split("/")
    return any(p in TEST_DIRS for p in parts[:-1]) or bool(TEST_NAME.match(parts[-1]))


def is_source_file(path):
    return path.endswith(CODE_EXT) and not is_test_file(path)


def eligible(subject, changes):
    """changes: list of (status letter, path). True if the commit meets FRAME section 4 (2-5)."""
    if not FIX_RE.search(subject):
        return False
    if len(changes) > 20:
        return False
    if any(MANIFEST.search(p) for _, p in changes):
        return False
    tests = [p for s, p in changes if s != "D" and is_test_file(p)]
    code = [p for _, p in changes if is_source_file(p)]
    return bool(tests) and bool(code)


def draw(items, seed):
    """One random() per item, in the given order; returns [(value, item)] sorted by value."""
    rng = random.Random(seed)
    return sorted(((rng.random(), it) for it in items), key=lambda x: x[0])


def sample_repos(candidates, seed=SEED, per_language=PER_LANGUAGE):
    ordered = sorted(candidates, key=lambda c: c["full_name"].lower())
    drawn = draw(ordered, seed)
    picked = []
    for lang in LANGUAGES:
        picked += [(v, c) for v, c in drawn if c["language"] == lang][:per_language]
    picked.sort(key=lambda x: x[0])
    return [dict(c, draw=v, position=i) for i, (v, c) in enumerate(picked)]


def pick_commit(commits, position, seed=SEED):
    """commits: eligible commits sorted by (committer time, sha). Smallest draw wins."""
    if not commits:
        return None
    return draw(commits, seed + position)[0][1]


# ---------- helpers ----------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def run(cmd, cwd=None, timeout=None, env=None, shell=False):
    t = time.time()
    try:
        p = subprocess.run(cmd, cwd=cwd, timeout=timeout, env=env, shell=shell, capture_output=True, text=True, errors="replace")
        return {"code": p.returncode, "out": p.stdout[-4000:], "err": p.stderr[-4000:], "s": round(time.time() - t, 1), "timeout": False}
    except subprocess.TimeoutExpired as e:
        return {"code": None, "out": str(e.stdout or "")[-2000:], "err": str(e.stderr or "")[-2000:], "s": round(time.time() - t, 1), "timeout": True}


def git(cwd, *args, timeout=600):
    r = run(["git", *args], cwd=cwd, timeout=timeout)
    if r["code"] != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), r["err"].strip()[-300:]))
    return r["out"]


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- section 2 ----------

def cmd_fetch(_args):
    out = os.path.join(FROZEN, "candidates.jsonl")
    if os.path.exists(out):
        sys.exit("candidates.jsonl already exists; it is frozen")
    rows = []
    for lang in LANGUAGES:
        q = QUERY.format(lang=lang)
        for page in (1, 2, 3):
            url = "https://api.github.com/search/repositories?" + urllib.parse.urlencode(
                {"q": q, "sort": "stars", "order": "desc", "per_page": 100, "page": page})
            req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "pocp-eval-e4"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            fetched = now()
            for rank, it in enumerate(data["items"], start=(page - 1) * 100 + 1):
                rows.append({"full_name": it["full_name"], "language": lang, "rank": rank, "stars": it["stargazers_count"],
                             "pushed_at": it["pushed_at"], "default_branch": it["default_branch"],
                             "archived": it["archived"], "fork": it["fork"], "query": q, "fetched_at": fetched})
            time.sleep(7)  # unauthenticated search: 10 requests a minute
    os.makedirs(FROZEN, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")
    with open(out + ".sha256", "w") as f:
        f.write("%s  candidates.jsonl\n" % sha256_file(out))
    print("%d candidates (%s)" % (len(rows), ", ".join("%s %d" % (l, sum(r["language"] == l for r in rows)) for l in LANGUAGES)))


def load_candidates():
    with open(os.path.join(FROZEN, "candidates.jsonl"), encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


# ---------- section 3 ----------

def cmd_sample(_args):
    out = os.path.join(FROZEN, "sample.json")
    if os.path.exists(out):
        sys.exit("sample.json already exists; it is frozen")
    cands = load_candidates()
    picked = sample_repos(cands)
    write_json(out, {"seed": SEED, "candidates_sha256": sha256_file(os.path.join(FROZEN, "candidates.jsonl")),
                     "rule": "FRAME.md section 3", "repos": [{k: c[k] for k in ("position", "full_name", "language", "stars", "default_branch", "draw")} for c in picked]})
    for c in picked:
        print("%2d %-10s %s" % (c["position"], c["language"], c["full_name"]))


# ---------- section 4 ----------

def clone(full_name, dest, blobless=True):
    if os.path.isdir(os.path.join(dest, ".git")):
        return
    args = ["clone", "-q", "--no-tags"]
    if blobless:
        args.append("--filter=blob:none")
    git(None, *args, "https://github.com/%s.git" % full_name, dest, timeout=1200)


def eligible_commits(repo):
    log = git(repo, "log", "--first-parent", "--no-merges", "--no-renames", "--name-status", "--format=@@%H%x00%ct%x00%P%x00%s",
              "--since=%sT00:00:00Z" % WINDOW[0], "--until=%sT23:59:59Z" % WINDOW[1], "HEAD")
    commits = []
    for block in log.split("@@")[1:]:
        head, _, body = block.partition("\n")
        sha, ct, parents, subject = head.split("\x00", 3)
        if len(parents.split()) != 1:
            continue
        changes = []
        for line in body.splitlines():
            if not line.strip():
                continue
            parts = line.split("\t")
            changes.append((parts[0][0], parts[-1]))
        if eligible(subject, changes):
            commits.append({"sha": sha, "parent": parents.strip(), "committed": int(ct), "subject": subject,
                            "tests": sorted(p for s, p in changes if s != "D" and is_test_file(p)),
                            "source": sorted(p for _, p in changes if is_source_file(p)), "files": len(changes)})
    commits.sort(key=lambda c: (c["committed"], c["sha"]))
    return commits


def cmd_select(args):
    out = os.path.join(FROZEN, "selection.json")
    if os.path.exists(out):
        sys.exit("selection.json already exists; it is frozen")
    with open(os.path.join(FROZEN, "sample.json"), encoding="utf-8") as f:
        sample = json.load(f)
    rows = []
    for r in sample["repos"]:
        dest = os.path.join(args.work, r["full_name"].replace("/", "__"))
        row = {"position": r["position"], "full_name": r["full_name"], "language": r["language"]}
        try:
            clone(r["full_name"], dest)
            row["head"] = git(dest, "rev-parse", "HEAD").strip()
            el = eligible_commits(dest)
            row["eligible"] = len(el)
            pick = pick_commit(el, r["position"])
            if pick:
                row["fix"] = pick
            else:
                row["excluded"] = "no-eligible-fix"
        except Exception as e:  # noqa: BLE001 - recorded, never hidden
            row["excluded"] = "fetch-failed"
            row["detail"] = str(e)[-300:]
        print("%2d %-40s %s" % (r["position"], r["full_name"], row.get("excluded") or "%s (%d eligible)" % (row["fix"]["sha"][:10], row["eligible"])))
        rows.append(row)
    write_json(out, {"seed": SEED, "sample_sha256": sha256_file(os.path.join(FROZEN, "sample.json")), "rule": "FRAME.md section 4",
                     "window": list(WINDOW), "selected_at": now(), "repos": rows})


# ---------- section 5 ----------

def py_setup(repo):
    venv = os.path.join(repo, ".e4-venv")
    py = os.path.join(venv, "bin", "python")
    steps = [[sys.executable, "-m", "venv", venv]]
    extra = None
    text = ""
    for name in ("pyproject.toml", "setup.cfg", "setup.py"):
        p = os.path.join(repo, name)
        if os.path.exists(p):
            text += open(p, encoding="utf-8", errors="replace").read()
    for cand in ("test", "tests", "testing", "dev"):
        if re.search(r"(^|[\s\"'\[])%s\s*(=|\"\s*:|'\s*:)" % cand, text, re.M):
            extra = cand
            break
    has_project = any(os.path.exists(os.path.join(repo, n)) for n in ("pyproject.toml", "setup.py", "setup.cfg"))
    if has_project:
        steps.append([py, "-m", "pip", "install", "-q", "-e", ".[%s]" % extra if extra else "."])
    reqs = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
        rel = os.path.relpath(root, repo)
        for fn in files:
            p = fn if rel == "." else "%s/%s" % (rel, fn)
            if re.fullmatch(r"(requirements[^/]*test[^/]*|requirements-dev[^/]*|test-requirements[^/]*|dev-requirements[^/]*)\.txt", p) or \
               re.fullmatch(r"requirements/(test|tests|dev)[^/]*\.txt", p):
                reqs.append(p)
    for p in sorted(reqs):
        steps.append([py, "-m", "pip", "install", "-q", "-r", p])
    steps.append([py, "-m", "pip", "install", "-q", "pytest"])
    return steps, lambda files: [py, "-m", "pytest", "-q", "-p", "no:cacheprovider", *files], ".", {"extra": extra, "requirements": reqs}


def js_setup(repo, tests):
    def pkg(d):
        p = os.path.join(repo, d, "package.json")
        if not os.path.exists(p):
            return None
        try:
            return json.load(open(p, encoding="utf-8"))
        except ValueError:
            return None

    def runner_of(j):
        deps = {**(j.get("dependencies") or {}), **(j.get("devDependencies") or {})}
        return next((r for r in ("vitest", "jest", "mocha") if r in deps), None)

    folders = set()
    for t in tests:
        d = os.path.dirname(t)
        while d and pkg(d) is None:
            d = os.path.dirname(d)
        folders.add(d)
    if len(folders) != 1:
        return None, "tests span %d package folders" % len(folders)
    folder = folders.pop()
    runner = runner_of(pkg(folder) or {}) or runner_of(pkg("") or {})
    if not runner:
        return None, "no vitest, jest or mocha in %s/package.json or the root's" % (folder or ".")
    if os.path.exists(os.path.join(repo, "package-lock.json")):
        install = ["npm", "ci", "--no-audit", "--no-fund"]
    elif os.path.exists(os.path.join(repo, "pnpm-lock.yaml")):
        install = ["corepack", "pnpm", "install", "--frozen-lockfile"]
    elif os.path.exists(os.path.join(repo, "yarn.lock")):
        berry = os.path.exists(os.path.join(repo, ".yarnrc.yml"))
        install = ["corepack", "yarn", "install", "--immutable" if berry else "--frozen-lockfile"]
    else:
        install = ["npm", "install", "--no-audit", "--no-fund"]
    rel = lambda files: [os.path.relpath(os.path.join(repo, f), os.path.join(repo, folder)) for f in files]
    if runner == "vitest":
        cmd = lambda files: ["npx", "--no-install", "vitest", "run", *rel(files)]
    elif runner == "jest":
        cmd = lambda files: ["npx", "--no-install", "jest", *rel(files)]
    else:
        cmd = lambda files: ["npx", "--no-install", "mocha", *rel(files)]
    return ([install], cmd, folder or ".", {"runner": runner, "install": install[0:3]}), None


def outcome(r):
    return {"exit": r["code"], "timed_out": r["timeout"], "s": r["s"], "tail": (r["out"] + "\n" + r["err"]).strip()[-1500:]}


def replay_one(sel, work):
    fix = sel["fix"]
    repo = os.path.join(work, "replay", sel["full_name"].replace("/", "__"))
    rec = {"tests": fix["tests"]}
    if os.path.exists(repo):
        shutil.rmtree(repo)
    clone(sel["full_name"], repo)
    git(repo, "checkout", "-q", fix["sha"])
    git(repo, "submodule", "update", "--init", "--recursive", "--depth", "1", timeout=1200)
    # No bytecode: the parent side rewrites sources in place, maybe within the same second and
    # at the same size, and Python would then run the fix's cached .pyc.
    env = dict(os.environ, CI="1", FORCE_COLOR="0", NO_COLOR="1", PYTHONDONTWRITEBYTECODE="1")
    if sel["language"] == "Python":
        steps, cmd, folder, info = py_setup(repo)
    else:
        js, why = js_setup(repo, fix["tests"])
        if not js:
            return dict(rec, excluded="unsupported-runner", detail=why)
        steps, cmd, folder, info = js
    rec["setup"] = info
    t0 = time.time()
    for s in steps:
        left = INSTALL_LIMIT_S - (time.time() - t0)
        r = run(s, cwd=repo, timeout=max(1, left), env=env)
        if r["code"] != 0:
            return dict(rec, excluded="install-failed", detail={"step": s[-3:], **outcome(r)})
    rec["install_s"] = round(time.time() - t0, 1)
    argv = cmd(fix["tests"])
    rec["command"] = " ".join(argv[argv.index("-m") + 1:] if "-m" in argv else argv)
    rec["cwd"] = folder
    cwd = os.path.join(repo, folder)
    at_fix = run(argv, cwd=cwd, timeout=TEST_LIMIT_S, env=env)
    if at_fix["timeout"]:
        return dict(rec, excluded="test-timeout", detail={"side": "fix", **outcome(at_fix)})
    rec["at_fix"] = outcome(at_fix)
    # The parent's code with the fix's test files put back.
    git(repo, "checkout", "-q", fix["parent"], "--", ".")
    git(repo, "checkout", "-q", fix["sha"], "--", *fix["tests"])
    for f in fix["source"]:  # a file the fix added doesn't exist at the parent
        if run(["git", "cat-file", "-e", "%s:%s" % (fix["parent"], f)], cwd=repo)["code"] != 0:
            p = os.path.join(repo, f)
            if os.path.exists(p):
                os.remove(p)
    at_parent = run(argv, cwd=cwd, timeout=TEST_LIMIT_S, env=env)
    if at_parent["timeout"]:
        return dict(rec, excluded="test-timeout", detail={"side": "parent", **outcome(at_parent)})
    rec["at_parent"] = outcome(at_parent)
    passed_fix, passed_parent = at_fix["code"] == 0, at_parent["code"] == 0
    rec["verdict"] = "fails-on-fix" if not passed_fix else "does-not-detect" if passed_parent else "confirmed"
    return rec


def cmd_replay(args):
    with open(os.path.join(FROZEN, "selection.json"), encoding="utf-8") as f:
        selection = json.load(f)
    start = time.time()
    batch = args.batch
    for sel in selection["repos"]:
        rec = {"schema": "pocp-eval-run/1", "eval": "E4", "batch": batch, "phase": "pilot",
               "run_id": "%s-%s" % (batch, sel["full_name"].replace("/", "__")),
               "unit": {"repo": sel["full_name"], "language": sel["language"], "position": sel["position"],
                        "commit": (sel.get("fix") or {}).get("sha")},
               "pins": {"frame_sha256": sha256_file(os.path.join(HERE, "FRAME.md")),
                        "selection_sha256": sha256_file(os.path.join(FROZEN, "selection.json")),
                        "checker": "eval/e4/e4.py", "checker_sha256": sha256_file(os.path.abspath(__file__)),
                        "os": "%s %s" % (os.uname().sysname.lower(), os.uname().release), "python": sys.version.split()[0],
                        "node": run(["node", "--version"])["out"].strip()},
               "started_at": now(), "excluded": None, "outcome": {}}
        t = time.time()
        if sel.get("excluded"):
            rec["excluded"] = sel["excluded"]
            rec["outcome"] = {"reference": {"detail": sel.get("detail")}}
        elif time.time() - start > CAP_S:
            rec["excluded"] = "time-cap"
        else:
            try:
                r = replay_one(sel, args.work)
            except Exception as e:  # noqa: BLE001
                r = {"excluded": "fetch-failed", "detail": str(e)[-300:]}
            rec["excluded"] = r.pop("excluded", None)
            rec["outcome"] = {"reference": r}
        rec["status"] = "completed"
        rec["ended_at"] = now()
        rec["duration_s"] = round(time.time() - t, 1)
        with open(args.out, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, sort_keys=True) + "\n")
        ref = rec["outcome"].get("reference", {})
        print("%2d %-40s %s" % (sel["position"], sel["full_name"], rec["excluded"] or ref.get("verdict")), flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    sub.add_parser("sample")
    s = sub.add_parser("select")
    s.add_argument("--work", required=True)
    r = sub.add_parser("replay")
    r.add_argument("--work", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--batch", required=True)
    a = ap.parse_args()
    {"fetch": cmd_fetch, "sample": cmd_sample, "select": cmd_select, "replay": cmd_replay}[a.cmd](a)


if __name__ == "__main__":
    main()
