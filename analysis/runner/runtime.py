"""The local, rootless-only linux/amd64 execution boundary."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

BASE = "python@sha256:0f086103b026048cc50cb5da25ec435c023c5241a83fc44daea593377abc61c4"
PROFILE = Path(__file__).with_name("seccomp.json")
CGROUP = Path("/sys/fs/cgroup")


class Refusal(RuntimeError):
    def __init__(self, capability):
        super().__init__("ANALYSIS_RUNTIME_UNAVAILABLE " + capability)


class Engine:
    def __init__(self):
        self.config = tempfile.TemporaryDirectory(prefix="analysis-docker-")
        self.cli = ["docker", "--config", self.config.name, "--host",
                    f"unix:///run/user/{os.getuid()}/docker.sock"]

    def command(self, *args, **kwargs):
        return subprocess.run(self.cli + list(args), check=True, capture_output=True,
                              timeout=kwargs.pop("timeout", 15), env={"PATH": os.defpath},
                              **kwargs).stdout

    def preflight(self):
        try:
            info = json.loads(self.command("info", "--format", "{{json .}}"))
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            raise Refusal("rootless Docker user socket " + self.cli[-1]) from error
        for present, capability in [
            ("name=rootless" in (info.get("SecurityOptions") or []), "rootless daemon"),
            (info.get("OSType") == "linux" and info.get("Architecture") in ("amd64", "x86_64"), "linux/amd64"),
            (info.get("CgroupVersion") == "2" and info.get("CgroupDriver") == "systemd", "systemd cgroup v2"),
            (info.get("MemoryLimit") and info.get("PidsLimit") and info.get("CpuCfsQuota"), "delegated memory, pids and cpu"),
        ]:
            if not present:
                raise Refusal(capability)

    def close(self):
        self.config.cleanup()


def options(name):
    return ["--name", name, "--label", "org.2rain.analysis=1", "--pull=never",
            "--platform=linux/amd64", "--user=65534:65534", "--read-only",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
            "--ipc=none", "--network=none", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", f"--security-opt=seccomp={PROFILE}",
            "--cgroup-parent=analysis.slice", "--cpus=1", "--memory=1g", "--pids-limit=32",
            "--log-driver=none", "--workdir=/tmp"]


def group_for(pid, container_id):
    for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines():
        if line.startswith("0::"):
            path = CGROUP / line[3:].lstrip("/")
            if path.name == f"docker-{container_id}.scope" and ".." not in path.parts:
                return path
    raise Refusal("private analysis cgroup")


def check_limits(group):
    for filename, expected in [("memory.max", "1073741824"), ("pids.max", "32")]:
        actual = (group / filename).read_text().strip()
        if actual != expected:
            raise Refusal(f"{filename} observed {actual}, expected {expected}")
    quota, period = (group / "cpu.max").read_text().split()
    if quota == "max" or int(quota) != int(period):
        raise Refusal(f"cpu.max observed {quota} {period}, expected one CPU")
    if not any((parent / "memory.swap.max").read_text().strip() == "0"
               for parent in (group, *group.parents)
               if parent != CGROUP and CGROUP in parent.parents):
        raise Refusal("memory.swap.max expected zero effective swap")


def cpu_seconds(group):
    stats = dict(line.split() for line in (group / "cpu.stat").read_text().splitlines())
    return int(stats["usage_usec"]) / 1_000_000


def stop_reason(start, cpu, cancelled, now=time.monotonic, wall_limit=90, cpu_limit=60):
    if cancelled:
        return "cancelled"
    if now() - start >= wall_limit:
        return "deadline"
    if cpu >= cpu_limit:
        return "cpu"
    return None


def kill(engine, name, group):
    engine.command("kill", name)
    state = json.loads(engine.command("inspect", "--format={{json .State}}", name))
    if state["Running"] or state["ExitCode"] != 137:
        raise Refusal("container survived kill")
    if group.exists() and (group / "cgroup.procs").read_text().strip():
        raise Refusal("tasks survived kill")


def teardown(engine, name, group):
    engine.command("rm", "--force", "--volumes", name)
    remaining = engine.command("ps", "--all", "--quiet", "--filter", f"name=^/{name}$")
    if remaining.strip() or (group is not None and group.exists()):
        raise Refusal("container or cgroup survived removal")


if __name__ == "__main__":
    engine = Engine()
    try:
        engine.preflight()
        print("Rootless Docker preflight passed")
    except Refusal as error:
        raise SystemExit(str(error))
    finally:
        engine.close()
