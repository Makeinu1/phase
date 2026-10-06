#!/usr/bin/env python3
"""Validator tests only: no mocked WebRTC and no browser capability claim."""

import copy
import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
