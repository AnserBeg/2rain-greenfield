"""Observe refusals at the production entry point, with a private stand-in cgroup."""
import json
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))
import execution
import runtime
import worker


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.group = root / "cgroup"
        self.group.mkdir()
        (self.group / "cpu.stat").write_text("usage_usec 100\n")
        self.folder = root / "jobs"
        self.engine = Mock()
        self.engine.command.return_value = b""
        for target, replacement in [
            ("worker.STATE", self.folder), ("execution.group_for", Mock(return_value=self.group)),
            ("execution.kill", Mock()), ("execution.teardown", Mock()),
        ]:
            self.enterContext(patch(target, replacement))
        self.request = {"version": 1, "op": "run", "job": str(uuid.uuid4()),
                        "image": json.loads(execution.PIN.read_text())["image"], "input": {"units": [3, 6, 9]},
                        "lease": {"boot": worker.BOOT.read_text().strip(), "until": 2**53}}

    def test_execute_refuses_before_sending_bytes(self):
        for gate in ("preflight", "limits", "guard"):
            with self.subTest(gate=gate), patch.object(execution, "stream") as stream:
                self.engine.reset_mock()
                self.engine.preflight.side_effect = runtime.Refusal("rootless") if gate == "preflight" else None

                def command(*args):
                    if args[0] == "exec" and gate == "guard":
                        self.assertEqual(args, ("exec", "--user", runtime.GUEST, "probe", "/usr/local/bin/python", "-c", execution.GUARD))
                        raise subprocess.CalledProcessError(1, "exec")
                    return b""

                self.engine.command.side_effect = command
                with patch.object(execution, "check_limits", side_effect=runtime.Refusal("memory.max") if gate == "limits" else None):
                    with self.assertRaisesRegex(runtime.Refusal, {"preflight":"rootless", "limits":"memory.max", "guard":"live guest isolation"}[gate]):
                        execution.execute(self.engine, "probe", "", b"", lambda: False, lambda: None)
                stream.assert_not_called()

    def test_cgroup_lost_after_launch_stays_charged(self):
        def lose_group(engine, name, script, data, group, budget, cancelled, launched, limit):
            launched()
            (group / "cpu.stat").unlink()
            group.rmdir()
            raise FileNotFoundError("cpu.stat")
        with patch.object(execution, "check_limits"), patch.object(execution, "stream", lose_group):
            result = worker.handle(self.engine, self.request)
        self.assertEqual((result["status"], result["launched"]), ("scriptFailure", True))
        self.assertIn("cgroup disappeared", result["reason"])

    def test_bad_host_value_after_launch_is_refunded(self):
        def bad_host_value(engine, name, script, data, cancel, launched, budget):
            launched()
            raise ValueError("malformed host inspection")
        with patch.object(worker, "execute", bad_host_value):
            result = worker.handle(self.engine, self.request)
        self.assertEqual((result["status"], result["launched"]), ("hostFailure", True))

    def test_recovery_and_ack_without_a_live_container(self):
        job = self.request["job"]
        worker.directory()
        path = self.folder / (job + ".json")
        worker.write_state(path, {"status":"active","launched":True})
        op = {"version":1,"job":job}
        worker.handle(self.engine, op | {"op":"cancel"})
        self.assertTrue(path.with_suffix(".cancel").exists())
        self.assertEqual(worker.handle(self.engine, op | {"op":"reconcile"}),
                         {"status":"scriptFailure","launched":True})
        for operation in ("ack", "ack", "cancel"):
            worker.handle(self.engine, op | {"op":operation})
        self.assertFalse(list(self.folder.glob(job + ".*")))
        self.request["lease"]["until"] = 0
        self.assertEqual(worker.handle(self.engine, self.request)["reason"], "dispatch lease expired")
