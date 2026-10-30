"""The reference checker must share no code with POCP and never run it (eval/README.md rule 1)."""

import ast
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
POCP_DIRS = ("src", "bin", "bench")
def python_files():
    out = []
    for dirpath, dirnames, filenames in os.walk(HERE):
        dirnames[:] = [d for d in dirnames if d not in ("__pycache__",)]
        for f in filenames:
            # This file is skipped: it has to spell out the violations it looks for.
            if f.endswith(".py") and os.path.join(dirpath, f) != os.path.abspath(__file__):
                out.append(os.path.join(dirpath, f))
    return sorted(out)


def string_constants(tree):
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            yield n


class Independence(unittest.TestCase):
    def test_scans_the_checker(self):
        names = {os.path.basename(p) for p in python_files()}
        for f in ("check.py", "strict_runner.py", "sandbox.py", "testdiff.py", "taskrepo.py", "canaries.py"):
            self.assertIn(f, names)

    def test_no_imports_of_pocp_code(self):
        for path in python_files():
            tree = ast.parse(open(path, encoding="utf-8").read(), path)
            for n in ast.walk(tree):
                mods = []
                if isinstance(n, ast.Import):
                    mods = [a.name for a in n.names]
                elif isinstance(n, ast.ImportFrom):
                    mods = [n.module or ""]
                for m in mods:
                    top = m.split(".")[0]
                    self.assertNotIn(top, POCP_DIRS + ("pocp",), "%s imports %s" % (path, m))

    def test_no_paths_into_pocp_code(self):
        for path in python_files():
            tree = ast.parse(open(path, encoding="utf-8").read(), path)
            for c in string_constants(tree):
                v = c.value
                for d in POCP_DIRS:
                    self.assertNotRegex(v, r"(^|[/\\'\" ])%s/[\w.-]+\.(js|mjs|cjs)" % d,
                                        "%s:%d names POCP code: %r" % (path, c.lineno, v[:80]))
                    self.assertNotIn("../../" + d, v, "%s:%d reaches into %s/" % (path, c.lineno, d))

    def test_no_node_or_pocp_executed(self):
        """No string literal that could be a command names node, npx or the pocp CLI."""
        for path in python_files():
            tree = ast.parse(open(path, encoding="utf-8").read(), path)
            for c in string_constants(tree):
                v = c.value.strip()
                first = v.split()[0] if v.split() else ""
                base = os.path.basename(first)
                self.assertNotIn(base, ("node", "nodejs", "npx", "npm", "pocp"),
                                 "%s:%d has a command-like string %r" % (path, c.lineno, v[:80]))
            for n in ast.walk(tree):
                if isinstance(n, ast.List) and n.elts and isinstance(n.elts[0], ast.Constant) \
                        and isinstance(n.elts[0].value, str):
                    self.assertNotIn(os.path.basename(n.elts[0].value), ("node", "nodejs", "npx", "npm", "pocp"),
                                     "%s:%d builds a node/pocp argv" % (path, n.lineno))

    def test_no_pocp_module_names_in_source(self):
        """No identifier or attribute named after POCP's modules (engine, guard-check, ...)."""
        pocp_modules = set()
        src = os.path.join(HERE, "..", "..", "src")
        if os.path.isdir(src):
            pocp_modules = {os.path.splitext(f)[0] for f in os.listdir(src) if f.endswith(".js")}
        for path in python_files():
            text = open(path, encoding="utf-8").read()
            for name in pocp_modules:
                self.assertNotRegex(text, r"""require\(['"][^'"]*%s""" % re.escape(name), path)
                self.assertNotIn("%s.js" % name, text, "%s names POCP module %s.js" % (path, name))

    def test_detector_catches_violations(self):
        """The checks above would fire on obvious violations."""
        bad = [
            "import pocp\n",
            "from src import engine\n",
            "subprocess.run(['node', 'x.js'])\n",
            "subprocess.run(['pocp', 'verify'])\n",
            "open('../../src/engine.js')\n",
            "x = 'src/guard-check.js'\n",
        ]
        hits = 0
        for code in bad:
            tree = ast.parse(code)
            flagged = False
            for n in ast.walk(tree):
                if isinstance(n, ast.Import) and any(a.name.split(".")[0] in POCP_DIRS + ("pocp",) for a in n.names):
                    flagged = True
                if isinstance(n, ast.ImportFrom) and (n.module or "").split(".")[0] in POCP_DIRS + ("pocp",):
                    flagged = True
                if isinstance(n, ast.List) and n.elts and isinstance(n.elts[0], ast.Constant) \
                        and os.path.basename(str(n.elts[0].value)) in ("node", "pocp"):
                    flagged = True
            for c in string_constants(tree):
                if "../../src" in c.value or re.search(r"(^|[/\\'\" ])src/[\w.-]+\.js", c.value):
                    flagged = True
            hits += flagged
        self.assertEqual(hits, len(bad))


if __name__ == "__main__":
    unittest.main()
