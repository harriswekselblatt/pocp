#!/usr/bin/env python3
"""Run the reference checker on fixture task repos whose correct label is known.

    python3 eval/reference/canaries.py [--json] [--jobs N] [--only NAME ...]

Each canary is eval/reference/canaries/<name>/: canary.json (task, mode, the
expected label/kind/subkind) and files/ (overlaid on the rendered task repo).
A canary repo is built the way the harness builds one: render the frozen task
(taskrepo.py), commit it, overlay the agent's files, commit again. Then
check.py runs on it as a separate process, exactly as harnesses call it.

Exit 0 when every canary gets its expected result, 1 otherwise. The E1/E2
harness runs this before every counted batch (eval/README.md rule 7).
"""

import argparse
import concurrent.futures
import json
import os
import py_compile
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CANARIES = os.path.join(HERE, "canaries")
FROZEN = os.path.join(os.path.dirname(HERE), "tasks", "frozen")
sys.path.insert(0, HERE)

import taskrepo  # noqa: E402

GIT_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
           "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z"}


def git(repo, *args):
    subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=canary",
                    "-c", "user.email=canary@invalid", "-c", "commit.gpgsign=false", "-C", repo] + list(args),
                   env=GIT_ENV, check=True, capture_output=True)


def load(name):
    with open(os.path.join(CANARIES, name, "canary.json"), encoding="utf-8") as f:
        return json.load(f)


def names():
    return sorted(n for n in os.listdir(CANARIES) if os.path.isfile(os.path.join(CANARIES, n, "canary.json")))


def build(name, dest):
    """Build canary `name` as a git repo at dest. Returns its spec."""
    spec = load(name)
    task_file = os.path.join(FROZEN, spec["task_file"])
    task, _ = taskrepo.load_task(task_file, spec["task_id"])
    os.makedirs(dest)
    taskrepo.write_repo(task, spec["mode"], dest)
    use_git = shutil.which("git", path=GIT_ENV["PATH"]) is not None
    if use_git:
        git(dest, "init", "-q")
        git(dest, "add", "-A")
        git(dest, "commit", "-q", "-m", "task")
    src = os.path.join(CANARIES, name, "files")
    if os.path.isdir(src):
        for dirpath, _, filenames in os.walk(src):
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, src)
                out = os.path.join(dest, rel)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                shutil.copyfile(full, out)
    pyc = spec.get("build", {}).get("pyc")
    if pyc:
        # An unchecked-hash .pyc for `for`, compiled from `source`. Python loads it
        # without comparing it to the source file, for the running interpreter's tag.
        # The path is spelled out rather than taken from importlib.util.cache_from_source,
        # which honours sys.pycache_prefix (set by Apple's /usr/bin/python3, for one).
        target = os.path.join(dest, pyc["for"])
        stem = os.path.splitext(os.path.basename(target))[0]
        cfile = os.path.join(os.path.dirname(target), "__pycache__",
                             "%s.%s.pyc" % (stem, sys.implementation.cache_tag))
        os.makedirs(os.path.dirname(cfile), exist_ok=True)
        py_compile.compile(os.path.join(dest, pyc["source"]), cfile=cfile, dfile=target, doraise=True,
                           invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
        if pyc.get("remove_source"):
            os.remove(os.path.join(dest, pyc["source"]))
    if use_git:
        git(dest, "add", "-A", "-f")
        git(dest, "commit", "-q", "--allow-empty", "-m", "agent")
    spec["task_path"] = task_file
    return spec


def unmet_requirements(spec):
    """Facts about the interpreter that a canary's attack depends on.

    The checker replays CI with this same interpreter, so if a requirement fails the
    attack can't work here and the canary would fail for a reason unrelated to the
    checker. It still fails (never silently skipped), with this message.
    """
    req = spec.get("requires", {})
    out = []
    if req.get("no_pycache_prefix") and getattr(sys, "pycache_prefix", None):
        out.append("this Python has sys.pycache_prefix=%r, so it never reads __pycache__ in the repo"
                   % sys.pycache_prefix)
    mod = req.get("not_preloaded")
    if mod:
        env = {"PATH": os.path.dirname(os.path.realpath(sys.executable)) + ":/usr/bin:/bin",
               "HOME": tempfile.gettempdir(), "LANG": "C.UTF-8"}
        p = subprocess.run([sys.executable, "-c", "import sys; print(%r in sys.modules)" % mod],
                           env=env, capture_output=True, timeout=60)
        if p.stdout.strip() != b"False":
            out.append("this Python imports %s at startup (site, sitecustomize or a .pth file), so a "
                       "repo-level %s.py can't shadow it" % (mod, mod))
    return out


def run_checker(spec, repo, timeout=None):
    cmd = [sys.executable, os.path.join(HERE, "check.py"), "--task", spec["task_path"], "--task-id", spec["task_id"],
           "--mode", spec["mode"], "--repo", repo, "--json"]
    if timeout:
        cmd += ["--timeout", str(timeout)]
    p = subprocess.run(cmd, capture_output=True, timeout=1800)
    try:
        return json.loads(p.stdout.decode("utf-8"))
    except ValueError:
        return {"label": "ERROR", "kind": None,
                "evidence": {"stdout": p.stdout.decode()[-500:], "stderr": p.stderr.decode()[-1500:]}}


def matches(spec, result):
    exp = spec["expect"]
    if result.get("label") != exp["label"] or result.get("kind") != exp.get("kind"):
        return False
    if "subkind" in exp and result.get("evidence", {}).get("subkind") != exp["subkind"]:
        return False
    return True


def run_one(name):
    tmp = tempfile.mkdtemp(prefix="pocp-ref-canary-")
    try:
        repo = os.path.join(tmp, "repo")
        spec = build(name, repo)
        unmet = unmet_requirements(spec)
        if unmet:
            return spec, {"label": "UNMET-REQUIREMENT", "kind": None, "evidence": {"reason": "; ".join(unmet)}}
        result = run_checker(spec, repo)
        return spec, result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run the reference checker's canaries.")
    ap.add_argument("--json", action="store_true", help="print one JSON summary object")
    ap.add_argument("--only", nargs="*", help="run only these canaries")
    ap.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1), help="canaries run in parallel")
    a = ap.parse_args(argv)
    todo = a.only or names()
    rows, failed = [], 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
        results = list(pool.map(run_one, todo))
    for name, (spec, result) in zip(todo, results):
        ok = matches(spec, result)
        failed += not ok
        got = "%s/%s%s" % (result.get("label"), result.get("kind"),
                           (" (" + str(result.get("evidence", {}).get("subkind")) + ")")
                           if result.get("evidence", {}).get("subkind") else "")
        exp = spec["expect"]
        want = "%s/%s%s" % (exp["label"], exp.get("kind"), " (" + exp["subkind"] + ")" if "subkind" in exp else "")
        rows.append({"canary": name, "ok": ok, "expected": want, "got": got,
                     "reason": result.get("evidence", {}).get("reason") or result.get("evidence")})
        if not a.json:
            print("%s  %-45s expected %-40s got %s" % ("ok  " if ok else "FAIL", name, want, got))
            if not ok:
                print("      " + json.dumps(rows[-1]["reason"])[:1500])
    if a.json:
        print(json.dumps({"passed": failed == 0, "total": len(todo), "failed": failed, "canaries": rows}))
    else:
        print("%d/%d canaries ok" % (len(todo) - failed, len(todo)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
