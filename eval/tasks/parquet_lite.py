"""A small, standard-library-only Parquet reader for flat string tables.

Why it exists: freeze.py must read the dataset *at a pinned revision*. The
Hugging Face rows API only serves the current revision, so the canonical
source is the parquet file downloaded at the pinned commit, and this reader
turns it into rows without third-party packages.

Scope, on purpose narrow (anything else raises ParquetError, never guesses):
- one or more row groups, flat schema (no nesting, no repetition)
- columns of physical type BYTE_ARRAY (strings), REQUIRED or OPTIONAL
- PLAIN, PLAIN_DICTIONARY and RLE_DICTIONARY encodings
- data pages v1 and v2, dictionary pages
- codecs UNCOMPRESSED, SNAPPY (pure-Python decoder below) and GZIP
"""

import struct
import zlib


class ParquetError(Exception):
    pass


# ---------------------------------------------------------------- snappy

def snappy_decompress(data):
    """Decode a raw (unframed) Snappy block."""
    pos = 0
    length, pos = _uvarint(data, pos)
    out = bytearray()
    n = len(data)
    while pos < n:
        tag = data[pos]
        pos += 1
        kind = tag & 3
        if kind == 0:  # literal
            ln = tag >> 2
            if ln >= 60:
                nbytes = ln - 59
                ln = int.from_bytes(data[pos:pos + nbytes], "little")
                pos += nbytes
            ln += 1
            if pos + ln > n:
                raise ParquetError("snappy: literal runs past end of input")
            out += data[pos:pos + ln]
            pos += ln
            continue
        if kind == 1:
            ln = ((tag >> 2) & 7) + 4
            off = ((tag >> 5) << 8) | data[pos]
            pos += 1
        elif kind == 2:
            ln = (tag >> 2) + 1
            off = int.from_bytes(data[pos:pos + 2], "little")
            pos += 2
        else:
            ln = (tag >> 2) + 1
            off = int.from_bytes(data[pos:pos + 4], "little")
            pos += 4
        if off == 0 or off > len(out):
            raise ParquetError("snappy: bad copy offset")
        start = len(out) - off
        if off >= ln:
            out += out[start:start + ln]
        else:  # overlapping copy: byte by byte semantics
            for i in range(ln):
                out.append(out[start + i])
    if len(out) != length:
        raise ParquetError("snappy: length mismatch (%d != %d)" % (len(out), length))
    return bytes(out)


def _uvarint(data, pos):
    shift = 0
    result = 0
    while True:
        if pos >= len(data):
            raise ParquetError("varint runs past end of input")
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7
        if shift > 70:
            raise ParquetError("varint too long")


def _zigzag(n):
    return (n >> 1) ^ -(n & 1)


# ---------------------------------------------------- thrift compact protocol

class _Thrift:
    """Generic Thrift compact-protocol reader. Structs become {field_id: value}."""

    def __init__(self, data, pos=0):
        self.data = data
        self.pos = pos

    def byte(self):
        b = self.data[self.pos]
        self.pos += 1
        return b

    def varint(self):
        v, self.pos = _uvarint(self.data, self.pos)
        return v

    def value(self, ftype):
        if ftype == 1:
            return True
        if ftype == 2:
            return False
        if ftype == 3:
            b = self.byte()
            return b - 256 if b > 127 else b
        if ftype in (4, 5, 6):
            return _zigzag(self.varint())
        if ftype == 7:
            v = struct.unpack_from("<d", self.data, self.pos)[0]
            self.pos += 8
            return v
        if ftype == 8:
            ln = self.varint()
            v = bytes(self.data[self.pos:self.pos + ln])
            self.pos += ln
            return v
        if ftype in (9, 10):
            head = self.byte()
            size = head >> 4
            etype = head & 0x0F
            if size == 15:
                size = self.varint()
            if etype in (1, 2):  # booleans inside lists are one byte each
                return [self.byte() == 1 for _ in range(size)]
            return [self.value(etype) for _ in range(size)]
        if ftype == 11:
            size = self.varint()
            if size == 0:
                return {}
            kv = self.byte()
            return {self.value(kv >> 4): self.value(kv & 0x0F) for _ in range(size)}
        if ftype == 12:
            return self.struct()
        raise ParquetError("thrift: unknown type %d" % ftype)

    def struct(self):
        out = {}
        last = 0
        while True:
            head = self.byte()
            if head == 0:
                return out
            delta = head >> 4
            ftype = head & 0x0F
            fid = last + delta if delta else _zigzag(self.varint())
            out[fid] = self.value(ftype)
            last = fid


# --------------------------------------------------------- RLE / bit-packing

