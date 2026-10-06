"""One 30s preflight command, followed by bounded cleanup of its owned group."""
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

stage, directory, *argv = sys.argv[1:]
assert stage in {"input-public-exports", "browser-CDP-capability"} and argv
evidence = Path(directory)
evidence.mkdir(parents=True, exist_ok=True)
receipt = evidence / "process-exit.json"
assert not receipt.exists(), "do not retry a recorded preflight"
record = {"stage": stage, "deadlineSeconds": 30, "cleanupWaitSecondsPerSignal": 5,
          "noRetry": True, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
process = None
stop_signal = None
code = 1


def request_stop(signum, _frame):
    global stop_signal
    stop_signal = signum


def members(group):
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if int(fields[2]) == group:
            found.append({"pid": int(entry.name), "state": fields[0]})
    return found


def active(group):
    return [row for row in members(group) if row["state"] not in {"Z", "X"}]


def stop_group(group, signum):
    try:
        os.killpg(group, signum)
    except ProcessLookupError:
        return
    until = time.monotonic() + 5
    while time.monotonic() < until:
        process.poll()  # Reap the owned direct child before observing its group.
        if not active(group):
            return
        time.sleep(0.1)


signal.signal(signal.SIGTERM, request_stop)
signal.signal(signal.SIGINT, request_stop)
try:
    with (evidence / "process.log").open("w") as log:
        process = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        record["ownedPgid"] = process.pid
        deadline = time.monotonic() + 30
        while process.poll() is None and not stop_signal and time.monotonic() < deadline:
            time.sleep(0.1)
        record["deadlineExceeded"] = process.poll() is None and not stop_signal
        record["supervisorSignal"] = stop_signal
        code = 124 if record["deadlineExceeded"] else (1 if stop_signal else process.returncode)
except Exception as error:
    record["failure"] = str(error)[:240]
finally:
    if process is not None:
        try:
            record["membersBeforeCleanup"] = members(process.pid)
            record["cleanupSignals"] = []
            for signum in [signal.SIGTERM, signal.SIGKILL]:
                if active(process.pid):
                    record["cleanupSignals"].append(signal.Signals(signum).name)
                    stop_group(process.pid, signum)
            record["membersAfterCleanup"] = members(process.pid)
            record["activeMembersAfterCleanup"] = active(process.pid)
            record["cleanupScope"] = "owned process group; zombies recorded separately from active processes"
            record["childReturnCode"] = process.poll()
            if record["activeMembersAfterCleanup"] or process.returncode is None:
                code = 1
                record["failure"] = "owned process group cleanup incomplete"
        except Exception as error:
            code = 1
            record["cleanupFailure"] = str(error)[:240]
    code = code if isinstance(code, int) and 0 <= code <= 255 else 1
    record.update(exitCode=code, passCommand=code == 0,
                  finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    receipt.write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps({"stage": stage, "exitCode": code, "deadlineExceeded": record.get("deadlineExceeded"),
                  "activeMembersAfterCleanup": record.get("activeMembersAfterCleanup")}))
sys.exit(code)
