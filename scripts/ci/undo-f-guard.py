"""Bound one CI command; signal only the new session created by this process."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

SOURCE = "e10955dc5977f1ba7c65cb1518cb8f4b1679fe92"
GIB = 1024**3
limit = 13 * GIB
disk_min = 4 * GIB
label, *argv = sys.argv[1:]
assert argv and label.replace("-", "").isalnum()
evidence = Path(os.environ["F_EVIDENCE"])
evidence.mkdir(parents=True, exist_ok=True)
assert not (evidence / (label + ".json")).exists(), "do not retry a recorded command"


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sample():
    cg = Path("/sys/fs/cgroup")
    if (cg / "memory.max").is_file() and (cg / "memory.max").read_text().strip() != "max":
        stat = dict(line.split() for line in (cg / "memory.stat").read_text().splitlines())
        total = int((cg / "memory.current").read_text())
        inactive = int(stat["inactive_file"])
        scope = "cgroup"
        cap = int((cg / "memory.max").read_text())
        details = {k: int(stat[k]) for k in ["active_file", "inactive_file", "anon", "kernel"]}
    else:
        mem = {k: int(v.split()[0]) * 1024 for k, v in
               (line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())}
        total = mem["MemTotal"] - mem["MemFree"]
        inactive = mem["Inactive(file)"]
        scope = "host_vm"
        cap = mem["MemTotal"]
        details = {"active_file": mem["Active(file)"], "inactive_file": inactive,
                   "anon": mem["AnonPages"], "kernel": mem["Slab"] + mem["KernelStack"] + mem["PageTables"]}
    return {"at": now(), "scope": scope, "cap_bytes": cap, "used_bytes": total,
            "working_set_bytes": total - inactive, **details,
            "workspace_free_bytes": shutil.disk_usage(Path.cwd()).free,
            "temp_free_bytes": shutil.disk_usage(os.environ["RUNNER_TEMP"]).free}


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


assert git("rev-parse", "HEAD") == SOURCE
assert git("status", "--porcelain") == "", "start from the published, clean source"
for key in ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS",
            "CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS", "RUSTC_WRAPPER",
            "RUSTC_WORKSPACE_WRAPPER"]:
    assert not os.environ.get(key), "unexpected compiler override: " + key
assert os.environ.get("CARGO_INCREMENTAL", "0") == "0", "incremental must remain disabled"
before = sample()
assert before["cap_bytes"] >= limit, "runner has less RAM than the guard"
assert before["working_set_bytes"] <= limit
assert min(before["workspace_free_bytes"], before["temp_free_bytes"]) >= disk_min
record = {"started_at": now(), "source_sha": SOURCE, "workflow_sha": os.environ["GITHUB_SHA"],
          "source_tree": git("rev-parse", "HEAD^{tree}"), "argv": argv,
          "environment": {k: os.environ.get(k) for k in ["CARGO_TARGET_DIR", "CARGO_BUILD_JOBS", "RUST_MIN_STACK", "CARGO_INCREMENTAL", "CARGO_PROFILE_DEV_DEBUG"]},
          "guard": {"working_set_bytes": limit, "disk_free_min_bytes": disk_min,
                    "sample_interval_seconds": 1, "timeout_seconds": 1500}, "preflight": before}
process = None
reason = None
code = 1
try:
    with (evidence / (label + ".log")).open("w") as log, (evidence / (label + ".jsonl")).open("w") as samples:
        process = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        started = time.monotonic()
        while process.poll() is None:
            try:
                reading = sample()
                samples.write(json.dumps(reading) + "\n")
                samples.flush()
                if reading["scope"] != before["scope"] or reading["cap_bytes"] != before["cap_bytes"]:
                    reason = "memory_scope_or_cap_changed"
                elif reading["working_set_bytes"] > limit:
                    reason = "working_set_above_13GiB"
                elif min(reading["workspace_free_bytes"], reading["temp_free_bytes"]) < disk_min:
                    reason = "disk_free_below_4GiB"
                elif time.monotonic() - started >= 1500:
                    reason = "command_timeout_25min"
            except Exception as error:
                reason = "telemetry_error:" + type(error).__name__
            if reason:
                break
            time.sleep(1)
        if reason and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            code = process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait()
finally:
    if process is not None and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    source_unchanged = git("rev-parse", "HEAD") == SOURCE and git("status", "--porcelain") == ""
    if not source_unchanged:
        reason = reason or "published_source_changed"
    record.update(finished_at=now(), exit_code=code, stop_reason=reason, source_unchanged=source_unchanged)
    for suffix in [".log", ".jsonl"]:
        p = evidence / (label + suffix)
        if p.is_file():
            record[suffix + "_sha256"] = hashlib.sha256(p.read_bytes()).hexdigest()
    (evidence / (label + ".json")).write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps({"label": label, "exit_code": code, "stop_reason": reason}))
if code != 0 or reason:
    log_path = evidence / (label + ".log")
    if log_path.exists():
        with log_path.open("rb") as stream:
            stream.seek(max(0, log_path.stat().st_size - 6000))
            tail = stream.read().decode(errors="replace")
        for line in tail.splitlines()[-30:]:
            line = line.replace(str(Path.cwd()), "<source>").replace(os.environ["RUNNER_TEMP"], "<runner-temp>")
            print("[failed command] " + line)
sys.exit(code if 0 <= code <= 255 and not reason else 1)
