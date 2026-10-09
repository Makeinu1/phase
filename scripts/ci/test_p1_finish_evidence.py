"""Offline Finish evidence regressions; synthetic bytes are not product UI PASS."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

spec = importlib.util.spec_from_file_location('capture', Path(__file__).with_name('p1-product-capture.py'))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class FinishEvidenceTests(unittest.TestCase):
    def verify(self, stack_count=0, finish_changes=None, initial_changes=None):
        product = {'sha': 'unit-product', 'tree': 'unit-tree'}
        execution = {'validation_sha': 'unit-consumer', 'run_id': 1, 'run_attempt': 1}
        manifest = {'consumer': product, 'runtime': product, 'validation': {'sha': 'unit-producer'},
                    'artifacts': {'engine_wasm_bg.wasm': {'sha256': 'unit-runtime'}}}
        initial = {'life': [20, 20], 'manualPhase': 'open', 'sourceId': 7, 'sourceName': 'Public card',
                   'stackCount': stack_count, 'waitingType': 'ManualResolution',
                   'manualStackEntryId': 9, 'resolvingEntryId': 9}
        initial.update(initial_changes or {})
        life = dict(initial, life=[19, 20])
        finish = dict(life, manualPhase='closed', waitingType='Priority', resolvingEntryId=None)
        finish.update(finish_changes or {})
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
               + chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00')) + chunk(b'IEND', b''))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entries = []
            for step, state in [('same-source', initial), ('life19', life), ('finish', finish)]:
                item = {'step': step, 'status': 'observation-only', 'exit_code': 0,
                        'consumer': product, 'runtime': product, 'validation': manifest['validation'],
                        'consumer_execution': execution, 'served': {'engine_wasm_bg.wasm': 'unit-runtime'}}
                for kind, relative, data in [('screenshot', 'screenshots/' + step + '.png', png),
                                             ('state', 'states/' + step + '.json', json.dumps(state).encode())]:
                    path = root / relative
                    path.parent.mkdir(exist_ok=True)
                    path.write_bytes(data)
                    item[kind] = {'path': relative, 'sha256': hashlib.sha256(data).hexdigest()}
                entries.append(item)
            (root / 'step-index.json').write_text(json.dumps(entries))
            return capture.validate_required_images(root, manifest, execution)

    def test_empty_stack_finishes_the_already_popped_occurrence(self):
        self.assertEqual(self.verify()['verified_count'], 3)

    def test_nonempty_stack_keeps_other_entries_while_finishing(self):
        self.assertEqual(self.verify(stack_count=2)['verified_count'], 3)

    def test_incomplete_or_unrelated_state_is_rejected(self):
        faults = [({'manualPhase': 'open'}, {}), ({'resolvingEntryId': 9}, {}),
                  ({'waitingType': 'ManualResolution'}, {}), ({'manualStackEntryId': 10}, {}),
                  ({'sourceId': 8}, {}), ({'life': [18, 20]}, {}), ({'stackCount': -1}, {}),
                  ({}, {'resolvingEntryId': None}), ({}, {'resolvingEntryId': 10}),
                  ({}, {'stackCount': True})]
        for finish, initial in faults:
            with self.subTest(finish=finish, initial=initial), self.assertRaises(capture.EvidenceFailure):
                self.verify(finish_changes=finish, initial_changes=initial)

    def test_removing_an_unrelated_nonempty_stack_entry_is_rejected(self):
        with self.assertRaises(capture.EvidenceFailure):
            self.verify(stack_count=2, finish_changes={'stackCount': 1})


if __name__ == '__main__':
    unittest.main()
