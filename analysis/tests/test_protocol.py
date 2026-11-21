import io
import struct
import unittest
from pathlib import Path
import sys
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"runner"))
import worker
from frames import Invalid


class Protocol(unittest.TestCase):
    def test_bounded_request(self):
        data = worker.packet({"version":1,"op":"probe"})
        self.assertEqual(worker.read_packet(io.BytesIO(data),len(data)-4)["op"],"probe")
        for bad in (data[:2],data[:-1],data+b'!',struct.pack(">I",8193)):
            with self.assertRaises(Invalid):
                worker.read_packet(io.BytesIO(bad),8192)

    def test_closed_fixture_only_job_contract(self):
        engine=Mock()
        for request in [{"version":2,"op":"run"}, {"version":True,"op":"probe"},
                        {"version":1,"op":"run","job":"abc","image":"x","code":"print(0)"},
                        {"version":1,"op":"publish"}]:
            with self.assertRaises(Invalid):
                worker.handle(engine,request)
        engine.preflight.assert_not_called()
        result=worker.handle(engine,{"version":1,"op":"run","job":"abc","image":"mutable:tag","input":{"units":[3,6,9]}})
        self.assertEqual(result["status"],"refused")