def _rle_hybrid(data, pos, end, bit_width, count):
    """Decode `count` values of the RLE/bit-packing hybrid between pos and end."""
    out = []
    width_bytes = (bit_width + 7) // 8
    while len(out) < count and pos < end:
        header, pos = _uvarint(data, pos)
        if header & 1:
            groups = header >> 1
            nbytes = groups * bit_width
            chunk = int.from_bytes(data[pos:pos + nbytes], "little")
            pos += nbytes
            mask = (1 << bit_width) - 1
            for i in range(groups * 8):
                out.append((chunk >> (i * bit_width)) & mask if bit_width else 0)
        else:
            run = header >> 1
            val = int.from_bytes(data[pos:pos + width_bytes], "little")
            pos += width_bytes
            out.extend([val] * run)
    if len(out) < count:
        raise ParquetError("rle: ran out of data")
    return out[:count]


def _plain_byte_arrays(data, pos, count):
    out = []
    for _ in range(count):
        ln = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        out.append(bytes(data[pos:pos + ln]))
        pos += ln
    return out, pos


# ---------------------------------------------------------------- the reader

_CODECS = {0: "UNCOMPRESSED", 1: "SNAPPY", 2: "GZIP"}


def _decompress(codec, data):
    if codec == 0:
        return bytes(data)
    if codec == 1:
        return snappy_decompress(bytes(data))
    if codec == 2:
        return zlib.decompress(bytes(data), 47)
    raise ParquetError("unsupported codec %r" % codec)


def read_table(blob):
    """Return (column_names, rows) where rows is a list of dicts of str|None."""
    if blob[:4] != b"PAR1" or blob[-4:] != b"PAR1":
        raise ParquetError("not a parquet file (magic)")
    meta_len = struct.unpack("<I", blob[-8:-4])[0]
    meta = _Thrift(blob, len(blob) - 8 - meta_len).struct()
    schema = meta[2]
    root, leaves = schema[0], schema[1:]
    if root.get(5, 0) != len(leaves):
        raise ParquetError("nested schemas are not supported")
    names = []
    for el in leaves:
        if el.get(5):
            raise ParquetError("nested schemas are not supported")
        if el.get(1) != 6:  # BYTE_ARRAY
            raise ParquetError("column %r is not BYTE_ARRAY" % el.get(4))
        if el.get(3, 0) == 2:
            raise ParquetError("repeated columns are not supported")
        names.append(el[4].decode("utf-8"))
    optional = [el.get(3, 0) == 1 for el in leaves]
    columns = {n: [] for n in names}
    total = 0
    for rg in meta[4]:
        nrows = rg[3]
        total += nrows
        for ci, chunk in enumerate(rg[1]):
            cm = chunk[3]
            name = b".".join(cm[3]).decode("utf-8")
            if name not in columns:
                raise ParquetError("unknown column %r" % name)
            vals = _read_chunk(blob, cm, nrows, optional[names.index(name)])
            columns[name].extend(vals)
    if total != meta[3]:
        raise ParquetError("row count mismatch")
    rows = []
    for i in range(total):
        rows.append({n: columns[n][i] for n in names})
    return names, rows


def _read_chunk(blob, cm, nrows, optional):
    codec = cm[4]
    if codec not in _CODECS:
        raise ParquetError("unsupported codec %r" % codec)
    start = cm.get(11, cm[9]) if cm.get(11) else cm[9]
    pos = start
    end = start + cm[7]
    dictionary = None
    values = []
    while len(values) < nrows and pos < end:
        th = _Thrift(blob, pos)
        ph = th.struct()
        pos = th.pos
        ptype, comp_size = ph[1], ph[3]
        raw = blob[pos:pos + comp_size]
        pos += comp_size
        if ptype == 2:  # dictionary page
            page = _decompress(codec, raw)
            n = ph[7][1]
            dictionary, _ = _plain_byte_arrays(page, 0, n)
            continue
        if ptype == 0:
            hdr = ph[5]
            n, enc = hdr[1], hdr[2]
            page = _decompress(codec, raw)
            p = 0
            if optional:
                ln = struct.unpack_from("<I", page, p)[0]
                p += 4
                defs = _rle_hybrid(page, p, p + ln, 1, n)
                p += ln
            else:
                defs = [1] * n
        elif ptype == 3:
            hdr = ph[8]
            n, enc = hdr[1], hdr[4]
            dl, rl = hdr[5], hdr[6]
            if rl:
                raise ParquetError("repetition levels are not supported")
            levels = raw[:dl]
            body = raw[dl + rl:]
            page = _decompress(codec, body) if hdr.get(7, True) else bytes(body)
            defs = _rle_hybrid(levels, 0, dl, 1, n) if optional else [1] * n
            p = 0
        else:
            raise ParquetError("unsupported page type %r" % ptype)
        present = sum(defs)
        if enc == 0:
            vals, _ = _plain_byte_arrays(page, p, present)
        elif enc in (2, 8):
            if dictionary is None:
                raise ParquetError("dictionary-encoded page without a dictionary")
            bw = page[p]
            idx = _rle_hybrid(page, p + 1, len(page), bw, present)
            vals = [dictionary[i] for i in idx]
        else:
            raise ParquetError("unsupported encoding %r" % enc)
        it = iter(vals)
        for d in defs:
            values.append(next(it).decode("utf-8") if d else None)
    if len(values) != nrows:
        raise ParquetError("column chunk has %d values, expected %d" % (len(values), nrows))
    return values
