#!/usr/bin/env python3
"""Drive the unchanged A1/A2 harness in a real, sandboxed Linux Chromium."""

import argparse
import base64
import copy
import hashlib
import importlib.metadata
import json
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HTML = "qa/private-rtc-capability.html"
MANIFEST = "qa/private-rtc-capability.manifest.json"
SOURCE_INPUTS = sorted([
    "package.json", "pnpm-lock.yaml", HTML, "vite.privateRtcCapability.config.ts",
    *[f"src/qa/harness/{name}.ts" for name in
      ["build", "capabilityControl", "entry", "preflight", "runGate", "schema"]],
])
FORBIDDEN_ARGS = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-web-security",
    "--ignore-certificate-errors", "--allow-insecure-localhost",
    "--allow-running-insecure-content", "--unsafely-treat-insecure-origin-as-secure",
    "--disable-webrtc-encryption",
]


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


class EntryMetadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.manifests = []
        self.in_manifest = False

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        require(len(dict(attrs)) == len(attrs), "duplicate script attribute")
        attrs = dict(attrs)
        if attrs.get("type") == "module":
            self.scripts.append(attrs)
        self.in_manifest = attrs.get("id") == "qa-runtime-manifest"
        if self.in_manifest:
            require(attrs.get("type") == "application/json", "inline manifest type")
            self.manifests.append("")

    def handle_data(self, data):
        if self.in_manifest:
            self.manifests[-1] += data

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_manifest = False


