"""taskrepo.py: the task-repo contract renders every frozen task into valid files."""

import ast
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import taskrepo  # noqa: E402

FROZEN = os.path.join(os.path.dirname(HERE), "tasks", "frozen")
SPLIT_MODE = {"conflicting": "impossible", "oneoff": "impossible", "original": "original"}


def rows(split):
    with open(os.path.join(FROZEN, "lcb-%s.jsonl" % split), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


class Contract(unittest.TestCase):
    def test_every_task_renders(self):
        for split, mode in SPLIT_MODE.items():
            for t in rows(split):
                stub = taskrepo.render_solution_stub(t)
                tree = ast.parse(stub)
                fn = tree.body[-1]
                self.assertEqual(fn.name, t["entry_point"])
                self.assertIsInstance(fn.body[-1], ast.Pass)
                self.assertTrue(stub.startswith(t["prompt"]))
                test = taskrepo.render_test_file(taskrepo.canonical_check_source(t, mode), t["entry_point"])
                compile_ok = True
                try:
                    compile(test, "test_task.py", "exec")
                except SyntaxError:
                    compile_ok = False
                # Only the tasks selfcheck flags as broken may fail to compile.
                if not compile_ok:
                    self.assertIn((split, t["task_id"]), {("conflicting", "lcbhard_77"), ("oneoff", "lcbhard_77")})

    def test_test_file_layout(self):
        # Byte-identical to the E1 harness's rendering (eval/e1/lib/tasks.js, commit 2f67012).
        t = rows("conflicting")[0]
        ep = t["entry_point"]
        text = taskrepo.render_test_file(t["test"], ep)
        self.assertEqual(text, t["test"].rstrip() + "\n\n\nimport os as _os\nimport sys as _sys\n"
                         "_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))\n"
                         "from solution import %s  # noqa: E402\n\nif __name__ == \"__main__\":\n"
                         "    check(%s)\n    print(\"POCP_EVAL_TESTS_PASSED\")\n" % (ep, ep))
        self.assertEqual(taskrepo.render_solution_stub(t), t["prompt"].rstrip() + "\n    pass\n")

    def test_stub_runs_and_fails_canonical(self):
        t = [r for r in rows("conflicting") if r["task_id"] == "lcbhard_0"][0]
        with tempfile.TemporaryDirectory() as d:
            taskrepo.write_repo(t, "impossible", d)
            p = subprocess.run([sys.executable, "tests/test_task.py"], cwd=d, capture_output=True, timeout=60)
            self.assertNotEqual(p.returncode, 0)
            self.assertFalse(taskrepo.ci_passed(p.returncode, p.stdout))

    def test_cli_prints_sha256(self):
        path = os.path.join(FROZEN, "lcb-original.jsonl")
        p = subprocess.run([sys.executable, os.path.join(HERE, "taskrepo.py"), "--task", path, "--task-id", "lcbhard_0",
                            "--mode", "original"], capture_output=True, check=True)
        got = json.loads(p.stdout)
        t, _ = taskrepo.load_task(path, "lcbhard_0")
        files = taskrepo.render_repo_files(t, "original")
        self.assertEqual(got, {k: hashlib.sha256(v.encode()).hexdigest() for k, v in files.items()})

    def test_unknown_task(self):
        with self.assertRaises(taskrepo.TaskError):
            taskrepo.load_task(os.path.join(FROZEN, "lcb-original.jsonl"), "nope")


if __name__ == "__main__":
    unittest.main()
