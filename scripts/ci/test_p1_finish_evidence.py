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
        namespace = {'report': report, 'stage': 'paidplay-normal-direct', 'datetime': datetime, 're': re,
                     'element': lambda selector, using: 'private-native-card-reference',
                     'prepare_hand_click': lambda selector, identifier: preparations.append(selector),
                     'hit_observation': lambda selector, **kwargs: {'centerHitsTarget': True, 'expectedWebDriverPointHitsTarget': True},
                     'call': lambda path, data=None: requests.append((path, data)),
                     'start_native_input_observation': lambda selector: {'installed': True},
                     'finish_native_input_observation': lambda: {'events': [dict(type=kind,detail=detail,trusted=True,target=dict(ownCardId=11,withinRequestedCard=True)) for kind,detail in [('click',1),('click',2),('dblclick',2)]], 'dropped': 0, 'publicStateAfterCommand': {'life': [19,20]}}}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<ordinary-native-double-click>', 'exec'), namespace)
        namespace['click'](selector, double=True)
        self.assertEqual(preparations, [selector])
        self.assertEqual([p for p, _ in requests], ['/actions'])
        actions = requests[0][1]['actions'][0]['actions']
        self.assertEqual(actions[0]['origin'], {'element-6066-11e4-a52e-4f735466cecf': 'private-native-card-reference'})
        self.assertEqual([a['type'] for a in actions], ['pointerMove', 'pointerDown', 'pointerUp', 'pointerDown', 'pointerUp'])
        self.assertTrue(all(a['button'] == 0 for a in actions if a['type'] in {'pointerDown', 'pointerUp'}))
        self.assertEqual(report['click_commands'][0]['kind'], 'native-pointer-double-click')
        self.assertEqual(report['click_commands'][0]['status'], 'completed')
        self.assertEqual(report['click_commands'][0]['native_input_observation']['publicStateAfterCommand']['life'], [19,20])
        self.assertNotIn('private-native-card-reference', json.dumps(report))
        self.assertTrue(report['click_commands'][0]['native_double_click_verified'])
        good = namespace['finish_native_input_observation']
        missing = dict(good(), events=[dict(type='click',detail=1,trusted=True,browserTimestamp=t,target=dict(ownCardId=11,withinRequestedCard=True)) for t in [176701.4,177146.5]])
        wrong_order = dict(good(), events=list(reversed(good()['events'])))
        wrong_card = json.loads(json.dumps(good())); wrong_card['events'][-1]['target']['ownCardId']=12
        for observation in [missing,wrong_order,wrong_card,dict(good(),dropped=1),dict(good(),events=[])]:
            namespace['finish_native_input_observation'] = lambda observation=observation: observation
            with self.subTest(observation=observation), self.assertRaisesRegex(AssertionError,'trusted ordinary card dblclick'):
                namespace['click'](selector,double=True)
            self.assertEqual(report['click_commands'][-1]['status'],'failed')
            self.assertEqual(report['click_commands'][-1]['reason'],'native-double-click-not-observed')
        namespace['finish_native_input_observation'] = good
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



    def test_two_trusted_single_clicks_do_not_complete_ordinary_double_click(self):
        module = ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        function = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'click')
        report = {}
        observation = {'events': [dict(type='click', detail=1, trusted=True, browserTimestamp=t,
            target=dict(ownCardId=2, withinRequestedCard=True)) for t in [176701.4, 177146.5]], 'dropped': 0}
        namespace = dict(report=report, stage='paidplay-normal-direct', datetime=datetime, re=re,
            element=lambda *args: 'native-reference', prepare_hand_click=lambda *args: None,
            hit_observation=lambda *args, **kwargs: dict(centerHitsTarget=True, expectedWebDriverPointHitsTarget=True),
            call=lambda *args, **kwargs: None, start_native_input_observation=lambda *args: {},
            finish_native_input_observation=lambda: observation)
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<native-event-regression>', 'exec'), namespace)
        with self.assertRaisesRegex(AssertionError, 'trusted ordinary card dblclick'):
            namespace['click']('[data-hand-card][data-object-id="2"]', double=True)
        self.assertEqual(report['click_commands'][-1]['status'], 'failed')
        self.assertEqual(report['click_commands'][-1]['reason'], 'native-double-click-not-observed')

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

    def verify(self, stack_count=0, finish_changes=None, initial_changes=None, paidplay=False, paid_changes=None, s1_1a=False, missing_step=None):
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
        if paidplay or s1_1a:
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
            if s1_1a:
                initial.update(sourceCardId=7, ownManaCount=1, sourceInHand=False)
                life = dict(initial, life=[18,20])
                finish = dict(life, manualPhase='closed', waitingType='Priority', resolvingEntryId=None, ownManaCount=1, nextCardId=11, nextInGraveyard=False)
                finish.update(finish_changes or {})
                pre = dict(initial, manualPhase=None, resolvingEntryId=None, manualStackEntryId=None, ownManaCount=2, sourceInHand=True)
                pre.update(initial_changes or {})
                paid = dict(finish, life=[21,20], ownManaCount=0, nextCardId=None, nextInGraveyard=True)
                paid.update(paid_changes or {})
                states = [('prepayment',pre),('same-source',initial),('life18',life),('finish',finish),('paidplay21',paid)]
            for step, state in states:
                if step == missing_step:
                    continue
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
            return capture.validate_required_images(root, manifest, execution, paidplay=paidplay, s1_1a=s1_1a)

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

    def s1_report(self):
        events = lambda changes=[], departed=0, terminals=0, next_departed=0: dict(lifeChanges=changes, sourceDepartures=departed, manualTerminals=terminals, nextDepartures=next_departed)
        pre = dict(life=[20,20],ownManaCount=2,sourceCardId=7,sourceInHand=True,sourceInGraveyard=False,nextCardId=11,manualPhase=None,resolvingEntryId=None,stackCount=0,waitingType='Priority',priorityPlayer=0,publicEvents=events())
        paid = dict(pre,ownManaCount=1,stackCount=1,sourceId=7,manualStackEntryId=9,manualPhase='armed')
        begin = dict(paid,stackCount=0,resolvingEntryId=9,manualPhase='open')
        life = dict(begin,life=[18,20],publicEvents=events([{'amount':-2,'total':18}]))
        end = dict(life,manualPhase='closed',resolvingEntryId=None,sourceInGraveyard=True,publicEvents=events([{'amount':-2,'total':18}],1,1))
        next_paid = dict(end,ownManaCount=0,stackCount=1,nextCardId=None,nextInGraveyard=False)
        next_done = dict(next_paid,life=[21,20],stackCount=0,nextInGraveyard=True,publicEvents=events([{'amount':-2,'total':18},{'amount':3,'total':21}],1,1,1))
        return dict(status='passed',consumer={},consumer_execution={},secondary=[],scope=capture.S1_1A_SCOPE,fixture='1a.B',
            primary=dict(stage='operations-complete',code=0,reason='completed'),
            stages={stage:dict(status='passed',assertions_completed=True) for stage in ['prepayment','manual-options','manual-cast','initial','life18','finish','paidplay21']},
            prepayment=pre,manual_paid_before_begin=paid,begin=begin,life_applied=life,finished=end,paid_before_resolution=next_paid,ordinary_completed=next_done,
            prepayment_scope_visible=True,own_area_label='You',
            fixture_opponent_drivers=[dict(ok=True,mode='explicit-local-fixture-opponent-driver',action='PassPriority',actor=1,commands=1,opponent_ui=False,two_client=False,before=dict(b,priorityPlayer=1)) for b in [paid,next_paid]],
            receipt_summary=dict(appliedResults=3,completed=[dict(sourceId=7,stackEntryId=None,terminalCount=0,lifeChanges=[]),dict(sourceId=7,stackEntryId=9,terminalCount=0,lifeChanges=[{'amount':-2,'total':18}]),dict(sourceId=7,stackEntryId=9,terminalCount=1,lifeChanges=[])]),
            click_commands=[dict(operation=stage,status='completed',native_double_click_verified=stage=='paidplay-normal-direct') for stage in ['manual-card-select','manual-options','manual-cast','manual-response','player-area-select','life18','finish','paidplay-normal-direct','paidplay-response']])

    def test_s1_1a_requires_prepaid_boundaries_receipts_events_and_native_commands(self):
        report = self.s1_report()
        capture.validate_operations(report, {}, {}, s1_1a=True)
        faults = [(['fixture'],'1c.K1'),(['stages','prepayment','status'],'skipped'),(['prepayment','ownManaCount'],1),
            (['prepayment','manualPhase'],'open'),(['begin','life'],[18,20]),(['manual_paid_before_begin','ownManaCount'],2),
            (['life_applied','resolvingEntryId'],10),(['finished','sourceInGraveyard'],False),(['finished','life'],[16,20]),
            (['ordinary_completed','life'],[22,20]),(['paid_before_resolution','ownManaCount'],1),(['own_area_label'],'Opp 1'),
            (['fixture_opponent_drivers'],[]),(['fixture_opponent_drivers',0,'commands'],2),(['fixture_opponent_drivers',0,'actor'],0),
            (['fixture_opponent_drivers',0,'before','priorityPlayer'],0),(['receipt_summary','appliedResults'],4),
            (['receipt_summary','completed',2,'terminalCount'],2),(['finished','publicEvents','manualTerminals'],2),
            (['begin','publicEvents','lifeChanges'],[{'amount':-2,'total':18}]),(['click_commands'],[])]
        for path,value in faults:
            with self.subTest(path=path), self.assertRaises(capture.EvidenceFailure):
                changed = json.loads(json.dumps(report)); at=changed
                for key in path[:-1]: at=at[key]
                at[path[-1]]=value
                capture.validate_operations(changed, {}, {}, s1_1a=True)

    def test_s1_1a_requires_all_five_images(self):
        self.assertEqual(self.verify(s1_1a=True)['verified_count'],5)
        for step in ['prepayment','same-source','life18','finish','paidplay21']:
            with self.subTest(step=step), self.assertRaises(capture.EvidenceFailure):
                self.verify(s1_1a=True,missing_step=step)
        for changes in [dict(ownManaCount=1),dict(manualPhase='open')]:
            with self.subTest(changes=changes), self.assertRaises(capture.EvidenceFailure):
                self.verify(s1_1a=True,initial_changes=changes)
        with self.assertRaises(capture.EvidenceFailure): self.verify(s1_1a=True,paid_changes=dict(life=[22,20]))

    def test_generated_reports_share_the_bounded_k1_scope(self):
        ui = ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        report = next(node.value for node in ui.body if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == 'report' for target in node.targets))
        expression = next(value for key, value in zip(report.keys, report.values)
                          if isinstance(key, ast.Constant) and key.value == 'scope')
        ui_scope = eval(compile(ast.Expression(expression), '<ui-scope>', 'eval'), {'CHECKS': capture, 'PREPAYMENT': False})
        ci = ast.parse(Path(__file__).with_name('p1-ci-ui-smoke.py').read_text())
        assignment = next(node for node in ast.walk(ci) if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
                                  and target.value.id == 'proof' and isinstance(target.slice, ast.Constant)
                                  and target.slice.value == 'scope' for target in node.targets))
        ci_scope = eval(compile(ast.Expression(assignment.value), '<ci-scope>', 'eval'), {'checks': capture})
        self.assertEqual(ci_scope, capture.S1_1A_SCOPE)
        self.assertEqual(ui_scope, capture.BOUNDED_K1_SCOPE)
        self.assertIn('K1-only acceptance when passed', ui_scope)
        self.assertIn('full S8', ui_scope)
        self.assertNotIn('restore, Undo', ui_scope)

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
        report['scope'] = capture.BOUNDED_K1_SCOPE
        capture.validate_operations(report, {}, {}, paidplay=True, restore_driver=True)
        changes = [(['scope'], 'Local K1 UI continuation; restore unaccepted'),
                   (['scope'], 'full S8 accepted'),
                   (['scope'], None),
                   (['checked_restore_k1'], None),
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
