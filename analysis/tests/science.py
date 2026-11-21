"""Exercise the admitted scientific image and the host's real stream boundaries."""
import json
import struct
import sys
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))
from execution import ROOT, RunBudget, Stopped, execute
from frames import DIAGNOSTICS, LIMIT, dimensions
from runtime import Engine, options, group_for
from worker import handle
from spike import PROBE, check_guest


def probe(script, data=b"", budget=None, limit=LIMIT):
    return execute(engine, "analysis-check-"+uuid.uuid4().hex, script, data,
                   lambda: False, lambda: None, budget=budget, limit=limit)


def rejects(script, why, **kwargs):
    try:
        probe(script, **kwargs)
    except Stopped as error:
        assert why in str(error), error
    else:
        raise AssertionError("expected " + why)


def interrupt_fixture(engine, request):
    # Only exercise the signal after observing the hardened sleeper in this
    # private PID namespace. Distinct exits identify a setup failure or an
    # unexpected permission separately from the charged guest failure.
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        (root / "guest.py").write_bytes((ROOT / "guest.py").read_bytes())
        (root / "fixture.py").write_text("""
import os, signal
from pathlib import Path
s = dict(x.split(':',1) for x in Path('/proc/1/status').read_text().splitlines() if ':' in x)
if int(s['Uid'].split()[0]) != 65533 or os.getuid() != 65534 or not int(s['SigIgn'],16) & 2:
    raise SystemExit(43)
try:
    os.kill(1, signal.SIGINT)
except PermissionError:
    raise SystemExit(42)
raise SystemExit(44)
""")
        with patch("worker.ROOT", root):
            return handle(engine, request)


if __name__ == "__main__":
    engine = Engine()
    try:
        engine.preflight()
        if sys.argv[1:] == ["--interrupt-fixture"]:
            print(json.dumps(interrupt_fixture(engine, json.load(sys.stdin))))
            sys.exit(0)
        prefix = "import sys;sys.stdin.buffer.read();"
        check_guest(json.loads(probe(prefix + PROBE)), uid=65534)
        assert len(probe(prefix+f"sys.stdout.buffer.write(b'x'*{LIMIT})")) == LIMIT
        rejects(prefix+f"sys.stdout.buffer.write(b'x'*{LIMIT+1})","output limit")
        budget = RunBudget()
        probe(prefix+f"sys.stderr.buffer.write(b'x'*{DIAGNOSTICS})",budget=budget)
        rejects(prefix+"sys.stderr.buffer.write(b'x')","diagnostic limit",budget=budget)
        rejects(prefix+"print('late')","cpu",budget=RunBudget(cpu=60))
        png = probe(prefix+"""
from PIL import Image,PngImagePlugin
meta=PngImagePlugin.PngInfo()
meta.add_text("private","discard-me")
Image.new('RGB',(2,3),'blue').save(sys.stdout.buffer,'PNG',pnginfo=meta)
""")
        cleaned = probe((ROOT/"clean_png.py").read_text(),png)
        assert dimensions(cleaned[32:]) == (2,3) and b'discard-me' not in cleaned
        from hashlib import sha256
        assert cleaned[:32] == sha256(bytes([0,0,255,255])*6).digest()
        rejects((ROOT/"clean_png.py").read_text(),"script exit",data=png[:33])
        rejects((ROOT/"clean_png.py").read_text(),"script exit",data=png[:16]+struct.pack(">II",2000001,1)+png[24:])
        environment = probe(prefix+"""
import importlib.util,os,shutil
assert not any(shutil.which(name) for name in ('sh','bash','pip','apt','psql','docker'))
assert not importlib.util.find_spec('pip') and not importlib.util.find_spec('ensurepip')
assert not any(k.startswith(('PG','GITHUB','AWS','DOCKER')) for k in os.environ)
print('clean')
""")
        assert environment == b'clean\n'
        job = str(uuid.uuid4())
        name = "analysis-job-" + job
        digest = json.loads((ROOT.parent/"image/profile.json").read_text())["image"]
        ident = engine.command("create", *options(name), "analysis.local/science@"+digest,
                               "-c", "import time; time.sleep(60)").decode().strip()
        try:
            engine.command("start",name)
            pid = engine.command("inspect","--format={{.State.Pid}}",name).decode().strip()
            group = group_for(pid,ident)
            reconciled = handle(engine,{"version":1,"op":"reconcile","job":job})
            assert reconciled == {"status":"hostFailure","launched":False}
            assert not group.exists()
            assert not engine.command("ps","-aq","--filter",f"name=^/{name}$").strip()
            late = handle(engine,{"version":1,"op":"run","job":job,"image":digest,"input":{"units":[3,6,9]},
                                  "lease":{"boot":Path("/proc/sys/kernel/random/boot_id").read_text().strip(),"until":0}})
            assert late["status"] == "refused" and not late["launched"]
        finally:
            if engine.command("ps","-aq","--filter",f"name=^/{name}$").strip():
                engine.command("rm","-fv",name)
        print("Stream boundaries, diagnostic and CPU carry-over, clean pixels, header refusal and guest environment passed.")
    finally:
        engine.close()
