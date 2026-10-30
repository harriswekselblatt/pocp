"""Per-task self-check for the frozen ImpossibleBench LiveCodeBench tasks.

Run by freeze.py on every row; its results go into MANIFEST.json. A task that
fails is listed as a `dataset-task-broken` *candidate* (PREREG section 3). It is
never dropped: the decision to exclude is made, and reported, by the analysis.

Checks:
- every field is present and a string;
- `prompt` parses and defines `entry_point` at top level;
- `test` and `original_test` parse and define `check(candidate)` at top level;
- the row's `impossible_type` matches its split; in the `original` split,
  `test` equals `original_test`;
- for `conflicting` and `oneoff`: the structural diff between the statements
  of `check` in `original_test` and in `test` (which asserts were added,
  changed or removed). An empty diff means the task isn't impossible at all.

Notes (informational, not breakage): whether each conflicting task has a
"conflict witness" (the same call asserted equal to two different values) and
whether each oneoff task changed the expected value of an existing call.
"""

import ast
import difflib
import hashlib

FIELDS = ("task_id", "prompt", "test", "original_test", "impossible_type", "entry_point")
IMPOSSIBLE_SPLITS = ("conflicting", "oneoff")
SRC_LIMIT = 400


def _clip(src):
    if src is None:
        return None
    if len(src) <= SRC_LIMIT:
        return src
    return src[:SRC_LIMIT] + "...(+%d chars, sha256 %s)" % (
        len(src) - SRC_LIMIT, hashlib.sha256(src.encode("utf-8")).hexdigest()[:16])


def _parse(src, label, problems):
    try:
        return ast.parse(src)
    except SyntaxError as e:
        problems.append("%s-syntax-error: line %s: %s" % (label, e.lineno, e.msg))
        return None


def find_check(tree):
    """The last top-level `def check` (the one a module actually binds)."""
    found = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "check":
            found = node
    return found


def _check_fn(tree, label, problems):
    fn = find_check(tree)
    if fn is None:
        problems.append("%s-no-check-function" % label)
        return None
    a = fn.args
    if len(a.args) != 1 or a.vararg or a.kwarg or a.kwonlyargs or a.posonlyargs:
        problems.append("%s-check-signature: expected check(candidate)" % label)
    return fn


def _stmt_key(node):
    return ast.dump(node, annotate_fields=True, include_attributes=False)


def _call_key(node):
    """For `assert <call> == <value>`, the dump of <call>; else None."""
    if isinstance(node, ast.Assert) and isinstance(node.test, ast.Compare) \
            and len(node.test.ops) == 1 and isinstance(node.test.ops[0], ast.Eq):
        return ast.dump(node.test.left, include_attributes=False)
    return None


def _expected_key(node):
    if _call_key(node) is None:
        return None
    return ast.dump(node.test.comparators[0], include_attributes=False)


def structural_diff(original_src, test_src):
    """Statement-level diff of check()'s body: original_test -> test."""
    o_tree, t_tree = ast.parse(original_src), ast.parse(test_src)
    o_fn, t_fn = find_check(o_tree), find_check(t_tree)
    o_body, t_body = o_fn.body, t_fn.body
    o_keys = [_stmt_key(s) for s in o_body]
    t_keys = [_stmt_key(s) for s in t_body]
    out = []

    def entry(op, t_node=None, o_node=None):
        return {
            "op": op,
            "test_line": t_node.lineno if t_node is not None else None,
            "test_src": _clip(ast.get_source_segment(test_src, t_node)) if t_node is not None else None,
            "original_line": o_node.lineno if o_node is not None else None,
            "original_src": _clip(ast.get_source_segment(original_src, o_node)) if o_node is not None else None,
        }

    sm = difflib.SequenceMatcher(a=o_keys, b=t_keys, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        olds, news = o_body[i1:i2], t_body[j1:j2]
        if tag == "replace":
            for k in range(max(len(olds), len(news))):
                o = olds[k] if k < len(olds) else None
                t = news[k] if k < len(news) else None
                op = "changed" if (o is not None and t is not None) else ("added" if o is None else "removed")
                out.append(entry(op, t, o))
        elif tag == "insert":
            out.extend(entry("added", t, None) for t in news)
        elif tag == "delete":
            out.extend(entry("removed", None, o) for o in olds)
    return out, t_body


def _notes(split, diff, t_body):
    notes = []
    calls = {}
    for s in t_body:
        ck = _call_key(s)
        if ck is not None:
            calls.setdefault(ck, set()).add(_expected_key(s))
    contradictory = sum(1 for v in calls.values() if len(v) > 1)
    if split == "conflicting":
        if contradictory == 0:
            notes.append("no-conflict-witness: no call is asserted equal to two different values")
    if split == "oneoff":
        if not any(d["op"] == "changed" for d in diff):
            notes.append("no-changed-assert: no existing assert was modified")
    return notes, contradictory


def check_task(row, split):
    problems, notes = [], []
    for f in FIELDS:
        if not isinstance(row.get(f), str):
            problems.append("field-missing-or-not-string: %s" % f)
    if problems:
        return {"ok": False, "problems": problems, "notes": notes, "conflict_asserts": None}

    ep = row["entry_point"]
    p_tree = _parse(row["prompt"], "prompt", problems)
    if p_tree is not None:
        defs = [n.name for n in p_tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
        if ep not in defs:
            problems.append("entry-point-not-defined-in-prompt: %s" % ep)
    if not ep.isidentifier():
        problems.append("entry-point-not-identifier")

    t_tree = _parse(row["test"], "test", problems)
    o_tree = _parse(row["original_test"], "original-test", problems)
    t_fn = _check_fn(t_tree, "test", problems) if t_tree is not None else None
    o_fn = _check_fn(o_tree, "original-test", problems) if o_tree is not None else None

    if row["impossible_type"] != split:
        problems.append("impossible-type-mismatch: %r in split %r" % (row["impossible_type"], split))

    diff = None
    if split == "original":
        if row["test"] != row["original_test"]:
            problems.append("original-split-test-differs-from-original_test")
    elif t_fn is not None and o_fn is not None:
        diff, t_body = structural_diff(row["original_test"], row["test"])
        if not diff:
            problems.append("no-structural-change: test has the same check() statements as original_test")
        else:
            n, _ = _notes(split, diff, t_body)
            notes.extend(n)
    return {"ok": not problems, "problems": problems, "notes": notes, "conflict_asserts": diff}


def check_split(rows, split):
    """Return {task_id: result} for every row, in task_id order."""
    return {r["task_id"]: check_task(r, split) for r in sorted(rows, key=lambda r: r["task_id"])}
