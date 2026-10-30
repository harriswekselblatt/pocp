#!/usr/bin/env python3
"""Freeze ImpossibleBench's LiveCodeBench split at a pinned dataset revision.

    python3 eval/tasks/freeze.py            # fetch, verify, write frozen/ (network)
    python3 eval/tasks/freeze.py --verify   # offline: rebuild from frozen/source/*.parquet and compare

Source of truth: the dataset's own parquet files downloaded *at the pinned
revision* (huggingface.co/datasets/<id>/resolve/<rev>/...). Each download must
match the LFS sha256 that the Hub lists for that revision. They are parsed with
parquet_lite.py (standard library only) and committed under frozen/source/, so
anyone can rebuild the JSONL offline.

Cross-check: when the dataset's current head equals the pinned revision, the
rows API (datasets-server, which only serves the head) must return exactly the
same rows. When the head has moved on, the cross-check is skipped and recorded;
the parquet at the pinned revision is still the source.

Output: frozen/lcb-<split>.jsonl (one task per line, sorted by task_id, keys in
FIELDS order) and frozen/MANIFEST.json (source, revision, fetch time, row counts,
sha256 per file, and selfcheck.py's per-task results).
"""

import argparse
import datetime
import hashlib
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import parquet_lite  # noqa: E402
import selfcheck  # noqa: E402

DATASET = "fjzzq2002/impossible_livecodebench"
REVISION = "98650ffc3f28a01b261669b6d19fcd7773823710"
SPLITS = ("conflicting", "oneoff", "original")
FIELDS = selfcheck.FIELDS
FROZEN = os.path.join(HERE, "frozen")
SOURCE_DIR = os.path.join(FROZEN, "source")
UA = "pocp-eval-freeze/1 (python urllib)"
JSONL_FORMAT = ("one JSON object per line, keys in order " + ",".join(FIELDS) +
                "; sorted by task_id (Python str order); UTF-8; "
                "json.dumps(ensure_ascii=False, separators=(',', ':')); each line ends with \\n")


class FreezeError(Exception):
    pass


# python.org builds on macOS ship without a CA store until "Install Certificates"
# is run. Verification is never turned off: we fall back to the system bundle.
CA_FALLBACKS = ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt")
_ssl_context = None


def _context():
    global _ssl_context
    if _ssl_context is None:
        ctx = ssl.create_default_context()
        if not ctx.get_ca_certs():
            for path in CA_FALLBACKS:
                if os.path.exists(path):
                    ctx = ssl.create_default_context(cafile=path)
                    break
        _ssl_context = ctx
    return _ssl_context


def http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_context()) as r:
            return r.read()
    except (urllib.error.URLError, OSError) as e:
        raise FreezeError("GET %s failed: %s" % (url, e))


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def parquet_name(split):
    return "data/%s-00000-of-00001.parquet" % split


def jsonl_bytes(rows):
    out = []
    for r in sorted(rows, key=lambda r: r["task_id"]):
        missing = [f for f in FIELDS if f not in r]
        if missing:
            raise FreezeError("row %r lacks fields %s" % (r.get("task_id"), missing))
        extra = sorted(set(r) - set(FIELDS))
        if extra:
            raise FreezeError("row %r has unexpected fields %s" % (r.get("task_id"), extra))
        obj = {f: r[f] for f in FIELDS}
        out.append(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    ids = [r["task_id"] for r in rows]
    if len(ids) != len(set(ids)):
        raise FreezeError("duplicate task_id")
    return "".join(out).encode("utf-8")


def rows_from_parquet(blob):
    _, rows = parquet_lite.read_table(blob)
    return rows


def fetch_rows_api(split, total_hint=None):
    rows, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"dataset": DATASET, "config": "default", "split": split,
                                    "offset": offset, "length": 100})
        d = json.loads(http_get("https://datasets-server.huggingface.co/rows?" + q))
        for item in d["rows"]:
            if item.get("truncated_cells"):
                raise FreezeError("rows API truncated cells in %s row %s" % (split, item.get("row_idx")))
            rows.append(item["row"])
        offset += len(d["rows"])
        if not d["rows"] or offset >= d["num_rows_total"]:
            return rows


def build_manifest(split_rows, sources, fetched_at, head_sha, crosscheck, jsonl_files):
    tasks, broken = {}, []
    for split in SPLITS:
        res = selfcheck.check_split(split_rows[split], split)
        tasks[split] = res
        for tid, r in res.items():
            if not r["ok"]:
                broken.append({"split": split, "task_id": tid, "problems": r["problems"]})
    files = {}
    for split in SPLITS:
        name = "lcb-%s.jsonl" % split
        files[name] = {"split": split, "rows": len(split_rows[split]), "sha256": sha256(jsonl_files[name]),
                       "source": "source/%s.parquet" % split}
    return {
        "schema": "pocp-eval-frozen/1",
        "dataset": DATASET,
        "revision": REVISION,
        "license": "MIT (ImpossibleBench: Zhong, Raghunathan, Carlini, ICLR 2026)",
        "source": {
            "kind": "parquet files at the pinned revision, parsed by eval/tasks/parquet_lite.py",
            "url_template": "https://huggingface.co/datasets/%s/resolve/%s/%s" % (DATASET, REVISION, "data/<split>-00000-of-00001.parquet"),
        },
        "fetched_at": fetched_at,
        "head_sha_at_fetch": head_sha,
        "rows_api_crosscheck": crosscheck,
        "jsonl_format": JSONL_FORMAT,
        "files": files,
        "sources": sources,
        "selfcheck": {
            "checks": "see eval/tasks/selfcheck.py",
            "dataset_task_broken_candidates": broken,
            "tasks": tasks,
        },
    }


