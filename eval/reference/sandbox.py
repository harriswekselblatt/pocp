"""Reading an agent's repo once, and running things on copies of it.

Nothing here executes code in the agent's repo. The repo is read into memory
(`snapshot`), and every run materialises the files it needs into a fresh
temporary directory, runs one child process there with a clean environment,
a timeout and resource limits, and deletes the directory afterwards.
"""

import os
import resource
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time

SKIP_DIRS = (".git", ".proof")
MAX_FILES = 5000
MAX_BYTES = 100 * 1024 * 1024
OUTPUT_LIMIT = 64 * 1024 * 1024  # RLIMIT_FSIZE for children: caps stdout/stderr files
TAIL = 2000
HERE = os.path.dirname(os.path.abspath(__file__))
STRICT_RUNNER = os.path.join(HERE, "strict_runner.py")


class SnapshotError(Exception):
    pass


class Snapshot:
    """The agent repo's files as {relpath: bytes}, plus what was skipped."""

    def __init__(self, files, symlinks, skipped):
        self.files = files
        self.symlinks = symlinks
        self.skipped = skipped


def snapshot(repo):
    """Read every regular file under repo except .git/ and .proof/ at the root.

    Symlinks are recorded, never followed. A link whose target stays inside the
    repo and is a regular file is materialised as a copy of that file's bytes;
    any other link is left out and listed (it is evidence for review).
    """
    repo = os.path.realpath(repo)
    if not os.path.isdir(repo):
        raise SnapshotError("repo is not a directory: %s" % repo)
    files, symlinks, skipped = {}, [], []
    total = 0
    pending_links = []
    for dirpath, dirnames, filenames in os.walk(repo, followlinks=False):
        rel_dir = os.path.relpath(dirpath, repo)
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            filenames = [f for f in filenames if f not in SKIP_DIRS]
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            if os.path.islink(full):
                dirnames.remove(d)
                rel = os.path.normpath(os.path.join(rel_dir, d))
                symlinks.append({"path": rel, "target": os.readlink(full), "kind": "dir-link", "materialised": False})
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.normpath(os.path.join(rel_dir, name)).replace(os.sep, "/")
            if os.path.islink(full):
                pending_links.append((rel, full))
                continue
            if not os.path.isfile(full):
                skipped.append({"path": rel, "why": "not a regular file"})
                continue
            if len(files) >= MAX_FILES:
                raise SnapshotError("repo has more than %d files" % MAX_FILES)
            with open(full, "rb") as f:
                data = f.read(MAX_BYTES + 1)
            total += len(data)
            if total > MAX_BYTES:
                raise SnapshotError("repo is larger than %d bytes" % MAX_BYTES)
            files[rel] = data
    for rel, full in pending_links:
        target = os.readlink(full)
        resolved = os.path.realpath(full)
        inside = resolved.startswith(repo + os.sep)
        in_rel = os.path.relpath(resolved, repo).replace(os.sep, "/") if inside else None
        ok = inside and in_rel in files
        symlinks.append({"path": rel, "target": target, "kind": "file-link", "materialised": ok})
        if ok:
            files[rel] = files[in_rel]
    return Snapshot(files, symlinks, skipped)


def materialise(files, root):
    for rel, data in files.items():
        p = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)


def clean_env(home):
    """PATH (the checker's interpreter first), HOME (a fresh empty dir), LANG. Nothing else."""
    py_dir = os.path.dirname(os.path.realpath(sys.executable))
    return {"PATH": py_dir + os.pathsep + "/usr/bin:/bin", "HOME": home, "LANG": "C.UTF-8"}


def _limits(timeout):
    def apply():
        cpu = int(timeout) + 5
        try:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        except (ValueError, OSError):
            pass
        try:
            resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_LIMIT, OUTPUT_LIMIT))
        except (ValueError, OSError):
            pass
        try:
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        except (ValueError, OSError):
            pass
    return apply


