"""Capability gate. Launch only fixed probes, sequentially, including in controls."""
import contextlib
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))
import runtime


def expect(condition, reason):
    if not condition:
        raise AssertionError(reason)


@contextlib.contextmanager
def container(engine, omit=None, suffix=()):
    name = "analysis-probe-" + uuid.uuid4().hex
    flags = [flag for flag in runtime.options(name) if flag != omit]
    container_id = engine.command("create", *flags, *suffix, runtime.BASE, "python", "-c",
                                  "import time; time.sleep(240)").decode().strip()
    group = None
    try:
        engine.command("start", name)
        pid = engine.command("inspect", "--format={{.State.Pid}}", name).decode().strip()
        group = runtime.group_for(pid, container_id)
        yield name, group
    finally:
        runtime.teardown(engine, name, group)


def guest(engine, name, source):
    try:
        return engine.command("exec", name, "python", "-c", source, timeout=20).decode().strip()
    except subprocess.CalledProcessError as error:
        raise RuntimeError(error.stderr.decode()[-1000:]) from error


PROBE = """
import errno, json, os, socket
from pathlib import Path
result = {"interfaces": sorted(os.listdir('/sys/class/net')), "uid": os.getuid()}
for family in [socket.AF_UNIX, socket.AF_INET, socket.AF_INET6]:
    try:
        with socket.socket(family): pass
    except OSError as err:
        result[family.name] = err.errno
    else:
        result[family.name] = 0
try:
    socket.getaddrinfo("example.com", 443)
except socket.gaierror as err:
    result["dns"] = err.errno
else:
    result["dns"] = 0
status = dict(row.split(":", 1) for row in Path('/proc/self/status').read_text().splitlines() if ":" in row)
result.update(caps=int(status['CapEff'], 16), nnp=int(status['NoNewPrivs']))
try:
    Path("/rootfs-probe").touch()
except OSError as err:
    result["rootfs"] = err.errno
result["scratch"] = os.statvfs('/tmp').f_blocks * os.statvfs('/tmp').f_frsize
result["fresh"] = not Path('/tmp/probe-marker').exists()
Path('/tmp/probe-marker').write_text('private scratch')
print(json.dumps(result))
"""


def check_guest(data):
    expect(data["interfaces"] == ["lo"], "network namespace has an external interface")
    for key in ("AF_INET", "AF_INET6", "AF_UNIX"):
        expect(data[key] == 1, f"{key} socket allowed")
    expect(data["dns"] != 0, "DNS resolved")
    expect(data["uid"] == 65534, "unexpected guest UID")
    expect(data["caps"] == 0, "effective capabilities")
    expect(data["nnp"] == 1, "no-new-privileges missing")
    expect(data["rootfs"] == 30, "writable root filesystem")
    expect(data["fresh"] and data["scratch"] == 128 * 1024**2, "scratch not fresh and bounded")


def state(engine, name):
    return json.loads(engine.command("inspect", "--format={{json .State}}", name))


def killed(engine, name, group):
    engine.command("kill", name)
    observed = state(engine, name)
    expect(not observed["Running"] and observed["ExitCode"] == 137, "container survived kill")
    expect(not group.exists() or not (group / "cgroup.procs").read_text().strip(), "tasks survived kill")


def limits_under_load(engine):
    with container(engine) as (name, group):
        runtime.check_limits(group)
        data = json.loads(guest(engine, name, PROBE))
        check_guest(data)
        print("Isolation:", json.dumps(data))
        count = guest(engine, name, """
import errno, subprocess
children = []
try:
    for _ in range(33):
        children.append(subprocess.Popen(['sleep', '20']))
except OSError as err:
    assert err.errno == errno.EAGAIN
finally:
    for child in children: child.kill()
    for child in children: child.wait()
print(len(children))
""")
        events = dict(line.split() for line in (group / "pids.events").read_text().splitlines())
        expect(int(count) < 32 and int(events["max"]) > 0, "pids limit did not refuse a child")
        print("pids.max=32, children started before EAGAIN:", count)
        # Fail the allocation inside the disposable cgroup. This is a bounded fixed fixture.
        engine.command("exec", "--detach", name, "python", "-c", "a = bytearray(1088 * 1024**2)")
        end = time.monotonic() + 15
        while group.exists() and time.monotonic() < end:
            events = dict(row.split() for row in (group / "memory.events").read_text().splitlines())
            if int(events["oom_kill"]):
                print("memory.max=1073741824, effective swap=0, memory.events:", events)
                break
            time.sleep(.1)
        else:
            expect(state(engine, name)["OOMKilled"], "memory limit produced no OOM kill")


