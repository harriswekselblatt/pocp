"""Tests for the E4 frame rules (eval/e4/FRAME.md sections 3 and 4) and E4's independence."""
import ast
import os
import unittest

import e4

HERE = os.path.dirname(os.path.abspath(__file__))


class TestFiles(unittest.TestCase):
    def test_test_files(self):
        for p in ["tests/test_x.py", "pkg/test_x.py", "pkg/x_test.py", "src/__tests__/a.ts", "a.test.tsx", "lib/b.spec.mjs", "spec/c.js", "test/d.js"]:
            self.assertTrue(e4.is_test_file(p), p)
        for p in ["src/testing.py", "src/contest.js", "src/a.ts", "docs/test.md.txt", "latest/x.py"]:
            self.assertFalse(e4.is_test_file(p), p)

    def test_source_files(self):
        self.assertTrue(e4.is_source_file("src/a.ts"))
        self.assertFalse(e4.is_source_file("tests/test_a.py"))
        self.assertFalse(e4.is_source_file("README.md"))


class TestEligible(unittest.TestCase):
    ok = [("M", "src/a.py"), ("A", "tests/test_a.py")]

    def test_needs_fix_subject(self):
        self.assertTrue(e4.eligible("Fix off-by-one in parser", self.ok))
        self.assertTrue(e4.eligible("parser: regression in 2.1", self.ok))
        self.assertFalse(e4.eligible("Prefix handling", self.ok))
        self.assertFalse(e4.eligible("Add feature", self.ok))

    def test_needs_test_and_source(self):
        self.assertFalse(e4.eligible("fix", [("M", "src/a.py")]))
        self.assertFalse(e4.eligible("fix", [("A", "tests/test_a.py")]))
        self.assertFalse(e4.eligible("fix", [("M", "src/a.py"), ("D", "tests/test_a.py")]), "a deleted test isn't a test")

    def test_limits(self):
        self.assertFalse(e4.eligible("fix", self.ok + [("M", "package.json")]))
        self.assertFalse(e4.eligible("fix", self.ok + [("M", "requirements-dev.txt")]))
        self.assertFalse(e4.eligible("fix", self.ok + [("M", "x%d.py" % i) for i in range(19)]))
        self.assertTrue(e4.eligible("fix", self.ok + [("M", "x%d.py" % i) for i in range(18)]))


class TestSampling(unittest.TestCase):
    def test_deterministic_and_per_language(self):
        cands = [{"full_name": "o/%s%d" % (l[0], i), "language": l, "stars": 1000, "default_branch": "main"}
                 for l in e4.LANGUAGES for i in range(20)]
        a = e4.sample_repos(cands)
        b = e4.sample_repos(list(reversed(cands)))
        self.assertEqual([c["full_name"] for c in a], [c["full_name"] for c in b], "input order doesn't matter")
        self.assertEqual(len(a), 15)
        for l in e4.LANGUAGES:
            self.assertEqual(sum(c["language"] == l for c in a), 5)
        self.assertEqual([c["position"] for c in a], list(range(15)))
        self.assertEqual(a, sorted(a, key=lambda c: c["draw"]))

    def test_pick_commit(self):
        commits = [{"sha": str(i)} for i in range(10)]
        self.assertEqual(e4.pick_commit(commits, 3), e4.pick_commit(commits, 3))
        self.assertIsNone(e4.pick_commit([], 0))


class TestIndependence(unittest.TestCase):
    def test_imports_nothing_from_pocp(self):
        for name in os.listdir(HERE):
            if not name.endswith(".py") or name.startswith("test_"):
                continue
            tree = ast.parse(open(os.path.join(HERE, name), encoding="utf-8").read())
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    self.assertNotIn("bin/pocp", node.value, name)
                    self.assertFalse(node.value.startswith(("src/", "../src", "bench/")), (name, node.value))
            mods = [a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names]
            mods += [n.module or "" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
            for m in mods:
                self.assertNotIn("pocp", m.lower(), name)


if __name__ == "__main__":
    unittest.main()