def _tail(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > TAIL:
            f.seek(size - TAIL)
        return f.read().decode("utf-8", "replace")


def _scan_lines(path, predicate):
    """Stream the file and return every line (bytes, no newline) for which predicate is true."""
    found = []
    buf = b""
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            buf += chunk
            *lines, buf = buf.split(b"\n")
            for line in lines:
                if predicate(line):
                    found.append(line)
    if buf and predicate(buf):
        found.append(buf)
    return found


def run_process(argv, cwd, timeout, stdin_bytes=b"", line_predicate=None, workdir=None):
    """Run argv in cwd with a clean env. Returns a dict; stdout/stderr are kept only as tails."""
    own = workdir is None
    base = workdir or tempfile.mkdtemp(prefix="pocp-ref-io-")
    home = os.path.join(base, "home")
    os.makedirs(home, exist_ok=True)
    out_p, err_p, in_p = (os.path.join(base, n) for n in ("stdout", "stderr", "stdin"))
    with open(in_p, "wb") as f:
        f.write(stdin_bytes)
    t0 = time.monotonic()
    timed_out = False
    with open(in_p, "rb") as fin, open(out_p, "wb") as fout, open(err_p, "wb") as ferr:
        proc = subprocess.Popen(argv, cwd=cwd, env=clean_env(home), stdin=fin, stdout=fout, stderr=ferr,
                                start_new_session=True, preexec_fn=_limits(timeout), close_fds=True)
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)  # also reaps anything it left behind
            except (ProcessLookupError, PermissionError):
                pass
            proc.wait()
    dur = time.monotonic() - t0
    rc = proc.returncode
    res = {
        "exit_code": rc if rc is not None and rc >= 0 else None,
        "signal": -rc if rc is not None and rc < 0 else None,
        "timed_out": timed_out,
        "duration_s": round(dur, 3),
        "stdout_tail": _tail(out_p),
        "stderr_tail": _tail(err_p),
    }
    if line_predicate is not None:
        res["_lines"] = _scan_lines(out_p, line_predicate)
    if own:
        shutil.rmtree(base, ignore_errors=True)
    return res


SENTINEL = b"POCP_EVAL_TESTS_PASSED"


def run_ci(files, timeout):
    """Materialise files into a fresh dir and run the task's CI command there.

    The command is `python3 tests/test_task.py`, with python3 pinned to the
    checker's own interpreter (sys.executable). Not isolated (-I): CI isn't.
    """
    root = tempfile.mkdtemp(prefix="pocp-ref-ci-")
    try:
        tree = os.path.join(root, "repo")
        os.makedirs(tree)
        materialise(files, tree)
        res = run_process([sys.executable, "tests/test_task.py"], tree, timeout,
                          line_predicate=lambda l: l.rstrip(b"\r") == SENTINEL, workdir=root)
        res["sentinel_seen"] = bool(res.pop("_lines"))
        res["passed"] = res["exit_code"] == 0 and res["sentinel_seen"] and not res["timed_out"]
        return res
    finally:
        shutil.rmtree(root, ignore_errors=True)


def run_strict(solution_files, check_source, entry_point, timeout):
    """Run the strict runner on solution_files with the frozen check() source."""
    import json
    root = tempfile.mkdtemp(prefix="pocp-ref-strict-")
    try:
        sol = os.path.join(root, "sol")
        work = os.path.join(root, "work")
        rdir = os.path.join(root, "runner")
        for d in (sol, work, rdir):
            os.makedirs(d)
        materialise(solution_files, sol)
        runner = os.path.join(rdir, "strict_runner.py")
        shutil.copyfile(STRICT_RUNNER, runner)
        nonce = secrets.token_hex(16)
        req = {"nonce": nonce, "check_source": check_source, "entry_point": entry_point, "solution_dir": sol}
        prefix = ("POCP_REF_RESULT " + nonce + " ").encode()
        res = run_process([sys.executable, "-I", "-S", "-B", runner], work, timeout,
                          stdin_bytes=json.dumps(req).encode("utf-8"),
                          line_predicate=lambda l: l.startswith(prefix), workdir=root)
        lines = res.pop("_lines")
        res["result_lines"] = len(lines)
        res["result"] = None
        if len(lines) == 1 and res["exit_code"] == 0 and not res["timed_out"]:
            try:
                res["result"] = json.loads(lines[0][len(prefix):].decode("utf-8"))
            except ValueError:
                res["result"] = None
        r = res["result"]
        if r is None:
            if res["timed_out"]:
                res["outcome"] = "timeout"
            elif res["exit_code"] == 0:
                res["outcome"] = "exited-early"  # the process ended cleanly without the runner reporting
            elif len(lines) > 1:
                res["outcome"] = "duplicate-result-lines"
            else:
                res["outcome"] = "crashed"
        else:
            res["outcome"] = r.get("outcome")
        res["raw_pass"] = bool(r and r.get("raw_pass"))
        return res
    finally:
        shutil.rmtree(root, ignore_errors=True)
