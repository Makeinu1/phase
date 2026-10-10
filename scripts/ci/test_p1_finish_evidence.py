"""Offline Finish evidence regressions; synthetic bytes are not product UI PASS."""
import ast
import base64
import datetime
import hashlib
import html
import importlib.util
import json
import re
import subprocess
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
    def test_actual_manual_observation_retains_geometry_before_rejection(self):
        tree=ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        node=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='manual_visual_observation')
        observed={'diagnostic':None,'warningVisible':False,'warningSuppressed':False}
        report={}
        namespace={'call':lambda *args:observed,'report':report,'CHECKS':capture,'stage':'capture-same-source',
            'CANONICAL_MANUAL_SOURCE_TEXT':None}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-manual-observation>','exec'),namespace)
        with self.assertRaises(capture.EvidenceFailure):namespace['manual_visual_observation']()
        self.assertEqual(report['manual_visual_observation_attempts'],[
            {'stage':'capture-same-source','require_visible':False,'observation':observed}])

    def test_manual_visual_rejects_false_warning_overlap_and_missing_narrow_view(self):
        import copy
        def rect(left, top, width, height):
            return dict(left=left, right=left+width, top=top, bottom=top+height, width=width, height=height)
        value = dict(viewport={'width':1440,'height':1000}, source=rect(0,0,300,350),
            card=rect(78,10,144,202), details=rect(10,230,280,90), form=rect(0,370,300,150),
            lines=[rect(10,230,200,20),rect(10,260,280,20)],sourceClientWidth=298,sourceScrollWidth=298,
            panelClientWidth=332,panelScrollWidth=332,cardContentPresent=True,cardContentKind='artless-fallback',diagnostic=None,
            visible=dict(left=0,right=390,top=0,bottom=844),
            warningVisible=False,warningSuppressed=False)
        value['textBlocks'] = [dict(kind='title',present=True,textLength=16,lines=value['lines'][:1]),
            dict(kind='oracle',present=True,textLength=62,lines=value['lines'][1:])]
        value['oracleTextCoverage'] = 'observed'
        value['canonicalSourceText']={'source_name':'Replay Self Loss','card_data_sha256':'1'*64,
            'oracle_text_kind':'nonempty','oracle_text_length':62}
        value['titleMatchesFixture']=True
        capture.validate_manual_visual_observation(value)
        for key, changed in [('diagnostic',{}),('warningVisible',True),('warningSuppressed',True),
                ('cardContentPresent',False),('cardContentKind','unavailable'),('card',rect(200,10,144,202)),
                ('details',rect(10,100,280,90)),('form',rect(0,200,300,150)),
                ('lines',[rect(250,230,200,20),rect(10,260,280,20)]),('sourceScrollWidth',350)]:
            bad=copy.deepcopy(value);bad[key]=changed
            if key=='lines':
                bad['textBlocks'][0]['lines']=changed[:1];bad['textBlocks'][1]['lines']=changed[1:]
            with self.subTest(key=key),self.assertRaises(capture.EvidenceFailure):
                capture.validate_manual_visual_observation(bad)
        empty=copy.deepcopy(value)
        empty['textBlocks'][1].update(textLength=0,lines=[])
        empty['lines']=empty['textBlocks'][0]['lines']
        empty['oracleTextCoverage']='not-present-in-fixture'
        empty['canonicalSourceText'].update(oracle_text_kind='null',oracle_text_length=0)
        capture.validate_manual_visual_observation(empty)
        for kind,index in [('title',0),('oracle',1)]:
            bad=copy.deepcopy(value);bad['textBlocks'][index]['lines']=[]
            bad['lines']=[line for block in bad['textBlocks'] for line in block['lines']]
            with self.subTest(nonempty_block=kind),self.assertRaises(capture.EvidenceFailure) as error:
                capture.validate_manual_visual_observation(bad)
            self.assertEqual(error.exception.reason,'source-text-lines-unavailable:'+kind)
        for key,changed in [('textLength',0),('present',False)]:
            bad=copy.deepcopy(empty);bad['textBlocks'][0][key]=changed
            with self.subTest(missing_title=key),self.assertRaises(capture.EvidenceFailure):
                capture.validate_manual_visual_observation(bad)
        bad=copy.deepcopy(empty);bad['oracleTextCoverage']='observed'
        with self.assertRaises(capture.EvidenceFailure):capture.validate_manual_visual_observation(bad)
        bad=copy.deepcopy(empty);bad['canonicalSourceText']=copy.deepcopy(value['canonicalSourceText'])
        with self.assertRaises(capture.EvidenceFailure) as error:capture.validate_manual_visual_observation(bad)
        self.assertEqual(error.exception.reason,'source-text-does-not-match-fixture')
        bad=copy.deepcopy(value);bad['titleMatchesFixture']=False
        with self.assertRaises(capture.EvidenceFailure):capture.validate_manual_visual_observation(bad)
        observations={key:copy.deepcopy(value) for key in
            ['same-source','life19','life18','registered-pending','historical-lookup','manual-source-narrow']}
        observations['manual-source-narrow']['viewport']['width']=390
        capture.validate_manual_visual({'manual_visual':observations,'viewport_restored':True})
        with self.assertRaises(capture.EvidenceFailure):capture.validate_manual_visual(
            {'manual_visual':observations,'viewport_restored':True},source_text=empty['canonicalSourceText'])
        positive={'scope':capture.MANUAL_SOURCE_TEXT_SCOPE,'fixture':'1c.B','source_text_only':True,
            'status':'passed','consumer':{'sha':'same'},'consumer_execution':{'run':'same'},
            'primary':{'stage':'operations-complete','code':0,'reason':'completed'},'secondary':[],
            'stages':{key:{'status':'passed','assertions_completed':True} for key in
                      ['prepayment','manual-options','manual-cast','initial']},
            'prepayment':dict(sourceCardId=3,sourceInHand=True,waitingType='Priority',priorityPlayer=0,
                stackCount=0,manualPhase=None,life=[20,20],ownManaCount=2),
            'manual_paid_before_begin':dict(sourceId=3,manualPhase='armed',stackCount=1,
                resolvingEntryId=None,life=[20,20],ownManaCount=1),
            'begin':dict(sourceId=3,manualPhase='open',stackCount=0,manualStackEntryId=7,
                resolvingEntryId=7,life=[20,20],ownManaCount=1,
                publicEvents=dict(lifeChanges=[],sourceDepartures=0,manualTerminals=0)),
            'prepayment_full_control':True,'prepayment_scope_visible':True,'viewport_restored':True,
            'manual_visual':{key:copy.deepcopy(observations[key]) for key in ['same-source','manual-source-narrow']}}
        positive['click_commands']=[dict(operation=stage,kind='native-element-click',status='completed',locator=locator)
            for stage,locator in [
                ('prepayment-full-control','[data-mobile-action-right] button[aria-label="Full Control Off"][aria-pressed="false"]'),
                ('manual-card-select','[data-hand-card][data-object-id="3"]'),
                ('manual-options','//button[normalize-space()="Resolution options for P1 Self Loss"]'),
                ('manual-cast','//button[normalize-space()="Cast with manual resolution"]'),
                ('manual-response','//button[normalize-space()="Resolve"]')]]
        positive['fixture_opponent_drivers']=[dict(ok=True,actor=1,action='PassPriority',
            mode='explicit-local-fixture-opponent-driver',commands=1,
            before=dict(positive['manual_paid_before_begin'],waitingType='Priority',priorityPlayer=1),
            after=positive['begin'])]
        positive['receipt_observer_stopped']=True
        capture.validate_source_text_positive(positive,positive['consumer'],positive['consumer_execution'],value['canonicalSourceText'])
        for key,field,changed in [('begin','life',[19,20]),('begin','sourceId',4),
                ('begin','resolvingEntryId',8),('manual_paid_before_begin','ownManaCount',2)]:
            bad=copy.deepcopy(positive);bad[key][field]=changed
            with self.subTest(positive_boundary=(key,field)),self.assertRaises(capture.EvidenceFailure):
                capture.validate_source_text_positive(bad,positive['consumer'],positive['consumer_execution'],value['canonicalSourceText'])
        with self.assertRaises(capture.EvidenceFailure):capture.validate_source_text_positive(
            positive,positive['consumer'],positive['consumer_execution'],empty['canonicalSourceText'])
        for key,changed in [('click_commands',[]),('fixture_opponent_drivers',[]),('receipt_observer_stopped',False)]:
            bad=copy.deepcopy(positive);bad[key]=changed
            with self.subTest(missing_positive_proof=key),self.assertRaises(capture.EvidenceFailure):
                capture.validate_source_text_positive(bad,positive['consumer'],positive['consumer_execution'],value['canonicalSourceText'])
        for clipped in [dict(left=100,right=390,top=0,bottom=844),dict(left=0,right=390,top=0,bottom=250)]:
            bad=copy.deepcopy(value);bad['visible']=clipped
            with self.assertRaises(capture.EvidenceFailure):capture.validate_manual_visual_observation(bad,require_visible=True)
        observations['manual-source-narrow']['viewport']['width']=1440
        with self.assertRaises(capture.EvidenceFailure):capture.validate_manual_visual({'manual_visual':observations,'viewport_restored':True})

    def test_narrow_viewport_restore_preserves_primary_and_fails_closed(self):
        tree=ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='capture_narrow_source')
        for body_fails in [False,True]:
            for wd_present in [False,True]:
                report={'manual_visual':{},'secondary':[]};primary_wd={'error':'original'}
                original=ValueError('geometry failed');restorer=RuntimeError('restore failed')
                def call(endpoint,args):
                    if endpoint=='/window/rect' and args['width']==1440:
                        report['webdriver_error']={'error':'restore'}
                        raise restorer
                    return True
                def geometry(**kwargs):
                    if body_fails:
                        if wd_present:report['webdriver_error']=primary_wd
                        raise original
                    return {}
                namespace={'observe':lambda:{'life':[20,20]},'call':call,'report':report,
                           'manual_visual_observation':geometry,'capture':lambda step:None,'stage':'same-source'}
                exec(compile(ast.Module(body=[function],type_ignores=[]),'<narrow-restore>', 'exec'),namespace)
                with self.assertRaises(Exception) as caught:namespace['capture_narrow_source']()
                self.assertIs(caught.exception,original if body_fails else restorer)
                self.assertEqual(report['secondary'],[{'stage':'viewport-restore','code':1,'reason':'viewport-restore-failed'}])
                self.assertIs(report['viewport_restored'],False)
                if body_fails:
                    self.assertEqual('webdriver_error' in report,wd_present)
                    if wd_present:self.assertIs(report['webdriver_error'],primary_wd)
                else:self.assertEqual(namespace['stage'],'viewport-restore')

    def test_recorded_prep_rejects_missing_recording_and_nonordinary_ready_state(self):
        import copy
        base={'life':[20,20],'manualPhase':None,'resolvingEntryId':None,'manualStackEntryId':None,
          'stackCount':0,'phase':'PreCombatMain','activePlayer':0,'waitingType':'Priority','priorityPlayer':0,
          'ownManaCount':2,'sourceCardId':1,'sourceInHand':True,'nextCardId':2,
          'selectedIds':{'source':1,'next':2,'land':3},
          'land':{'id':3,'zone':'Battlefield','controller':0,'tapped':True,'inHand':False,'inBattlefield':True},
          'publicEvents':{'lifeChanges':[],'sourceDepartures':0,'manualTerminals':0,'nextDepartures':0}}
        report={'scope':'recorded-start-preparation-only','fixture':'1c.recorded.B','status':'passed',
          'recorded_ready':base,'recording':{'available':True,'replayActions':5,'replaySha256':'a'*64},
          'prep_steps':4,'prep_opponent_drivers':[{'ok':True,'actor':1,'commands':1,'action':'MulliganDecision','opponent_ui':False,'two_client':False}],
          'click_commands':[{'status':'completed','kind':'native-element-click','operation':'recorded-own-keep'},
            {'status':'completed','kind':'native-pointer-double-click','operation':'recorded-land-play'},
            {'status':'completed','kind':'native-element-click','operation':'recorded-land-mana'}]}
        initial=copy.deepcopy(base);initial.update(ownManaCount=0,waitingType='MulliganDecision',mulliganPlayers=[0,1]);initial['land'].update(zone='Hand',tapped=False,inHand=True,inBattlefield=False,legalActionTypes=['PlayLand'])
        main=copy.deepcopy(initial);main.update(waitingType='Priority',mulliganPlayers=[])
        landed=copy.deepcopy(main);landed['land'].update(zone='Battlefield',inHand=False,inBattlefield=True,legalActionTypes=['ActivateManaSource'])
        report.update(recorded_initial=initial,recorded_main=main,land_mana_before=landed)
        report['prep_opponent_drivers'][0].update(before=initial,after=main)
        report['click_commands'][1]['native_double_click_verified']=True
        capture.validate_recorded_prep(report)
        for advance in [
            {'status':'priority-switched','before':dict(base,priorityPlayer=0)},
            {'status':'native-click','before':dict(base,phase='Upkeep')},
            {'status':'main-ready','before':dict(base,life=[19,20])}]:
            bad=copy.deepcopy(report);bad['prep_own_advances']=[advance]
            with self.subTest(advance=advance),self.assertRaises(capture.EvidenceFailure):
                capture.validate_recorded_prep(bad)
        report.update(consumer={},consumer_execution={},secondary=[],
            primary={'stage':'operations-complete','code':0,'reason':'completed'},
            stages={stage:{'status':'passed','assertions_completed':True}
                for stage in ['recorded-initial','recorded-main','recorded-ready']})
        capture.validate_recorded_operations(report, {}, {})
        for key,value in [('consumer',{'sha':'wrong'}),('consumer_execution',{'run_id':'wrong'}),
                ('secondary',[{'code':1}]),('primary',{'stage':'operations-complete','code':1,'reason':'completed'}),
                ('status','incomplete')]:
            bad=copy.deepcopy(report);bad[key]=value
            with self.subTest(completion=key),self.assertRaises(capture.EvidenceFailure):
                capture.validate_recorded_operations(bad, {}, {})
        for stage in report['stages']:
            bad=copy.deepcopy(report);bad['stages'][stage]['assertions_completed']=False
            with self.subTest(stage=stage),self.assertRaises(capture.EvidenceFailure):
                capture.validate_recorded_operations(bad, {}, {})
        cases=[('recording',{'available':False}),('recording',{'available':True,'replayActions':0,'replaySha256':'a'*64}),
          ('prep_steps',21),('prep_opponent_drivers',[]),('prep_opponent_drivers',[{'ok':True,'actor':0,'commands':1,'action':'PassPriority','opponent_ui':False,'two_client':False}])]
        for key,value in cases:
          bad=copy.deepcopy(report);bad[key]=value
          with self.subTest(key=key,value=value),self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)
        for key,value in [('life',[18,20]),('ownManaCount',0),('activePlayer',1),('sourceInHand',False),('nextCardId',None),('stackCount',1),('manualPhase','open')]:
          bad=copy.deepcopy(report);bad['recorded_ready'][key]=value
          with self.subTest(key=key),self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)
        bad=copy.deepcopy(report);bad['recorded_ready']['land']['tapped']=False
        with self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)

        for key in ['recorded_initial','recorded_main','land_mana_before']:
          for field,value in [('ownManaCount',2),('selectedIds',{'source':9,'next':2,'land':3}),('manualPhase','open')]:
            bad=copy.deepcopy(report);bad[key][field]=value
            with self.subTest(boundary=key,field=field),self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)
        bad=copy.deepcopy(report);bad['recorded_initial']['waitingType']='Priority'
        with self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)
        bad=copy.deepcopy(report);bad['recorded_main']['land']['zone']='Battlefield'
        with self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)
        bad=copy.deepcopy(report);bad['prep_opponent_drivers'][0]['before']={}
        with self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)
        bad=copy.deepcopy(report);bad['click_commands'][1]['native_double_click_verified']=False
        with self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)

        bad=copy.deepcopy(report);bad['recorded_initial']['mulliganPlayers']=[0]
        with self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)
        bad=copy.deepcopy(report);bad['prep_opponent_drivers']*=2
        with self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_prep(bad)

    def test_recorded_priority_rechecks_before_using_acquired_native_control(self):
        import copy
        node=next(n for n in ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text()).body
            if isinstance(n,ast.FunctionDef) and n.name=='advance_recorded_priority')
        base={'waitingType':'Priority','activePlayer':0,'life':[20,20],'ownManaCount':0,
            'stackCount':0,'manualPhase':None,'resolvingEntryId':None,'priorityPlayer':0,'phase':'Upkeep'}
        for label,states,expected,clicks in [
            ('opponent',[dict(base,priorityPlayer=1)],'priority-switched',0),
            ('acquisition-race',[base,dict(base,priorityPlayer=1)],'priority-switched',0),
            ('main',[dict(base,phase='PreCombatMain')],'main-ready',0),
            ('own',[base,base],'native-click',1)]:
            with self.subTest(label=label):
                states=iter(copy.deepcopy(states));report={};recorded=[];calls=[]
                def call(path,body=None):
                    calls.append((path,body))
                    return [{'element-6066-11e4-a52e-4f735466cecf':'acquired'}] if path=='/elements' else True
                namespace={'time':SimpleNamespace(monotonic=lambda:0),'observe':lambda:next(states),
                    'report':report,'call':call,'click':lambda *args,**kwargs:recorded.append((args,kwargs))}
                exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-priority-acquisition>','exec'),namespace)
                namespace['advance_recorded_priority']()
                self.assertEqual(report['prep_own_advances'][0]['status'],expected)
                self.assertEqual(len(recorded),clicks)
                if clicks:self.assertEqual(recorded[0][1],{'acquired_identifier':'acquired'})
                if calls:self.assertIn('starts-with(normalize-space(),"Pass")',calls[0][1]['value'])
        namespace={'time':SimpleNamespace(monotonic=lambda:0),'observe':lambda:dict(base,life=[19,20])}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-priority-boundary>','exec'),namespace)
        with self.assertRaises(AssertionError):namespace['advance_recorded_priority']()
        ticks=iter([0,41]);report={}
        namespace={'time':SimpleNamespace(monotonic=lambda:next(ticks)),'observe':lambda:base,
            'report':report,'stage':'recorded-own-advance'}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-priority-timeout>','exec'),namespace)
        with self.assertRaisesRegex(AssertionError,'Required product control'):namespace['advance_recorded_priority']()
        self.assertEqual(report['control_acquisition_failure']['operation'],'recorded-own-advance')

    def test_recorded_prep_actual_function_marks_initial_before_capture(self):
        tree=ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        node=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='run_recorded_prep')
        class CaptureBoundary(Exception):pass
        report={'stages':{'recorded-initial':{}}}
        def capture_initial(step):
            self.assertEqual(step,'recorded-initial')
            self.assertEqual(report['stages'][step],{'status':'passed','assertions_completed':True})
            raise CaptureBoundary()
        state={'life':[20,20],'stackCount':0,'manualPhase':None,'ownManaCount':0}
        namespace={'report':report,'wait_for':lambda predicate:state,'capture':capture_initial}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-recorded-prep>','exec'),namespace)
        with self.assertRaises(CaptureBoundary):namespace['run_recorded_prep']()

    def test_native_failure_preserves_safe_step_and_exception_without_raw_wire(self):
        source=Path(__file__).with_name('p1-ui-smoke.py').read_text()
        function=re.search(r'const nativeFailure = .*?\n };',source,re.S).group(0)
        program=function+"\nconst assert=require('node:assert/strict');\n"
        program+="const known=nativeFailure('before-second','checkpoint-replay-export',new Error('No replay recording available. Start a game first, or it was invalidated by an undo/restore.'),[]); assert.equal(known.reason,'replay-recording-unavailable'); assert.equal(known.step,'checkpoint-replay-export'); assert.equal(known.exception.name,'Error'); assert.deepEqual(known.completedChecks,[]);\n"
        program+="const unknown=nativeFailure('after-second','original-lookup',new Error('PRIVATE_WIRE_ATTEMPT'),['qL1-register']); assert.equal(unknown.exception.message,null); assert.equal(JSON.stringify(unknown).includes('PRIVATE_WIRE_ATTEMPT'),false); assert.deepEqual(unknown.completedChecks,['qL1-register']);\n"
        subprocess.run(['node','-e',program],check=True,capture_output=True)

    def test_native_probe_uses_actual_nested_manual_schema(self):
        source=Path(__file__).with_name('p1-ui-smoke.py').read_text()
        expression=re.search(r'const opportunity = (.*?);',source,re.S).group(1)
        fixture={'snapshot':{'viewerInteraction':{'opportunities':[
            {'spec':{'type':'manualResolution'},'response':{'type':'schema','data':{'spec':{'type':'ordinary'},'candidates':[]}}},
            {'response':{'type':'schema','data':{'spec':{'type':'manualResolution'},'candidates':[
                {'surfaces':[{'type':'action','data':{'code':'finishManualResolution'}}]}]}}}]}}}
        program='const frame='+json.dumps(fixture)+'; const selected=('+expression+');\n'
        program+="require('node:assert/strict').strictEqual(selected,frame.snapshot.viewerInteraction.opportunities[1]);\n"
        subprocess.run(['node','-e',program],check=True,capture_output=True)

    def test_native_probe_failure_stage_survives_browser_report_validation(self):
        spec=importlib.util.spec_from_file_location('native_browser_checks',Path(__file__).with_name('p1-product-browser.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        for stage in ['native-original-checks','native-final-replay','registered-pending','capture-registered-pending']:
            primary=dict(stage=stage,code=1,reason='operation-assertion-failed')
            self.assertEqual(module.safe_primary(primary),primary)

    def test_registered_pending_capture_step_is_finite_and_admitted(self):
        source=Path(__file__).with_name('p1-product-capture.py').read_text()
        pattern=next(n.args[0].value for n in ast.walk(ast.parse(source)) if isinstance(n,ast.Call)
            and isinstance(n.func,ast.Attribute) and n.func.attr=='fullmatch' and n.args
            and isinstance(n.args[0],ast.Constant) and 'recorded-initial|' in str(n.args[0].value))
        self.assertIsNotNone(re.fullmatch(pattern,'registered-pending'))
        for value in ['registered-pending-extra','../registered-pending','arbitrary-private-wire']:
            self.assertIsNone(re.fullmatch(pattern,value))

    def test_case_guards_preserve_no_retry_rule_without_colliding_between_cases(self):
        module = ast.parse(Path(__file__).with_name('p1-ci-ui-smoke.py').read_text())
        main = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        guarded = next(n for n in main.body if isinstance(n, ast.FunctionDef) and n.name == 'guarded')
        class StageStop(Exception):
            pass
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destinations = []
            def guarded_run(argv, cwd, env, stdout, stderr):
                destination = Path(env['MANUAL_EVIDENCE'])
                destinations.append(destination)
                record = destination / 'p1-ui-smoke.json'
                if record.exists():
                    return SimpleNamespace(returncode=1, stdout=b'do not retry a recorded command')
                record.write_text('{}')
                return SimpleNamespace(returncode=0, stdout=b'completed')
            browser = {'consumer': {}, 'consumer_execution': {}, 'status': 'scenario-exited',
                       'effective_exit': 0, 'stages': {'application': 'passed'},
                       'primary': {'stage': 'operations-complete', 'code': 0, 'reason': 'completed'}, 'secondary': []}
            namespace = {'Path': Path, 'VALIDATION': root, 'source': root, 'evidence': root,
                         'environment': {'MANUAL_EVIDENCE': str(root)}, 'manifest': {'consumer': {}},
                         'proof': {'consumer_execution': {}, 'secondary': [], 'stages': {}},
                         'subprocess': SimpleNamespace(run=guarded_run, PIPE=1, STDOUT=2),
                         'results': SimpleNamespace(load_result=lambda *args: (browser, True), safe_primary=lambda x: x),
                         'StageStop': StageStop}
            exec(compile(ast.Module(body=[guarded], type_ignores=[]), '<case-guard-isolation>', 'exec'), namespace)
            for case in ['auto-s', 'auto-n']:
                child = root / case
                child.mkdir()
                namespace['browser_evidence'] = child
                namespace['guarded']('p1-ui-smoke', ['existing-browser-command'])
            self.assertEqual(destinations, [root / 'auto-s', root / 'auto-n'])
            self.assertTrue(all((child / 'p1-ui-smoke.json').exists() for child in destinations))
            self.assertFalse((root / 'p1-ui-smoke.json').exists())
            with self.assertRaises(StageStop):
                namespace['guarded']('p1-ui-smoke', ['existing-browser-command'])

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

    def verify(self, stack_count=0, finish_changes=None, initial_changes=None, paidplay=False, paid_changes=None, s1_1a=False, s1_1c=False, missing_step=None):
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
        if paidplay or s1_1a or s1_1c:
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
            if s1_1a or s1_1c:
                initial.update(sourceCardId=7, ownManaCount=1, sourceInHand=False)
                life = dict(initial, life=[18,20])
                finish = dict(life, manualPhase='closed', waitingType='Priority', resolvingEntryId=None, ownManaCount=1, nextCardId=11, nextInGraveyard=False)
                finish.update(finish_changes or {})
                pre = dict(initial, manualPhase=None, resolvingEntryId=None, manualStackEntryId=None, ownManaCount=2, sourceInHand=True)
                pre.update(initial_changes or {})
                paid = dict(finish, life=[21,20], ownManaCount=0, nextCardId=None, nextInGraveyard=True)
                paid.update(paid_changes or {})
                states = [('prepayment',pre),('same-source',initial),('life18',life),('finish',finish),('paidplay21',paid)]
                if s1_1c:
                    states += [('life19',dict(initial,life=[19,20])),('historical-lookup',dict(life))]
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
            return capture.validate_required_images(root, manifest, execution, paidplay=paidplay, s1_1a=s1_1a, s1_1c=s1_1c)

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
            prepayment_scope_visible=True,prepayment_full_control=True,own_area_label='You',
            fixture_opponent_drivers=[dict(ok=True,mode='explicit-local-fixture-opponent-driver',action='PassPriority',actor=1,commands=1,opponent_ui=False,two_client=False,before=dict(b,priorityPlayer=1)) for b in [paid,next_paid]],
            receipt_summary=dict(appliedResults=3,completed=[dict(sourceId=7,stackEntryId=None,terminalCount=0,lifeChanges=[]),dict(sourceId=7,stackEntryId=9,terminalCount=0,lifeChanges=[{'amount':-2,'total':18}]),dict(sourceId=7,stackEntryId=9,terminalCount=1,lifeChanges=[])]),
            click_commands=[dict(operation=stage,status='completed',native_double_click_verified=stage=='paidplay-normal-direct') for stage in ['prepayment-full-control','manual-card-select','manual-options','manual-cast','manual-response','player-area-select','life18','finish','paidplay-normal-direct','paidplay-response']])

    def test_completed_auto_capture_failure_preserves_primary_and_fixed_secondary(self):
        ui=ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        handler=next(n for n in ui.body if isinstance(n,ast.Try)).handlers[0]
        cases=next(n for n in handler.body if isinstance(n,ast.If) and 'capture-control-completed' in ast.unparse(n.test))
        report={'stages':{k:{'assertions_completed':True} for k in ['control-initial','control-full-control','control-paid','control-response','control-completed']},'secondary':[],'status':'failed'}
        namespace=dict(stage='capture-control-completed',report=report)
        exec(compile(ast.Module(body=[cases],type_ignores=[]),'<auto-final-capture-failure>','exec'),namespace)
        self.assertEqual(report['primary'],dict(stage='operations-complete',code=0,reason='completed'))
        self.assertEqual(report['status'],'incomplete')
        self.assertEqual(report['secondary'],[dict(stage='capture-control-completed',code=1,reason='required-capture-failed')])
        report={'stages':{k:{'assertions_completed':True} for k in ['recorded-initial','recorded-main','recorded-ready']},'secondary':[],'status':'failed'}
        namespace=dict(stage='capture-recorded-ready',report=report)
        exec(compile(ast.Module(body=[cases],type_ignores=[]),'<recorded-final-capture-failure>','exec'),namespace)
        self.assertEqual(report['primary'],dict(stage='operations-complete',code=0,reason='completed'))
        self.assertEqual(report['status'],'incomplete')
        self.assertEqual(report['secondary'],[dict(stage='capture-recorded-ready',code=1,reason='required-capture-failed')])
        for complete in [True,False]:
            report={'stages':{key:{'assertions_completed':True} for key in
                    ['prepayment','manual-options','manual-cast','initial']},'secondary':[]}
            if not complete: report['stages']['initial']['assertions_completed']=False
            namespace=dict(stage='capture-manual-source-narrow',report=report,SOURCE_TEXT_POSITIVE=True,
                           error=RuntimeError(),CHECKS=capture,exit_code=0)
            exec(compile(ast.Module(body=handler.body,type_ignores=[]),'<source-final-capture-failure>','exec'),namespace)
            self.assertEqual(namespace['exit_code'],1)
            self.assertEqual(report['status'],'incomplete' if complete else 'failed')
            self.assertEqual(report['primary']['code'],0 if complete else 1)
            self.assertEqual(report['secondary'],[dict(stage='capture-manual-source-narrow',code=1,
                reason='required-capture-failed')] if complete else [])
        for name in ['p1-product-browser.py','p1-ci-ui-smoke.py']:
            module=ast.parse(Path(__file__).with_name(name).read_text())
            propagation=[n for n in ast.walk(module) if isinstance(n,ast.If) and 'item.get' in ast.unparse(n.test)
                and 'capture-control-completed' in ast.unparse(n.test)]
            self.assertTrue(propagation,name)
            allowed=[n for n in ast.walk(module) if isinstance(n,ast.Assign)
                     and any(isinstance(target,ast.Name) and target.id=='allowed' for target in n.targets)]
            for reason in ['required-capture-failed','unreviewed']:
                item=dict(stage='capture-manual-source-narrow',code=1,reason=reason)
                proof={'secondary':[]}
                exec(compile(ast.Module(body=allowed+propagation,type_ignores=[]),'<actual-source-secondary>','exec'),
                     {'item':item,'proof':proof})
                self.assertEqual(proof['secondary'],[item] if reason=='required-capture-failed' else [],name)

    def auto_report(self,case):
        if case=='auto-v':
            r=self.auto_report('auto-s')
            r.update(scope='Fixed afe3 ordinary cost1 vanilla V2/2 Battlefield real own UI with explicit fixture B pass; not Manual/negative/full P1 acceptance',control_case=case,fixture='11c.V.B',selected_card_id=17)
            for key,mana,stack,zone,casts,entries in [('control_initial',2,0,'Hand',0,0),('control_paid',1,1,'Stack',1,0),('control_completed',1,0,'Battlefield',1,1)]:
                r[key]=dict(r['control_initial'],life=[20,20],ownManaCount=mana,stackCount=stack,
                    vanilla=dict(id=17,name='P1 Vanilla V',zone=zone,controller=0,inHand=zone=='Hand',inBattlefield=zone=='Battlefield',power=2,toughness=2,cost=dict(type='Cost',shards=[],generic=1),abilityCounts=[0,0,0,0,0],spellCasts=casts,battlefieldEntries=entries,effects=0))
            r['fixture_opponent_driver']['before']=dict(r['control_paid'],priorityPlayer=1)
            return r
        empty=dict(lifeChanges=[],sourceDepartures=0,manualTerminals=0,nextDepartures=0)
        initial=dict(life=[20,20],ownManaCount=2,stackCount=0,manualPhase=None,resolvingEntryId=None,manualStackEntryId=None,sourceId=None,sourceName=None,
            sourceCardId=7,sourceInHand=True,sourceInGraveyard=False,nextCardId=11,nextInGraveyard=False,waitingType='Priority',priorityPlayer=0,publicEvents=empty)
        paid=dict(initial,ownManaCount=1,stackCount=1)
        done=dict(initial,life=[18 if case=='auto-s' else 23,20],ownManaCount=1,sourceInHand=case=='auto-n',sourceInGraveyard=case=='auto-s',
            nextCardId=11 if case=='auto-s' else None,nextInGraveyard=case=='auto-n',publicEvents=dict(lifeChanges=[dict(amount=-2 if case=='auto-s' else 3,total=18 if case=='auto-s' else 23)],sourceDepartures=1 if case=='auto-s' else 0,manualTerminals=0,nextDepartures=1 if case=='auto-n' else 0))
        return dict(status='passed',consumer={},consumer_execution={},scope=capture.AUTO_CONTROLS_SCOPE,control_case=case,fixture='1a.B',secondary=[],
            primary=dict(stage='operations-complete',code=0,reason='completed'),stages={k:dict(status='passed',assertions_completed=True) for k in ['control-initial','control-full-control','control-paid','control-response','control-completed']},
            control_initial=initial,control_paid=paid,control_completed=done,selected_card_id=7 if case=='auto-s' else 11,control_on=True,
            click_commands=[dict(operation=k,status='completed',native_double_click_verified=k=='control-normal-direct') for k in ['control-full-control','control-normal-direct','control-response']],
            fixture_opponent_driver=dict(ok=True,mode='explicit-local-fixture-opponent-driver',action='PassPriority',actor=1,commands=1,opponent_ui=False,two_client=False,before=dict(paid,priorityPlayer=1)))

    def test_vanilla_control_requires_paid_real_ui_and_one_battlefield_entry(self):
        report=self.auto_report('auto-v')
        capture.validate_operations(report,{}, {},control='auto-v')
        faults=[(['fixture'],'1a.B'),(['selected_card_id'],7),(['control_on'],False),
            (['control_paid','ownManaCount'],2),(['control_completed','life'],[19,20]),
            (['control_completed','stackCount'],1),(['control_completed','manualPhase'],'open'),
            (['control_completed','vanilla','zone'],'Graveyard'),(['control_completed','vanilla','inBattlefield'],False),
            (['control_completed','vanilla','power'],3),(['control_completed','vanilla','cost'],dict(type='Cost',shards=[],generic=2)),
            (['control_completed','vanilla','abilityCounts'],[0,1,0,0,0]),(['control_completed','vanilla','battlefieldEntries'],0),
            (['control_initial','vanilla','battlefieldEntries'],1),(['control_completed','vanilla','effects'],1),
            (['click_commands'],report['click_commands'][:2]),(['fixture_opponent_driver','two_client'],True),
            (['fixture_opponent_driver','before'],None),(['fixture_opponent_driver','before','priorityPlayer'],0),
            (['fixture_opponent_driver','before','ownManaCount'],2),(['fixture_opponent_driver','before','stackCount'],0),
            (['fixture_opponent_driver','before','manualPhase'],'open'),(['fixture_opponent_driver','before','vanilla','spellCasts'],0),
            (['fixture_opponent_driver','before','vanilla','battlefieldEntries'],1)]
        for path,value in faults:
            bad=json.loads(json.dumps(report)); target=bad
            for key in path[:-1]: target=target[key]
            target[path[-1]]=value
            with self.subTest(path=path),self.assertRaises(capture.EvidenceFailure):
                capture.validate_operations(bad,{}, {},control='auto-v')

    def test_auto_controls_reject_payment_carrier_effect_and_missing_native_response(self):
        for case in ['auto-s','auto-n']:
            report=self.auto_report(case)
            capture.validate_operations(report,{}, {},control=case)
            faults=[(['control_on'],False),(['selected_card_id'],99),(['control_paid','ownManaCount'],0),(['control_paid','life'],[18,20]),
                (['control_completed','life'],[21,20]),(['control_completed','manualPhase'],'closed'),(['control_completed','resolvingEntryId'],9),
                (['control_completed','sourceInHand'],case=='auto-s'),(['control_completed','nextInGraveyard'],case=='auto-s'),
                (['control_completed','publicEvents','manualTerminals'],1),(['fixture_opponent_driver','actor'],0),(['fixture_opponent_driver','commands'],2),
                (['fixture_opponent_driver','before','priorityPlayer'],0),(['fixture_opponent_driver','before','ownManaCount'],0),
                (['control_completed','publicEvents','lifeChanges'],[dict(amount=3,total=21)])]
            for path,value in faults:
                changed=json.loads(json.dumps(report));node=changed
                for key in path[:-1]:node=node[key]
                node[path[-1]]=value
                with self.subTest(case=case,path=path),self.assertRaises(capture.EvidenceFailure):capture.validate_operations(changed,{}, {},control=case)
            for operation in ['control-full-control','control-normal-direct','control-response']:
                changed=json.loads(json.dumps(report));changed['click_commands']=[c for c in changed['click_commands'] if c['operation']!=operation]
                with self.subTest(case=case,operation=operation),self.assertRaises(capture.EvidenceFailure):capture.validate_operations(changed,{}, {},control=case)

    def test_auto_controls_require_two_current_exact_images(self):
        def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
        png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\x00\x00\x00\x00'))+chunk(b'IEND',b'')
        manifest=dict(runtime={},consumer={},validation={},artifacts={'engine_wasm_bg.wasm':{'sha256':'unit-wasm'}})
        for case in ['auto-s','auto-n','auto-v']:
            report=self.auto_report(case)
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory);entries=[]
                (root/'ui-smoke-report.json').write_text(json.dumps(report))
                for step,key in [('control-initial','control_initial'),('control-completed','control_completed')]:
                    item=dict(step=step,status='observation-only',exit_code=0,runtime={},consumer={},validation={},consumer_execution={},served={'engine_wasm_bg.wasm':'unit-wasm'})
                    for kind,path,data in [('state','states/'+step+'.json',json.dumps(report[key]).encode()),('screenshot','screenshots/'+step+'.png',png)]:
                        target=root/path;target.parent.mkdir(exist_ok=True);target.write_bytes(data)
                        item[kind]=dict(path=path,sha256=hashlib.sha256(data).hexdigest())
                    entries.append(item)
                (root/'step-index.json').write_text(json.dumps(entries))
                self.assertEqual(capture.validate_required_images(root,manifest,{},control=case)['verified_count'],2)
                (root/'step-index.json').write_text(json.dumps(entries[:1]))
                with self.assertRaises(capture.EvidenceFailure):capture.validate_required_images(root,manifest,{},control=case)
                (root/'step-index.json').write_text(json.dumps(entries))
                entries[1]['state']['sha256']='bad';(root/'step-index.json').write_text(json.dumps(entries))
                with self.assertRaises(capture.EvidenceFailure):capture.validate_required_images(root,manifest,{},control=case)

    def s1_1c_report(self):
        report = self.s1_report()
        report.update(scope=capture.S1_1C_SCOPE,fixture='1c.B',receipt_observer_stopped=True)
        first = dict(report['begin'],life=[19,20],publicEvents=dict(lifeChanges=[{'amount':-1,'total':19}],sourceDepartures=0,manualTerminals=0,nextDepartures=0))
        losses = [{'amount':-1,'total':19},{'amount':-1,'total':18}]
        for key in ['life_applied','finished','ordinary_completed']:
            report[key]['publicEvents']['lifeChanges'] = losses + ([{'amount':3,'total':21}] if key=='ordinary_completed' else [])
        report['life_first'] = first
        report['stages'].update({stage:dict(status='passed',assertions_completed=True) for stage in ['life19','historical-lookup']})
        report['click_commands'].append(dict(operation='life19',status='completed'))
        report['receipt_summary']['completed'][1]['lifeChanges']=[{'amount':-1,'total':19}]
        report['receipt_summary']['completed'].insert(2,dict(sourceId=7,stackEntryId=9,terminalCount=0,lifeChanges=[{'amount':-1,'total':18}]))
        report['receipt_summary']['appliedResults']=4
        counts=dict(publications=3,appliedResults=3,completed=3)
        report['historical_lookup']=dict(method='native-read-only-original-lookup-and-client-terminal-cache-reconcile',nativeLookupCount=1,
            before=report['life_applied'],after=report['life_applied'],countsBefore=counts,countsAfter=dict(counts),
            differentInteractions=True,differentAttempts=True,sameOriginal=True,sameOriginalResult=True,sameSource=True,sameContext=True,
            nativeAppliedResultNull=True,nativeRejectionNull=True,cacheOriginalBinding=True,nativeStatus='completed',cacheStatus='completed',
            historicalLifeChanges=[{'amount':-1,'total':19}],historicalTerminalCount=0,currentLife=[18,20],currentSourceId=7,currentEntryId=9,currentPhase='open',adapterPublishedHistoricalReply=False)
        return report

    def native_original_report(self):
        report=self.s1_1c_report(); groups=[]
        for phase,total,count,key in [('before-second',19,2,'life_first'),('after-second',18,3,'life_applied')]:
            counts=dict(publications=count,appliedResults=count,completed=count)
            hashes=dict(stateSha256='a'*64,replaySha256='b'*64,replayActions=8+count)
            queries=[dict(subject=subject,operation=operation,status='completed',currentLife=[total,20],
                historicalLife=[{'amount':-1,'total':19 if subject=='qL1' else 18}],loseLifeEffects=1,
                sameOriginal=True,sameOriginalResult=True,appliedResultNull=True,rejectionNull=True,sameSource=True)
                for subject in (['qL1'] if total==19 else ['qL1','qL2']) for operation in ['register','apply','lookup']]
            group=dict(phase=phase,method='same-actual-UI-original-native-register-apply-lookup',before=report[key],after=report[key],
                countsBefore=counts,countsAfter=counts,hashesBefore=hashes,hashesAfter=hashes,queries=queries,
                adapterPublishedHistoricalReply=False,qL2PrecommitCustodyProven=False)
            if total==19:
                group['refusals']=dict(method='real-Worker-register-only-admission-and-old-interaction',calls=2,actor=1,
                    admissionErrorMatched=True,freshInteractionDifferentFromOld=True,oldBindingNewAttempt=True,separateNegativeAttempts=True,
                    currentContextMatched=True,sameOriginal=True,resultNull=True,appliedResultNull=True,gameStateUnchanged=True,
                    admissionReceiptReturned=False,ledgerUnchangedClaim=False,refusalUi=False,
                    rawOldStatus='notApplied',oldRejection='invalid_interaction_response',
                    actorAfter=report[key],actorCountsAfter=counts,actorHashesAfter=hashes,
                    oldAfter=report[key],oldCountsAfter=counts,oldHashesAfter=hashes)
            groups.append(group)
        report['native_original_checks']=groups
        report['native_final_replay']=dict(method='real-Worker-read-only-replay',sha256='c'*64,actions=18,manualLife=2,manualFinish=1)
        return report

    def test_actual_pending_release_preserves_prior_failure_and_fails_closed(self):
        import copy,sys
        tree=ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        finalbody=next(n.finalbody for n in ast.walk(tree) if isinstance(n,ast.Try) and n.finalbody
            and any(isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='prior_pending_failure' for t in x.targets) for x in n.finalbody))
        class PrimaryFailure(Exception):pass
        class ReleaseFailure(Exception):pass
        for earlier,had_wire in [(True,False),(True,True),(False,False)]:
            namespace={'sys':sys,'report':{'secondary':[]},'stage':'registered-pending',
                'call':lambda *args:(namespace['report'].update(webdriver_error={'source':'cleanup'}),(_ for _ in ()).throw(ReleaseFailure()))[1],'PrimaryFailure':PrimaryFailure}
            if had_wire:namespace['report']['webdriver_error']={'source':'original'}
            body=[ast.Raise(exc=ast.Call(func=ast.Name(id='PrimaryFailure',ctx=ast.Load()),args=[],keywords=[]),cause=None)] if earlier else [ast.Pass()]
            node=ast.Try(body=body,handlers=[],orelse=[],finalbody=copy.deepcopy(finalbody))
            code=compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'<actual-pending-finally>','exec')
            with self.subTest(prior=earlier),self.assertRaises(PrimaryFailure if earlier else ReleaseFailure):exec(code,namespace)
            self.assertEqual(namespace['report'].get('webdriver_error'),({'source':'original'} if had_wire else None) if earlier else {'source':'cleanup'})
            self.assertFalse(namespace['report']['pending_hold_released'])
            self.assertEqual(namespace['report']['secondary'],[dict(stage='pending-hold-release',code=1,reason='pending-hold-release-failed')])
            self.assertEqual(namespace['stage'],'registered-pending' if earlier else 'pending-hold-release')

    def recorded_1c_report(self):
        import copy
        report=self.native_original_report();report.update(scope=capture.RECORDED_1C_SCOPE,fixture='1c.recorded.B',pending_hold_released=True)
        for group in report['native_original_checks']:
            group['countsBefore']['publications']*=2
        report['receipt_summary']['publications']=9
        h=report['historical_lookup'];h.update(method='actual-original-request-native-lookup-and-adapter-historical-publication',adapterPublishedHistoricalReply=True,
            countsBefore=dict(publications=6,appliedResults=3,completed=3),countsAfter=dict(publications=7,appliedResults=3,completed=3),
            originalRequestRetained=True,originalRequestFrozen=True,publicationSameOriginal=True,publicationSameOriginalResult=True,
            publicationAppliedResultNull=True,publicationStatus='completed',publicationHistoricalLife=[dict(amount=-1,total=19)],publicationCurrentLife=[18,20])
        hashes=dict(stateSha256='d'*64,replaySha256='e'*64,replayActions=9)
        report['registered_pending']=dict(method='actual-registered-pending-before-apply-native-register-lookup',engineInFlight=False,
            before=copy.deepcopy(report['life_first']),after=copy.deepcopy(report['life_first']),
            countsBefore=dict(publications=5,appliedResults=2,completed=2),countsAfter=dict(publications=5,appliedResults=2,completed=2),
            hashesBefore=hashes,hashesAfter=dict(hashes),originalRequestRetained=True,originalRequestFrozen=True,oneShotClaimed=True,
            pendingResultNull=True,pendingAppliedResultNull=True,queries=[dict(operation=operation,status='pending',sameOriginal=True,resultNull=True,rejectionNull=True,appliedResultNull=True,currentLife=[19,20]) for operation in ['register','lookup']])
        return report

    def test_actual_recorded_subscriber_claims_pending_once_and_preserves_frozen_request(self):
        tree=ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        scripts=[n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str) and 'window.__p1ArmPending = ' in n.value]
        self.assertEqual(len(scripts),1)
        script=scripts[0].replace("import('/src/stores/gameStore.ts')","Promise.resolve({useGameStore})").replace("import('/src/adapter/wasm-adapter.ts')","Promise.resolve({unwrapClientGameState:s=>s})").replace("import('/src/adapter/types.ts')","Promise.resolve({sameLocalContinuationValue:(a,b)=>JSON.stringify(a)===JSON.stringify(b)})")
        program=r'''
const assert=require('node:assert/strict');global.crypto=require('node:crypto').webcrypto;global.window={};
let listener, stopped=false, currentRequest, firstRequest, nativeCalls=[];const terminal=new Map();
const cap={subscribe:l=>{listener=l;return()=>{stopped=true;};},commandPortFactory:()=>({getUnresolvedManualResolutionRequest:()=>currentRequest,reconcileManualResolution:async original=>{assert.strictEqual(original,firstRequest);await listener({receipt:terminal.get('first'),appliedResult:null,current:currentFrame()});return {status:'completed',binding:original.binding};}})};
const currentFrame=()=>({context:{adapterGeneration:1},snapshot:{state:{players:[{life:18},{life:20}],derived:{manual_resolution:{phase:'open',source:{stackEntryId:9,sourceId:7}}},resolving_stack_entry:{id:9}}}});
const publicState={life:[19,20]}, engine={exportReplayLog:async()=>'{"actions":[{}]}',submitLocalContinuation:async(actor,wire)=>{nativeCalls.push(wire.operation);if(terminal.has(wire.attempt.attemptId))return {receipt:terminal.get(wire.attempt.attemptId),appliedResult:null,current:currentFrame()};return {receipt:{attempt:wire.attempt,status:'pending',result:null,rejection:null},appliedResult:null,current:{snapshot:{state:{players:[{life:19},{life:20}]}}}};}};
const useGameStore={getState:()=>({adapter:{localContinuation:()=>cap,getEngineClient:()=>engine,exportPersistenceState:async()=>'{"unchanged":true}'}})};
window.__p1Observe=()=>publicState;
const attempt=id=>({attemptId:id,context:{adapterGeneration:1},source:{stackEntryId:9,sourceId:7},submission:{interactionId:id,response:{type:'manualResolution',data:{decision:{type:'loseOwnLife',data:{amount:1}}}}}});
const freeze=a=>Object.freeze({binding:Object.freeze({interactionId:a.submission.interactionId,adapterGeneration:1}),command:Object.freeze({type:'lose-life',affectedPlayerId:0,amount:1,stackEntryId:9,sourceObjectId:7})});
const pending=a=>({receipt:{attempt:a,status:'pending',result:null,rejection:null},appliedResult:null});
(async()=>{
 await new Promise(done=>new Function('useGameStore','return function(){'+SCRIPT+'}')(useGameStore)(true,done));
 const a1=attempt('first');currentRequest=freeze(a1);firstRequest=currentRequest;await listener(pending(a1));
 terminal.set('first',{attempt:a1,status:'completed',rejection:null,result:{events:[{type:'LifeChanged',data:{player_id:0,amount:-1,new_total:19}}]}});
 await listener({receipt:terminal.get('first'),appliedResult:{}});
 assert.equal(window.__p1ArmPending(),true);
 const a2=attempt('second');currentRequest=freeze(a2);let completed=false;
 const held=listener(pending(a2)).then(()=>{completed=true;});
 await Promise.resolve();assert.equal(window.__p1PendingReady(),true);assert.equal(completed,false);
 const proof=await window.__p1ProbePending();assert.equal(proof.originalRequestRetained,true);assert.equal(proof.originalRequestFrozen,true);
 assert.deepEqual(nativeCalls,['register','lookup']);assert.equal(proof.pendingResultNull,true);assert.equal(proof.pendingAppliedResultNull,true);
 // Reentrant notification must never create another hold.
 await listener(pending(a2));assert.equal(completed,false);
 assert.equal(window.__p1ReleasePending(),true);await held;assert.equal(completed,true);
 terminal.set('second',{attempt:a2,status:'completed',result:{events:[{type:'LifeChanged',data:{player_id:0,amount:-1,new_total:18}}]}});
 await listener({receipt:terminal.get('second'),appliedResult:{}});publicState.life=[18,20];
 const historic=await window.__p1LookupFirst();assert.equal(historic.originalRequestRetained,true);assert.equal(historic.adapterPublishedHistoricalReply,true);
 assert.equal(historic.publicationSameOriginalResult,true);assert.equal(historic.publicationAppliedResultNull,true);assert.deepEqual(historic.publicationHistoricalLife,[{amount:-1,total:19}]);assert.deepEqual(historic.publicationCurrentLife,[18,20]);
 assert.equal(window.__p1StopReceipts(),true);assert.equal(stopped,true);assert.equal(window.__p1ProbePending,undefined);
})().catch(e=>{console.error(e);process.exitCode=1;});
'''
        program=program.replace('SCRIPT',json.dumps(script))
        subprocess.run(['node','-e',program],check=True,capture_output=True,timeout=10)

    def test_recorded_1c_rejects_pending_mutation_and_false_historical_publication(self):
        import copy
        report=self.recorded_1c_report();capture.validate_recorded_1c(report,final=False)
        faults=[(['pending_hold_released'],False),(['registered_pending','engineInFlight'],True),
            (['registered_pending','originalRequestRetained'],False),(['registered_pending','countsAfter','appliedResults'],3),
            (['registered_pending','hashesAfter','replaySha256'],'f'*64),(['registered_pending','queries',0,'status'],'completed'),
            (['registered_pending','queries',1,'appliedResultNull'],False),(['registered_pending','after','life'],[18,20]),
            (['historical_lookup','adapterPublishedHistoricalReply'],False),(['historical_lookup','publicationSameOriginal'],False),
            (['historical_lookup','publicationAppliedResultNull'],False),(['historical_lookup','publicationHistoricalLife'],[dict(amount=-1,total=18)]),
            (['historical_lookup','publicationCurrentLife'],[19,20]),(['historical_lookup','countsAfter','publications'],6),
            (['historical_lookup','countsAfter','appliedResults'],4),(['native_original_checks',0,'countsBefore','publications'],2)]
        for path,value in faults:
            changed=copy.deepcopy(report);node=changed
            for key in path[:-1]:node=node[key]
            node[path[-1]]=value
            with self.subTest(path=path),self.assertRaises(capture.EvidenceFailure):capture.validate_recorded_1c(changed,final=False)
        with self.assertRaises(capture.EvidenceFailure):capture.validate_historical_lookup(report)
        with self.assertRaises(capture.EvidenceFailure):capture.validate_native_original_checks(report)

    def test_native_originals_require_both_phases_distinct_resends_and_atomic_refusals(self):
        report=self.native_original_report()
        capture.validate_operations(report,{}, {},s1_1c=True)
        capture.validate_native_original_checks(report,final=True)
        partial=json.loads(json.dumps(report));partial['native_original_checks']=partial['native_original_checks'][:1]
        capture.validate_native_original_checks(partial,complete=False)
        with self.assertRaises(capture.EvidenceFailure):capture.validate_native_original_checks(partial)
        faults=[(['native_original_checks',0,'queries',1,'operation'],'lookup'),
            (['native_original_checks',1,'queries',0,'currentLife'],[19,20]),
            (['native_original_checks',1,'queries',3,'historicalLife'],[{'amount':-1,'total':19}]),
            (['native_original_checks',0,'queries',0,'loseLifeEffects'],0),
            (['native_original_checks',0,'hashesAfter','replaySha256'],'d'*64),
            (['native_original_checks',0,'refusals','rawOldStatus'],'not-applied'),
            (['native_original_checks',0,'refusals','oldRejection'],'stale_interaction'),
            (['native_original_checks',0,'refusals','oldBindingNewAttempt'],False),
            (['native_original_checks',0,'refusals','admissionReceiptReturned'],True),
            (['native_original_checks',0,'refusals','oldCountsAfter','appliedResults'],3),
            (['native_original_checks',0,'refusals','actorHashesAfter','stateSha256'],'d'*64),
            (['native_original_checks',1,'adapterPublishedHistoricalReply'],True),
            (['native_original_checks',0,'qL2PrecommitCustodyProven'],True),
            (['native_final_replay','manualLife'],3),(['native_final_replay','manualFinish'],0)]
        for path,value in faults:
            changed=json.loads(json.dumps(report));node=changed
            for key in path[:-1]:node=node[key]
            node[path[-1]]=value
            with self.subTest(path=path),self.assertRaises(capture.EvidenceFailure):capture.validate_native_original_checks(changed,final=True)

    def test_s1_1c_rejects_old_receipt_replay_and_ui_regression(self):
        report=self.s1_1c_report()
        capture.validate_operations(report, {}, {}, s1_1c=True)
        faults=[(['historical_lookup',flag],False) for flag in ['differentInteractions','differentAttempts','sameOriginal','sameOriginalResult','sameSource','sameContext','nativeAppliedResultNull','nativeRejectionNull','cacheOriginalBinding']]
        faults += [(['historical_lookup','nativeLookupCount'],2),(['historical_lookup','adapterPublishedHistoricalReply'],True),
            (['historical_lookup','nativeStatus'],'pending'),(['historical_lookup','cacheStatus'],'indeterminate'),
            (['historical_lookup','historicalLifeChanges'],[{'amount':-1,'total':18}]),(['historical_lookup','currentLife'],[19,20]),
            (['historical_lookup','currentSourceId'],8),(['historical_lookup','currentEntryId'],10),(['historical_lookup','currentPhase'],'closed'),
            (['historical_lookup','countsAfter','publications'],4),(['historical_lookup','countsAfter','appliedResults'],4),
            (['historical_lookup','countsAfter','completed'],4),(['historical_lookup','after','life'],[19,20]),
            (['life_first','publicEvents','lifeChanges'],[{'amount':-2,'total':18}]),(['receipt_observer_stopped'],False),
            (['receipt_summary','appliedResults'],5),(['fixture'],'1a.B'),(['stages','historical-lookup','status'],'skipped')]
        for path,value in faults:
            changed=json.loads(json.dumps(report)); node=changed
            for key in path[:-1]: node=node[key]
            node[path[-1]]=value
            with self.subTest(path=path),self.assertRaises(capture.EvidenceFailure):
                capture.validate_operations(changed,{}, {},s1_1c=True)
        for operation in ['life19','life18']:
            changed=json.loads(json.dumps(report)); changed['click_commands']=[c for c in changed['click_commands'] if c['operation']!=operation]
            with self.subTest(operation=operation),self.assertRaises(capture.EvidenceFailure):
                capture.validate_operations(changed,{}, {},s1_1c=True)

    def test_s1_1c_requires_seven_current_images(self):
        self.assertEqual(self.verify(s1_1c=True)['verified_count'],7)
        for step in ['prepayment','same-source','life19','life18','historical-lookup','finish','paidplay21']:
            with self.subTest(step=step),self.assertRaises(capture.EvidenceFailure):
                self.verify(s1_1c=True,missing_step=step)

    def test_s1_1a_requires_prepaid_boundaries_receipts_events_and_native_commands(self):
        report = self.s1_report()
        capture.validate_operations(report, {}, {}, s1_1a=True)
        faults = [(['prepayment_full_control'],False),(['fixture'],'1c.K1'),(['stages','prepayment','status'],'skipped'),(['prepayment','ownManaCount'],1),
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

    def test_s1_1a_rejects_each_missing_or_incomplete_native_operation(self):
        report = self.s1_report()
        for index, command in enumerate(report['click_commands']):
            for mode in ['missing', 'incomplete']:
                with self.subTest(operation=command['operation'], mode=mode), self.assertRaises(capture.EvidenceFailure):
                    changed = json.loads(json.dumps(report))
                    if mode == 'missing':
                        del changed['click_commands'][index]
                    else:
                        changed['click_commands'][index]['status'] = 'attempting'
                    capture.validate_operations(changed, {}, {}, s1_1a=True)

    def test_s1_1a_requires_own_native_response_before_each_opponent_driver(self):
        module = ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        journey = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'run_s1_1a')
        function = next(n for n in journey.body if isinstance(n, ast.FunctionDef) and n.name == 'opponent')
        for operation, life, mana, phase in [('manual-response',20,1,'armed'),('paidplay-response',18,0,'closed')]:
            state = {'waitingType':'Priority','priorityPlayer':1}
            native, drivers = [], []
            def wait(predicate):
                if not predicate(state): raise AssertionError('required own priority unavailable')
                return state
            def native_click(*args):
                native.append(operation); state['priorityPlayer']=1
            def driver(*args):
                drivers.append(args); return dict(ok=True,commands=1)
            namespace = dict(report={},observe=lambda: state,wait_for=wait,click=native_click,drive_fixture_opponent_pass_once=driver)
            exec(compile(ast.Module(body=[function],type_ignores=[]),'<own-native-response>', 'exec'),namespace)
            with self.subTest(operation=operation), self.assertRaisesRegex(AssertionError,'required own priority'):
                namespace['opponent'](life,mana,phase)
            self.assertEqual(native,[]); self.assertEqual(drivers,[])
            state['priorityPlayer']=0
            namespace['opponent'](life,mana,phase)
            self.assertEqual(native,[operation]); self.assertEqual(drivers,[(life,mana,phase)])

    def test_full_control_uses_visible_right_rail_and_records_acquisition_failure(self):
        module = ast.parse(Path(__file__).with_name('p1-ui-smoke.py').read_text())
        lookup = next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='element')
        journey = next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='run_s1_1a')
        start = next(i for i,n in enumerate(journey.body) if isinstance(n,ast.Assign) and isinstance(n.value,ast.Constant) and n.value.value=='prepayment-full-control')
        end = next(i for i,n in enumerate(journey.body) if isinstance(n,ast.Assign) and isinstance(n.value,ast.Constant) and n.value.value=='manual-card-select')
        report, native = {}, []
        def request(path,data=None):
            if path=='/elements':
                ids=['visible-right'] if data['value'].startswith('[data-mobile-action-right]') else ['hidden-left','visible-right']
                return [{'element-6066-11e4-a52e-4f735466cecf':i} for i in ids]
            if path.endswith('/displayed'): return 'visible-right' in path
            if path.endswith('/enabled'): return True
            if path.endswith('/click'): native.append(path); return None
            if path=='/execute/sync': return bool(native) and '[data-mobile-action-right]' in data['script']
            raise AssertionError(path)
        ticks=iter([0,0,41])
        namespace=dict(report=report,stage='prepayment-full-control',call=request,
            time=SimpleNamespace(monotonic=lambda:next(ticks),sleep=lambda _:None),
            observe=lambda:dict(life=[20,20],ownManaCount=2,stackCount=0))
        exec(compile(ast.Module(body=[lookup],type_ignores=[]),'<control-acquisition>', 'exec'),namespace)
        def native_click(selector):
            identifier=namespace['element'](selector)
            request('/element/'+identifier+'/click',{})
        namespace['click']=native_click
        exec(compile(ast.Module(body=journey.body[start:end],type_ignores=[]),'<actual-control-journey-prefix>', 'exec'),namespace)
        self.assertEqual(native,['/element/visible-right/click'])
        self.assertTrue(report['prepayment_full_control'])
        self.assertEqual(report['full_control_confirmation'],dict(phase='on-confirmation',found=True))
        native.clear(); ticks=iter([0,0,41])
        with self.assertRaisesRegex(AssertionError,'visible and enabled'):
            namespace['element']('button[aria-label="Full Control Off"]')
        failure=report['control_acquisition_failure']
        self.assertEqual(failure['phase'],'element-acquisition')
        self.assertEqual(failure['lastObservation'],dict(matchCount=2,firstMatch=dict(index=0,displayed=False,enabled=None)))
        self.assertEqual(failure['publicStateAtFailure']['life'],[20,20])
        self.assertNotIn('hidden-left',json.dumps(failure))
        self.assertEqual(native,[])

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
        ui_scope = eval(compile(ast.Expression(expression), '<ui-scope>', 'eval'), {'CHECKS': capture, 'PREPAYMENT': False, 'AUTO_CONTROL': None, 'RECORDED_PREP': False, 'RECORDED_1C': False})
        ci = ast.parse(Path(__file__).with_name('p1-ci-ui-smoke.py').read_text())
        assignment = next(node for node in ast.walk(ci) if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
                                  and target.value.id == 'proof' and isinstance(target.slice, ast.Constant)
                                  and target.slice.value == 'scope' for target in node.targets))
        ci_scope = eval(compile(ast.Expression(assignment.value), '<ci-scope>', 'eval'), {'checks': capture})
        self.assertEqual(ci_scope, capture.AUTO_CONTROLS_SCOPE)
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
