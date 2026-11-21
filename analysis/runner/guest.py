"""Trusted bootstrap; only the fixed fixture is admitted in slice 1a."""
import json
import struct
import sys

input_size, = struct.unpack(">I",sys.stdin.buffer.read(4))
if input_size > 1024:
    raise ValueError("fixture input bytes")
fixture = json.loads(sys.stdin.buffer.read(input_size))
code = sys.stdin.buffer.read(65537)
if len(code) > 65536:
    raise ValueError("code bytes")
result = sys.stdout.buffer
sys.stdout = sys.stderr


def frame(kind, payload):
    result.write(struct.pack(">BI", kind, len(payload)))
    result.write(payload)
    result.flush()


exec(compile(code, "fixture.py", "exec"), {
    "fixture": fixture,
    "emit_table": lambda value: frame(1, json.dumps(value, allow_nan=False).encode()),
    "emit_png": lambda png: frame(2, png),
    "emit_text": lambda finding: frame(3, finding.encode()),
})
frame(0, b"")
