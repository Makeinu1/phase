#!/usr/bin/env python3
"""Completion/input validator tests only, never WebRTC capability proof."""
import copy
import tempfile
import unittest
from pathlib import Path

from qa_wpt_rtc_control import CASES, INPUTS, check_result, load_inputs
from qa_rtc_comparison import TRIALS, summarize


class ControlContractTests(unittest.TestCase):
    def test_fixed_plan_retains_failures_and_never_accepts_missing_trials(self):
        records = [{"arm": arm, "number": number, "pass": True} for arm, number in TRIALS]
        self.assertEqual(summarize(records)["result"], "pass")
        records[0]["pass"] = False
        result = summarize(records)
        self.assertEqual(result["result"], "fail")
        self.assertEqual(result["arms"], {"qa": False, "send-in-open": True, "immediate-bidirectional": True})
        self.assertFalse(summarize(records[1:])["completeFixedPlan"])
        self.assertEqual(summarize(records[1:])["result"], "fail")

    def test_exact_completion_for_each_selected_case(self):
        for case, values in CASES.items():
            check_result({"harnessStatus": 0, "tests": [{"name": values[3], "status": 0}]}, case)

    def test_failure_incomplete_wrong_case_and_boolean_statuses_are_rejected(self):
        good = {"harnessStatus": 0, "tests": [{"name": CASES["send-in-open"][3], "status": 0}]}
        invalid = [{}, {"result": "running"}, {**good, "harnessStatus": False},
                   {**good, "harnessStatus": 1}, {**good, "tests": []},
                   {**good, "tests": good["tests"] * 2}, {**good, "extra": 0}]
        for status in (False, True, "0", None, 1, 2, 3, 4):
            value = copy.deepcopy(good)
            value["tests"][0]["status"] = status
            invalid.append(value)
        other = copy.deepcopy(good)
        other["tests"][0]["name"] = CASES["immediate-bidirectional"][3]
        invalid.append(other)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                check_result(value, "send-in-open")

    def test_missing_tampered_and_symlink_input_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            name = next(iter(INPUTS))
            with self.assertRaises(ValueError):
                load_inputs(root)
            path = root / name
            path.parent.mkdir(parents=True)
            path.write_bytes(b"untrusted control source")
            with self.assertRaises(ValueError):
                load_inputs(root)
            path.unlink()
            target = root / "different-file"
            target.write_bytes(b"untrusted control source")
            path.symlink_to(target)
            with self.assertRaises(ValueError):
                load_inputs(root)


if __name__ == "__main__":
    unittest.main()
