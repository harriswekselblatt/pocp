"""freeze.py, offline: JSONL format, the manifest, and every refusal path (network mocked)."""

import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import freeze  # noqa: E402

SOURCES = os.path.join(HERE, "frozen", "source")


def mini_row(tid, split="conflicting"):
    t = "def check(candidate):\n    assert candidate(1) == 2\n"
    return {"task_id": tid, "prompt": 'def f(x):\n    """Doc."""', "test": t + "    assert candidate(1) == 3\n",
            "original_test": t, "impossible_type": split, "entry_point": "f"}


class Format(unittest.TestCase):
    def test_sorted_stable_keys(self):
        rows = [mini_row("b"), dict(reversed(list(mini_row("a").items())))]
        data = freeze.jsonl_bytes(rows).decode()
        lines = data.splitlines()
        self.assertEqual([json.loads(l)["task_id"] for l in lines], ["a", "b"])
        self.assertTrue(lines[0].startswith('{"task_id":"a","prompt":'))
        self.assertEqual(list(json.loads(lines[0])), list(freeze.FIELDS))
        self.assertTrue(data.endswith("\n"))

    def test_unicode_kept_raw(self):
        r = mini_row("a")
        r["prompt"] = 'def f(x):\n    """é ≤ 10⁹"""'
        self.assertIn("é ≤ 10⁹".encode(), freeze.jsonl_bytes([r]))

    def test_rejects_duplicates_missing_and_extra(self):
        with self.assertRaises(freeze.FreezeError):
            freeze.jsonl_bytes([mini_row("a"), mini_row("a")])
        r = mini_row("a")
        del r["test"]
        with self.assertRaises(freeze.FreezeError):
            freeze.jsonl_bytes([r])
        r = mini_row("a")
        r["x"] = "1"
        with self.assertRaises(freeze.FreezeError):
            freeze.jsonl_bytes([r])


class FakeHub:
    """Serves the committed parquet files as if from the Hub."""

    def __init__(self, head=freeze.REVISION, corrupt=None, api_rows=None):
        self.head = head
        self.corrupt = corrupt
        self.api_rows = api_rows
        self.blobs = {}
        for s in freeze.SPLITS:
            with open(os.path.join(SOURCES, s + ".parquet"), "rb") as f:
                self.blobs[s] = f.read()
        self.calls = []

    def __call__(self, url, timeout=60):
        self.calls.append(url)
        if url.endswith("/api/datasets/" + freeze.DATASET):
            return json.dumps({"sha": self.head}).encode()
        if "/tree/" in url:
            return json.dumps([{"path": freeze.parquet_name(s), "lfs": {"oid": hashlib.sha256(b).hexdigest(),
                                                                           "size": len(b)}}
                               for s, b in self.blobs.items()]).encode()
        if "/resolve/" in url:
            self.assertRevision(url)
            s = url.rsplit("/", 1)[1].split("-")[0]
            b = self.blobs[s]
            return b[:-1] + b"X" if self.corrupt == s else b
        if "datasets-server" in url:
            split = url.split("split=")[1].split("&")[0]
            offset = int(url.split("offset=")[1].split("&")[0])
            rows = self.api_rows(split) if self.api_rows else freeze.rows_from_parquet(self.blobs[split])
            page = rows[offset:offset + 100]
            return json.dumps({"rows": [{"row_idx": offset + i, "row": r, "truncated_cells": []}
                                        for i, r in enumerate(page)], "num_rows_total": len(rows)}).encode()
        raise AssertionError("unexpected url " + url)

    def assertRevision(self, url):
        if "/resolve/%s/" % freeze.REVISION not in url:
            raise AssertionError("download not pinned to the revision: " + url)


class Fetch(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        self.real_get = freeze.http_get

    def tearDown(self):
        freeze.http_get = self.real_get
        shutil.rmtree(self.out, ignore_errors=True)

    def test_freeze_writes_identical_files(self):
        hub = FakeHub()
        freeze.http_get = hub
        man = freeze.freeze(self.out)
        self.assertTrue(man["rows_api_crosscheck"]["performed"])
        for name in man["files"]:
            with open(os.path.join(self.out, name), "rb") as a, open(os.path.join(HERE, "frozen", name), "rb") as b:
                self.assertEqual(a.read(), b.read(), name)
        self.assertEqual(freeze.verify(self.out), [])
        broken = {(b["split"], b["task_id"]) for b in man["selfcheck"]["dataset_task_broken_candidates"]}
        self.assertIn(("conflicting", "lcbhard_77"), broken)

    def test_refuses_corrupt_download(self):
        freeze.http_get = FakeHub(corrupt="oneoff")
        with self.assertRaises(freeze.FreezeError):
            freeze.freeze(self.out)

    def test_head_moved_skips_crosscheck_but_still_pinned(self):
        hub = FakeHub(head="0" * 40)
        freeze.http_get = hub
        man = freeze.freeze(self.out)
        self.assertFalse(man["rows_api_crosscheck"]["performed"])
        self.assertFalse(any("datasets-server" in u for u in hub.calls))
        self.assertEqual(man["head_sha_at_fetch"], "0" * 40)

    def test_refuses_when_rows_api_disagrees(self):
        def rows(split):
            r = freeze.rows_from_parquet(FakeHub().blobs[split])
            r[0] = dict(r[0], prompt=r[0]["prompt"] + " ")
            return r
        freeze.http_get = FakeHub(api_rows=rows)
        with self.assertRaises(freeze.FreezeError):
            freeze.freeze(self.out)


if __name__ == "__main__":
    unittest.main()
