"""Length-prefixed protocol v1 on stdin/stdout, also usable as an SSH forced command."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
import uuid

from execution import ROOT, PIN, execute, Stopped, RunBudget
from frames import CODE_LIMIT, Invalid, collect, encode, parse, require
from runtime import ContainerGone, Engine, Refusal, TeardownUnconfirmed, group_for, kill, teardown

STATE = Path(f"/run/user/{os.getuid()}/analysis-jobs")
MAX_REQUEST = 8192
MAX_RESPONSE = 8 * 1024**2
BOOT = Path("/proc/sys/kernel/random/boot_id")


def read_packet(stream, limit):
    prefix = stream.read(4)
    require(len(prefix) == 4, "protocol header")
    size, = struct.unpack(">I", prefix)
    require(0 < size <= limit, "protocol length")
    payload = stream.read(size)
    require(len(payload) == size and not stream.read(1), "protocol truncation or trailing bytes")
    return parse(payload)


def packet(value):
    body = encode(value)
    return struct.pack(">I", len(body)) + body


def directory():
    STATE.mkdir(mode=0o700, exist_ok=True)
    st = STATE.lstat()
    if not STATE.is_dir() or STATE.is_symlink() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Refusal("private lease directory")
    return STATE


def write_state(path, value):
    temporary = path.with_suffix(".new")
    temporary.write_bytes(encode(value))
    os.replace(temporary, path)


def read_state(path):
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    return parse(data)


def host_info(engine):
    engine.preflight()
    digest = json.loads(PIN.read_text())["image"]
    try:
        engine.command("image", "inspect", "--format={{.Id}}", "analysis.local/science@" + digest)
    except subprocess.SubprocessError as error:
        raise Refusal("missing admitted scientific image " + digest) from error
    fields = Path("/proc/meminfo").read_text().splitlines()
    available = next(int(s.split()[1])*1024 for s in fields if s.startswith("MemAvailable:"))
    return {"machine": Path("/etc/machine-id").read_text().strip(), "available": available, "boot": BOOT.read_text().strip(),
            "tick": time.monotonic(), "image": json.loads(PIN.read_text())["image"]}


def reap(engine, name):
    stopped_live_job = False
    ids = engine.command("ps", "-aq", "--filter", "label=org.2rain.analysis=1",
                         "--filter", f"name=^/{name}$").decode().split()
    for ident in ids:
        state = json.loads(engine.command("inspect", "--format={{json .State}}", ident))
        group = group_for(state["Pid"], engine.command("inspect","--format={{.Id}}",ident).decode().strip()) if state["Running"] else None
        if group is not None:
            try:
                kill(engine, name, group)
                stopped_live_job = True
            except ContainerGone:
                pass
        teardown(engine, ident, group)
    if engine.command("ps","-aq","--filter",f"name=^/{name}$").strip():
        raise Refusal("orphan teardown")
    return stopped_live_job


def handle(engine, request):
    require(type(request) is dict and type(request.get("version")) is int and request["version"] == 1, "protocol version")
    op = request.get("op")
    if op == "probe" and request.keys() == {"version","op"}:
        return host_info(engine)
    require(op in ("run", "cancel", "status", "reconcile", "ack") and
            request.keys() == ({"version","op","job","image","input","lease"} if op == "run" else {"version","op","job"}), "protocol operation")
    if op == "run":
        require(encode(request.get("input")) == b'{"units":[3,6,9]}', "fixed fixture input")
        if request["image"] != json.loads(PIN.read_text())["image"]:
            return {"status":"refused","launched":False,"reason":"unadmitted image digest"}
        lease = request["lease"]
        require(type(lease) is dict and lease.keys() == {"boot", "until"} and
                type(lease["until"]) is int and type(lease["boot"]) is str, "dispatch lease")
    job = str(uuid.UUID(request["job"]))
    require(job == request["job"], "canonical job id")
    engine.preflight()
    folder = directory()
    path = folder / (job + ".json")
    cancel = folder / (job + ".cancel")
    name = "analysis-job-" + job
    if op == "status":
        return read_state(path) or {"status":"absent", "launched":False}
    # One permanent inode. POSIX byte locks consume no file data and the kernel
    # releases them on worker exit. Ack and cancel also serialize marker edits.
    offset = (uuid.UUID(job).int % (1 << 61)) * 2
    with (folder / ".locks").open("ab") as lock:
        if op == "cancel":
            fcntl.lockf(lock, fcntl.LOCK_EX, 1, offset + 1)
            if (read_state(path) or {}).get("status") == "active":
                cancel.touch(mode=0o600)
            return {"status":"cancelling"}
        try:
            fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, offset)
        except BlockingIOError:
            return {"status":"active"}
        previous = read_state(path)
        if op == "ack":
            fcntl.lockf(lock, fcntl.LOCK_EX, 1, offset + 1)
            for suffix in (".json", ".cancel", ".new", ".lock"):
                path.with_suffix(suffix).unlink(missing_ok=True)
            return {"status":"acknowledged"}
        if previous is not None and previous["status"] != "active":
            return previous
        if op == "run" and previous is None and (lease["boot"] != BOOT.read_text().strip() or
                            time.monotonic_ns() // 1_000_000 > lease["until"]):
            return {"status":"refused","launched":False,"reason":"dispatch lease expired"}
        if op == "reconcile" or previous is not None:
            killed = [reap(engine, label) for label in (name, name+"-png")]
            launched_before = bool(previous and previous["launched"])
            status = "scriptFailure" if launched_before and not any(killed) else "hostFailure"
            value = {"status":status,"launched":launched_before}
            if previous is not None:
                write_state(path,value)
            return value
        code = (ROOT / "fixture.py").read_bytes()
        require(len(code) <= CODE_LIMIT, "code bytes")
        state = {"status":"active","launched":False}
        write_state(path, state)
        def launched():
            state["launched"] = True
            write_state(path, state)
        budget = RunBudget()
        try:
            input_bytes = encode(request["input"])
            guest_input = struct.pack(">I",len(input_bytes)) + input_bytes + code
            raw = execute(engine,name,(ROOT/"guest.py").read_text(),guest_input,cancel.exists,launched,budget)
            def clean(data):
                out = execute(engine,name+"-png",(ROOT/"clean_png.py").read_text(),data,cancel.exists,
                              lambda: None,budget,limit=4*1024**2+32)
                return out[32:], out[:32].hex()
            output = collect(raw,clean)
            if cancel.exists():
                raise Stopped("cancelled")
            profile = json.loads(PIN.read_text())
            cpu = Path("/proc/cpuinfo").read_text().split("\n\n",1)[0].splitlines()
            features = next(row.split(":",1)[1].strip() for row in cpu if row.startswith("flags"))
            receipt = {"code":code.decode(), "codeSha256":hashlib.sha256(code).hexdigest(),
                       "profile":profile, "cpuClass":hashlib.sha256(features.encode()).hexdigest(),
                       "parameters":{}, "inputSha256":hashlib.sha256(input_bytes).hexdigest(), "modelCallDisclosureDigests":[],
                       "seed":1, "threads":1, "timezone":"UTC","locale":"C.UTF-8","solver":"optimal",
                       "outputSha256":hashlib.sha256(encode([output["tables"], output["findings"],
                                      [c["pixelSha256"] for c in output["charts"]]])).hexdigest()}
            state.update(status="success",receipt=receipt,output=output)
        except (Invalid, Stopped, ContainerGone) as error:
            state.update(status="scriptFailure" if state["launched"] else "refused", reason=str(error)[:200])
        except (Refusal, OSError, subprocess.SubprocessError, ValueError) as error:
            # No host refund until orphan absence is verified.
            for label in (name,name+"-png"):
                reap(engine,label)
            state.update(status="hostFailure", reason=str(error)[:200])
        write_state(path,state)
        return state


if __name__ == "__main__":
    engine = Engine()
    request = {}
    try:
        request = read_packet(sys.stdin.buffer,MAX_REQUEST)
        response = handle(engine,request)
        wire = packet(response)
        require(len(wire) <= MAX_RESPONSE+4, "response bytes")
        sys.stdout.buffer.write(wire)
    except (Refusal, TeardownUnconfirmed, OSError, subprocess.SubprocessError) as error:
        # A lost daemon or unverifiable teardown cannot release an active lease.
        uncertain = isinstance(request, dict) and request.get("op") in ("run","reconcile","ack")
        sys.stdout.buffer.write(packet({"status":"unreconciled" if uncertain else "refused","reason":str(error)[:200]}))
    except (Invalid, ValueError, KeyError, TypeError) as error:
        sys.stdout.buffer.write(packet({"status":"invalidRequest","reason":str(error)[:200]}))
    finally:
        engine.close()
