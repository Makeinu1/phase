"""Consume this job's newly built immutable runtime on the normal Local board."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile

VERSION = '154.0.8037.92'
VALIDATION = Path(__file__).resolve().parents[2]


def browser_tools(destination):
    # Official CfT metadata supplies the URLs; no guessed storage URL or
    # private artifact download is involved.
    endpoint = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json'
    with urllib.request.urlopen(endpoint, timeout=60) as response:
        metadata = json.load(response)
    version = next(item for item in metadata['versions'] if item['version'] == VERSION)
    destination.mkdir(parents=True, exist_ok=True)
    proof = {'version': VERSION, 'metadata_url': endpoint, 'archives': {}}
    for kind in ['chrome', 'chromedriver']:
        url = next(item['url'] for item in version['downloads'][kind] if item['platform'] == 'linux64')
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != 'https' or parsed.hostname != 'storage.googleapis.com'
                or not parsed.path.startswith('/chrome-for-testing-public/' + VERSION + '/linux64/')):
            raise ValueError('unexpected official browser asset')
        archive = destination / (kind + '.zip')
        with urllib.request.urlopen(url, timeout=120) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output)
        proof['archives'][kind] = {'url': url, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                target = (destination / member.filename).resolve()
                if not target.is_relative_to(destination.resolve()):
                    raise ValueError('browser archive path escapes destination')
                bundle.extract(member, destination)
                if not member.is_dir():
                    target.chmod((member.external_attr >> 16) & 0o777 or 0o644)
    binaries = {'P1_CHROME_BINARY': destination / 'chrome-linux64/chrome',
                'BOOTSTRAP_CHROMEDRIVER': destination / 'chromedriver-linux64/chromedriver'}
    for key, path in binaries.items():
        output = subprocess.check_output([str(path), '--version'], text=True).strip()
        if VERSION not in output:
            raise ValueError('browser/driver version mismatch')
        proof[key] = {'path': str(path), 'version_output': output,
                      'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    return binaries, proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--candidate-sha', required=True)
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    source, evidence = args.source.resolve(), args.evidence.resolve()
    manifest = json.loads((evidence / 'manifest.json').read_text())
    if manifest['status'] != 'built' or manifest['consumer']['sha'] != args.candidate_sha:
        raise ValueError('verified runtime for this exact candidate required')
    environment = dict(os.environ, MANUAL_EXPECTED_SOURCE_SHA=args.candidate_sha,
        MANUAL_EVIDENCE=str(evidence), CARGO_BUILD_JOBS='1', CARGO_INCREMENTAL='0',
        CARGO_TARGET_DIR=str(evidence / 'target'), RUNNER_TEMP=os.environ.get('RUNNER_TEMP', '/tmp'))
    proof = {'consumer': manifest['consumer'], 'stage': 'starting', 'status': 'running', 'secondary': [],
             'stages': {'runtime': 'passed', 'application': 'not_run', 'operations': 'not_run', 'images': 'not_run'},
             'consumer_execution': {'validation_sha': subprocess.check_output(
                 ['git', '-C', str(VALIDATION), 'rev-parse', 'HEAD'], text=True).strip(),
                 'run_id': os.environ.get('GITHUB_RUN_ID'), 'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT')}}
    effective_exit = 0
    spec = importlib.util.spec_from_file_location('p1_capture_checks', VALIDATION / 'scripts/ci/p1-product-capture.py')
    checks = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checks)
    proof['scope'] = checks.AUTO_CONTROLS_SCOPE
    proof['cases'] = {}
    browser_evidence = evidence
    spec = importlib.util.spec_from_file_location('p1_browser_results', VALIDATION / 'scripts/ci/p1-product-browser.py')
    results = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(results)

    class StageStop(Exception):
        pass

    def guarded(label, command, extra=None):
        proof['stage'] = label
        command_environment = dict(environment, **(extra or {}))
        if label == 'p1-ui-smoke':
            command_environment['MANUAL_EVIDENCE'] = str(browser_evidence)
        result = subprocess.run(['python3', str(VALIDATION / 'scripts/ci/manual-integration-guard.py'),
            label, *command], cwd=source, env=command_environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        proof['primary'] = {'stage': label, 'code': result.returncode,
            'reason': 'completed' if result.returncode == 0 else 'guarded-command-failed'}
        browser_report_failed = False
        if label == 'p1-ui-smoke':
            try:
                browser, saved = results.load_result(browser_evidence / 'browser-boot.json', browser_evidence / 'p1-ui-smoke.log')
                if not saved:
                    browser_report_failed = True
                    proof['secondary'].append({'stage': 'browser-boot-report', 'code': 1, 'reason': 'required-report-save-failed'})
                if browser.get('stages', {}).get('application') == 'passed':
                    proof['stages']['application'] = 'passed'
                if (browser.get('consumer') != manifest['consumer']
                        or browser.get('consumer_execution') != proof['consumer_execution']
                        or (result.returncode == 0 and (browser.get('status') != 'scenario-exited'
                            or type(browser.get('effective_exit')) is not int or browser['effective_exit'] != 0))):
                    browser_report_failed = True
                    proof['secondary'].append({'stage': 'browser-boot-report', 'code': 1, 'reason': 'required-report-incomplete'})
                primary = browser['primary']
                if results.safe_primary(primary):
                    proof['primary'] = results.safe_primary(primary)
                # Copy only safe, structured secondary fields from this local helper.
                allowed = {'diagnostic-save-failed', 'failure-report-unreadable', 'session-cleanup-failed',
                           'process-cleanup-failed', 'required-report-save-failed', 'required-capture-failed', 'receipt-observer-cleanup-failed','pending-hold-release-failed','viewport-restore-failed'}
                for item in browser.get('secondary', []):
                    if (isinstance(item, dict) and item.get('reason') in allowed
                            and item.get('stage') in {'diagnostic-collector', 'scenario-report', 'browser-cleanup',
                                'capture-manual-source-narrow','capture-manual-controls-narrow','viewport-restore','process-cleanup', 'browser-boot-report', 'capture-control-completed', 'capture-recorded-ready', 'capture-finish', 'capture-paidplay21', 'receipt-observer-cleanup', 'pending-hold-release', 'ui-smoke-report'} and type(item.get('code')) is int):
                        proof['secondary'].append({key: item[key] for key in ['stage', 'code', 'reason']})
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                browser_report_failed = True
                proof['secondary'].append({'stage': 'browser-boot-report', 'code': 1, 'reason': 'required-report-unreadable'})
        try:
            ((browser_evidence if label=='p1-ui-smoke' else evidence) / (label + '.control.log')).write_bytes(result.stdout)
        except Exception:
            proof['secondary'].append({'stage': label + '-control-log', 'code': 1, 'reason': 'required-control-log-save-failed'})
            raise StageStop()
        if result.returncode or browser_report_failed:
            raise StageStop()

    try:
        recorded_1c = os.environ.get('P1_CI_CASE') == 'recorded-1c'
        recorded = recorded_1c or os.environ.get('P1_CI_CASE') == 'recorded-prep'
        fixtures = evidence / ('private-recorded-inputs' if recorded else 'private-fixtures')
        if recorded:
            guarded('p1-recorded-fixtures', ['cargo', 'test', '--locked', '-p', 'engine-wasm',
                '--features', 'manual_resolution_local_bootstrap', '--lib',
                'local_continuation_tests::admitted_paid_manual_replay_uses_truthful_ordinary_header_and_seeks',
                '--', '--exact'], {'P1_RECORDED_FIXTURE_OUTPUT_DIR': str(fixtures),
                    'RUST_MIN_STACK': '8388608'})
            if os.environ.get('P1_MANUAL_VISUAL') == '1':
                # The fixture emitter just built this same native engine feature
                # set; reuse it for the existing focused target, under the same guard.
                guarded('p1-manual-visual-native', ['cargo', 'test', '--locked', '-p', 'phase-engine',
                    '--features', 'manual_resolution_prototype,test-support',
                    '--test', 'manual_resolution_prototype', '--', '--test-threads=1'],
                    {'RUST_MIN_STACK': '8388608'})
                guarded('p1-manual-visual-feature-off', ['cargo', 'check', '--locked', '-p', 'phase-engine',
                    '--lib', '--no-default-features'], {'RUST_MIN_STACK': '8388608'})
            bundle = json.loads((fixtures / 'recorded-game-inputs.json').read_text())
            recipe = bundle.get('cases', {}).get('1c.recorded.B', {})
            if (bundle.get('version') != 1 or set(bundle.get('cases', {})) != {'1c.recorded.B'}
                    or recipe.get('kind') != 'recorded' or recipe.get('seed') != 117
                    or recipe.get('familyVariant') != '1c' or recipe.get('position') != 'B'
                    or set(recipe) != {'kind','seed','familyVariant','position','deckData'}):
                raise ValueError('reviewed recorded recipe required')
            cards = json.loads((fixtures / 'recorded-card-data.json').read_text())
            if not isinstance(cards, dict) or set(cards) != {'replay mana land','replay next play','replay response','replay self loss'}:
                raise ValueError('reviewed four-card database required')
            initializer = json.loads((fixtures / 'recorded-initializer-inputs.json').read_text())
            config = initializer.get('formatConfig', {})
            if (initializer.get('deckData') != recipe['deckData'] or initializer.get('seed') != recipe['seed']
                    or initializer.get('firstPlayer') != 0 or initializer.get('playerCount') is not None
                    or initializer.get('matchConfig') is not None or config.get('format') != 'Limited'
                    or config.get('starting_life') != 20 or config.get('min_players') != 2
                    or config.get('max_players') != 2):
                raise ValueError('recorded ordinary initializer correspondence required')
            proof['recorded_initializer'] = {'deck_and_seed_match': True, 'first_player': 0,
                'native_player_count': 'default-two', 'provider_player_count': 2,
                'format': 'Limited', 'match_config': None, 'full_1c_accepted': False}
            fixture_names = ['recorded-game-inputs.json','recorded-card-data.json','recorded-initializer-inputs.json']
        else:
            guarded('p1-native-fixtures', ['cargo', 'test', '--locked', '-p', 'phase-engine',
                '--features', 'manual_resolution_prototype', '--test', 'manual_resolution_prototype',
                'p1_native_journey::paid_manual_begin_life_finish_next_and_checked_checkpoints',
                '--', '--exact'], {'P1_FIXTURE_OUTPUT_DIR': str(fixtures)})
            bundle = json.loads((fixtures / 'trusted-game-states.json').read_text())
            if bundle['version'] != 1 or '1c.B' not in bundle['cases'] or len(bundle['cases']) != 145:
                raise ValueError('finite fixture generation did not produce the reviewed bundle')
            fixture_names = ['card-data.json','trusted-game-states.json']
        proof['fixtures'] = {name: hashlib.sha256((fixtures / name).read_bytes()).hexdigest()
            for name in fixture_names}
        if recorded_1c and os.environ.get('P1_MANUAL_VISUAL') == '1':
            face=cards['replay self loss'];oracle=face.get('oracle_text')
            if face.get('name') != 'Replay Self Loss' or (oracle is not None and not isinstance(oracle,str)):
                raise ValueError('reviewed source text metadata required')
            oracle_length=len((oracle or '').strip().encode('utf-16-le'))//2
            proof['manual_source_text']={'source_name':face['name'],
                'card_data_sha256':proof['fixtures']['recorded-card-data.json'],
                'oracle_text_kind':'null' if oracle is None else 'nonempty' if oracle_length else 'empty',
                'oracle_text_length':oracle_length}
        # Only ignored generated fixture bytes enter the immutable consumer.
        # A checkout-local exclude keeps the product's tracked tree unchanged.
        exclude = Path(subprocess.check_output(['git', 'rev-parse', '--git-path', 'info/exclude'],
            cwd=source, text=True).strip())
        if not exclude.is_absolute():
            exclude = source / exclude
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open('a') as output:
            output.write('\n/client/public/p1-integration-fixtures/\n')
        public = source / 'client/public'
        (public / 'p1-integration-fixtures').mkdir(parents=True, exist_ok=True)
        shutil.copyfile(fixtures / ('recorded-game-inputs.json' if recorded else 'trusted-game-states.json'),
            public / 'p1-integration-fixtures/trusted-game-states.json')
        shutil.copyfile(fixtures / ('recorded-card-data.json' if recorded else 'card-data.json'), public / 'card-data.json')
        proof['stage'] = 'install-runtime'
        subprocess.run(['python3', str(VALIDATION / 'scripts/ci/p1-wasm-validation.py'),
            'install-runtime', '--source', str(source), '--candidate-sha', args.candidate_sha,
            '--evidence', str(evidence)], env=environment, check=True)
        guarded('p1-client-dependencies', ['pnpm', '--dir', 'client', 'install', '--frozen-lockfile'])
        guarded('p1-browser-tools', ['python3', str(Path(__file__).resolve()), 'browser-tools',
            str(Path(environment['RUNNER_TEMP']) / 'p1-browser-tools'), str(evidence / 'browser-tools.json')])
        browser_proof = json.loads((evidence / 'browser-tools.json').read_text())
        tools = {key: browser_proof[key]['path'] for key in ['P1_CHROME_BINARY', 'BOOTSTRAP_CHROMEDRIVER']}
        for case in (['recorded-1c' if recorded_1c else 'recorded-prep'] if recorded else ['auto-v']):
            manual = recorded_1c or case == 'manual-originals'
            if recorded:
                proof['scope'] = checks.RECORDED_1C_SCOPE if recorded_1c else 'recorded-start-preparation-only'
            elif manual:
                proof['scope'] = checks.NATIVE_ORIGINAL_SCOPE
            elif case=='auto-v':
                proof['scope'] = checks.AUTO_V_SCOPE
            proof['case'] = case
            browser_evidence = evidence / 'controls' / case
            browser_evidence.mkdir(parents=True)
            for name in ['manifest.json','consumer-install.json']:
                shutil.copyfile(evidence/name,browser_evidence/name)
            proof['stage'] = 'product-browser'
            guarded('p1-ui-smoke', ['python3', str(VALIDATION / 'scripts/ci/p1-product-browser.py'),
                '--source', str(source), '--evidence', str(browser_evidence),
                '--entry-route', '/game/p1-'+case+'?mode=local&manual=1&p1Fixture='+('1c.recorded.B' if recorded else '1c.B' if manual else '11c.V.B' if case=='auto-v' else '1a.B'),
                '--scenario', str(VALIDATION / 'scripts/ci/p1-ui-smoke.py')],
                dict({key: str(value) for key, value in tools.items()},
                    P1_UI_CASE=case if recorded else 'prepayment1c' if manual else case, P1_NATIVE_CHECKS='1' if manual else '0',
                    P1_MANUAL_SOURCE_TEXT=json.dumps(proof.get('manual_source_text'))))
            # Each fresh case retains its own guarded attempt in its directory;
            # the unchanged guard still refuses a retry within that same case.
            proof['stages']['application'] = 'passed'
            proof['stage'] = 'operation-assertions'
            try:
                report = json.loads((browser_evidence / 'ui-smoke-report.json').read_text())
            except (OSError, ValueError):
                raise checks.EvidenceFailure('operation-assertions', 'required-operation-report-unreadable')
            if recorded_1c:
                checks.validate_operations(report, manifest['consumer'], proof['consumer_execution'], s1_1c=True, recorded_1c=True)
                checks.validate_lookup_privacy_revocation(report,complete=True)
                if os.environ.get('P1_MANUAL_VISUAL') == '1':
                    checks.validate_manual_visual(report,source_text=proof['manual_source_text'])
            elif recorded:
                checks.validate_recorded_operations(report, manifest['consumer'], proof['consumer_execution'])
            else:
                checks.validate_operations(report, manifest['consumer'], proof['consumer_execution'], s1_1c=manual, control=None if manual else case)
            if manual:
                checks.validate_native_original_checks(report, final=True, recorded=recorded_1c)
            proof['cases'][case] = {'status':'operations-complete','operations':'passed','images':'not_run'}
            proof['primary'] = {'stage':'operations-complete','code':0,'reason':'completed'}
            proof['stage'] = 'required-images'
            images = checks.validate_required_images(browser_evidence, manifest, proof['consumer_execution'], s1_1c=manual, control=None if manual or recorded else case, recorded_prep=recorded and not recorded_1c, recorded_1c=recorded_1c, manual_visual=os.environ.get('P1_MANUAL_VISUAL') == '1')
            proof['cases'][case] = {'status':'passed','images':images,'normal_ui':True,
                'initial_fixture':('1c.recorded.B' if recorded else '1c.B' if manual else '11c.V.B' if case=='auto-v' else '1a.B')+'-fresh-before-designation-payment','opponent':'explicit-fixture-driver','opponent_ui':False,'two_client':False}
            if manual:
                proof['cases'][case].update(refusal_ui=False,refusal_boundary='real-Worker-register-only',
                    qL2_precommit_custody=recorded_1c,adapter_historical_publication=recorded_1c,full_1c_accepted=False)
                if os.environ.get('P1_MANUAL_VISUAL') == '1':
                    proof['cases'][case]['manual_visual_text_coverage'] = {
                        key: value['oracleTextCoverage'] for key,value in report['manual_visual'].items()}
                    proof['cases'][case]['nonempty_oracle_wrap_accepted'] = False
        if recorded_1c and os.environ.get('P1_MANUAL_VISUAL') == '1':
            positive=evidence/'private-source-text-inputs'
            guarded('p1-manual-source-text-fixtures',['cargo','test','--locked','-p','phase-engine',
                '--features','manual_resolution_prototype,test-support','--test','manual_resolution_prototype',
                'p1_native_journey::paid_manual_begin_life_finish_next_and_checked_checkpoints','--','--exact'],
                {'P1_FIXTURE_OUTPUT_DIR':str(positive),'RUST_MIN_STACK':'8388608'})
            bundle=json.loads((positive/'trusted-game-states.json').read_text())
            if bundle.get('version')!=1 or len(bundle.get('cases',{}))!=145 or '1c.B' not in bundle['cases']:
                raise ValueError('existing checked-native source fixture required')
            cards=json.loads((positive/'card-data.json').read_text())
            faces=[face for face in cards.values() if face.get('name')=='P1 Self Loss']
            if len(faces)!=1 or not isinstance(faces[0].get('oracle_text'),str) or not faces[0]['oracle_text'].strip():
                raise ValueError('existing nonempty source oracle required')
            proof['source_text_positive_fixtures']={name:hashlib.sha256((positive/name).read_bytes()).hexdigest()
                for name in ['card-data.json','trusted-game-states.json']}
            canonical={'source_name':'P1 Self Loss','oracle_text_kind':'nonempty',
                'oracle_text_length':len(faces[0]['oracle_text'].strip().encode('utf-16-le'))//2,
                'card_data_sha256':proof['source_text_positive_fixtures']['card-data.json']}
            proof['source_text_positive_text']=canonical
            shutil.copyfile(positive/'trusted-game-states.json',public/'p1-integration-fixtures/trusted-game-states.json')
            shutil.copyfile(positive/'card-data.json',public/'card-data.json')
            browser_evidence=evidence/'controls/manual-source-text'
            browser_evidence.mkdir(parents=True)
            for name in ['manifest.json','consumer-install.json']:
                shutil.copyfile(evidence/name,browser_evidence/name)
            guarded('p1-ui-smoke',['python3',str(VALIDATION/'scripts/ci/p1-product-browser.py'),
                '--source',str(source),'--evidence',str(browser_evidence),
                '--entry-route','/game/p1-manual-source-text?mode=local&manual=1&p1Fixture=1c.B',
                '--scenario',str(VALIDATION/'scripts/ci/p1-ui-smoke.py')],
                dict({key:str(value) for key,value in tools.items()},P1_UI_CASE='manual-source-text',
                     P1_NATIVE_CHECKS='0',P1_MANUAL_SOURCE_TEXT=json.dumps(canonical)))
            report=json.loads((browser_evidence/'ui-smoke-report.json').read_text())
            checks.validate_source_text_positive(report,manifest['consumer'],proof['consumer_execution'],canonical)
            images=checks.validate_required_images(browser_evidence,manifest,proof['consumer_execution'],source_text_only=True)
            proof['cases']['manual-source-text']={'status':'passed','images':images,'normal_ui':True,
                'source_text_only':True,'nonempty_oracle_display_accepted':True,'oracle_multiline_wrap_accepted':False,
                'Apply_Finish_receipts_accepted':False,'recorded_ordinary_start':False,'full_1c_accepted':False}
            # Independent fresh checkpoint-origin main1a; no recorded replay claim.
            if '1a.B' not in bundle['cases']:
                raise ValueError('existing checked-native main1a fixture required')
            browser_evidence=evidence/'controls/main1a'
            browser_evidence.mkdir(parents=True)
            for name in ['manifest.json','consumer-install.json']:
                shutil.copyfile(evidence/name,browser_evidence/name)
            proof['stage']='product-browser'
            guarded('p1-ui-smoke',['python3',str(VALIDATION/'scripts/ci/p1-product-browser.py'),
                '--source',str(source),'--evidence',str(browser_evidence),
                '--entry-route','/game/p1-main1a?mode=local&manual=1&p1Fixture=1a.B',
                '--scenario',str(VALIDATION/'scripts/ci/p1-ui-smoke.py')],
                dict({key:str(value) for key,value in tools.items()},P1_UI_CASE='prepayment1a',P1_NATIVE_CHECKS='0'))
            proof['stage']='operation-assertions'
            report=json.loads((browser_evidence/'ui-smoke-report.json').read_text())
            checks.validate_operations(report,manifest['consumer'],proof['consumer_execution'],s1_1a=True)
            proof['stage']='required-images'
            images=checks.validate_required_images(browser_evidence,manifest,proof['consumer_execution'],s1_1a=True)
            proof['cases']['main1a']={'status':'passed','images':images,'normal_ui':True,
                'initial_fixture':'1a.B-fresh-before-designation-payment','fixture_sha256':proof['source_text_positive_fixtures'],
                'opponent':'explicit-fixture-driver','opponent_ui':False,'two_client':False,
                'finite_scope':'checkpoint-origin main1a UI/payment/receipts/ordinary continuation',
                'recorded_ordinary_start':False,'actual_W_recorded_replay_accepted':False,'full_1a_accepted':False}
        proof['stages']['operations'] = 'passed'
        proof['stages']['images'] = 'passed'
        proof['primary'] = {'stage':'operations-complete','code':0,'reason':'completed'}
        proof['status'] = 'passed'
    except checks.EvidenceFailure as error:
        failure = {'stage': error.stage, 'code': 1, 'reason': error.reason}
        if error.stage == 'required-images':
            proof['secondary'].append(failure)
        else:
            proof['primary'] = failure
        effective_exit = 1
        proof['status'] = 'incomplete' if proof.get('primary', {}).get('code') == 0 else 'failed'
    except StageStop:
        code = proof['primary']['code']
        effective_exit = code if type(code) is int and 1 <= code <= 255 else 1
        proof['status'] = 'incomplete' if code == 0 else 'failed'
    except Exception as error:
        proof['status'] = 'failed'
        proof['error_type'] = type(error).__name__
        failure = {'stage': proof['stage'], 'code': 1, 'reason': 'consumer-stage-failed'}
        if proof.get('primary', {}).get('code', 0) != 0:
            proof['secondary'].append(failure)
        else:
            proof['primary'] = failure
        code = proof['primary']['code']
        effective_exit = code if type(code) is int and 1 <= code <= 255 else 1
    finally:
        # Never serialize checkpoints, actor capabilities, request wire data,
        # browser profiles, session identifiers or raw transport into artifacts.
        proof['effective_exit'] = effective_exit
        try:
            (evidence / 'ci-ui-smoke-report.json').write_text(json.dumps(proof, indent=2) + '\n')
        except Exception:
            proof['secondary'].append({'stage': 'ci-ui-smoke-report', 'code': 1, 'reason': 'required-report-save-failed'})
            effective_exit = effective_exit or 1
            proof['status'] = 'incomplete' if proof.get('primary', {}).get('code') == 0 else 'failed'
            print(json.dumps({'primary': proof.get('primary'), 'secondary': proof['secondary'],
                              'status': proof['status'], 'effective_exit': effective_exit}))
    raise SystemExit(effective_exit)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'browser-tools':
        _, proof = browser_tools(Path(sys.argv[2]))
        Path(sys.argv[3]).write_text(json.dumps(proof, indent=2) + '\n')
    else:
        main()
