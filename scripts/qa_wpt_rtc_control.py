#!/usr/bin/env python3
"""Pinned upstream WPT controls using the existing standard Chromium launcher."""

import argparse
import hashlib
import importlib.metadata
import json
import platform
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from qa_private_rtc_capability import require, run_browser, write_json

WPT_COMMIT = "c271c10de4c682ac8377dc00977d19dbb62f4a7d"
CHROME_VERSION = "154.0.8037.57"
INPUTS = {
    "webrtc/RTCDataChannel-send.html": "6726d90fd693ee678094b3120690f31d43fa2e6ee37592dd61b940c67334a7d4",
    "webrtc/RTCPeerConnection-helper.js": "3c69349c4fea43febcaee5dc77170a87ed7008f0020c938ba51e65d8d7105dd2",
    "webrtc/RTCDataChannel-helper.js": "64b78b1b934c8cb8eb1eec7fd76465de8b1c45558ca26ee448f8e96a657bf0b7",
    "webrtc/third_party/sdp/sdp.js": "564802e656f2d7e0c52edd4e49f29c9a3a08f10430ab984890838bdb0ac392ce",
    "resources/testharness.js": "7a108d7cfa98ac413ddb38f82fd509fb2037dfcc25ccf466567520cbb6bdf1fa",
    "resources/testharnessreport.js": "3777176fc736b0a78cf7617b9613b220f635daae7536ec7ebb99c61dbb525aae",
    "LICENSE.md": "5fac07febb0e2a97fb0d7b0def149ec08b642e1ba4b9c345283ab1cbd2af6570",
}
CASES = {
    "send-in-open": (18280, 18875, "71674d5359df8d8f82f3e5748855cce57bc8dd7d8bb59f5a16efcff32482d025",
                     "Sending in onopen should work"),
    "immediate-bidirectional": (16912, 18278, "3e9d9d3cf6968c21a7d5107dcde2b3020b403473242c67831448b23364af0e9c",
                              "Sending before the other side is open should work"),
}


def load_inputs(root):
    contents = {}
    for name, expected in INPUTS.items():
        path = root / name
        require(path.is_file() and not path.is_symlink(), "missing/nonregular WPT input: " + name)
        require(path.stat().st_size <= 1_000_000, "WPT input exceeds bound: " + name)
        data = path.read_bytes()
        require(hashlib.sha256(data).hexdigest() == expected, "WPT input SHA256 mismatch: " + name)
        contents[name] = data
    return contents


def prepare(root):
    root.mkdir(parents=True, mode=0o700, exist_ok=False)
    for name, expected in INPUTS.items():
        url = f"https://raw.githubusercontent.com/web-platform-tests/wpt/{WPT_COMMIT}/{name}"
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(1_000_001)
        require(len(data) <= 1_000_000 and hashlib.sha256(data).hexdigest() == expected,
                "downloaded WPT input mismatch: " + name)
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(data)
    return load_inputs(root)


def build_controls(inputs):
    # Preserve every upstream helper/license byte and selected test body. The
    # wrapper only reports WPT completion; no native WebRTC API is replaced.
    contents = dict(inputs)
    source = inputs["webrtc/RTCDataChannel-send.html"]
    for key, (start, end, expected, _title) in CASES.items():
        body = source[start:end]
        require(hashlib.sha256(body).hexdigest() == expected, "WPT case body mismatch")
        contents[f"webrtc/{key}.js"] = b"'use strict';\n\n" + body + b"\n"
        contents[f"webrtc/{key}.html"] = f'''<!doctype html>
<meta charset="utf-8">
<meta name="timeout" content="long">
<script src="/resources/testharness.js"></script>
<script src="/resources/testharnessreport.js"></script>
<script src="RTCPeerConnection-helper.js"></script>
<script src="RTCDataChannel-helper.js"></script>
<script src="third_party/sdp/sdp.js"></script>
<pre id="qa-control-output">{{"result":"running"}}</pre>
<script>
add_completion_callback((tests, status) => {{
  document.getElementById("qa-control-output").textContent = JSON.stringify({{
    harnessStatus: status.status,
    tests: tests.map(test => ({{name: test.name, status: test.status}}))
  }});
}});
</script>
<script src="{key}.js"></script>
'''.encode()
    return contents


