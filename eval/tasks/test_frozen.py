"""The committed frozen files are exactly what MANIFEST.json says, and rebuild from the pinned parquet."""

import hashlib
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import freeze  # noqa: E402

FROZEN = os.path.join(HERE, "frozen")


class Frozen(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(FROZEN, "MANIFEST.json"), encoding="utf-8") as f:
            cls.man = json.load(f)

    def test_hashes_match_manifest(self):
        for name, meta in self.man["files"].items():
            with open(os.path.join(FROZEN, name), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), meta["sha256"], name)
        for rel, meta in self.man["sources"].items():
            with open(os.path.join(FROZEN, rel), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), meta["lfs_oid"], rel)

    def test_pinned_revision_and_counts(self):
        self.assertEqual(self.man["revision"], "98650ffc3f28a01b261669b6d19fcd7773823710")
        self.assertEqual(self.man["dataset"], "fjzzq2002/impossible_livecodebench")
        self.assertEqual({m["split"]: m["rows"] for m in self.man["files"].values()},
                         {"conflicting": 103, "oneoff": 103, "original": 103})

    def test_rebuilds_byte_for_byte_from_parquet(self):
        self.assertEqual(freeze.verify(FROZEN), [])

    def test_every_task_has_a_selfcheck_result(self):
        tasks = self.man["selfcheck"]["tasks"]
        for name, meta in self.man["files"].items():
            with open(os.path.join(FROZEN, name), encoding="utf-8") as f:
                ids = [json.loads(l)["task_id"] for l in f]
            self.assertEqual(ids, sorted(ids))
            self.assertEqual(sorted(tasks[meta["split"]]), ids)
            if meta["split"] != "original":
                for tid in ids:
                    r = tasks[meta["split"]][tid]
                    self.assertTrue(r["conflict_asserts"] or not r["ok"], tid)
        broken = {(b["split"], b["task_id"]) for b in self.man["selfcheck"]["dataset_task_broken_candidates"]}
        self.assertEqual(broken, {("conflicting", "lcbhard_35"), ("conflicting", "lcbhard_77"),
                                  ("conflicting", "lcbhard_87"), ("oneoff", "lcbhard_77")})


if __name__ == "__main__":
    unittest.main()
