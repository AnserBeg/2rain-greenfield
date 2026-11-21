"""Rebuild the single-platform OCI archive and admit only the reviewed digest."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))
from runtime import Engine, Refusal

HERE = Path(__file__).resolve().parent
PIN = HERE / "profile.json"


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def build():
    engine = Engine()
    try:
        engine.preflight()
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / "image.tar"
            # The built-in BuildKit worker uses the rootless engine. A fixed epoch
            # normalizes both OCI metadata and file timestamps in the final layer.
            engine.command("buildx", "build", "--platform=linux/amd64", "--provenance=false",
                           "--build-arg=SOURCE_DATE_EPOCH=0",
                           "--output", f"type=oci,name=analysis.local/science:locked,dest={archive},rewrite-timestamp=true",
                           str(HERE), timeout=600)
            with tarfile.open(archive) as oci:
                index = json.load(oci.extractfile("index.json"))
                descriptor, = index["manifests"]
                manifest_digest = descriptor["digest"]
                manifest = oci.extractfile("blobs/sha256/" + manifest_digest[7:]).read()
                assert sha(manifest) == manifest_digest
                config = json.loads(manifest)["config"]["digest"]
            profile = dict(protocol=1, manifest=manifest_digest, image=config,
                           wheels=sha((HERE / "wheels.lock").read_bytes()))
            print("Measured OCI profile:", json.dumps(profile, sort_keys=True), flush=True)
            if not PIN.exists() or profile != json.loads(PIN.read_text()):
                raise Refusal("review the measured image digest before admission")
            engine.command("load", "--input", str(archive), timeout=150)
            if engine.command("image", "inspect", "--format={{.Id}}", config).decode().strip() != config:
                raise Refusal("loaded image digest mismatch")
    finally:
        engine.close()


if __name__ == "__main__":
    import subprocess
    try:
        build()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.stderr.decode()[-8000:])