def inventory(contents):
    return [{"file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in sorted(contents.items())]


def check_result(snapshot, case):
    require(type(snapshot) is dict and set(snapshot) == {"harnessStatus", "tests"}, "incomplete WPT completion")
    require(type(snapshot["harnessStatus"]) is int and snapshot["harnessStatus"] == 0, "WPT harness failed")
    tests = snapshot["tests"]
    require(type(tests) is list and len(tests) == 1, "expected exactly one WPT case")
    test = tests[0]
    require(type(test) is dict and set(test) == {"name", "status"}
            and test["name"] == CASES[case][3], "unexpected WPT case")
    require(type(test["status"]) is int and test["status"] == 0, "WPT case failed")


def observe_control(page, origin, result, case, deadline_ms):
    require(result["browserVersion"] == CHROME_VERSION, "connected browser version mismatch")
    result["stage"] = "wpt-run"
    started = time.monotonic()
    result["navigationStartedAtUnixMs"] = int(time.time() * 1000)
    try:
        page.goto(origin + f"/webrtc/{case}.html", wait_until="load", timeout=deadline_ms)
        remaining = deadline_ms - int((time.monotonic() - started) * 1000)
        require(remaining > 0, "WPT navigation exceeded deadline")
        page.wait_for_function("""() => {
            const output = document.getElementById('qa-control-output');
            if (!output || output.textContent.length > 12000) return false;
            try { return Object.hasOwn(JSON.parse(output.textContent), 'harnessStatus'); }
            catch { return false; }
        }""", timeout=remaining)
    finally:
        result["observationEndedAtUnixMs"] = int(time.time() * 1000)
        try:
            text = page.locator("#qa-control-output").inner_text(timeout=1000)
            if len(text) <= 12_000:
                result["lastOutput"] = text
        except Exception:
            pass  # Preserve stage/stderr if the page is inaccessible.
    text = page.locator("#qa-control-output").inner_text()
    require(len(text) <= 12_000, "WPT completion exceeds bound")
    result["wpt"] = json.loads(text)
    result["wptElapsedMs"] = int((time.monotonic() - started) * 1000)
    require(result["wptElapsedMs"] <= deadline_ms, "WPT completed after deadline")
    check_result(result["wpt"], case)
    result["stage"] = "complete"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--case", choices=CASES)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--browser-path", default=shutil.which("google-chrome"))
    parser.add_argument("--deadline-ms", type=int, choices=[30_000], default=30_000)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    require(args.prepare_only or args.case is not None, "WPT case required")
    args.output_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    result = {"schema": 1, "result": "fail", "stage": "prepare" if args.prepare_only else "input-check",
              "argv": sys.argv, "wptCommit": WPT_COMMIT, "case": args.case, "deadlineMs": args.deadline_ms,
              "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "sharedLauncherSha256": hashlib.sha256(Path(__file__).with_name("qa_private_rtc_capability.py").read_bytes()).hexdigest(),
              "platform": platform.platform(), "pythonVersion": sys.version,
              "scope": "Selected upstream WPT native same-page control only; no Phase/Undo/A1/cross-tab acceptance"}
    started = time.monotonic()
    try:
        contents = build_controls(prepare(args.root) if args.prepare_only else load_inputs(args.root))
        result["inputs"] = inventory(contents)
        if not args.prepare_only:
            require(sys.platform == "linux" and args.browser_path and Path(args.browser_path).is_file(), "standard Linux browser required")
            result["playwrightVersion"] = importlib.metadata.version("playwright")
            require(result["playwrightVersion"] == "1.62.0", "Playwright version mismatch")
            version = subprocess.run([args.browser_path, "--version"], capture_output=True, text=True, timeout=10)
            require(version.returncode == 0 and version.stdout.strip() == "Google Chrome " + CHROME_VERSION,
                    "browser executable version mismatch")
            result["browserExecutableVersion"] = version.stdout.strip()
            write_json(args.output_dir / "run-contract.json", {
                "wptCommit": WPT_COMMIT, "case": args.case, "inputs": result["inputs"],
                "deadlineMs": args.deadline_ms, "expectedBrowser": CHROME_VERSION,
                "launch": "standard executable/headless/loopback CDP/fresh temporary profile; no security overrides",
                "context": "fresh nonpersistent; ignore_https_errors=false; default service worker policy",
            })
            runtime = {name: data for name, data in contents.items()
                       if name not in ["webrtc/RTCDataChannel-send.html", "LICENSE.md"]}
            run_browser(args, None, runtime, result,
                        observe=lambda page, origin, output: observe_control(page, origin, output, args.case, args.deadline_ms))
        result["result"] = "pass"
    except Exception as error:
        result["errorType"] = type(error).__name__
        result["error"] = str(error) if isinstance(error, ValueError) else "Execution failed; inspect stage and preserved browser stderr."
    finally:
        result["elapsedSeconds"] = time.monotonic() - started
        write_json(args.output_dir / "result.json", result)
    print(json.dumps({"result": result["result"], "stage": result["stage"], "evidence": str(args.output_dir / "result.json")}))
    return 0 if result["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
