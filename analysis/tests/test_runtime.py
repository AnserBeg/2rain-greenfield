"""Admission tests independent of a local container daemon."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))
import runtime


class RootlessAdmission(unittest.TestCase):
    def setUp(self):
        self.engine = runtime.Engine()
        self.addCleanup(self.engine.close)
        self.info = dict(SecurityOptions=["name=rootless"], OSType="linux", Architecture="x86_64",
                         CgroupVersion="2", CgroupDriver="systemd", CpuCfsQuota=True,
                         MemoryLimit=True, PidsLimit=True)

    def test_reachable_user_daemon_requires_every_capability(self):
        with patch.object(self.engine, "command", return_value=json.dumps(self.info)):
            self.engine.preflight()
        for key, value, reason in [
            ("SecurityOptions", ["name=seccomp,profile=builtin"], "rootless daemon"),
            ("OSType", "windows", "linux/amd64"), ("Architecture", "aarch64", "linux/amd64"),
            ("CgroupVersion", "1", "cgroup v2"), ("CgroupDriver", "none", "cgroup v2"),
            ("MemoryLimit", False, "delegated memory"), ("CpuCfsQuota", False, "delegated memory"),
            ("PidsLimit", False, "delegated memory"),
        ]:
            with self.subTest(key=key), patch.object(self.engine, "command", return_value=json.dumps(
                    self.info | {key: value})), self.assertRaisesRegex(runtime.Refusal, reason):
                self.engine.preflight()

    def test_unavailable_socket_refuses_without_fallback(self):
        with patch.dict("os.environ", {"DOCKER_HOST": "unix:///var/run/docker.sock",
                                       "DOCKER_CONTEXT": "default"}), patch.object(
                subprocess, "run", side_effect=FileNotFoundError) as invoked:
            with self.assertRaisesRegex(runtime.Refusal, "ANALYSIS_RUNTIME_UNAVAILABLE rootless Docker user socket"):
                self.engine.preflight()
            invoked.assert_called_once()
            args, kwargs = invoked.call_args
            self.assertIn(f"unix:///run/user/{runtime.os.getuid()}/docker.sock", args[0])
            self.assertNotIn("DOCKER_HOST", kwargs["env"])
            self.assertNotIn("DOCKER_CONTEXT", kwargs["env"])

    def test_monotonic_budget_boundaries(self):
        self.assertIsNone(runtime.stop_reason(8, 59.999, False, now=lambda: 97.999))
        self.assertEqual("cpu", runtime.stop_reason(8, 60, False, now=lambda: 8))
        self.assertEqual("deadline", runtime.stop_reason(8, 1, False, now=lambda: 98))
        self.assertEqual("cancelled", runtime.stop_reason(8, 1, True, now=lambda: 8))
