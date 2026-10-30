# Frozen benchmark tasks

ImpossibleBench's LiveCodeBench split (Zhong, Raghunathan, Carlini, ICLR 2026; MIT), dataset `fjzzq2002/impossible_livecodebench` at revision `98650ffc3f28a01b261669b6d19fcd7773823710`, splits `conflicting`, `oneoff` and `original`, 103 tasks each.

| File | What |
|---|---|
| `frozen/lcb-<split>.jsonl` | the canonical tasks: one per line, sorted by `task_id`, keys `task_id, prompt, test, original_test, impossible_type, entry_point` |
| `frozen/source/<split>.parquet` | the dataset's own parquet files at the pinned revision (sha256 = the Hub's LFS oid) |
| `frozen/MANIFEST.json` | revision, fetch time, row counts, sha256 of every file, the rows-API cross-check, and `selfcheck` results per task |
| `freeze.py` | fetches and writes all of the above; `--verify` rebuilds the JSONL offline from the parquet and checks every hash |
| `parquet_lite.py` | a standard-library parquet reader (Snappy, Thrift compact, RLE/dictionary pages) |
| `selfcheck.py` | per-task checks and the structural diff `original_test` → `test` (`conflict_asserts`) |

## How the freeze is pinned

The Hub's rows API serves only the dataset's current head, so it isn't the source. `freeze.py` downloads each parquet file from `resolve/<revision>/`, requires its sha256 and size to equal the LFS metadata the Hub lists *for that revision*, and parses it with `parquet_lite.py`. When the head still equals the pinned revision (it did on 2026-10-28), it also fetches every row through the rows API and refuses unless both agree exactly, then re-reads the head to make sure it didn't move meanwhile. If the head has moved, that cross-check is skipped and recorded, and the freeze is still pinned through the parquet.

```bash
python3 eval/tasks/freeze.py            # network; rewrites frozen/
python3 eval/tasks/freeze.py --verify   # offline; exit 1 on any mismatch
python3 -m unittest discover -s eval/tasks -p 'test_*.py'
```

## `dataset-task-broken` candidates

The self-check found four, listed in `MANIFEST.json` under `selfcheck.dataset_task_broken_candidates`. They're kept in the frozen files; excluding them is the analysis's decision (PREREG §3), and must be reported.

| Split | Task | Problem |
|---|---|---|
| conflicting | `lcbhard_35` | `test` is a bare `assert` with no `def check` |
| conflicting | `lcbhard_87` | same |
| conflicting | `lcbhard_77` | `test` doesn't parse (an unterminated string on line 27) |
| oneoff | `lcbhard_77` | same, line 26 |

These defects are in the upstream parquet itself (the rows API returns the same bytes, with no truncated cells). Informational notes, not breakage: three conflicting tasks (`lcbhard_5`, `lcbhard_26`, `lcbhard_72`) have no "conflict witness" (no call asserted equal to two different values; the added asserts are of other shapes, such as `is None`), so whether their tests truly contradict the spec is worth a look. There is no reference solution in the dataset, so "original tests fail on the reference solution" can't be checked.
