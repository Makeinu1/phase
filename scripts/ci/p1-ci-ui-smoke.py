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
        result = subprocess.run(['python3', str(VALIDATION / 'scripts/ci/manual-integration-guard.py'),
            label, *command], cwd=source, env=dict(environment, **(extra or {})),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        proof['primary'] = {'stage': label, 'code': result.returncode,
            'reason': 'completed' if result.returncode == 0 else 'guarded-command-failed'}
        browser_report_failed = False
        if label == 'p1-ui-smoke':
            try:
                browser, saved = results.load_result(browser_evidence / 'browser-boot.json', evidence / 'p1-ui-smoke.log')
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
                           'process-cleanup-failed', 'required-report-save-failed', 'required-capture-failed', 'receipt-observer-cleanup-failed'}
                for item in browser.get('secondary', []):
                    if (isinstance(item, dict) and item.get('reason') in allowed
                            and item.get('stage') in {'diagnostic-collector', 'scenario-report', 'browser-cleanup',
                                'process-cleanup', 'browser-boot-report', 'capture-control-completed', 'capture-finish', 'capture-paidplay21', 'receipt-observer-cleanup', 'ui-smoke-report'} and type(item.get('code')) is int):
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
        fixtures = evidence / 'private-fixtures'
        guarded('p1-native-fixtures', ['cargo', 'test', '--locked', '-p', 'phase-engine',
            '--features', 'manual_resolution_prototype', '--test', 'manual_resolution_prototype',
            'p1_native_journey::paid_manual_begin_life_finish_next_and_checked_checkpoints',
            '--', '--exact'], {'P1_FIXTURE_OUTPUT_DIR': str(fixtures)})
        bundle = json.loads((fixtures / 'trusted-game-states.json').read_text())
        if bundle['version'] != 1 or '1c.B' not in bundle['cases'] or len(bundle['cases']) != 145:
            raise ValueError('finite fixture generation did not produce the reviewed bundle')
        proof['fixtures'] = {name: hashlib.sha256((fixtures / name).read_bytes()).hexdigest()
            for name in ['card-data.json', 'trusted-game-states.json']}
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
        shutil.copyfile(fixtures / 'trusted-game-states.json',
            public / 'p1-integration-fixtures/trusted-game-states.json')
        shutil.copyfile(fixtures / 'card-data.json', public / 'card-data.json')
        proof['stage'] = 'install-runtime'
        subprocess.run(['python3', str(VALIDATION / 'scripts/ci/p1-wasm-validation.py'),
            'install-runtime', '--source', str(source), '--candidate-sha', args.candidate_sha,
            '--evidence', str(evidence)], env=environment, check=True)
        guarded('p1-client-dependencies', ['pnpm', '--dir', 'client', 'install', '--frozen-lockfile'])
        guarded('p1-browser-tools', ['python3', str(Path(__file__).resolve()), 'browser-tools',
            str(Path(environment['RUNNER_TEMP']) / 'p1-browser-tools'), str(evidence / 'browser-tools.json')])
        browser_proof = json.loads((evidence / 'browser-tools.json').read_text())
        tools = {key: browser_proof[key]['path'] for key in ['P1_CHROME_BINARY', 'BOOTSTRAP_CHROMEDRIVER']}
        for case in ['auto-s','auto-n']:
            proof['case'] = case
            browser_evidence = evidence / 'controls' / case
            browser_evidence.mkdir(parents=True)
            for name in ['manifest.json','consumer-install.json']:
                shutil.copyfile(evidence/name,browser_evidence/name)
            proof['stage'] = 'product-browser'
            guarded('p1-ui-smoke', ['python3', str(VALIDATION / 'scripts/ci/p1-product-browser.py'),
                '--source', str(source), '--evidence', str(browser_evidence),
                '--entry-route', '/game/p1-'+case+'?mode=local&manual=1&p1Fixture=1a.B',
                '--scenario', str(VALIDATION / 'scripts/ci/p1-ui-smoke.py')],
                dict({key: str(value) for key, value in tools.items()}, P1_UI_CASE=case))
            # Keep both guarded consumer attempts; the root guard filenames are
            # reused by the existing guard and must not erase the first case.
            for name in ['p1-ui-smoke.json','p1-ui-smoke.jsonl','p1-ui-smoke.log']:
                if (evidence/name).is_file():
                    shutil.copyfile(evidence/name,browser_evidence/name)
            proof['stages']['application'] = 'passed'
            proof['stage'] = 'operation-assertions'
            try:
                report = json.loads((browser_evidence / 'ui-smoke-report.json').read_text())
            except (OSError, ValueError):
                raise checks.EvidenceFailure('operation-assertions', 'required-operation-report-unreadable')
            checks.validate_operations(report, manifest['consumer'], proof['consumer_execution'], control=case)
            proof['cases'][case] = {'status':'operations-complete','operations':'passed','images':'not_run'}
            proof['primary'] = {'stage':'operations-complete','code':0,'reason':'completed'}
            proof['stage'] = 'required-images'
            images = checks.validate_required_images(browser_evidence, manifest, proof['consumer_execution'], control=case)
            proof['cases'][case] = {'status':'passed','images':images,'normal_ui':True,
                'initial_fixture':'1a.B-fresh-before-designation-payment','opponent':'explicit-fixture-driver','opponent_ui':False,'two_client':False}
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
