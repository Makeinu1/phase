#!/usr/bin/env python3
"""Run one fixed nine-browser comparison; preserve every failed trial."""
import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from qa_private_rtc_capability import require, write_json
from qa_wpt_rtc_control import CHROME_VERSION, WPT_COMMIT

QA_HEAD = "eea2145f7421535981b282d1e139ba632854dc9e"
QA_SOURCE_SHA = "1867d85304aa0675ab57baba1bc0fdb118228348c19d530fe33ebc7b7f8c483d"
QA_DRIVER_SHA = "70c23c01e19d32dee43780d6d407a8a5061ea9f76d5b1c7c7ad75c4b7ed01a00"
TRIALS = [("qa", 1), ("send-in-open", 1), ("immediate-bidirectional", 1),
          ("send-in-open", 2), ("immediate-bidirectional", 2), ("qa", 2),
          ("immediate-bidirectional", 3), ("qa", 3), ("send-in-open", 3)]


def summarize(observations):
    arms = {arm: len([item for item in observations if item["arm"] == arm]) == 3
            and all(item["pass"] is True for item in observations if item["arm"] == arm)
            for arm in ("qa", "send-in-open", "immediate-bidirectional")}
    complete = [(item["arm"], item["number"]) for item in observations] == TRIALS
    return {"result": "pass" if complete and all(arms.values()) else "fail", "arms": arms,
            "completeFixedPlan": complete, "trials": observations,
            "scope": "Same-page native controls; no Phase/Undo/cross-tab/NAT/reconnect acceptance"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qa-root", type=Path, required=True)
    parser.add_argument("--wpt-root", type=Path, required=True)
    parser.add_argument("--browser-path", default="/usr/bin/google-chrome")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    scripts = Path(__file__).resolve().parent
    qa_driver = args.qa_root / "scripts/qa_private_rtc_capability.py"
    require(hashlib.sha256(qa_driver.read_bytes()).hexdigest() == QA_DRIVER_SHA, "fixed QA driver mismatch")
    head = subprocess.run(["git", "-C", str(args.qa_root), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10)
    require(head.returncode == 0 and head.stdout.strip() == QA_HEAD, "fixed QA checkout mismatch")
    write_json(args.output_dir / "comparison-contract.json", {
        "qaHead": QA_HEAD, "qaSourceSha256": QA_SOURCE_SHA, "qaDriverSha256": QA_DRIVER_SHA,
        "wptCommit": WPT_COMMIT, "expectedBrowser": CHROME_VERSION, "trials": TRIALS,
        "acceptance": "Each arm requires all three independent fresh-process trials; any failure is retained. No retry.",
        "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    })
    observations = []
    for arm, number in TRIALS:
        label = f"{arm}-{number}"
        output = args.output_dir / label
        if arm == "qa":
            command = [sys.executable, str(qa_driver), "--client-root", str(args.qa_root / "client"),
                       "--build-dir", str(args.qa_root / "client/dist-private-rtc-capability"),
                       "--expected-source-head", QA_HEAD, "--expected-source-sha256", QA_SOURCE_SHA]
        else:
            command = [sys.executable, str(scripts / "qa_wpt_rtc_control.py"),
                       "--root", str(args.wpt_root), "--case", arm, "--deadline-ms", "30000"]
        command += ["--browser-path", args.browser_path, "--output-dir", str(output)]
        write_json(args.output_dir / f"{label}.command.json", {"command": command, "startedAtUnixMs": int(time.time() * 1000)})
        started = time.monotonic()
        with (args.output_dir / f"{label}.stdout.txt").open("xb") as stdout, (args.output_dir / f"{label}.stderr.txt").open("xb") as stderr:
            try:
                with subprocess.Popen(command, stdout=stdout, stderr=stderr, start_new_session=True) as process:
                    try:
                        exit_code = process.wait(timeout=120)
                    except subprocess.TimeoutExpired:
                        # Only this trial's new process group; other CI jobs and
                        # the user's independently running work are untouched.
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            pass
                        # The driver may exit before a child browser does.
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait(timeout=5)
                        exit_code = 124
            except OSError:
                exit_code = 127
        result_file = output / "result.json"
        try:
            result = json.loads(result_file.read_text()) if result_file.is_file() else None
        except (OSError, UnicodeError, json.JSONDecodeError):
            result = None
        passed = (exit_code == 0 and type(result) is dict and result.get("result") == "pass"
                  and result.get("browserVersion") == CHROME_VERSION)
        record = {"arm": arm, "number": number, "exitCode": exit_code, "pass": passed,
                  "elapsedSeconds": time.monotonic() - started,
                  "stdoutSha256": hashlib.sha256((args.output_dir / f"{label}.stdout.txt").read_bytes()).hexdigest(),
                  "stderrSha256": hashlib.sha256((args.output_dir / f"{label}.stderr.txt").read_bytes()).hexdigest(),
                  "resultSha256": hashlib.sha256(result_file.read_bytes()).hexdigest() if result_file.is_file() else None}
        write_json(args.output_dir / f"{label}.receipt.json", record)
        observations.append(record)
        print(json.dumps(record), flush=True)
    summary = summarize(observations)
    write_json(args.output_dir / "summary.json", summary)
    return 0 if summary["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
