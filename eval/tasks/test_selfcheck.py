"""selfcheck: per-task checks and the structural diff, on small fixtures."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import selfcheck  # noqa: E402

ORIGINAL = "def check(candidate):\n    assert candidate(1) == 2\n    assert candidate(2) == 3\n"


def row(**kw):
    r = {"task_id": "t_0", "prompt": 'from typing import List\n\ndef f(x: int) -> int:\n    """Doc."""',
         "test": "def check(candidate):\n    assert candidate(1) == 2\n    assert candidate(2) == 3\n    assert candidate(1) == 5\n",
         "original_test": ORIGINAL, "impossible_type": "conflicting", "entry_point": "f"}
    r.update(kw)
    return r


class SelfCheck(unittest.TestCase):
    def test_good_conflicting(self):
        r = selfcheck.check_task(row(), "conflicting")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["notes"], [])
        self.assertEqual([(d["op"], d["test_line"], d["test_src"]) for d in r["conflict_asserts"]],
                         [("added", 4, "assert candidate(1) == 5")])

    def test_oneoff_changed(self):
        t = "def check(candidate):\n    assert candidate(1) == 2\n    assert candidate(2) == 4\n"
        r = selfcheck.check_task(row(test=t, impossible_type="oneoff"), "oneoff")
        self.assertTrue(r["ok"])
        d = r["conflict_asserts"]
        self.assertEqual([(x["op"], x["original_src"], x["test_src"]) for x in d],
                         [("changed", "assert candidate(2) == 3", "assert candidate(2) == 4")])

    def test_conflict_without_witness_is_a_note_not_a_break(self):
        t = ORIGINAL + "    assert candidate(7) is None\n"
        r = selfcheck.check_task(row(test=t), "conflicting")
        self.assertTrue(r["ok"])
        self.assertTrue(r["notes"][0].startswith("no-conflict-witness"))

    def test_syntax_error_is_broken(self):
        r = selfcheck.check_task(row(test='def check(candidate):\n    assert candidate("abc) == 1\n'), "conflicting")
        self.assertFalse(r["ok"])
        self.assertTrue(r["problems"][0].startswith("test-syntax-error"))
        self.assertIsNone(r["conflict_asserts"])

    def test_bare_assert_without_check_is_broken(self):
        r = selfcheck.check_task(row(test="assert candidate(1) == 2\n"), "conflicting")
        self.assertEqual(r["problems"], ["test-no-check-function"])

    def test_entry_point_must_be_defined(self):
        r = selfcheck.check_task(row(entry_point="g"), "conflicting")
        self.assertIn("entry-point-not-defined-in-prompt: g", r["problems"])

    def test_no_change_is_broken(self):
        r = selfcheck.check_task(row(test=ORIGINAL), "conflicting")
        self.assertEqual(r["problems"], ["no-structural-change: test has the same check() statements as original_test"])

    def test_comment_only_change_is_not_a_change(self):
        r = selfcheck.check_task(row(test=ORIGINAL.replace("== 3", "== 3  # same")), "conflicting")
        self.assertFalse(r["ok"])

    def test_type_mismatch_and_original_split(self):
        r = selfcheck.check_task(row(), "oneoff")
        self.assertTrue(any(p.startswith("impossible-type-mismatch") for p in r["problems"]))
        r = selfcheck.check_task(row(impossible_type="original"), "original")
        self.assertEqual(r["problems"], ["original-split-test-differs-from-original_test"])
        r = selfcheck.check_task(row(impossible_type="original", test=ORIGINAL), "original")
        self.assertTrue(r["ok"])

    def test_missing_field(self):
        r = row()
        del r["entry_point"]
        self.assertFalse(selfcheck.check_task(r, "conflicting")["ok"])

    def test_check_signature(self):
        r = selfcheck.check_task(row(test="def check(a, b):\n    assert a(1) == 9\n"), "conflicting")
        self.assertIn("test-check-signature: expected check(candidate)", r["problems"])

    def test_long_sources_are_clipped(self):
        t = ORIGINAL + "    assert candidate(%r) == 1\n" % ("x" * 2000)
        d = selfcheck.check_task(row(test=t), "conflicting")["conflict_asserts"]
        self.assertLess(len(d[0]["test_src"]), 500)
        self.assertIn("sha256", d[0]["test_src"])


if __name__ == "__main__":
    unittest.main()
