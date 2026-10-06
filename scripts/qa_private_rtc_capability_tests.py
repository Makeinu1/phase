#!/usr/bin/env python3
"""Validator/cleanup fault injection only; no browser capability proof."""

import copy
import base64
import errno
import hashlib
import json
import tempfile
import shutil
import sys
import types
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

import qa_private_rtc_capability as driver

from qa_private_rtc_capability import HTML, MANIFEST, SOURCE_INPUTS, check_a1, check_a2, check_reobservation, load_artifact, stable_a1


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {"stamp": {"sourceSha256": "a" * 64}, "entry": {"integrity": "sha384-test"}}
        identity = {"origin": "http://127.0.0.1:1234", "path": "/qa/private-rtc-capability.html", "flags": {
            "environmentAccepted": "1", "queryFlagCount": 0, "fragmentFlagCount": 1,
            "unknownFlagCount": 0, "unknownFlagValues": "unknown",
        }}
        self.a1 = {
            "runtimeStamp": self.manifest["stamp"], "manifest": self.manifest, "secureContext": True,
            "apiPresence": {key: "present" for key in ["RTCPeerConnection", "RTCDataChannel", "cryptoSubtleDigest", "serviceWorker", "cacheStorage"]},
            "script": {"documentScriptMatchesRuntime": True, "manifestFileMatchesRuntime": True,
                       "stampMatches": True, "integrityMatches": True, "documentIntegrity": "sha384-test", "laterRefetchPerformed": False},
            "initialIdentity": identity, "currentIdentity": identity,
            "drift": {"controllerChanges": 0, "navigationEvents": 0, "locationChanged": False},
            "serviceWorkers": {"state": "complete", "truncated": False, "controller": None,
                               "registrationCount": 0, "registrations": [], "identitySha256": "b" * 64, "capturedAtMs": 1},
            "cacheInventory": {"state": "complete", "truncated": False, "count": 0, "nameSha256": [], "capturedAtMs": 1},
        }
        side = {"payloadReceived": True, "acknowledgementReceived": True,
                "counts": {"openEvents": 1, "messagesSent": 2, "messagesReceived": 2, "bytesSent": 64, "bytesReceived": 64,
                           "iceEvents": 2, "localCandidates": 1, "queuedCandidates": 0, "applyingCandidates": 0, "appliedCandidates": 1},
                "states": {"connection": "connected", "ice": "connected", "channel": "open", "signaling": "stable"}}
        self.a2 = {"result": "pass", "payloadBytes": 32, "iceServerCount": 0, "limitMs": 30_000, "elapsedMs": 10,
                   "sides": [copy.deepcopy(side), copy.deepcopy(side)],
                   "exchangeEvents": [{"side": side, "event": event} for side, event in [
                       (0, "handlers-attached"), (1, "handlers-attached"), (0, "open"), (1, "open"),
                       (0, "send-payload"), (1, "send-payload"), (1, "receive-payload"), (1, "send-ack"),
                       (0, "receive-payload"), (0, "send-ack"), (0, "receive-ack"), (1, "receive-ack")]]}

    def test_matching_contract(self):
        check_a1(self.a1, self.manifest, "http://127.0.0.1:1234")
        check_a2(self.a2)

    def test_failed_unknown_or_changed_observations(self):
        cases = [("secureContext", False), ("runtimeStamp", None)]
        for field, value in cases:
            snapshot = copy.deepcopy(self.a1)
            snapshot[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                check_a1(snapshot, self.manifest, "http://127.0.0.1:1234")
        for group, field, values in [
            ("serviceWorkers", "state", ["unknown", "unavailable", "read-failed"]),
            ("cacheInventory", "state", ["unknown", "unavailable", "read-failed"]),
            ("serviceWorkers", "registrationCount", [None, 1]),
            ("serviceWorkers", "identitySha256", [None, "invalid"]),
            ("serviceWorkers", "controller", [{"state": "activated"}]),
            ("cacheInventory", "count", [None, 1]),
            ("cacheInventory", "nameSha256", [["c" * 64]]),
            ("drift", "controllerChanges", [1]),
            ("apiPresence", "RTCPeerConnection", ["unknown", "absent"]),
            ("script", "stampMatches", [False, None]),
            ("script", "laterRefetchPerformed", [True]),
        ]:
            for value in values:
                snapshot = copy.deepcopy(self.a1)
                snapshot[group][field] = value
                with self.subTest(group=group, field=field, value=value), self.assertRaises(ValueError):
                    check_a1(snapshot, self.manifest, "http://127.0.0.1:1234")

    def test_intent_flag_does_not_allow_other_identity(self):
        for value in [None, "unknown"]:
            snapshot = copy.deepcopy(self.a1)
            snapshot["currentIdentity"]["flags"]["environmentAccepted"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                check_a1(snapshot, self.manifest, "http://127.0.0.1:1234")
        with self.assertRaises(ValueError):
            check_a1(self.a1, self.manifest, "http://127.0.0.1:5678")

    def test_only_capture_times_are_excluded(self):
        current = copy.deepcopy(self.a1)
        current["serviceWorkers"]["capturedAtMs"] = 2
        current["cacheInventory"]["capturedAtMs"] = 3
        self.assertEqual(stable_a1(self.a1), stable_a1(current))
        current["serviceWorkers"]["identitySha256"] = "c" * 64
        self.assertNotEqual(stable_a1(self.a1), stable_a1(current))

    def test_a2_timeout_partial_bytes_or_non_native_settings_fail(self):
        for field, value in [("result", "timeout"), ("payloadBytes", 31), ("iceServerCount", 1), ("elapsedMs", 30_001)]:
            snapshot = copy.deepcopy(self.a2)
            snapshot[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                check_a2(snapshot)
        for group, field, value in [("counts", "bytesReceived", 32), ("counts", "iceEvents", 257),
                                    ("states", "channel", "connecting"), ("states", "ice", "checking")]:
            snapshot = copy.deepcopy(self.a2)
            snapshot["sides"][1][group][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                check_a2(snapshot)
        snapshot = copy.deepcopy(self.a2)
        snapshot["sides"][1]["acknowledgementReceived"] = False
        with self.assertRaises(ValueError):
            check_a2(snapshot)

    def test_reobservation_and_monitoring_remain_required(self):
        observed = {"setup": copy.deepcopy(self.a1), "monitoring": copy.deepcopy(self.a1["drift"]), "beforeRun": copy.deepcopy(self.a1)}
        check_reobservation(self.a1, observed, self.manifest, "http://127.0.0.1:1234")
        for mutation in ["missing", "identity", "monitoring", "frozen"]:
            current = copy.deepcopy(observed)
            if mutation == "missing":
                current["beforeRun"] = None
            elif mutation == "identity":
                current["beforeRun"]["serviceWorkers"]["identitySha256"] = "c" * 64
            elif mutation == "monitoring":
                current["monitoring"]["controllerChanges"] = 1
            else:
                current["setup"]["serviceWorkers"]["capturedAtMs"] = 2
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                check_reobservation(self.a1, current, self.manifest, "http://127.0.0.1:1234")

    def test_exchange_requires_both_actual_open_events_and_verified_message_order(self):
        check_a2(self.a2)
        for mutation in ["early-send", "early-ack", "duplicate", "missing", "extra", "unknown", "bad-side"]:
            snapshot = copy.deepcopy(self.a2)
            events = snapshot["exchangeEvents"]
            if mutation == "early-send":
                events[3], events[4] = events[4], events[3]
            elif mutation == "early-ack":
                events[6], events[7] = events[7], events[6]
            elif mutation == "duplicate":
                events[3] = copy.deepcopy(events[2])
            elif mutation == "missing":
                events.pop()
            elif mutation == "extra":
                events.append(copy.deepcopy(events[0]))
            elif mutation == "unknown":
                events[0]["event"] = "unknown"
            else:
                events[0]["side"] = True
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                check_a2(snapshot)


class ArtifactTests(unittest.TestCase):
    def test_artifact_source_sri_and_manifest_refusals(self):
        for mutation in ["none", "source", "entry", "head", "inline", "html-script", "vite"]:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                client = Path(directory) / "client"
                build = Path(directory) / "build"
                digest = hashlib.sha256()
                for name in SOURCE_INPUTS:
                    path = client / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    data = ("synthetic validator input: " + name).encode()
                    path.write_bytes(data)
                    digest.update(name.encode() + b"\0" + data + b"\0")
                source_sha = digest.hexdigest()
                entry_name = "assets/capability-validator.js"
                data = b"// Validator fixture only; never executed in a browser.\n"
                integrity = "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode()
                vite = json.dumps({HTML: {"file": entry_name, "isEntry": True}}).encode()
                manifest = {"stamp": {"schema": 1, "sourceDirty": False, "sourceSha256": source_sha, "sourceHead": "a" * 40},
                            "entry": {"file": entry_name, "bytes": len(data), "integrity": integrity},
                            "viteManifest": {"file": ".vite/manifest.json", "sha256": hashlib.sha256(vite).hexdigest(), "entryKey": HTML}}
                if mutation == "source":
                    (client / SOURCE_INPUTS[0]).write_bytes(b"different source")
                if mutation == "entry":
                    data += b"different byte"
                if mutation == "head":
                    manifest["stamp"]["sourceHead"] = "b" * 40
                inline = copy.deepcopy(manifest)
                if mutation == "inline":
                    inline["entry"]["bytes"] += 1
                if mutation == "vite":
                    vite += b" "
                script_path = "/wrong.js" if mutation == "html-script" else "/" + entry_name
                html = f'<script type="module" crossorigin="anonymous" integrity="{integrity}" src="{script_path}"></script><script id="qa-runtime-manifest" type="application/json">{json.dumps(inline)}</script>'
                for name, value in [(entry_name, data), (MANIFEST, json.dumps(manifest).encode()),
                                    (".vite/manifest.json", vite), (HTML, html.encode())]:
                    path = build / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(value)
                if mutation == "none":
                    loaded, _contents, _proof = load_artifact(build, client, source_sha, "a" * 40)
                    self.assertEqual(loaded, manifest)
                else:
                    with self.assertRaises(ValueError):
                        load_artifact(build, client, source_sha, "a" * 40)


class CleanupTests(unittest.TestCase):
    """Fake page snapshots isolate teardown; no native/browser process is run."""

    def setUp(self):
        contract = ContractTests()
        contract.setUp()
        self.manifest = contract.manifest
        observed = {"setup": contract.a1, "monitoring": contract.a1["drift"], "beforeRun": contract.a1}
        self.page = Mock()
        outputs = {"#qa-a1-output": [json.dumps({"setup": contract.a1}), json.dumps(observed)],
                   "#qa-a2-output": ["Not run", json.dumps(contract.a2)]}
        locators = {key: Mock() for key in [*outputs, "#qa-a2-run"]}
        for key, values in outputs.items():
            locators[key].inner_text.side_effect = values
        self.page.locator.side_effect = lambda key: locators[key]
        locators["#qa-a2-run"].is_enabled.return_value = True
        locators["#qa-a2-run"].is_disabled.return_value = True
        self.browser = Mock(version="test-only")
        self.browser.new_context.return_value.new_page.return_value = self.page
        self.playwright = Mock()
        self.playwright.chromium.connect_over_cdp.return_value = self.browser
        self.process = Mock()
        self.process.poll.return_value = None
        self.process.wait.return_value = 0
        self.server = Mock(server_port=1234)
        self.thread = Mock()
        self.thread.is_alive.return_value = False
        module = types.ModuleType("playwright.sync_api")
        module.sync_playwright = lambda: Mock(start=lambda: self.playwright)
        self.modules = {"playwright": types.ModuleType("playwright"), "playwright.sync_api": module}
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.args = types.SimpleNamespace(browser_path="/not-run/browser", output_dir=Path(directory.name))
        self.result = {"result": "fail", "stage": "artifact-check"}

    def run_fault(self):
        error = None
        with ExitStack() as stack:
            stack.enter_context(patch.dict(sys.modules, self.modules))
            stack.enter_context(patch.object(driver, "ThreadingHTTPServer", return_value=self.server))
            stack.enter_context(patch.object(driver.threading, "Thread", return_value=self.thread))
            stack.enter_context(patch.object(driver.subprocess, "Popen", return_value=self.process))
            stack.enter_context(patch.object(driver.Path, "read_text", return_value="1234\n"))
            try:
                driver.run_browser(self.args, self.manifest, {}, self.result)
            except Exception as failure:
                error = failure
        command = self.result["browserArguments"]
        self.profile = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--user-data-dir=")))
        self.addCleanup(shutil.rmtree, self.profile, ignore_errors=True)
        return error

    def test_two_cleanup_errors_preserve_first_and_release_remaining_resources(self):
        self.browser.close.side_effect = OSError(errno.EBADF, "private-error-text")
        self.playwright.stop.side_effect = OSError(errno.EIO, "second-private-error-text")
        error = self.run_fault()
        self.assertEqual(error.errno, errno.EBADF)
        self.assertEqual(self.result["a2"]["result"], "pass")
        self.assertEqual(self.result["cleanup"]["result"], "fail")
        errors = [x for x in self.result["cleanup"]["steps"] if x["result"] == "fail"]
        self.assertEqual([(x["stage"], x["error"]["errno"]) for x in errors], [("browser-close", errno.EBADF), ("playwright-stop", errno.EIO)])
        self.assertNotIn("private-error-text", json.dumps(self.result["cleanup"]))
        self.process.wait.assert_called_once_with(timeout=5)
        self.server.server_close.assert_called_once()
        self.thread.join.assert_called_once_with(timeout=2)

    def test_server_shutdown_error_still_closes_socket_and_preserves_requests(self):
        self.server.shutdown.side_effect = OSError(errno.EIO, "private-server-path")
        error = self.run_fault()
        self.assertEqual(error.errno, errno.EIO)
        self.server.server_close.assert_called_once()
        self.thread.join.assert_called_once_with(timeout=2)
        self.assertEqual(self.result["httpRequests"], [])
        self.assertEqual(self.result["cleanup"]["result"], "fail")

    def test_process_stop_error_retains_profile_and_fails(self):
        self.process.terminate.side_effect = OSError(errno.EPERM, "private-process-detail")
        error = self.run_fault()
        self.assertEqual(error.errno, errno.EPERM)
        self.assertTrue(self.profile.is_dir())
        profile = next(x for x in self.result["cleanup"]["steps"] if x["stage"] == "profile-remove")
        self.assertEqual(profile["result"], "skipped")
        self.assertEqual(self.result["cleanup"]["result"], "fail")
        self.server.server_close.assert_called_once()

    def test_observation_error_remains_authoritative_when_cleanup_also_fails(self):
        self.page.goto.side_effect = ValueError("fixed-observation-failure")
        self.browser.close.side_effect = OSError(errno.EBADF, "private-close-detail")
        error = self.run_fault()
        self.assertIsInstance(error, ValueError)
        self.assertEqual(str(error), "fixed-observation-failure")
        self.assertEqual(self.result["cleanup"]["result"], "fail")
        self.server.server_close.assert_called_once()

    def test_unrelated_caller_exception_cannot_suppress_cleanup_failure(self):
        self.browser.close.side_effect = OSError(errno.EBADF, "private-close-detail")
        try:
            raise ValueError("unrelated-caller-exception")
        except ValueError:
            error = self.run_fault()
        self.assertIsInstance(error, OSError)
        self.assertEqual(error.errno, errno.EBADF)
        self.assertEqual(self.result["cleanup"]["result"], "fail")

    def test_launch_exception_text_is_not_saved(self):
        self.playwright.chromium.connect_over_cdp.side_effect = ValueError("private-launch-message /private/launch/path")
        self.assertIsInstance(self.run_fault(), ValueError)
        self.assertNotIn("private-launch-message", json.dumps(self.result))
        self.assertNotIn("/private/launch/path", json.dumps(self.result))

    def test_successful_cleanup_keeps_complete_and_reaps_before_profile_removal(self):
        self.assertIsNone(self.run_fault())
        self.assertEqual(self.result["stage"], "complete")
        self.assertEqual(self.result["cleanup"]["result"], "pass")
        self.assertTrue(self.result["cleanup"]["launchFilesClosed"])
        self.assertEqual(self.result["cleanup"]["browserProcess"]["exitCode"], 0)
        self.assertFalse(self.profile.exists())

    def test_exited_process_is_reaped_without_sending_signals(self):
        self.process.poll.return_value = 0
        cleanup = {}
        driver.stop_browser_process(self.process, cleanup)
        self.process.terminate.assert_not_called()
        self.process.kill.assert_not_called()
        self.process.wait.assert_called_once_with(timeout=5)
        self.assertEqual(cleanup["browserProcess"]["exitCode"], 0)

    def test_termination_timeout_escalates_only_to_owned_process_and_reaps(self):
        self.process.wait.side_effect = [driver.subprocess.TimeoutExpired("test-only", 5), -9]
        cleanup = {}
        driver.stop_browser_process(self.process, cleanup)
        self.process.terminate.assert_called_once()
        self.process.kill.assert_called_once()
        self.assertEqual(self.process.wait.call_args_list, [unittest.mock.call(timeout=5), unittest.mock.call(timeout=5)])
        self.assertEqual(cleanup["browserProcess"], {"terminateSent": True, "killSent": True, "exitCode": -9})

    def main_failure(self, error):
        def fail_cleanup(args, manifest, contents, result):
            result.update(stage="complete", a2={"result": "pass"}, cleanup={"result": "fail"})
            raise error

        output = self.args.output_dir / "result-run"
        argv = ["driver", "--build-dir", "not-used", "--output-dir", str(output),
                "--browser-path", sys.executable, "--expected-source-sha256", "a" * 64,
                "--expected-source-head", "b" * 40]
        with patch.object(sys, "argv", argv), patch.object(driver.importlib.metadata, "version", return_value="test-only"), \
                patch.object(driver.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout="test browser")), \
                patch.object(driver, "load_artifact", return_value=(self.manifest, {}, {})), \
                patch.object(driver, "run_browser", side_effect=fail_cleanup):
            self.assertEqual(driver.main(), 1)
        saved = json.loads((output / "result.json").read_text())
        self.assertEqual(saved["result"], "fail")
        self.assertEqual(saved["a2"]["result"], "pass")
        self.assertNotIn("private-message", json.dumps(saved))
        self.assertNotIn("/private/profile/name", json.dumps(saved))
        return saved

    def test_main_saves_passed_a2_but_returns_failure_with_safe_error_code(self):
        saved = self.main_failure(OSError(errno.ENOTEMPTY, "private-message", "/private/profile/name"))
        self.assertEqual(saved["errorDetails"]["errno"], errno.ENOTEMPTY)
        self.assertEqual(saved["errorDetails"]["code"], "ENOTEMPTY")

    def test_cleanup_value_error_never_saves_private_text_or_path(self):
        saved = self.main_failure(ValueError("private-message /private/profile/name"))
        self.assertEqual(saved["errorDetails"]["type"], "ValueError")
        self.assertIsNone(saved["errorDetails"]["errno"])


if __name__ == "__main__":
    unittest.main()
