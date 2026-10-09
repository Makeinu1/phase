"""Consume this job's newly built immutable runtime on the normal Local board."""
import argparse
import hashlib
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
        raise ValueError('build this exact candidate in this job first')
    environment = dict(os.environ, MANUAL_EXPECTED_SOURCE_SHA=args.candidate_sha,
        MANUAL_EVIDENCE=str(evidence), CARGO_BUILD_JOBS='1', CARGO_INCREMENTAL='0',
        CARGO_TARGET_DIR=str(evidence / 'target'), RUNNER_TEMP=os.environ.get('RUNNER_TEMP', '/tmp'))
    proof = {'scope': 'one Local UI smoke; not S1-S12 or Undo acceptance',
             'consumer': manifest['consumer'], 'stage': 'starting', 'status': 'running'}

    def guarded(label, command, extra=None):
        proof['stage'] = label
        result = subprocess.run(['python3', str(VALIDATION / 'scripts/ci/manual-integration-guard.py'),
            label, *command], cwd=source, env=dict(environment, **(extra or {})),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (evidence / (label + '.control.log')).write_bytes(result.stdout)
        if result.returncode:
            raise RuntimeError('guarded stage failed: ' + label)

    try:
        fixtures = evidence / 'private-fixtures'
        guarded('p1-native-fixtures', ['cargo', 'test', '--locked', '-p', 'phase-engine',
            '--features', 'manual_resolution_prototype', '--test', 'manual_resolution_prototype',
            'p1_native_journey::paid_manual_begin_life_finish_next_and_checked_checkpoints',
            '--', '--exact'], {'P1_FIXTURE_OUTPUT_DIR': str(fixtures)})
        bundle = json.loads((fixtures / 'trusted-game-states.json').read_text())
        if bundle['version'] != 1 or '1c.K1' not in bundle['cases'] or len(bundle['cases']) != 145:
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
        proof['stage'] = 'product-browser'
        guarded('p1-ui-smoke', ['python3', str(VALIDATION / 'scripts/ci/p1-product-browser.py'),
            '--source', str(source), '--evidence', str(evidence),
            '--entry-route', '/game/p1-ci-smoke?mode=local&manual=1&p1Fixture=1c.K1',
            '--scenario', str(VALIDATION / 'scripts/ci/p1-ui-smoke.py')],
            {key: str(value) for key, value in tools.items()})
        proof['status'] = 'passed'
    except Exception as error:
        proof['status'] = 'failed'
        proof['error_type'] = type(error).__name__
        raise
    finally:
        # Never serialize checkpoints, actor capabilities, request wire data,
        # browser profiles, session identifiers or raw transport into artifacts.
        (evidence / 'ci-ui-smoke-report.json').write_text(json.dumps(proof, indent=2) + '\n')


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'browser-tools':
        _, proof = browser_tools(Path(sys.argv[2]))
        Path(sys.argv[3]).write_text(json.dumps(proof, indent=2) + '\n')
    else:
        main()
