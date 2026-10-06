"""Download the exact new draft input once; never print credentials or redirects."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import urllib.error
import urllib.request
import zipfile

PRODUCER = "eac6c9be9b1e0f1b9406506017c195f1107b6437"
RUN = 37403621352
INPUTS = {
    "draft": (11386268197, "undo-f-exact-draft-wasm", "16b1cfe3204034373ef271c20f6bf0acd25cb27ef91a59b0844f4ca1c0e9354a",
              {"draft_wasm.js", "draft_wasm.d.ts", "draft_wasm_bg.wasm", "draft_wasm_bg.wasm.d.ts", "package.json", "provenance.json", "manifest.json"}),
}
kind, output, archive = sys.argv[1:]
identity, name, expected_digest, members = INPUTS[kind]
output, archive = Path(output), Path(archive)
assert not output.exists() and not archive.exists(), "do not overwrite or retry an input"
token = os.environ["GH_TOKEN"]
assert token and "\n" not in token and "\r" not in token
headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
url = f"https://api.github.com/repos/Makeinu1/phase/actions/artifacts/{identity}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


api = urllib.request.build_opener(NoRedirect())
with api.open(urllib.request.Request(url, headers=headers), timeout=60) as response:
    metadata = json.load(response)
assert metadata["id"] == identity and metadata["name"] == name and not metadata["expired"]
assert metadata["digest"] == "sha256:" + expected_digest
assert metadata["workflow_run"]["id"] == RUN and metadata["workflow_run"]["head_sha"] == PRODUCER
try:
    api.open(urllib.request.Request(url + "/zip", headers=headers), timeout=60)
except urllib.error.HTTPError as error:
    assert error.code == 302, "artifact API denied or failed"
    location = error.headers["Location"]
else:
    raise AssertionError("expected the documented artifact redirect")
assert location.startswith("https://")
archive.parent.mkdir(parents=True, exist_ok=True)
digest = hashlib.sha256()
# No Authorization header is forwarded to the signed storage redirect.
with urllib.request.urlopen(location, timeout=180) as response, archive.open("xb") as stream:
    for block in iter(lambda: response.read(1024 * 1024), b""):
        digest.update(block)
        stream.write(block)
assert digest.hexdigest() == expected_digest, "downloaded ZIP digest mismatch"
assert archive.stat().st_size == metadata["size_in_bytes"], "downloaded ZIP size mismatch"
with zipfile.ZipFile(archive) as bundle:
    entries = bundle.infolist()
    assert {entry.filename for entry in entries} == members and len(entries) == len(members)
    assert all(not entry.is_dir() and not stat.S_ISLNK(entry.external_attr >> 16) for entry in entries)
    output.mkdir()
    bundle.extractall(output)
record = {"artifact_id": identity, "producer_run": RUN, "producer_workflow_sha": PRODUCER,
          "source_sha": "e10955dc5977f1ba7c65cb1518cb8f4b1679fe92",
          "archive_bytes": archive.stat().st_size, "zip_sha256": expected_digest}
archive.with_suffix(".receipt.json").write_text(json.dumps(record, indent=2) + "\n")
(Path(os.environ["F_EVIDENCE"]) / "draft-input.receipt.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps(record))
