"""The strict canonical runner. Executed as a child process, never imported.

    python3 -I -S -B strict_runner.py        (request JSON on stdin)

It imports the solution in one step, then runs the frozen check() in a second
step, and only then reports, on a line tagged with a per-run random nonce that
it received on stdin. The solution never sees the check() source on disk, and
can't predict the nonce, so printing a success line, exiting early, or raising
SystemExit cannot produce a pass. See README.md, "The strict runner".

Self-contained on purpose: under -I the script's directory isn't on sys.path.
"""

import ast
import builtins
import hashlib
import json
import os
import sys
import traceback

# References taken before any agent code runs.
_write = os.write
_exit = os._exit
_dumps = json.dumps
_sha = hashlib.sha256
_isinstance = isinstance
_type = type
_repr = repr
_len = len
_BaseException = BaseException

PLAIN_TYPES = (int, float, str, bool, bytes, complex, type(None), list, tuple, dict, set, frozenset)
MAX_CALL_RECORDS = 10000


def _plain(value, depth=0, seen=None):
    """True when value is built only from exact built-in types (type(x) is T)."""
    if depth > 50:
        return False
    t = _type(value)
    if not any(t is p for p in PLAIN_TYPES):
        return False
    if t in (list, tuple, set, frozenset):
        seen = seen or set()
        if id(value) in seen:
            return True
        seen.add(id(value))
        return all(_plain(v, depth + 1, seen) for v in value)
    if t is dict:
        seen = seen or set()
        if id(value) in seen:
            return True
        seen.add(id(value))
        return all(_plain(k, depth + 1, seen) and _plain(v, depth + 1, seen) for k, v in value.items())
    return True


def _digest(value):
    try:
        return _sha(_repr(value).encode("utf-8", "backslashreplace")).hexdigest()[:16]
    except _BaseException as e:  # a hostile __repr__
        return "repr-error:" + _type(e).__name__


def _describe_exc(e):
    try:
        tb = traceback.extract_tb(e.__traceback__)
    except _BaseException:
        tb = []
    where = None
    for fr in tb:
        if fr.filename == "<canonical-check>":
            where = fr.lineno
    msg = ""
    try:
        msg = str(e)[:300]
    except _BaseException:
        msg = "<unprintable>"
    out = {"type": _type(e).__name__, "message": msg, "check_line": where}
    if _isinstance(e, SystemExit):
        out["exit_code"] = _repr(e.code)[:50]
    return out


def main():
    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    out_fd = os.dup(1)
    nonce = req.pop("nonce")
    result = {"phase": "start"}

    def report():
        line = "\nPOCP_REF_RESULT " + nonce + " " + _dumps(result, sort_keys=True) + "\n"
        data = line.encode("utf-8")
        while data:
            n = _write(out_fd, data)
            data = data[n:]
        _exit(0)

    # Build the instrumented check() before agent code runs.
    try:
        tree = ast.parse(req["check_source"], "<canonical-check>")
    except SyntaxError as e:
        result.update(phase="parse", outcome="check-syntax-error", detail=str(e)[:300])
        report()
    fn = None
    for node in tree.body:
        if _isinstance(node, ast.FunctionDef) and node.name == "check":
            fn = node
    if fn is None:
        result.update(phase="parse", outcome="check-not-defined")
        report()
    n_stmts = _len(fn.body)
    new_body = []
    for i, stmt in enumerate(fn.body):
        hit = ast.Expr(ast.Call(ast.Name("__pocp_ref_hit__", ast.Load()), [ast.Constant(i)], []))
        ast.copy_location(hit, stmt)
        ast.fix_missing_locations(hit)
        new_body.append(hit)
        new_body.append(stmt)
    fn.body = new_body
    code = compile(tree, "<canonical-check>", "exec")

    hits = []
    calls = []
    by_args = {}
    type_violations = []
    eq_probe_true = []

    def hit(i):
        hits.append(i)

    builtins_saved = dict(vars(builtins))
    trace_before = (sys.gettrace(), sys.getprofile())

    def restore():
        """Record what agent code changed in builtins and the trace hooks, then undo it,
        so the runner's own reporting (tracebacks, json) runs on an intact interpreter
        whatever the Python version uses internally."""
        current = vars(builtins)
        changed = sorted(k for k in set(builtins_saved) | set(current)
                         if k not in builtins_saved or k not in current or current[k] is not builtins_saved[k])
        hooked = (sys.gettrace(), sys.getprofile()) != trace_before
        sys.settrace(None)
        sys.setprofile(None)
        for k in [k for k in current if k not in builtins_saved]:
            del current[k]
        current.update(builtins_saved)
        out = []
        if changed:
            out.append("builtins-modified:" + ",".join(changed[:20]))
        if hooked:
            out.append("trace-or-profile-hook-installed")
        return out

    # Step 1: import the solution (appended to sys.path: stdlib can't be shadowed).
    sys.path.append(req["solution_dir"])
    result["phase"] = "import"
    try:
        import importlib
        mod = importlib.import_module("solution")
    except _BaseException as e:
        tamper = restore()
        result.update(outcome="import-error", error=_describe_exc(e), tamper=tamper)
        if _isinstance(e, ModuleNotFoundError):
            result["missing_module"] = e.name
        report()
    ep = getattr(mod, req["entry_point"], None)
    if not callable(ep):
        result.update(outcome="entry-point-missing")
        report()

    def candidate(*args, **kwargs):
        key = _digest((args, kwargs))
        r = ep(*args, **kwargs)
        plain = _plain(r)
        rd = _digest(r)
        if _len(calls) < MAX_CALL_RECORDS:
            calls.append({"args": key, "result": rd, "plain": plain})
        by_args.setdefault(key, set()).add(rd)
        if not plain:
            type_violations.append({"args": key, "type": _type(r).__name__})
            try:
                if r == object():
                    eq_probe_true.append(_type(r).__name__)
            except _BaseException:
                pass
        return r

    # Step 2: run the frozen check() in a fresh namespace.
    result["phase"] = "check"
    ns = {"__name__": "canonical_check", "__builtins__": builtins, "__pocp_ref_hit__": hit}
    exc = None
    try:
        exec(code, ns)
        ns["check"](candidate)
        outcome = "returned"
    except _BaseException as e:
        outcome = "raised"
        exc = e

    # Step 3: verify (on restored builtins), then report.
    result["phase"] = "verify"
    tamper = restore()
    error = _describe_exc(exc) if exc is not None else None
    all_hit = hits == list(range(n_stmts))
    nondeterministic = sorted(k for k, v in by_args.items() if _len(v) > 1)
    result.update(
        outcome=outcome,
        error=error,
        statements=n_stmts,
        statements_hit=_len(hits),
        all_statements_hit_in_order=all_hit,
        raw_pass=(outcome == "returned" and all_hit),
        calls=_len(calls),
        nondeterministic_args=nondeterministic[:20],
        type_violations=type_violations[:20],
        eq_override=sorted(set(eq_probe_true)),
        tamper=tamper,
    )
    report()


if __name__ == "__main__":
    main()
