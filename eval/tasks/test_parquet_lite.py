"""parquet_lite: Snappy, Thrift compact and RLE decoding on hand-made bytes, then a real file."""

import json
import os
import struct
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import parquet_lite as pl  # noqa: E402


class Snappy(unittest.TestCase):
    def test_literal(self):
        self.assertEqual(pl.snappy_decompress(bytes([5, (5 - 1) << 2]) + b"hello"), b"hello")

    def test_copy_with_1_byte_offset_overlapping(self):
        # "ab" then copy len 6 from offset 2 -> "abababab"
        data = bytes([8, (2 - 1) << 2]) + b"ab" + bytes([((6 - 4) << 2) | 1, 2])
        self.assertEqual(pl.snappy_decompress(data), b"abababab")

    def test_copy_with_2_byte_offset(self):
        lit = b"0123456789"
        data = bytes([15, (10 - 1) << 2]) + lit + bytes([((5 - 1) << 2) | 2]) + struct.pack("<H", 10)
        self.assertEqual(pl.snappy_decompress(data), lit + b"01234")

    def test_long_literal(self):
        lit = bytes(range(256)) * 2
        # Tag 61<<2: "length - 1 follows in 2 bytes" (511 doesn't fit the 1-byte form, tag 60).
        data = bytes([0x80 | (512 & 0x7F), 512 >> 7]) + bytes([61 << 2]) + struct.pack("<H", 511) + lit
        self.assertEqual(pl.snappy_decompress(data), lit)

    def test_bad_offset_and_length(self):
        with self.assertRaises(pl.ParquetError):
            pl.snappy_decompress(bytes([4, (4 - 4) << 2 | 1, 9]))
        with self.assertRaises(pl.ParquetError):
            pl.snappy_decompress(bytes([9, 0]) + b"a")


class Thrift(unittest.TestCase):
    def test_struct(self):
        # field 1 i32 = -3 (zigzag 5), field 2 binary "hi", field 4 list<i32> [1,2], field 5 true, stop
        data = bytes([0x15, 5, 0x18, 2]) + b"hi" + bytes([0x29, 0x25, 2, 4, 0x11, 0])
        self.assertEqual(pl._Thrift(data).struct(), {1: -3, 2: b"hi", 4: [1, 2], 5: True})

    def test_long_field_delta(self):
        # delta 0 -> explicit zigzag i16 field id 20 (zigzag 40), type i64, value 7 (zigzag 14)
        data = bytes([0x06, 40, 14, 0])
        self.assertEqual(pl._Thrift(data).struct(), {20: 7})


class Rle(unittest.TestCase):
    def test_rle_run(self):
        self.assertEqual(pl._rle_hybrid(bytes([3 << 1, 1]), 0, 2, 1, 3), [1, 1, 1])

    def test_bit_packed(self):
        # one group of 8 values, width 1: 0b10110101 -> LSB first
        self.assertEqual(pl._rle_hybrid(bytes([(1 << 1) | 1, 0b10110101]), 0, 2, 1, 8), [1, 0, 1, 0, 1, 1, 0, 1])

    def test_runs_out(self):
        with self.assertRaises(pl.ParquetError):
            pl._rle_hybrid(bytes([2 << 1, 1]), 0, 2, 1, 3)


class RealFile(unittest.TestCase):
    def test_reads_committed_source(self):
        path = os.path.join(HERE, "frozen", "source", "original.parquet")
        with open(path, "rb") as f:
            names, rows = pl.read_table(f.read())
        self.assertEqual(len(rows), 103)
        self.assertEqual(set(names), {"task_id", "prompt", "test", "original_test", "impossible_type", "entry_point"})
        self.assertTrue(all(isinstance(r["prompt"], str) for r in rows))

    def test_not_parquet(self):
        with self.assertRaises(pl.ParquetError):
            pl.read_table(b"nope")


if __name__ == "__main__":
    unittest.main()