def write_frozen(split_rows, sources, source_blobs, fetched_at, head_sha, crosscheck, out_dir=FROZEN):
    os.makedirs(os.path.join(out_dir, "source"), exist_ok=True)
    jsonl_files = {"lcb-%s.jsonl" % s: jsonl_bytes(split_rows[s]) for s in SPLITS}
    for name, data in jsonl_files.items():
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(data)
    for split, blob in source_blobs.items():
        with open(os.path.join(out_dir, "source", "%s.parquet" % split), "wb") as f:
            f.write(blob)
    manifest = build_manifest(split_rows, sources, fetched_at, head_sha, crosscheck, jsonl_files)
    with open(os.path.join(out_dir, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    return manifest


def freeze(out_dir=FROZEN):
    info = json.loads(http_get("https://huggingface.co/api/datasets/%s" % DATASET))
    head = info.get("sha")
    tree = json.loads(http_get("https://huggingface.co/api/datasets/%s/tree/%s/data" % (DATASET, REVISION)))
    lfs = {e["path"]: e.get("lfs") for e in tree}
    sources, blobs, split_rows = {}, {}, {}
    for split in SPLITS:
        path = parquet_name(split)
        meta = lfs.get(path)
        if not meta:
            raise FreezeError("%s not listed (with LFS metadata) at revision %s" % (path, REVISION))
        blob = http_get("https://huggingface.co/datasets/%s/resolve/%s/%s" % (DATASET, REVISION, path), timeout=300)
        if sha256(blob) != meta["oid"] or len(blob) != meta["size"]:
            raise FreezeError("%s: downloaded bytes don't match the LFS sha256/size at the revision" % path)
        rows = rows_from_parquet(blob)
        sources["source/%s.parquet" % split] = {"hub_path": path, "sha256": sha256(blob), "size": len(blob),
                                                "lfs_oid": meta["oid"]}
        blobs[split] = blob
        split_rows[split] = rows
    if head == REVISION:
        cc = {"performed": True, "url": "https://datasets-server.huggingface.co/rows", "equal": {}}
        for split in SPLITS:
            api_rows = fetch_rows_api(split)
            key = lambda r: r["task_id"]  # noqa: E731
            eq = sorted(api_rows, key=key) == sorted(split_rows[split], key=key)
            cc["equal"][split] = eq
            if not eq:
                raise FreezeError("rows API disagrees with the parquet at the pinned revision for %s" % split)
        head2 = json.loads(http_get("https://huggingface.co/api/datasets/%s" % DATASET)).get("sha")
        if head2 != head:
            raise FreezeError("dataset head moved during the cross-check (%s -> %s); run again" % (head, head2))
    else:
        cc = {"performed": False, "why": "dataset head is %s, not the pinned revision; the rows API only "
                                         "serves the head" % head}
    fetched_at = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    return write_frozen(split_rows, sources, blobs, fetched_at, head, cc, out_dir)


def verify(frozen_dir=FROZEN):
    """Offline: every file matches MANIFEST, and the JSONL rebuilds byte-for-byte from the parquet."""
    with open(os.path.join(frozen_dir, "MANIFEST.json"), encoding="utf-8") as f:
        man = json.load(f)
    problems = []
    if man.get("revision") != REVISION:
        problems.append("MANIFEST revision %r != pinned %r" % (man.get("revision"), REVISION))
    for rel, meta in man["sources"].items():
        with open(os.path.join(frozen_dir, rel), "rb") as f:
            blob = f.read()
        if sha256(blob) != meta["sha256"] or meta["sha256"] != meta["lfs_oid"]:
            problems.append("%s: sha256 mismatch" % rel)
    for name, meta in man["files"].items():
        with open(os.path.join(frozen_dir, name), "rb") as f:
            data = f.read()
        if sha256(data) != meta["sha256"]:
            problems.append("%s: sha256 mismatch with MANIFEST" % name)
        with open(os.path.join(frozen_dir, meta["source"]), "rb") as f:
            rebuilt = jsonl_bytes(rows_from_parquet(f.read()))
        if rebuilt != data:
            problems.append("%s: does not rebuild byte-for-byte from %s" % (name, meta["source"]))
        if data.count(b"\n") != meta["rows"]:
            problems.append("%s: row count mismatch" % name)
    return problems


def main(argv=None):
    ap = argparse.ArgumentParser(description="Freeze the ImpossibleBench LiveCodeBench tasks.")
    ap.add_argument("--verify", action="store_true", help="offline check of the committed frozen files")
    a = ap.parse_args(argv)
    if a.verify:
        problems = verify()
        for p in problems:
            print("FAIL " + p)
        print("ok" if not problems else "%d problem(s)" % len(problems))
        return 1 if problems else 0
    try:
        man = freeze()
    except FreezeError as e:
        print("REFUSED: %s" % e, file=sys.stderr)
        return 1
    broken = man["selfcheck"]["dataset_task_broken_candidates"]
    for name, meta in sorted(man["files"].items()):
        print("%s  %d rows  sha256 %s" % (name, meta["rows"], meta["sha256"]))
    print("rows API cross-check: %s" % json.dumps(man["rows_api_crosscheck"]))
    print("dataset-task-broken candidates: %d" % len(broken))
    for b in broken:
        print("  %s %s: %s" % (b["split"], b["task_id"], "; ".join(b["problems"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