def load_artifact(build_dir, client_root, expected_sha, expected_head):
    digest = hashlib.sha256()
    source_files = []
    for name in SOURCE_INPUTS:
        data = (client_root / name).read_bytes()
        digest.update(name.encode() + b"\0" + data + b"\0")
        source_files.append({"file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    require(digest.hexdigest() == expected_sha, "source inputs differ from expected SHA256")
    contents = {}

    def read(name):
        data = (build_dir / name).read_bytes()
        require(len(data) <= 2_000_000, "artifact file exceeds bound")
        contents[name] = data
        return data

    manifest = json.loads(read(MANIFEST))
    stamp = manifest["stamp"]
    require(stamp["schema"] == 1 and stamp["sourceDirty"] is False, "unknown/dirty build stamp")
    require(stamp["sourceSha256"] == expected_sha and stamp["sourceHead"] == expected_head, "build stamp differs from expected source")
    entry = manifest["entry"]
    require(re.fullmatch(r"assets/[A-Za-z0-9_-]+\.js", entry["file"]), "invalid entry path")
    data = read(entry["file"])
    integrity = "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode()
    require(len(data) == entry["bytes"] and integrity == entry["integrity"], "entry bytes/SRI mismatch")
    vite = manifest["viteManifest"]
    require(vite["file"] == ".vite/manifest.json" and vite["entryKey"] == HTML, "Vite manifest identity mismatch")
    vite_bytes = read(vite["file"])
    require(hashlib.sha256(vite_bytes).hexdigest() == vite["sha256"], "Vite manifest hash mismatch")
    vite_entries = json.loads(vite_bytes)
    require(list(vite_entries) == [HTML] and vite_entries[HTML]["file"] == entry["file"]
            and vite_entries[HTML]["isEntry"] is True, "Vite entry mismatch")
    parser = EntryMetadata()
    parser.feed(read(HTML).decode())
    require(len(parser.manifests) == 1 and json.loads(parser.manifests[0]) == manifest, "inline/external manifest mismatch")
    require(len(parser.scripts) == 1, "expected one module script")
    script = parser.scripts[0]
    require(script.get("src") == "/" + entry["file"] and script.get("integrity") == integrity
            and script.get("crossorigin") == "anonymous", "HTML entry/SRI mismatch")
    inventory = [{"file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                 for name, data in sorted(contents.items())]
    return manifest, contents, {"stamp": stamp, "sourceInputs": source_files, "files": inventory}


def check_a1(snapshot, manifest, origin):
    require(snapshot["runtimeStamp"] == manifest["stamp"] and snapshot["manifest"] == manifest, "A1 runtime/artifact mismatch")
    require(snapshot["secureContext"] is True, "A1 insecure context")
    for key in ["RTCPeerConnection", "RTCDataChannel", "cryptoSubtleDigest", "serviceWorker", "cacheStorage"]:
        require(snapshot["apiPresence"][key] == "present", "A1 required API not present: " + key)
    script = snapshot["script"]
    require(all(script[key] is True for key in ["documentScriptMatchesRuntime", "manifestFileMatchesRuntime", "stampMatches", "integrityMatches"]), "A1 artifact correspondence unknown/false")
    require(script["documentIntegrity"] == manifest["entry"]["integrity"]
            and script["laterRefetchPerformed"] is False, "A1 entry/refetch mismatch")
    expected_identity = {"origin": origin, "path": "/" + HTML, "flags": {
        "environmentAccepted": "1", "queryFlagCount": 0, "fragmentFlagCount": 1,
        "unknownFlagCount": 0, "unknownFlagValues": "unknown",
    }}
    require(snapshot["initialIdentity"] == snapshot["currentIdentity"] == expected_identity, "A1 URL/flags mismatch")
    require(snapshot["drift"] == {"controllerChanges": 0, "navigationEvents": 0, "locationChanged": False}, "A1 drift")
    workers = snapshot["serviceWorkers"]
    require(workers["state"] == "complete" and workers["truncated"] is False
            and workers["controller"] is None and workers["registrationCount"] == 0
            and workers["registrations"] == [] and isinstance(workers["identitySha256"], str)
            and re.fullmatch(r"[a-f0-9]{64}", workers["identitySha256"]), "A1 SW inventory violates empty-context contract")
    caches = snapshot["cacheInventory"]
    require(caches["state"] == "complete" and caches["truncated"] is False
            and caches["count"] == 0 and caches["nameSha256"] == [], "A1 cache inventory violates empty-context contract")


def stable_a1(snapshot):
    value = copy.deepcopy(snapshot)
    for key in ["serviceWorkers", "cacheInventory"]:
        value[key].pop("capturedAtMs", None)
    return value


def check_reobservation(setup, observed, manifest, origin):
    require(observed["setup"] == setup, "frozen SETUP changed")
    require(observed["monitoring"] == setup["drift"], "drift observed during A2")
    require(observed["beforeRun"] is not None, "missing fresh before-run observation")
    check_a1(observed["beforeRun"], manifest, origin)
    require(stable_a1(setup) == stable_a1(observed["beforeRun"]), "SETUP/before-run identity differs")


def check_a2(snapshot):
    require(snapshot["result"] == "pass", "A2 result: " + str(snapshot["result"]))
    require(snapshot["payloadBytes"] == 32 and snapshot["iceServerCount"] == 0
            and snapshot["limitMs"] == 30_000 and 0 <= snapshot["elapsedMs"] <= 30_000,
            "A2 settings/time contract mismatch")
    require(len(snapshot["sides"]) == 2, "A2 requires two native peers")
    for side in snapshot["sides"]:
        require(side["payloadReceived"] is True and side["acknowledgementReceived"] is True, "A2 missing verified payload/ACK")
        counts = side["counts"]
        require(counts["openEvents"] == 1 and counts["messagesSent"] == counts["messagesReceived"] == 2
                and counts["bytesSent"] == counts["bytesReceived"] == 64, "A2 byte/message counts mismatch")
        require(all(type(counts[key]) is int and 0 <= counts[key] <= 256 for key in
                    ["iceEvents", "localCandidates", "queuedCandidates", "applyingCandidates", "appliedCandidates"]), "A2 candidate counts exceed bounds")
        states = side["states"]
        require(states["connection"] == "connected" and states["ice"] in ["connected", "completed"]
                and states["channel"] == "open" and states["signaling"] == "stable", "A2 terminal native states mismatch")
    events = snapshot["exchangeEvents"]
    names = ["handlers-attached", "open", "send-payload", "send-ack", "receive-payload", "receive-ack"]
    require(len(events) == 12 and all(set(event) == {"side", "event"}
            and type(event["side"]) is int and event["side"] in [0, 1] and event["event"] in names
            for event in events), "A2 invalid bounded exchange events")
    positions = {(event["side"], event["event"]): index for index, event in enumerate(events)}
    require(len(positions) == 12, "A2 repeated/missing exchange event")
    first_send = min(positions[(side, "send-payload")] for side in [0, 1])
    for side in [0, 1]:
        require(positions[(side, "handlers-attached")] < positions[(side, "open")] < first_send,
                "A2 payload started before both actual open events/handlers")
        require(positions[(1 - side, "send-payload")] < positions[(side, "receive-payload")]
                < positions[(side, "send-ack")] < positions[(1 - side, "receive-ack")],
                "A2 payload/ACK event order mismatch")


def run_browser(args, manifest, contents, result):
    from playwright.sync_api import sync_playwright

    # Only immutable harness runtime files are served. The Vite manifest remains evidence.
    allowed = {name: data for name, data in contents.items() if name != ".vite/manifest.json"}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            name = self.path.removeprefix("/")
            status = 200 if name in allowed else 404
            requests.append({"path": self.path.split("?", 1)[0], "status": status})
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8" if name.endswith(".html") else "text/javascript" if name.endswith(".js") else "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if status == 200:
                self.wfile.write(allowed[name])

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    result["origin"] = origin
    browser = None
    process = None
    page = None
    profile = tempfile.TemporaryDirectory(prefix="phase-rtc-ci-profile-")
    try:
        playwright = sync_playwright().start()
        try:
            result["stage"] = "launch-browser"
            # Playwright's launch defaults disable some browser protections. Start
            # the standard browser ourselves and use only its loopback CDP API.
            command = [args.browser_path, "--headless", "--remote-debugging-address=127.0.0.1",
                       "--remote-debugging-port=0", "--user-data-dir=" + profile.name]
            result["browserArguments"] = command
            require(not any(arg == flag or arg.startswith(flag + "=") for arg in command for flag in FORBIDDEN_ARGS), "forbidden browser security argument")
            with (args.output_dir / "browser-launch.stdout.txt").open("xb") as stdout, (args.output_dir / "browser-launch.stderr.txt").open("xb") as stderr:
                process = subprocess.Popen(command, stdout=stdout, stderr=stderr)
            port_file = Path(profile.name) / "DevToolsActivePort"
            deadline = time.monotonic() + 20
            port = None
            while process.poll() is None and time.monotonic() < deadline:
                try:
                    value = int(port_file.read_text().splitlines()[0])
                    if 0 < value < 65536:
                        port = value
                        break
                except (OSError, ValueError, IndexError):
                    pass  # Chromium can still be writing this new profile's port file.
                time.sleep(0.05)
            require(process.poll() is None and port is not None, "Chromium could not start sandboxed; see browser-launch.stderr.txt")
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=10_000, no_defaults=True)
            result["browserVersion"] = browser.version
            context = browser.new_context(ignore_https_errors=False)
            page = context.new_page()
            page.set_default_timeout(10_000)
            result["stage"] = "a1-setup"
            page.goto(origin + "/" + HTML + "#qa-environment-accepted=1", wait_until="load")
            page.wait_for_function("""() => {
                const status = document.getElementById('qa-harness-status');
                return status && !status.textContent.startsWith('Reading');
            }""")
            setup = json.loads(page.locator("#qa-a1-output").inner_text())["setup"]
            result["setup"] = setup
            check_a1(setup, manifest, origin)
            require(page.locator("#qa-a2-output").inner_text() == "Not run"
                    and page.locator("#qa-a2-run").is_enabled(), "A2 started early or setup gate disabled")
            # This CI contract and pinned artifact supply the external run record.
            # Use the existing button; do not call native control or modify any API.
            result["stage"] = "a2-run"
            page.locator("#qa-a2-run").click()
            page.wait_for_function("""() => {
                const text = document.getElementById('qa-a2-output').textContent;
                const status = document.getElementById('qa-harness-status').textContent;
                return (text !== 'Not run' && JSON.parse(text).result !== 'running')
                    || status.startsWith('Before-run observation failed')
                    || status.startsWith('Environment drift observed');
            }""", timeout=40_000)
            observed = json.loads(page.locator("#qa-a1-output").inner_text())
            result["a1"] = observed
            check_reobservation(setup, observed, manifest, origin)
            result["a2"] = json.loads(page.locator("#qa-a2-output").inner_text())
            check_a2(result["a2"])
            require(page.locator("#qa-a2-run").is_disabled(), "one-run button remained enabled")
            result["stage"] = "complete"
        finally:
            try:
                if browser is not None:
                    browser.close()
                    browser = None
            finally:
                playwright.stop()
    except Exception as error:
        if result["stage"] == "launch-browser":
            # Launch errors precede gameplay and contain no SDP or ICE descriptions.
            result["launchError"] = str(error)[:12_000]
        elif page is not None:
            for key, selector in [("a1Text", "#qa-a1-output"), ("a2Text", "#qa-a2-output"), ("status", "#qa-harness-status")]:
                try:
                    result[key] = page.locator(selector).inner_text(timeout=1000)
                except Exception:
                    pass
        raise
    finally:
        try:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        finally:
            try:
                profile.cleanup()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                result["httpRequests"] = requests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, required=True)
    parser.add_argument("--client-root", type=Path, default=Path(__file__).resolve().parents[1] / "client")
    parser.add_argument("--output-dir", type=Path, required=True, help="new directory; never overwrite an earlier run")
    parser.add_argument("--expected-source-sha256", required=True)
    parser.add_argument("--expected-source-head", required=True)
    parser.add_argument("--browser-path", default=shutil.which("google-chrome") or shutil.which("chromium"))
    args = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{64}", args.expected_source_sha256)
            and re.fullmatch(r"[a-f0-9]{40}", args.expected_source_head), "invalid source pin")
    args.output_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    result = {"schema": 1, "result": "fail", "stage": "artifact-check", "argv": sys.argv,
              "driverSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "platform": platform.platform(), "pythonVersion": sys.version,
              "security": {"chromiumSandbox": "standard browser default; never disabled", "ignoreHttpsErrors": False,
                           "launch": "standard executable + headless, loopback CDP, temporary profile only",
                           "serviceWorkerPolicy": "allow (default)", "context": "fresh nonpersistent"},
              "scope": "native same-page A1/A2 capability only; no Phase/Undo/cross-tab acceptance"}
    started = time.monotonic()
    try:
        require(sys.platform == "linux" and args.browser_path and Path(args.browser_path).is_file(), "Linux standard browser executable required")
        result["playwrightVersion"] = importlib.metadata.version("playwright")
        version = subprocess.run([args.browser_path, "--version"], capture_output=True, text=True, timeout=10)
        require(version.returncode == 0 and version.stdout.strip(), "browser version command failed")
        result["browserExecutableVersion"] = version.stdout.strip()[:512]
        manifest, contents, result["artifact"] = load_artifact(args.build_dir, args.client_root,
                                                             args.expected_source_sha256, args.expected_source_head)
        write_json(args.output_dir / "run-contract.json", {
            "expectedSourceSha256": args.expected_source_sha256, "expectedSourceHead": args.expected_source_head,
            "stamp": manifest["stamp"], "browserPath": args.browser_path, "security": result["security"],
            "a1": "loopback secure context; complete empty SW/cache inventories; matching artifact and URL/flags; fresh matching beforeRun",
            "a2": "native peers 2; ICE servers 0; 32-byte payload/ACK each direction; 30-second limit",
        })
        run_browser(args, manifest, contents, result)
        result["result"] = "pass"
    except Exception as error:
        result["errorType"] = type(error).__name__
        result["error"] = str(error) if isinstance(error, ValueError) else "Execution failed; see stage and available launch/A1/A2 evidence."
    finally:
        result["driverElapsedSeconds"] = time.monotonic() - started
        write_json(args.output_dir / "result.json", result)
    print(json.dumps({"result": result["result"], "stage": result["stage"], "evidence": str(args.output_dir / "result.json")}))
    return 0 if result["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
