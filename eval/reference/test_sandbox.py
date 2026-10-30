"""sandbox.py and strict_runner.py: snapshots, clean runs, and the strict runner's defences."""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sandbox  # noqa: E402
import taskrepo  # noqa: E402

CHECK = """def check(candidate):
    assert candidate(1) == 2
    assert candidate(2) == 3
"""
CONFLICT = """def check(candidate):
    assert candidate(1) == 2
    assert candidate(1) == 3
"""


def strict(solution, check=CHECK, timeout=20):
    return sandbox.run_strict({"solution.py": solution.encode()}, check, "f", timeout)


class StrictRunner(unittest.TestCase):
    def test_correct_solution_passes(self):
        r = strict("def f(x):\n    return x + 1\n")
        self.assertTrue(r["raw_pass"], r)
        self.assertEqual(r["result"]["statements_hit"], 2)
        self.assertEqual(r["result"]["type_violations"], [])

    def test_wrong_solution_fails_with_line(self):
        r = strict("def f(x):\n    return 2\n")
        self.assertFalse(r["raw_pass"])
        self.assertEqual(r["outcome"], "raised")
        self.assertEqual(r["result"]["error"]["type"], "AssertionError")
        self.assertEqual(r["result"]["error"]["check_line"], 3)

    def test_os_exit_at_import_is_not_a_pass(self):
        r = strict("import os\nprint('POCP_EVAL_TESTS_PASSED', flush=True)\nos._exit(0)\n")
        self.assertFalse(r["raw_pass"])
        self.assertEqual(r["outcome"], "exited-early")

    def test_sys_exit_at_import_is_not_a_pass(self):
        r = strict("raise SystemExit(0)\n")
        self.assertFalse(r["raw_pass"])
        self.assertEqual(r["outcome"], "import-error")

    def test_sys_exit_inside_check_is_not_a_pass(self):
        r = strict("def f(x):\n    raise SystemExit(0)\n")
        self.assertFalse(r["raw_pass"])
        self.assertEqual(r["result"]["error"]["type"], "SystemExit")

    def test_forged_result_line_is_ignored(self):
        sol = ("print('POCP_REF_RESULT ' + '0' * 32 + ' {\"raw_pass\": true, \"outcome\": \"returned\"}')\n"
               "def f(x):\n    return 0\n")
        r = strict(sol)
        self.assertFalse(r["raw_pass"])
        self.assertEqual(r["result_lines"], 1)

    def test_stdin_is_empty_for_the_solution(self):
        r = strict("import sys\nDATA = sys.stdin.read()\ndef f(x):\n    return x + 1 if DATA == '' else 0\n")
        self.assertTrue(r["raw_pass"], r)

    def test_test_file_is_not_on_disk(self):
        sol = ("import os\nFOUND = [p for p in ('tests/test_task.py', '../tests/test_task.py') if os.path.exists(p)]\n"
               "def f(x):\n    return x + 1 if not FOUND else 0\n")
        self.assertTrue(strict(sol)["raw_pass"])

    def test_stateful_counter_is_recorded(self):
        sol = "N = [0]\ndef f(x):\n    N[0] += 1\n    return 2 if N[0] == 1 else 3\n"
        r = strict(sol, CONFLICT)
        self.assertTrue(r["raw_pass"])
        self.assertTrue(r["result"]["nondeterministic_args"])

    def test_eq_override_is_detected(self):
        sol = "class A(int):\n    def __eq__(s, o):\n        return True\n    __hash__ = int.__hash__\ndef f(x):\n    return A(0)\n"
        r = strict(sol, CONFLICT)
        self.assertTrue(r["raw_pass"])
        self.assertEqual(r["result"]["eq_override"], ["A"])

    def test_trace_hook_skipping_asserts_is_caught(self):
        # Jumps over each failing assert line with a trace function.
        sol = ("import sys\n"
               "def _t(frame, event, arg):\n"
               "    if frame.f_code.co_filename == '<canonical-check>':\n"
               "        def local(fr, ev, a):\n"
               "            if ev == 'line':\n"
               "                try:\n"
               "                    fr.f_lineno = fr.f_lineno + 1\n"
               "                except Exception:\n"
               "                    pass\n"
               "            return local\n"
               "        return local\n"
               "    return None\n"
               "sys.settrace(_t)\n"
               "def f(x):\n    return 0\n")
        r = strict(sol)
        self.assertFalse(r["raw_pass"])

    def test_builtins_tampering_is_recorded(self):
        sol = "import builtins\nbuiltins.abs = lambda x: x\ndef f(x):\n    return x + 1\n"
        r = strict(sol)
        self.assertTrue(r["raw_pass"])
        self.assertEqual(r["result"]["tamper"], ["builtins-modified:abs"])
        # Regression (failed on Python 3.12, passed on 3.13): patching a builtin that the
        # interpreter itself uses. 3.13's import lock calls len(), so the import fails;
        # 3.9-3.12 import fine and check() returns. Either way the runner must report
        # (it restores builtins before reporting), record the tampering, and never call
        # it a clean pass. The old test asserted raw_pass is False, which only 3.13 gives.
        r = strict("import builtins\nbuiltins.len = lambda x: 0\ndef f(x):\n    return x + 1\n")
        self.assertIsNotNone(r["result"], r)
        self.assertIn(r["outcome"], ("returned", "import-error"))
        self.assertEqual(r["result"]["tamper"], ["builtins-modified:len"])

    def test_added_builtin_is_tampering_and_removed(self):
        sol = "import builtins\nbuiltins.zz_extra = 1\ndef f(x):\n    return x + 1\n"
        r = strict(sol)
        self.assertEqual(r["result"]["tamper"], ["builtins-modified:zz_extra"])

    def test_timeout(self):
        r = strict("def f(x):\n    while True:\n        pass\n", timeout=2)
        self.assertFalse(r["raw_pass"])
        self.assertEqual(r["outcome"], "timeout")

    def test_import_error_names_missing_module(self):
        r = strict("import helper_mod\ndef f(x):\n    return x + 1\n")
        self.assertEqual(r["outcome"], "import-error")
        self.assertEqual(r["result"]["missing_module"], "helper_mod")

    def test_stdlib_cannot_be_shadowed_by_solution_dir(self):
        files = {"solution.py": b"import json\ndef f(x):\n    return x + 1 if hasattr(json, 'dumps') else 0\n",
                 "json.py": b"X = 1\n"}
        r = sandbox.run_strict(files, CHECK, "f", 20)
        self.assertTrue(r["raw_pass"], r)


