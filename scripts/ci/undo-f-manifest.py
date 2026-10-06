"""Producer/consumer SHA-256 manifest; no missing-file or stub fallback."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

SOURCE = "e10955dc5977f1ba7c65cb1518cb8f4b1679fe92"
mode, directory, *expected = sys.argv[1:]
directory = Path(directory)
manifest = directory / "manifest.json"


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


if mode == "create":
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == SOURCE
    assert not manifest.exists()
    files = sorted(p for p in directory.rglob("*") if p.is_file())
    assert files and all(not p.is_symlink() for p in files)
    inputs = ["Cargo.toml", "Cargo.lock", ".cargo/config.toml", "rust-toolchain.toml", "client/pnpm-lock.yaml"]
    record = {"source_sha": SOURCE, "workflow_sha": os.environ["GITHUB_SHA"],
              "tool_versions": {name: subprocess.check_output(command, text=True).strip() for name, command in
                                {"rustc": ["rustc", "-Vv"], "cargo": ["cargo", "-V"]}.items()},
              "input_sha256": {p: sha(Path(p)) for p in inputs},
              "files": {str(p.relative_to(directory)): {"bytes": p.stat().st_size, "sha256": sha(p)} for p in files},
              "scope": "functional validation; new Undo WASM behavior/browser/RTC NOT RUN"}
    manifest.write_text(json.dumps(record, indent=2) + "\n")
elif mode == "verify":
    assert len(expected) in (1, 2) and sha(manifest) == expected[0], "producer manifest digest mismatch"
    record = json.loads(manifest.read_text())
    producer = expected[1] if len(expected) == 2 else os.environ["GITHUB_SHA"]
    assert len(producer) == 40 and all(c in "0123456789abcdef" for c in producer)
    assert record["source_sha"] == SOURCE and record["workflow_sha"] == producer
    assert record["files"]
    for name, identity in record["files"].items():
        relative = Path(name)
        assert not relative.is_absolute() and ".." not in relative.parts
        p = directory / relative
        assert p.is_file() and not p.is_symlink(), "missing artifact file: " + name
        assert p.stat().st_size == identity["bytes"] and sha(p) == identity["sha256"], "artifact mismatch: " + name
else:
    raise ValueError(mode)
print(sha(manifest))
