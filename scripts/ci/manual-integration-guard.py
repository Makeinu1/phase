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

SOURCE = "2ea90812ed16f701c6257353493a3665f000cff0"
PINS = {
    "Cargo.lock": "5285fad7759794f57019d5d73e49cbc35207395b7faf31341da5bc80d32463f0",
    "client/pnpm-lock.yaml": "bc13ba1f6de5efd5bc724d9945aa541136df1d6938a41c53768f76c7b36c4ea4",
    "rust-toolchain.toml": "52562c175563386d0f9f19afafd2855662ef2590765204b35bd624de13fe67af",
}
GIB = 1024**3
limit = 13 * GIB
disk_min = 4 * GIB
label, *argv = sys.argv[1:]
assert argv and label.replace("-", "").isalnum()
evidence = Path(os.environ["MANUAL_EVIDENCE"])
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


def source_stop_reason():
    try:
        if git("rev-parse", "HEAD") != SOURCE:
            return "source_sha_mismatch"
        if git("status", "--porcelain") != "":
            return "source_tree_not_clean"
        for path, expected in PINS.items():
            if hashlib.sha256(Path(path).read_bytes()).hexdigest() != expected:
                return "source_hash_mismatch:" + path
    except Exception as error:
        return "source_check_error:" + type(error).__name__
    return None


record = {"label": label, "started_at": now(), "source_sha": SOURCE,
          "event_sha": os.environ.get("GITHUB_SHA"), "source_tree": None, "argv": argv,
          "input_sha256": PINS,
          "environment": {k: os.environ.get(k) for k in ["CARGO_TARGET_DIR", "CARGO_BUILD_JOBS", "RUST_MIN_STACK", "CARGO_INCREMENTAL", "CARGO_PROFILE_DEV_DEBUG"]},
          "guard": {"working_set_bytes": limit, "disk_free_min_bytes": disk_min,
                    "sample_interval_seconds": 1, "timeout_seconds": 1500}, "preflight": None}
process = None
reason = None
code = None
before = None
try:
    with (evidence / (label + ".log")).open("w") as log, (evidence / (label + ".jsonl")).open("w") as samples:
        reason = source_stop_reason()
        if not reason:
            record["source_tree"] = git("rev-parse", "HEAD^{tree}")
            for key in ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS",
                        "CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS", "RUSTC_WRAPPER",
                        "RUSTC_WORKSPACE_WRAPPER"]:
                if os.environ.get(key):
                    reason = "unexpected_compiler_override:" + key
                    break
        if not reason and os.environ.get("CARGO_INCREMENTAL", "0") != "0":
            reason = "incremental_must_remain_disabled"
        if not reason:
            try:
                before = sample()
                record["preflight"] = before
                if before["cap_bytes"] < limit:
                    reason = "runner_cap_below_13GiB"
                elif before["working_set_bytes"] > limit:
                    reason = "working_set_above_13GiB"
                elif before["workspace_free_bytes"] < disk_min:
                    reason = "workspace_free_below_4GiB"
                elif before["temp_free_bytes"] < disk_min:
                    reason = "temp_free_below_4GiB"
            except Exception as error:
                reason = "preflight_telemetry_error:" + type(error).__name__
        if not reason:
            try:
                process = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            except Exception as error:
                reason = "command_start_error:" + type(error).__name__
        if process is not None:
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
except Exception as error:
    reason = reason or "guard_error:" + type(error).__name__
finally:
    if process is not None and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    if process is not None:
        code = process.returncode
    source_unchanged = source_stop_reason() is None
    if not source_unchanged:
        reason = reason or "published_source_changed"
    effective_exit = code if code is not None and 0 <= code <= 255 and not reason else 1
    record.update(finished_at=now(), exit_code=code, effective_exit=effective_exit,
                  stop_reason=reason, source_unchanged=source_unchanged)
    for suffix in [".log", ".jsonl"]:
        p = evidence / (label + suffix)
        if p.is_file():
            record[suffix + "_sha256"] = hashlib.sha256(p.read_bytes()).hexdigest()
    (evidence / (label + ".json")).write_text(json.dumps(record, indent=2) + "\n")
    if os.environ.get("GITHUB_OUTPUT"):
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as outputs:
            outputs.write("guard_stopped=" + ("true" if reason else "false") + "\n")
print(json.dumps({"label": label, "argv": argv, "exit_code": code,
                  "effective_exit": effective_exit, "stop_reason": reason}))
if effective_exit != 0:
    log_path = evidence / (label + ".log")
    if log_path.exists():
        with log_path.open("rb") as stream:
            stream.seek(max(0, log_path.stat().st_size - 6000))
            tail = stream.read().decode(errors="replace")
        for line in tail.splitlines()[-30:]:
            line = line.replace(str(Path.cwd()), "<source>").replace(os.environ.get("RUNNER_TEMP", "<runner-temp>"), "<runner-temp>")
            print("[failed command] " + line)
sys.exit(effective_exit)
