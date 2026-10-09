"""Offline Finish evidence regressions; synthetic bytes are not product UI PASS."""
import ast
import base64
import datetime
import hashlib
import html
import importlib.util
import json
import re
from pathlib import Path
import struct
import tempfile
import unittest
import zlib
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('capture', Path(__file__).with_name('p1-product-capture.py'))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class FinishEvidenceTests(unittest.TestCase):
    def test_ordinary_double_click_uses_native_pointer_pair_and_structured_origin(self):
        module = ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'click')
        report, requests, preparations = {}, [], []
        selector = '[data-hand-card][data-object-id="11"]'
        namespace = {'report': report, 'stage': 'paidplay-normal-direct', 'datetime': datetime,
                     'element': lambda selector, using: 'private-native-card-reference',
                     'prepare_hand_click': lambda selector, identifier: preparations.append(selector),
                     'hit_observation': lambda selector, **kwargs: {'centerHitsTarget': True, 'expectedWebDriverPointHitsTarget': True},
                     'call': lambda path, data=None: requests.append((path, data)),
                     'start_native_input_observation': lambda selector: {'installed': True},
                     'finish_native_input_observation': lambda: {'events': [], 'dropped': 0, 'publicStateAfterCommand': {'life': [19,20]}}}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<ordinary-native-double-click>', 'exec'), namespace)
        namespace['click'](selector, double=True)
        self.assertEqual(preparations, [selector])
        self.assertEqual([p for p, _ in requests], ['/actions'])
        actions = requests[0][1]['actions'][0]['actions']
        self.assertEqual(actions[0]['origin'], {'element-6066-11e4-a52e-4f735466cecf': 'private-native-card-reference'})
        self.assertEqual([a['type'] for a in actions], ['pointerMove', 'pointerDown', 'pointerUp', 'pause', 'pointerDown', 'pointerUp'])
        self.assertTrue(all(a['button'] == 0 for a in actions if a['type'] in {'pointerDown', 'pointerUp'}))
        self.assertEqual(report['click_commands'][0]['kind'], 'native-pointer-double-click')
        self.assertEqual(report['click_commands'][0]['status'], 'completed')
        self.assertEqual(report['click_commands'][0]['native_input_observation']['publicStateAfterCommand']['life'], [19,20])
        self.assertNotIn('private-native-card-reference', json.dumps(report))
        requests.clear()
        namespace['hit_observation'] = lambda selector, **kwargs: {'centerHitsTarget': True, 'expectedWebDriverPointHitsTarget': False}
        with self.assertRaises(AssertionError):
            namespace['click'](selector, double=True)
        self.assertEqual(requests, [])
        self.assertEqual(report['click_commands'][-1]['reason'], 'native-origin-obstructed')
        namespace['hit_observation'] = lambda selector, **kwargs: {'centerHitsTarget': True, 'expectedWebDriverPointHitsTarget': True}
        finished = []
        namespace['finish_native_input_observation'] = lambda: finished.append(True) or {'events': [], 'dropped': 0}
        def fail_actions(path, data=None):
            report['webdriver_error'] = {'error': 'invalid argument'}
            raise RuntimeError('native actions failed')
        namespace['call'] = fail_actions
        with self.assertRaisesRegex(RuntimeError, 'native actions failed'):
            namespace['click'](selector, double=True)
        self.assertEqual(finished, [True])
        self.assertEqual(report['click_commands'][-1]['status'], 'failed')
        self.assertEqual(report['click_commands'][-1]['native_input_observation']['events'], [])
        def fail_collector():
            report['webdriver_error'] = {'error': 'javascript error'}
            raise RuntimeError('collector failed')
        namespace['finish_native_input_observation'] = fail_collector
        with self.assertRaisesRegex(RuntimeError, 'native actions failed'):
            namespace['click'](selector, double=True)
        self.assertEqual(report['click_commands'][-1]['error'], {'error': 'invalid argument'})
        self.assertEqual(report['webdriver_error'], {'error': 'invalid argument'})
        self.assertEqual(report['click_commands'][-1]['native_input_observation_error_type'], 'RuntimeError')



    def test_click_commands_identify_button_operation_and_keep_original_error_when_diagnostic_fails(self):
        module = ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'click')
        report, requests = {}, []
        original = {'error': 'element click intercepted', 'native_click_point': {'x': 559, 'y': 640},
                    'target_at_error': {'tag': 'BUTTON'}, 'interceptor_at_error': {'tag': 'SPAN'}}
        def observe(selector, native_point=None, using='css selector'):
            self.assertEqual(using, 'xpath')
            return {'selector': selector, 'nativePoint': native_point}
        def call(path, data=None):
            requests.append(path)
            if namespace['stage'] == 'paidplay-options':
                return None
            if path.endswith('/click'):
                report['webdriver_error'] = dict(original)
                raise RuntimeError('original click failed')
            if path == '/screenshot':
                report['webdriver_error'] = {'error': 'different diagnostic error'}
                raise RuntimeError('diagnostic failed')
            self.fail('Unexpected command')
        namespace = {'report': report, 'stage': 'paidplay-options', 'datetime': datetime, 'base64': base64,
                     'element': lambda selector, using: 'private-browser-element-reference',
                     'hit_observation': observe, 'call': call}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<click-command-binding>', 'exec'), namespace)
        namespace['click']('//button[normalize-space()="Resolution options for Next Ordinary Play"]', 'xpath')
        namespace['stage'] = 'paidplay-normal'
        with self.assertRaisesRegex(RuntimeError, 'original click failed'):
            namespace['click']('//button[normalize-space()="Cast normally"]', 'xpath')
        self.assertEqual([c['operation'] for c in report['click_commands']], ['paidplay-options', 'paidplay-normal'])
        self.assertEqual([c['status'] for c in report['click_commands']], ['completed', 'failed'])
        self.assertEqual(report['failed_click_operation'], 'paidplay-normal')
        self.assertEqual(report['webdriver_error'], original)
        self.assertEqual(report['click_observation_after_failure_error_type'], 'RuntimeError')
        self.assertEqual(report['click_commands'][1]['after']['nativePoint'], {'x': 559, 'y': 640})
        self.assertNotIn('private-browser-element-reference', json.dumps(report))

    def test_click_error_keeps_native_point_and_interceptor_without_raw_private_attributes(self):
        module = ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'click_error_details')
        namespace = {'re': re, 'html': html}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<safe-native-click-error>', 'exec'), namespace)
        message = ('Element <div class="card" data-object-id="11"> is not clickable at point (866, 913). '
                   'Other element would receive the click: <section id="guide" class="overlay" '
                   'aria-label="Finish &amp; continue" data-private-capability="secret-token">')
        details = namespace['click_error_details'](message)
        self.assertEqual(details['native_click_point'], {'x': 866, 'y': 913})
        self.assertEqual(details['interceptor_at_error'], {'tag': 'SECTION', 'id': 'guide',
                         'class': 'overlay', 'aria-label': 'Finish & continue'})
        self.assertEqual(details['target_at_error'], {'tag': 'DIV', 'class': 'card'})
        self.assertNotIn('secret-token', json.dumps(details))
        self.assertEqual(namespace['click_error_details']('unrelated private receipt body'), {})

    def test_native_hand_hover_waits_for_stable_hit_and_preserves_obstruction(self):
        module = ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'prepare_hand_click')
        code = compile(ast.Module(body=[function], type_ignores=[]), '<reviewed-hand-stability>', 'exec')
        hit = {'rect': {'left': 10, 'top': 850, 'right': 110, 'bottom': 1050},
               'viewport': {'width': 1440, 'height': 1000}, 'scroll': {'x': 0, 'y': 0}, 'centerHitsTarget': True}
        moving = dict(hit, rect=dict(hit['rect'], top=830, bottom=1030))
        blocked = dict(hit, centerHitsTarget=False)
        for states, succeeds in [([hit, moving, hit, hit, hit], True), ([blocked], False)]:
            with self.subTest(succeeds=succeeds):
                remaining, requests, elapsed, report = list(states), [], [0], {}
                def observation(selector):
                    return remaining.pop(0) if len(remaining) > 1 else remaining[0]
                def call(path, data=None):
                    requests.append((path, data))
                def sleep(seconds):
                    elapsed[0] += seconds
                namespace = {'report': report, 'hit_observation': observation, 'call': call,
                             'time': SimpleNamespace(monotonic=lambda: elapsed[0], sleep=sleep)}
                exec(code, namespace)
                if succeeds:
                    namespace['prepare_hand_click']('[data-hand-card]', 'native-card')
                    self.assertEqual(report['hand_click_preparation']['status'], 'stable-visible-unobstructed')
                    self.assertFalse(report['hand_click_preparation']['fully_visible'])
                else:
                    with self.assertRaises(AssertionError):
                        namespace['prepare_hand_click']('[data-hand-card]', 'native-card')
                    self.assertFalse(report['hand_click_preparation']['last_observation']['centerHitsTarget'])
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0][0], '/actions')
                self.assertEqual(requests[0][1]['actions'][0]['actions'][0]['type'], 'pointerMove')
                self.assertEqual(requests[0][1]['actions'][0]['actions'][0]['origin'],
                                 {'element-6066-11e4-a52e-4f735466cecf': 'native-card'})

    def test_priority_control_wait_observes_completion_and_does_not_act_for_opponent(self):
        module = ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'resolve_control')
        code = compile(ast.Module(body=[function], type_ignores=[]), '<reviewed-resolve-control>', 'exec')
        own = {'life': [19, 20], 'waitingType': 'Priority', 'priorityPlayer': 0, 'stackCount': 1}
        opponent = dict(own, priorityPlayer=1)
        final = dict(own, life=[22, 20], stackCount=0)
        for states, expected in [([own, own], 'native-control'), ([opponent, final], None),
                                 ([own, final], None), ([opponent], 'timeout')]:
            with self.subTest(states=states):
                remaining = list(states)
                observed, requests, elapsed = [], [], [0]
                def observe():
                    state = remaining.pop(0) if len(remaining) > 1 else remaining[0]
                    observed.append(state)
                    return state
                def call(path, data=None):
                    self.assertEqual(observed[-1]['priorityPlayer'], 0)
                    requests.append(path)
                    return [{'element-6066-11e4-a52e-4f735466cecf': 'native-control'}] if path == '/elements' else True
                def sleep(seconds):
                    elapsed[0] += seconds
                namespace = {'observe': observe, 'call': call,
                             'time': SimpleNamespace(monotonic=lambda: elapsed[0], sleep=sleep)}
                exec(code, namespace)
                if expected == 'timeout':
                    with self.assertRaises(AssertionError):
                        namespace['resolve_control']()
                else:
                    self.assertEqual(namespace['resolve_control'](), expected)
                self.assertFalse(any(path.endswith('/click') for path in requests))

    def verify(self, stack_count=0, finish_changes=None, initial_changes=None, paidplay=False, paid_changes=None):
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
        if paidplay:
            finish.update(ownManaCount=1, nextCardId=11, nextInGraveyard=False)
        finish.update(finish_changes or {})
        paid = dict(finish, life=[22, 20], ownManaCount=0, nextCardId=None, nextInGraveyard=True)
        paid.update(paid_changes or {})
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
               + chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00')) + chunk(b'IEND', b''))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entries = []
            states = [('same-source', initial), ('life19', life), ('finish', finish)]
            if paidplay:
                states.append(('paidplay22', paid))
            for step, state in states:
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
            return capture.validate_required_images(root, manifest, execution, paidplay=paidplay)

    def test_paid_continuation_requires_four_current_execution_receipts(self):
        self.assertEqual(self.verify(paidplay=True)['verified_count'], 4)

    def test_paid_continuation_rejects_unpaid_unresolved_or_manual_state(self):
        faults = [{'life': [21, 20]}, {'life': [22, 19]}, {'ownManaCount': 1},
                  {'ownManaCount': False}, {'stackCount': 1}, {'manualPhase': 'open'},
                  {'resolvingEntryId': 9}, {'waitingType': 'ManaPayment'},
                  {'nextCardId': 11}, {'nextInGraveyard': False}]
        for change in faults:
            with self.subTest(change=change), self.assertRaises(capture.EvidenceFailure):
                self.verify(paidplay=True, paid_changes=change)
        with self.assertRaises(capture.EvidenceFailure):
            self.verify(paidplay=True, finish_changes={'ownManaCount': 0})

    def test_paid_operation_requires_payment_before_resolution(self):
        paid = {'life': [19, 20], 'ownManaCount': 0, 'stackCount': 1, 'waitingType': 'Priority',
                'manualPhase': 'closed', 'resolvingEntryId': None, 'nextCardId': None, 'nextInGraveyard': False}
        report = {'status': 'passed', 'consumer': {}, 'consumer_execution': {}, 'secondary': [],
                  'primary': {'stage': 'operations-complete', 'code': 0, 'reason': 'completed'},
                  'stages': {name: {'status': 'passed', 'assertions_completed': True}
                             for name in ['initial', 'life19', 'finish', 'paidplay22']},
                  'paid_before_resolution': paid}
        capture.validate_operations(report, {}, {}, paidplay=True)
        for change in [{'ownManaCount': 1}, {'stackCount': 0}, {'life': [22, 20]},
                       {'manualPhase': 'open'}, {'nextInGraveyard': True}]:
            with self.subTest(change=change), self.assertRaises(capture.EvidenceFailure):
                capture.validate_operations(dict(report, paid_before_resolution=dict(paid, **change)), {}, {}, paidplay=True)

    def test_bounded_restore_and_driver_require_complete_nonvacuous_receipts(self):
        k1 = {'life': [20,20], 'manualPhase': 'open', 'sourceId': 1, 'sourceName': 'P1 Self Loss',
              'stackCount': 0, 'manualStackEntryId': 1, 'resolvingEntryId': 1,
              'waitingType': 'ManualResolution', 'priorityPlayer': None, 'ownManaCount': 1, 'nextCardId': 2}
        paid = {'life': [19,20], 'manualPhase': 'closed', 'stackCount': 1, 'ownManaCount': 0,
                'waitingType': 'Priority', 'priorityPlayer': 1, 'resolvingEntryId': None,
                'nextCardId': None, 'nextInGraveyard': False}
        report = {'status': 'passed', 'consumer': {}, 'consumer_execution': {}, 'secondary': [],
                  'primary': {'stage': 'operations-complete', 'code': 0, 'reason': 'completed'},
                  'stages': {name: {'status': 'passed', 'assertions_completed': True} for name in
                             ['initial','life19','finish','paidplay22','checked-restore-k1','fixture-opponent-pass']},
                  'paid_before_resolution': paid,
                  'checked_restore_k1': {'ok': True, 'method': 'existing-live-export-and-authenticated-checked-restore',
                    'checkpoint_sha256': 'a'*64, 'contextChecks': {key: True for key in
                        ['sameOwner','newSession','nextRestoreEpoch','nextAdapterGeneration']}, 'before': k1, 'after': k1},
                  'fixture_opponent_driver': {'ok': True, 'mode': 'explicit-local-fixture-opponent-driver',
                    'action': 'PassPriority', 'actor': 1, 'commands': 1, 'opponent_ui': False, 'two_client': False,
                    'before': paid, 'after': {'life': [22,20]}}}
        capture.validate_operations(report, {}, {}, paidplay=True, restore_driver=True)
        changes = [(['checked_restore_k1'], None),
                   (['stages','checked-restore-k1','status'], 'skipped'),
                   (['stages','fixture-opponent-pass','assertions_completed'], False),
                   (['checked_restore_k1','contextChecks'], {}),
                   (['checked_restore_k1','contextChecks','newSession'], False),
                   (['checked_restore_k1','contextChecks','extra'], True),
                   (['checked_restore_k1','checkpoint_sha256'], 'invalid'),
                   (['checked_restore_k1','after','sourceId'], 9),
                   (['fixture_opponent_driver'], None),
                   (['fixture_opponent_driver','actor'], 0),
                   (['fixture_opponent_driver','actor'], True),
                   (['fixture_opponent_driver','action'], 'BeginResolveAll'),
                   (['fixture_opponent_driver','commands'], 2),
                   (['fixture_opponent_driver','commands'], True),
                   (['fixture_opponent_driver','opponent_ui'], True),
                   (['fixture_opponent_driver','two_client'], True),
                   (['fixture_opponent_driver','before','priorityPlayer'], 0),
                   (['fixture_opponent_driver','before','ownManaCount'], 1),
                   (['fixture_opponent_driver','before','resolvingEntryId'], 1)]
        for keys, value in changes:
            changed = json.loads(json.dumps(report))
            target = changed
            for key in keys[:-1]: target = target[key]
            target[keys[-1]] = value
            with self.subTest(keys=keys, value=value), self.assertRaises(capture.EvidenceFailure):
                capture.validate_operations(changed, {}, {}, paidplay=True, restore_driver=True)

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
