"""Same-run artifact identities tied to fixed source and explicit build settings."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

SOURCE = "f48a0d6ee0b143e4ec15b482249a70c932f7bde5"
SETTINGS = {"toolchain": "nightly-2026-04-19", "target": "wasm32-unknown-unknown",
            "profile": "tool", "opt_level": 0, "debug": 0, "incremental": False,
            "lto": "off", "codegen_units": 16, "jobs": 1, "stack_bytes": 16777216,
            "wasm_bindgen": "0.2.121", "bindings_target": "web"}
INPUTS = ["Cargo.toml", "Cargo.lock", ".cargo/config.toml", "rust-toolchain.toml",
          "crates/engine-wasm/src/fixtures/host-precast-card-data.json"]
REQUIRED = {"engine_wasm.js", "engine_wasm_bg.wasm", "engine_wasm.d.ts",
            "engine_wasm_bg.wasm.d.ts", "package.json"}
mode, directory, *expected = sys.argv[1:]
directory = Path(directory)
manifest = directory / "manifest.json"


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


assert git("rev-parse", "HEAD") == SOURCE
assert git("status", "--porcelain", "--untracked-files=no") == ""
identity = {"source_sha": SOURCE, "source_tree": git("rev-parse", "HEAD^{tree}"),
            "workflow_sha": os.environ["GITHUB_SHA"], "run_id": os.environ["GITHUB_RUN_ID"],
            "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"],
            "control_sha": subprocess.check_output(
                ["git", "-C", "../control", "rev-parse", "HEAD"], text=True).strip(),
            "input_sha256": {p: sha(p) for p in INPUTS}, "build_settings": SETTINGS}
assert identity["control_sha"] == identity["workflow_sha"]
if mode == "create":
    assert not expected and not manifest.exists()
    files = sorted(p for p in directory.rglob("*") if p.is_file())
    assert {str(p.relative_to(directory)) for p in files} == REQUIRED
    assert not any(p.is_symlink() for p in directory.rglob("*"))
    versions = {name: subprocess.check_output(command, text=True).strip() for name, command in
                {"rustc": ["rustc", "-Vv"], "cargo": ["cargo", "-V"],
                 "wasm_bindgen": ["wasm-bindgen", "--version"]}.items()}
    assert versions["wasm_bindgen"] == "wasm-bindgen 0.2.121"
    record = {**identity, "tool_versions": versions,
              "files": {str(p.relative_to(directory)): {"bytes": p.stat().st_size, "sha256": sha(p)}
                        for p in files}}
    manifest.write_text(json.dumps(record, indent=2) + "\n")
elif mode == "verify":
    assert len(expected) == 1 and sha(manifest) == expected[0]
    record = json.loads(manifest.read_text())
    assert all(record.get(key) == value for key, value in identity.items())
    assert record["tool_versions"]["wasm_bindgen"] == "wasm-bindgen 0.2.121"
    assert record["tool_versions"]["rustc"] and record["tool_versions"]["cargo"]
    assert set(record["files"]) == REQUIRED
    assert {str(p.relative_to(directory)) for p in directory.rglob("*") if p.is_file()} == REQUIRED | {"manifest.json"}
    assert not any(p.is_symlink() for p in directory.rglob("*"))
    for name, file_identity in record["files"].items():
        p = directory / name
        assert p.is_file() and p.stat().st_size == file_identity["bytes"] and sha(p) == file_identity["sha256"]
else:
    raise ValueError(mode)
print(sha(manifest))
