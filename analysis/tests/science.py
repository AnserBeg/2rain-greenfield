"""Exercise the admitted scientific image and the host's real stream boundaries."""
import struct
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))
from execution import ROOT, RunBudget, Stopped, execute
from frames import DIAGNOSTICS, LIMIT, dimensions
from runtime import Engine


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


if __name__ == "__main__":
    engine = Engine()
    try:
        engine.preflight()
        prefix = "import sys;sys.stdin.buffer.read();"
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
        print("Stream boundaries, diagnostic and CPU carry-over, clean pixels, header refusal and guest environment passed.")
    finally:
        engine.close()
