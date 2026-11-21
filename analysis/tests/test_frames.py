from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))
import frames


def frame(kind, payload):
    return frames.HEADER.pack(kind, len(payload)) + payload


END = frame(0, b"")
TABLE = {"columns": [{"id": "part", "type": "text"}], "rows": [["<part>"]]}


def png(w=10, h=10):
    return frames.PNG + b"\0\0\0\rIHDR" + struct.pack(">II", w, h) + bytes(9)


class Frames(unittest.TestCase):
    def decode(self, stream, clean=None):
        return frames.collect(stream, clean or (lambda p: (p, "a"*64)))

    def test_renderable_text_and_typed_table(self):
        output = self.decode(frame(1, frames.encode(TABLE)) + frame(3, b'<finding>') + END)
        self.assertEqual(output["tables"][0]["rows"], [["&lt;part&gt;"]])
        self.assertEqual(output["findings"], ["&lt;finding&gt;"])

    def test_all_or_nothing(self):
        for data, msg in [(b'', 'terminal'), (END+b'!', 'trailing'), (frame(0,b'x'), 'trailing'),
                          (frame(3,b'x')[:-1], 'length'), (frame(17,b'<svg/>')+END, 'unknown'),
                          (frame(3,b'x'*32768)+frame(3,b'y')+END, 'finding bytes'),
                          (frame(3,b'x'*frames.LIMIT)+END, 'aggregate'),
                          (frame(1,frames.encode(TABLE))*9+END, 'table count'),
                          (frame(2,png())*5+END, 'chart count')]:
            with self.subTest(msg=msg), self.assertRaisesRegex(frames.Invalid, msg):
                self.decode(data)

    def test_dimensions_checked_before_decoder(self):
        for payload in (b'<svg/>', png(0, 1), png(2000001, 1)):
            with self.assertRaises(frames.Invalid):
                self.decode(frame(2,payload)+END, lambda _: self.fail('decoder received invalid dimensions'))
        self.assertEqual(frames.dimensions(png(2000,1000)), (2000,1000))
        with self.assertRaisesRegex(frames.Invalid, 'clean chart dimensions'):
            self.decode(frame(2,png())+END, lambda _: (png(1,1), "0"*64))

    def test_rejects_invalid_tables(self):
        col = TABLE["columns"][0]
        examples = [
            (TABLE | {"extra": 0}, "table shape"), (TABLE | {"columns": []}, "columns"),
            (TABLE | {"columns": [col]*33}, "columns"), (TABLE | {"rows": [[1]]*1001}, "rows"),
            (TABLE | {"columns": [col,col]}, "column id"), (TABLE | {"rows": [[]]}, "width"),
            (TABLE | {"columns": [col | {"type":"object"}]}, "column type"),
            (TABLE | {"columns": [col | {"id":"<x>"}]}, "column id"),
            (TABLE | {"rows":[[{}]]}, "plain text"),
        ]
        for kind, cell in [("integer",True), ("integer",2**53), ("number","2"),
                           ("decimal","1e4"), ("boolean",1)]:
            examples.append(({"columns":[dict(id="a",type=kind)], "rows":[[cell]]}, kind+" cell"))
        for value, msg in examples:
            with self.subTest(msg=msg), self.assertRaisesRegex(frames.Invalid,msg):
                self.decode(frame(1,frames.encode(value))+END)

    def test_cleaned_bytes_capped(self):
        with self.assertRaisesRegex(frames.Invalid, "clean output bytes"):
            self.decode(frame(2,png())+END, lambda _: (png()+b'x'*frames.LIMIT, '0'*64))
