"""Reuse one explicitly pinned retained copy; never print credentials or redirects."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import urllib.error
import urllib.request
import zipfile

PRODUCER = "387b7542a901d711cbef2868e686b29726c905f0"
RUN = 37387607807
SOURCE = "e10955dc5977f1ba7c65cb1518cb8f4b1679fe92"
COPY_PRODUCER = "f855a0061f6e51a34383f1bd36c4e3a154913fd6"
COPY_RUN = 37442499873
INPUTS = {
    "native": (11380615315, 371281055,
               "78a8b14d923cfdc4b29206bc5d4e74a301c57b1647528f62a4decd053b6e49ef",
               {"core.tar.zst", "boundary.tar.zst", "manifest.json"}),
    "wasm": (11380069733, 295990784,
             "c8d82ef9bff55d1f1e376ba3f32525feefaf44d02c5b6fffba24d56e79fedd4d",
             {"engine_wasm.js", "engine_wasm.d.ts", "engine_wasm_bg.wasm",
              "engine_wasm_bg.wasm.d.ts", "package.json", "manifest.json"}),
}
COPIES = {
    "native": (11401867414, "undo-f-pinned-native-input", 371281628,
               "09d6f2091e092fbafdc11ea59439acb2124dda727c271ca291802598bd5c82f2"),
    "wasm": (11401468569, "undo-f-pinned-wasm-input", 295991349,
             "6f89a7fb1cafe9a121c5630cc45356d334520025067cee9618be164226b762b9"),
}
MANIFESTS = {
    "native": "21eda8d2e38a7b25a95297a773a68420895c8c60a4ce3e20786a1b4d3c53667b",
    "wasm": "f2681c2c2ba8e13dde7a6f5e65f461b3fc9957ce7769d339c3bde6250c152659",
}


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def exact_members(bundle, names):
    entries = bundle.infolist()
    assert len(entries) == len(names) and {e.filename for e in entries} == names, "artifact inventory mismatch"
    assert all(not e.is_dir() and not stat.S_ISLNK(e.external_attr >> 16) for e in entries), "artifact contains directory or symlink"


def unpack_copy(kind, retained, output, archive):
    identity, size, digest, members = INPUTS[kind]
    frozen = {"artifact_id": identity, "producer_run": RUN,
              "producer_workflow_sha": PRODUCER, "source_sha": SOURCE,
              "archive_bytes": size, "zip_sha256": digest}
    receipt_path = archive.with_suffix(".receipt.json")
    assert not output.exists() and not archive.exists() and not receipt_path.exists(), "do not overwrite or retry an input"
    with zipfile.ZipFile(retained) as bundle:
        exact_members(bundle, {kind + ".zip", kind + ".receipt.json"})
        assert bundle.getinfo(kind + ".zip").file_size == size, "inner ZIP size mismatch"
        assert bundle.getinfo(kind + ".receipt.json").file_size <= 4096, "oversized original receipt"
        raw_receipt = bundle.read(kind + ".receipt.json")
        assert json.loads(raw_receipt) == frozen, "original producer receipt mismatch"
        archive.parent.mkdir(parents=True, exist_ok=True)
        with bundle.open(kind + ".zip") as source, archive.open("xb") as target:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                target.write(block)
    assert archive.stat().st_size == size and sha(archive) == digest, "inner original ZIP digest mismatch"
    with zipfile.ZipFile(archive) as bundle:
        exact_members(bundle, members)
        output.mkdir()
        bundle.extractall(output)
    # Keep the frozen receipt byte-for-byte. Subsequent retention uploads remain
    # the same two original files, with no nesting growth or producer relabeling.
    with receipt_path.open("xb") as stream:
        stream.write(raw_receipt)
    return frozen


def main():
    kind, output, archive = sys.argv[1:]
    output, archive = Path(output), Path(archive)
    identity, name, expected_size, expected_digest = COPIES[kind]
    # The wrapper and new consumer provenance stay outside the uploaded directory.
    retained_dir = archive.parent.parent / "retained-inputs"
    retained = retained_dir / (kind + ".zip")
    provenance = retained_dir / (kind + ".provenance.json")
    assert not output.exists() and not archive.exists() and not archive.with_suffix(".receipt.json").exists()
    assert not retained.exists() and not provenance.exists(), "do not overwrite or retry retained copy"
    token = os.environ["GH_TOKEN"]
    assert token and "\n" not in token and "\r" not in token
    headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    url = f"https://api.github.com/repos/Makeinu1/phase/actions/artifacts/{identity}"

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    api = urllib.request.build_opener(NoRedirect())
    with api.open(urllib.request.Request(url, headers=headers), timeout=60) as response:
        metadata = json.load(response)
    assert metadata["id"] == identity and metadata["name"] == name and not metadata["expired"]
    assert metadata["digest"] == "sha256:" + expected_digest and metadata["size_in_bytes"] == expected_size
    assert metadata["workflow_run"]["id"] == COPY_RUN and metadata["workflow_run"]["head_sha"] == COPY_PRODUCER
    try:
        api.open(urllib.request.Request(url + "/zip", headers=headers), timeout=60)
    except urllib.error.HTTPError as error:
        assert error.code == 302, "artifact API denied or failed"
        location = error.headers["Location"]
    else:
        raise AssertionError("expected the documented artifact redirect")
    assert location.startswith("https://")
    retained_dir.mkdir(parents=True, exist_ok=True)
    # No Authorization forwarded to signed storage. Exactly one download.
    with urllib.request.urlopen(location, timeout=180) as response, retained.open("xb") as stream:
        for block in iter(lambda: response.read(1024 * 1024), b""):
            stream.write(block)
    assert retained.stat().st_size == expected_size and sha(retained) == expected_digest, "retained ZIP digest mismatch"
    original = unpack_copy(kind, retained, output, archive)
    manifest_digest = sha(output / "manifest.json")
    assert manifest_digest == MANIFESTS[kind], "producer manifest digest mismatch"
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["source_sha"] == SOURCE and manifest["workflow_sha"] == PRODUCER
    assert set(manifest["files"]) == INPUTS[kind][3] - {"manifest.json"}
    declared_files = {name: {"bytes": item["bytes"], "sha256": item["sha256"]}
                      for name, item in manifest["files"].items()}
    # Producer-declared identities only: the following existing manifest verify
    # command checks every actual file's size/hash before any consumer runs.
    record = {**original, "retained_copy": {"artifact_id": identity, "name": name,
              "producer_run": COPY_RUN, "producer_workflow_sha": COPY_PRODUCER,
              "archive_bytes": expected_size, "zip_sha256": expected_digest,
              "expires_at": metadata["expires_at"]},
              "payload_manifest_sha256": manifest_digest,
              "producer_declared_files": declared_files}
    provenance.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record))


if __name__ == "__main__":
    main()
