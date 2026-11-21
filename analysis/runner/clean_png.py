"""Executed only in a fresh credential-free collector container."""
import hashlib
import io
import struct
import sys

from PIL import Image

raw = sys.stdin.buffer.read(4 * 1024**2 + 1)
if len(raw) > 4 * 1024**2 or raw[:16] != b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR":
    raise ValueError("PNG header")
width, height = struct.unpack_from(">II", raw, 16)
if not width or not height or width * height > 2_000_000:
    raise ValueError("PNG dimensions")
Image.MAX_IMAGE_PIXELS = 2_000_000
with Image.open(io.BytesIO(raw), formats=["PNG"]) as image:
    if image.size != (width, height) or image.is_animated:
        raise ValueError("static PNG required")
    pixels = image.convert("RGBA").tobytes()
# Reconstruct from pixels. Ancillary chunks and image metadata cannot survive.
out = sys.stdout.buffer
out.write(hashlib.sha256(pixels).digest())
Image.frombytes("RGBA", (width, height), pixels).save(out, format="PNG")
