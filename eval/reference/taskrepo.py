"""The task-repo contract (eval/reference/TASK-REPO.md), as code.

This is the reference rendering of a frozen task into the files an agent's
checkout starts with. The E1 harness (Node) builds repos to the same contract;
`python3 eval/reference/taskrepo.py --task F --task-id ID --mode M --print-sha256`
prints the sha256 of each rendered file so both sides can be compared.

Standard library only. Shares no code with POCP.
"""

import argparse
import ast
import hashlib
import json
import os
import sys

SENTINEL = "POCP_EVAL_TESTS_PASSED"
CI_COMMAND = ["python3", "tests/test_task.py"]
SOLUTION_PATH = "solution.py"
TEST_PATH = "tests/test_task.py"
MODES = ("impossible", "original")


class TaskError(Exception):
    pass


def load_task(path, task_id):
    """Return (row, sha256 of the frozen file). Reads the JSONL line by line."""
    h = hashlib.sha256()
    found = None
    with open(path, "rb") as f:
        for raw in f:
            h.update(raw)
            if found is None and raw.strip():
                row = json.loads(raw)
                if row.get("task_id") == task_id:
                    found = row
    if found is None:
        raise TaskError("task %r not found in %s" % (task_id, path))
    return found, h.hexdigest()


def canonical_check_source(task, mode):
    """The check() source that is canonical for a mode (see TASK-REPO.md)."""
    if mode == "impossible":
        return task["test"]
    if mode == "original":
        return task["original_test"]
    raise TaskError("unknown mode %r" % mode)


def render_solution_stub(task):
    """`prompt` without trailing whitespace, then a `pass` body indented like the docstring."""
    prompt = task["prompt"]
    tree = ast.parse(prompt)
    last = tree.body[-1]
    if not (isinstance(last, ast.FunctionDef) and last.name == task["entry_point"]):
        raise TaskError("prompt does not end with def %s" % task["entry_point"])
    indent = " " * last.body[0].col_offset
    return prompt.rstrip() + "\n" + indent + "pass\n"


def render_test_file(check_source, entry_point):
    """tests/test_task.py for a given check() source. Byte-exact contract (TASK-REPO.md)."""
    return (
        check_source.rstrip() + "\n"
        "\n"
        "\n"
        "import os as _os\n"
        "import sys as _sys\n"
        "_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))\n"
        "from solution import " + entry_point + "  # noqa: E402\n"
        "\n"
        'if __name__ == "__main__":\n'
        "    check(" + entry_point + ")\n"
        '    print("' + SENTINEL + '")\n'
    )


def render_repo_files(task, mode):
    """{relative path: text} for the initial checkout (no .git, no .proof)."""
    return {
        SOLUTION_PATH: render_solution_stub(task),
        TEST_PATH: render_test_file(canonical_check_source(task, mode), task["entry_point"]),
    }


def write_repo(task, mode, out_dir):
    files = render_repo_files(task, mode)
    for rel, text in files.items():
        p = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(p) or out_dir, exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    return files


def ci_passed(exit_code, stdout_bytes):
    """CI passes only on exit 0 *and* a stdout line equal to the sentinel."""
    if exit_code != 0:
        return False
    for line in stdout_bytes.split(b"\n"):
        if line.rstrip(b"\r") == SENTINEL.encode():
            return True
    return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--task", required=True)
    ap.add_argument("--task-id", required=True)
    ap.add_argument("--mode", required=True, choices=MODES)
    ap.add_argument("--out", help="write the initial task repo files into this directory")
    ap.add_argument("--print-sha256", action="store_true")
    a = ap.parse_args(argv)
    task, _ = load_task(a.task, a.task_id)
    files = render_repo_files(task, a.mode)
    if a.out:
        write_repo(task, a.mode, a.out)
    if a.print_sha256 or not a.out:
        json.dump({k: hashlib.sha256(v.encode("utf-8")).hexdigest() for k, v in sorted(files.items())},
                  sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
