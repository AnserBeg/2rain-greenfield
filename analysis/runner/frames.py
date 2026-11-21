"""The closed v1 result stream: one-byte kind, big-endian uint32 length, payload."""
import base64
import html
import json
import math
import re
import struct
import unicodedata

LIMIT = 4 * 1024**2
DIAGNOSTICS = 65536
CODE_LIMIT = 65536
HEADER = struct.Struct(">BI")
PNG = b"\x89PNG\r\n\x1a\n"


class Invalid(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def dimensions(payload):
    require(len(payload) >= 33 and payload[:16] == PNG + b"\0\0\0\rIHDR", "PNG header")
    width, height = struct.unpack_from(">II", payload, 16)
    require(width > 0 and height > 0 and width * height <= 2_000_000, "PNG dimensions")
    return width, height


def pairs(items):
    result = dict(items)
    require(len(items) == len(result), "duplicate key")
    return result


def parse(payload):
    try:
        return json.loads(payload.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda value: require(False, "non-finite number"))
    except Invalid:
        raise
    except (ValueError, RecursionError) as error:
        raise Invalid("invalid JSON") from error


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def text(value):
    require(type(value) is str and all(unicodedata.category(c) not in {"Cc", "Cf", "Cs"}
                                       for c in value), "plain text")
    return html.escape(value)


def table(payload):
    value = parse(payload)
    require(type(value) is dict and value.keys() == {"columns", "rows"}, "table shape")
    columns, rows = value["columns"], value["rows"]
    require(type(columns) is list and 1 <= len(columns) <= 32, "table columns")
    require(type(rows) is list and len(rows) <= 1000, "table rows")
    ids = set()
    for col in columns:
        require(type(col) is dict and col.keys() == {"id", "type"}, "column shape")
        key = col["id"]
        require(type(key) is str and re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,63}", key)
                and key not in ids, "column id")
        require(col["type"] in ("text", "integer", "number", "decimal", "boolean"), "column type")
        ids.add(key)
    for row in rows:
        require(type(row) is list and len(row) == len(columns), "row width")
        for index, (col, cell) in enumerate(zip(columns, row)):
            if cell is None:
                continue
            kind = col["type"]
            if kind == "text":
                row[index] = text(cell)
            elif kind == "decimal":
                require(type(cell) is str and re.fullmatch(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?", cell), "decimal cell")
            elif kind == "integer":
                require(type(cell) is int and abs(cell) <= 2**53-1, "integer cell")
            elif kind == "number":
                try:
                    require(type(cell) in (float, int) and math.isfinite(cell), "number cell")
                except OverflowError as error:
                    raise Invalid("number cell") from error
            else:
                require(type(cell) is bool, "boolean cell")
    return value


def collect(stream, clean_png):
    require(len(stream) <= LIMIT, "aggregate frame bytes")
    result = {"tables": [], "charts": [], "findings": []}
    offset = text_bytes = clean_bytes = 0
    while offset + HEADER.size <= len(stream):
        kind, size = HEADER.unpack_from(stream, offset)
        offset += HEADER.size
        require(size <= len(stream) - offset, "frame length")
        payload = stream[offset:offset+size]
        offset += size
        if kind == 0:
            require(size == 0 and offset == len(stream), "trailing frames")
            return result
        if kind == 1:
            require(len(result["tables"]) < 8, "table count")
            value = table(payload)
            result["tables"].append(value)
            clean_bytes += len(encode(value))
        elif kind == 2:
            require(len(result["charts"]) < 4, "chart count")
            before = dimensions(payload)
            # Only the isolated decoder receives the compressed bytes.
            clean, pixels = clean_png(payload)
            require(dimensions(clean) == before, "clean chart dimensions")
            require(re.fullmatch(r"[a-f0-9]{64}", pixels) is not None, "pixel digest")
            result["charts"].append({"width": before[0], "height": before[1], "pixelSha256": pixels,
                                     "png": base64.b64encode(clean).decode("ascii")})
            clean_bytes += len(clean)
        elif kind == 3:
            text_bytes += size
            require(size > 0 and text_bytes <= 32768, "finding bytes")
            try:
                value = text(payload.decode("utf-8"))
            except UnicodeDecodeError as error:
                raise Invalid("finding UTF-8") from error
            result["findings"].append(value)
            clean_bytes += len(value.encode())
        else:
            raise Invalid("unknown frame kind")
        clean_bytes += HEADER.size
        require(clean_bytes + HEADER.size <= LIMIT, "clean output bytes")
    raise Invalid("missing terminal frame")
