"""Bounded duplex I/O to a disposable worker or PNG decoder."""
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import selectors
import subprocess
import time

from frames import DIAGNOSTICS, LIMIT
from runtime import Refusal, check_limits, cpu_seconds, group_for, kill, options, stop_reason, teardown

ROOT = Path(__file__).resolve().parent
PIN = ROOT.parent / "image/profile.json"
GUARD = """
import errno, os, socket
from pathlib import Path
def need(ok, name):
    if not ok: raise SystemExit(name)
status = dict(x.split(':',1) for x in Path('/proc/self/status').read_text().splitlines() if ':' in x)
need(os.getuid()==65534 and int(status['CapBnd'],16)==0 and int(status['NoNewPrivs'])==1, 'guest privileges')
need(os.statvfs('/').f_flag & os.ST_RDONLY, 'read-only root')
tmp=os.statvfs('/tmp')
need(tmp.f_blocks*tmp.f_frsize==134217728 and all(tmp.f_flag & f for f in [os.ST_NOEXEC,os.ST_NOSUID,os.ST_NODEV]), 'private bounded scratch')
need(os.listdir('/sys/class/net')==['lo'], 'external interface')
for family in (socket.AF_INET,socket.AF_INET6,socket.AF_UNIX):
    try: socket.socket(family)
    except OSError as err: need(err.errno==errno.EPERM, 'socket filter')
    else: raise SystemExit('socket filter')
"""


class Stopped(RuntimeError):
    pass


@dataclass
class RunBudget:
    start: float = field(default_factory=time.monotonic)
    cpu: float = 0
    diagnostic_bytes: int = 0


def stream(engine, name, script, data, group, budget, cancelled, on_launch, limit):
    cli = engine.cli + ["exec", "-i", name, "/usr/local/bin/python", "-B", "-u", "-c", script]
    child = subprocess.Popen(cli, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={"PATH": os.defpath}, bufsize=0)
    output = bytearray()
    diagnostic_limit = DIAGNOSTICS - budget.diagnostic_bytes
    diagnostics = bytearray()
    pos = 0
    try:
        with selectors.DefaultSelector() as selector:
            for pipe, mask in [(child.stdin, selectors.EVENT_WRITE), (child.stdout, selectors.EVENT_READ),
                               (child.stderr, selectors.EVENT_READ)]:
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, mask)
            while True:
                reason = stop_reason(budget.start, budget.cpu + cpu_seconds(group), cancelled())
                if reason:
                    raise Stopped(reason)
                if not selector.get_map() and child.poll() is not None:
                    break
                for key, _ in selector.select(.04):
                    pipe = key.fileobj
                    if pipe is child.stdin:
                        if pos < len(data):
                            pos += os.write(pipe.fileno(), memoryview(data)[pos:pos+65536])
                        if pos == len(data):
                            # The fixed bootstrap waits for EOF before interpreting any bytes.
                            on_launch()
                            selector.unregister(pipe)
                            pipe.close()
                    else:
                        dest, cap = (output, limit) if pipe is child.stdout else (diagnostics, diagnostic_limit)
                        chunk = os.read(pipe.fileno(), min(65536, cap - len(dest) + 1))
                        if not chunk:
                            selector.unregister(pipe)
                        elif len(dest) + len(chunk) > cap:
                            raise Stopped("output limit" if pipe is child.stdout else "diagnostic limit")
                        else:
                            dest.extend(chunk)
        events = dict(row.split() for row in (group / "memory.events").read_text().splitlines())
        if int(events["oom_kill"]):
            raise Stopped("memory limit")
        if child.returncode:
            # Guest diagnostics remain private, including on refusal.
            raise Stopped(f"script exit {child.returncode}")
        return bytes(output)
    finally:
        budget.diagnostic_bytes += len(diagnostics)
        for pipe in (child.stdin, child.stdout, child.stderr):
            pipe.close()
        child.kill()
        child.wait(timeout=5)


def execute(engine, name, script, data, cancelled, on_launch, budget=None, limit=LIMIT):
    budget = budget or RunBudget()
    digest = json.loads(PIN.read_text())["image"]
    engine.preflight()
    if cancelled():
        raise Stopped("cancelled")
    group = None
    container_id = engine.command("create", *options(name), digest, "-c",
                                  "import time; time.sleep(120)").decode().strip()
    try:
        engine.command("start", name)
        pid = engine.command("inspect", "--format={{.State.Pid}}", name).decode().strip()
        group = group_for(pid, container_id)
        check_limits(group)
        try:
            engine.command("exec", name, "/usr/local/bin/python", "-c", GUARD)
        except subprocess.SubprocessError as error:
            raise Refusal("live guest isolation") from error
        return stream(engine, name, script, data, group, budget, cancelled, on_launch, limit)
    finally:
        try:
            if group is not None and group.exists():
                budget.cpu += cpu_seconds(group)
                kill(engine, name, group)
        finally:
            teardown(engine, name, group)