def timed_stop(engine, expected, limit, exercise=True):
    with container(engine) as (name, group):
        runtime.check_limits(group)
        started = time.monotonic()
        if expected == "cpu":
            # Two independent finite workers exercise aggregate accounting and quota throttling.
            for _ in range(2):
                engine.command("exec", "-d", name, "python", "-c",
                               "import time\ne=time.monotonic()+75\nwhile time.monotonic()<e: pass")
        while True:
            elapsed = time.monotonic() - started
            seconds = runtime.cpu_seconds(group)
            reason = runtime.stop_reason(started, seconds, expected == "cancelled",
                                         wall_limit=limit if expected == "deadline" else 90,
                                         cpu_limit=limit if expected == "cpu" else 60) if exercise else None
            if reason == expected:
                if expected == "cpu":
                    stats = dict(row.split() for row in (group / "cpu.stat").read_text().splitlines())
                    expect(int(stats["nr_throttled"]) > 0, "CPU quota did not throttle")
                killed(engine, name, group)
                print(f"{reason}: killed at wall={elapsed:.3f}s aggregateCPU={seconds:.3f}s")
                return
            expect(elapsed < limit + 5, f"{expected} termination missing")
            time.sleep(.05)


def red(check, message):
    try:
        check()
    except (AssertionError, runtime.Refusal) as error:
        expect(message in str(error), f"unexpected control failure: {error}")
        print("Expected red:", error)
        return
    raise AssertionError("control survived: " + message)


def controls(engine):
    def check(omit, probe=False, suffix=()):
        with container(engine, omit, suffix) as (name, group):
            if probe:
                check_guest(json.loads(guest(engine, name, PROBE)))
            else:
                runtime.check_limits(group)

    for omit, reason in [("--memory=1g", "memory.max observed"), ("--pids-limit=32", "pids.max observed"),
                         ("--cpus=1", "cpu.max observed")]:
        red(lambda: check(omit), reason)
    red(lambda: check("--network=none", True), "external interface")
    red(lambda: check(f"--security-opt=seccomp={runtime.PROFILE}", True), "AF_INET socket allowed")
    red(lambda: check("--security-opt=no-new-privileges", True), "no-new-privileges missing")
    # A missing cancellation/deadline/aggregate-CPU branch must leave the live job running.
    for reason in ["cancelled", "deadline", "cpu"]:
        red(lambda: timed_stop(engine, reason, 1, exercise=False), f"{reason} termination missing")
    with container(engine) as (name, group):
        # Observe that skipping either kill or removal leaves the respective postcondition false.
        red(lambda: expect(not state(engine, name)["Running"], "container survived kill"), "survived kill")
        killed(engine, name, group)
        red(lambda: expect(not engine.command("ps", "-aq", "--filter", f"name=^/{name}$").strip(),
                           "container survived removal"), "survived removal")


if __name__ == "__main__":
    engine = runtime.Engine()
    try:
        engine.preflight()
        print(engine.command("pull", runtime.BASE, timeout=120).decode())
        limits_under_load(engine)
        timed_stop(engine, "cpu", 60)
        timed_stop(engine, "deadline", 90)
        timed_stop(engine, "cancelled", 1)
        controls(engine)
        print("Rootless capability gate passed with no retained job.")
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.stderr.decode() or str(error))
    finally:
        engine.close()