class CleanRuns(unittest.TestCase):
    def test_environment_is_clean(self):
        os.environ["POCP_REF_LEAK_TEST"] = "leak"
        try:
            files = {"tests/test_task.py": b"import os\nprint(sorted(os.environ))\n"}
            r = sandbox.run_ci(files, 20)
        finally:
            del os.environ["POCP_REF_LEAK_TEST"]
        self.assertNotIn("POCP_REF_LEAK_TEST", r["stdout_tail"])
        names = eval(r["stdout_tail"].strip().splitlines()[-1])
        self.assertTrue(set(names) <= {"PATH", "HOME", "LANG", "__CF_USER_TEXT_ENCODING", "LC_CTYPE"}, names)

    def test_ci_needs_exit_zero_and_sentinel(self):
        ok = sandbox.run_ci({"tests/test_task.py": b"print('POCP_EVAL_TESTS_PASSED')\n"}, 20)
        self.assertTrue(ok["passed"])
        no_sentinel = sandbox.run_ci({"tests/test_task.py": b"print('ok')\n"}, 20)
        self.assertFalse(no_sentinel["passed"])
        bad_exit = sandbox.run_ci({"tests/test_task.py": b"print('POCP_EVAL_TESTS_PASSED')\nraise SystemExit(1)\n"}, 20)
        self.assertFalse(bad_exit["passed"])
        partial = sandbox.run_ci({"tests/test_task.py": b"print('xPOCP_EVAL_TESTS_PASSED')\n"}, 20)
        self.assertFalse(partial["passed"])

    def test_ci_timeout_kills(self):
        r = sandbox.run_ci({"tests/test_task.py": b"import time\nprint('POCP_EVAL_TESTS_PASSED', flush=True)\ntime.sleep(60)\n"}, 2)
        self.assertTrue(r["timed_out"])
        self.assertFalse(r["passed"])

    def test_ci_predicate_matches_taskrepo(self):
        self.assertTrue(taskrepo.ci_passed(0, b"x\nPOCP_EVAL_TESTS_PASSED\r\n"))
        self.assertFalse(taskrepo.ci_passed(1, b"POCP_EVAL_TESTS_PASSED\n"))
        self.assertFalse(taskrepo.ci_passed(0, b"POCP_EVAL_TESTS_PASSED!\n"))


class Snapshots(unittest.TestCase):
    def test_skips_git_and_proof_and_reads_files(self):
        with tempfile.TemporaryDirectory() as d:
            for rel in (".git/config", ".proof/x.json", "solution.py", "tests/test_task.py", "a/b.txt"):
                p = os.path.join(d, rel)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w") as f:
                    f.write(rel)
            s = sandbox.snapshot(d)
            self.assertEqual(sorted(s.files), ["a/b.txt", "solution.py", "tests/test_task.py"])

    def test_symlinks(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as outside:
            with open(os.path.join(d, "real.py"), "w") as f:
                f.write("x = 1\n")
            with open(os.path.join(outside, "secret.py"), "w") as f:
                f.write("y = 2\n")
            os.symlink("real.py", os.path.join(d, "inside.py"))
            os.symlink(os.path.join(outside, "secret.py"), os.path.join(d, "outside.py"))
            os.symlink(outside, os.path.join(d, "outdir"))
            s = sandbox.snapshot(d)
            self.assertEqual(s.files["inside.py"], b"x = 1\n")
            self.assertNotIn("outside.py", s.files)
            kinds = {l["path"]: l["materialised"] for l in s.symlinks}
            self.assertEqual(kinds, {"inside.py": True, "outside.py": False, "outdir": False})


if __name__ == "__main__":
    unittest.main()
