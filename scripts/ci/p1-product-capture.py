#!/usr/bin/env python3
"""Capture a synthetic P1 fixture on the real product /game/:id route.

Use an existing Vite/ChromeDriver session. This records observations, not PASS.
The writer's fixture-specific read-only state script must be reviewed first.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--step', required=True)
    parser.add_argument('--state-script', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'(prepayment|same-source|life19|life18|finish|child|paidplay21|restore-k[0-4]|ack-(life|finish)-(applied|rejected|unknown|inflight))', args.step):
        raise ValueError('unknown P1 observation step')
    session = os.environ['P1_WEBDRIVER_SESSION']
    if not re.fullmatch('[a-zA-Z0-9-]+', session):
        raise ValueError('invalid session')
    root = args.evidence.resolve()
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest['status'] != 'built':
        raise ValueError('new candidate runtime has not been built')
    installed = json.loads((root / 'consumer-install.json').read_text())
    if installed['consumer'] != manifest['consumer'] or installed['exit_code'] != 0:
        raise ValueError('consumer installation evidence missing')
    boot_path = Path(os.environ['P1_BROWSER_BOOT'])
    boot = json.loads(boot_path.read_text())
    source = Path(os.environ['P1_CONSUMER_SOURCE']).resolve()
    if (boot['status'] != 'fresh-product-session' or not boot['fresh_session_after_install']
            or boot['session_sha256'] != hashlib.sha256(session.encode()).hexdigest()
            or boot['consumer'] != manifest['consumer'] or boot['consumer_source'] != str(source)
            or boot['manifest_sha256'] != hashlib.sha256((root / 'manifest.json').read_bytes()).hexdigest()
            or Path('/proc/' + str(boot['vite_pid']) + '/cwd').resolve() != source):
        raise ValueError('fresh candidate browser boot proof missing')
    def check_source():
        import subprocess
        def git(*argv):
            return subprocess.check_output(['git', '-C', str(source), *argv], text=True).strip()
        if git('status', '--porcelain') or {'sha': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}')} != manifest['consumer']:
            raise ValueError('consumer source changed')
        for name, item in manifest['artifacts'].items():
            if hashlib.sha256((source / 'client/src/wasm' / name).read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('installed runtime changed')
    check_source()
    target = root / 'screenshots' / (args.step + '.png')
    state = root / 'states' / (args.step + '.json')
    if target.exists() or state.exists():
        raise ValueError('do not overwrite an observation')

    def call(endpoint, data=None):
        request = urllib.request.Request('http://127.0.0.1:9515/session/' + session + endpoint,
                                         data=json.dumps(data).encode() if data is not None else None,
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=60) as response:
            value = json.load(response)['value']
        if isinstance(value, dict) and 'error' in value:
            raise ValueError('WebDriver failed')
        return value

    route = call('/url')
    if not re.fullmatch(r'http://127\.0\.0\.1:5173/game/[^/?#]+(?:[?#].*)?', route):
        raise ValueError('capture requires the product /game/:id route')
    # Verify both installed and actually served WASM. Vite transforms glue, so
    # save its served hash separately, as V0 does, rather than claiming equality.
    served = {}
    for name in ['engine_wasm.js', 'engine_wasm_bg.wasm']:
        path = '/src/wasm/' + name
        with urllib.request.urlopen('http://127.0.0.1:5173' + path, timeout=60) as response:
            served[name] = hashlib.sha256(response.read()).hexdigest()
    if served['engine_wasm_bg.wasm'] != manifest['artifacts']['engine_wasm_bg.wasm']['sha256']:
        raise ValueError('served runtime does not match the new candidate')
    script = args.state_script.read_text()
    observation = call('/execute/sync', {'script': script, 'args': []})
    pixels = base64.b64decode(call('/screenshot'), validate=True)
    if not pixels.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('invalid screenshot')
    check_source()
    target.parent.mkdir(parents=True, exist_ok=True)
    state.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(pixels)
    state.write_text(json.dumps(observation, ensure_ascii=False, indent=2) + '\n')
    index = root / 'step-index.json'
    steps = json.loads(index.read_text()) if index.exists() else []
    steps.append({'step': args.step, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'route': route, 'runtime': manifest['runtime'], 'consumer': manifest['consumer'],
                  'validation': manifest['validation'], 'served': served,
                  'state_script_sha256': hashlib.sha256(script.encode()).hexdigest(),
                  'screenshot': {'path': str(target.relative_to(root)), 'sha256': hashlib.sha256(pixels).hexdigest()},
                  'state': {'path': str(state.relative_to(root)), 'sha256': hashlib.sha256(state.read_bytes()).hexdigest()},
                  'status': 'observation-only', 'exit_code': 0})
    index.write_text(json.dumps(steps, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Raw W3C replies/session identifiers are never logged (V0). Keep the
        # original failure class and nonzero exit, not transport/application text.
        import sys
        failure = {'status': 'capture-failed', 'error': type(error).__name__, 'exit_code': 1}
        try:
            failed_root = Path(sys.argv[sys.argv.index('--evidence') + 1]).resolve()
            failed_step = sys.argv[sys.argv.index('--step') + 1]
            if re.fullmatch('[a-z0-9-]+', failed_step) and failed_root.is_dir():
                failure['step'] = failed_step
                failure_path = failed_root / ('capture-failure-' + failed_step + '.json')
                with failure_path.open('x') as output:
                    output.write(json.dumps(failure) + '\n')
        except (ValueError, IndexError, OSError):
            pass
        print(json.dumps(failure))
        raise SystemExit(1)
