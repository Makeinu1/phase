#!/usr/bin/env python3
"""Run a reviewed P1 fixture-specific consumer with fresh Vite/ChromeDriver.

The scenario belongs to validation scripts, and is supplied after the writer's
fixture contract arrives. Browser/driver transport logs remain unrecorded (V0).
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import urllib.parse


def identity(source):
    def git(*argv):
        return subprocess.check_output(['git', '-C', str(source), *argv], text=True).strip()
    if git('status', '--porcelain'):
        raise ValueError('consumer source must be clean')
    return {'sha': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}')}


def capture_failure(root, source, manifest, proof, session, call):
    """Keep a labelled live-browser diagnostic, never an acceptance snapshot."""
    diagnostic = {'kind': 'failure-diagnostic; not acceptance', 'consumer': manifest['consumer'],
                  'browser_status': proof['status'], 'scenario_exit_code': proof['exit_code'],
                  'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    endpoint = '/session/' + session
    try:
        diagnostic['source'] = identity(source)
        if diagnostic['source'] != manifest['consumer']:
            raise ValueError('diagnostic consumer mismatch')
        executable = {name: item for name, item in manifest['artifacts'].items()
                      if name.endswith(('.js', '.wasm'))}
        for name, item in executable.items():
            if hashlib.sha256((source / 'client/src/wasm' / name).read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('diagnostic runtime mismatch')
        diagnostic['installed_runtime'] = executable
        pixels = base64.b64decode(call(endpoint + '/screenshot'), validate=True)
        if not pixels.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('invalid diagnostic screenshot')
        target = root / 'screenshots/diagnostic-failure.png'
        if target.exists():
            raise ValueError('do not overwrite a diagnostic')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(pixels)
        diagnostic['screenshot'] = {'path': 'screenshots/diagnostic-failure.png',
                                    'sha256': hashlib.sha256(pixels).hexdigest()}
    except Exception as error:
        diagnostic['screenshot_error_type'] = type(error).__name__
    try:
        diagnostic['public_observation'] = call(endpoint + '/execute/sync', {'script': """
const known = ['/p1-integration-fixtures/trusted-game-states.json', '/card-data.json',
 '/src/wasm/engine_wasm.js', '/src/wasm/engine_wasm_bg.wasm',
 '/src/wasm/draft_wasm.js', '/src/adapter/draft-adapter.ts'];
let state = null, observerError = null;
try { if (typeof window.__p1Observe === 'function') state = window.__p1Observe(); }
catch (e) { observerError = e?.name ?? 'Error'; }
return {url: location.href.split(/[?#]/, 1)[0], state, observerError,
 visibleText: (document.body?.innerText ?? '').slice(0, 8000),
 viteError: (document.querySelector('vite-error-overlay')?.shadowRoot
   ?.querySelector('.message')?.textContent ?? '').slice(0, 2000),
 resources: performance.getEntriesByType('resource').map(e => ({path: new URL(e.name).pathname,
   status: e.responseStatus ?? null, initiator: e.initiatorType})).filter(e => known.includes(e.path))};
""", 'args': []})
    except Exception as error:
        diagnostic['observation_error_type'] = type(error).__name__
    try:
        # Inspect in memory, retain only categories; never persist raw console,
        # request bodies, session IDs, checkpoints or continuation capabilities.
        entries = call(endpoint + '/se/log', {'type': 'browser'})
        categories = []
        for entry in entries:
            message = entry.get('message', '')
            category = ('missing-draft-import' if 'Failed to resolve import' in message and '@wasm/draft' in message
                        else 'module-fetch-failed' if 'Failed to fetch dynamically imported module' in message
                        else 'resource-load-failed' if 'Failed to load resource' in message
                        else 'console-message')
            categories.append({'level': entry.get('level'), 'category': category})
        diagnostic['console_categories'] = categories[:100]
    except Exception as error:
        diagnostic['console_error_type'] = type(error).__name__
    (root / 'browser-failure.json').write_text(json.dumps(diagnostic, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--entry-route', required=True)
    parser.add_argument('--scenario', type=Path, required=True)
    args = parser.parse_args()
    root, source = args.evidence.resolve(), args.source.resolve()
    scenario = args.scenario.resolve()
    validation = Path(__file__).resolve().parents[2]
    if not scenario.is_relative_to(validation / 'scripts') or not scenario.is_file():
        raise ValueError('reviewed validation scenario required')
    entry = urllib.parse.urlsplit(args.entry_route)
    if (entry.scheme or entry.netloc or not entry.path.startswith('/') or entry.path.startswith('//')
            or '\\' in args.entry_route or entry.path.endswith('.html')):
        raise ValueError('existing product application entrance required')
    manifest_bytes = (root / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    installed = json.loads((root / 'consumer-install.json').read_text())
    if manifest['status'] != 'built' or identity(source) != manifest['consumer'] or installed['consumer'] != manifest['consumer']:
        raise ValueError('install the new candidate runtime first')
    runtime_artifacts = {name: item for name, item in manifest['artifacts'].items()
                         if name.endswith(('.js', '.wasm'))}
    if installed.get('installed_artifacts') != runtime_artifacts:
        raise ValueError('incomplete executable runtime installation')
    for name, item in runtime_artifacts.items():
        if hashlib.sha256((source / 'client/src/wasm' / name).read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('installed runtime mismatch')
    proof_path = root / 'browser-boot.json'
    if proof_path.exists():
        raise ValueError('fresh browser attempt needs fresh consumer evidence')
    proof = {'consumer': manifest['consumer'], 'consumer_source': str(source),
             'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
             'scenario_sha256': hashlib.sha256(scenario.read_bytes()).hexdigest(),
             'navigation_url': 'http://127.0.0.1:5173' + args.entry_route,
             'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'fresh_session_after_install': True, 'exit_code': None, 'status': 'starting'}
    processes, session = [], None

    def call(endpoint, data=None):
        request = urllib.request.Request('http://127.0.0.1:9515' + endpoint,
            data=json.dumps(data).encode() if data is not None else None,
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=65) as response:
            value = json.load(response)['value']
        if isinstance(value, dict) and 'error' in value:
            raise ValueError('WebDriver failed')
        return value

    try:
        for command in [['pnpm', '--dir', 'client', 'dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
                        [os.environ['BOOTSTRAP_CHROMEDRIVER'], '--port=9515', '--log-path=/dev/null']]:
            process = subprocess.Popen(command, cwd=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True, env=dict(os.environ, TELEMETRY_URL='', CHROME_LOG_FILE='/dev/null'))
            processes.append(process)
        proof['vite_pid'] = processes[0].pid
        proof['chromedriver_pid'] = processes[1].pid
        time.sleep(5)  # V0's one bounded startup interval; no retries.
        if any(process.poll() is not None for process in processes):
            raise ValueError('Vite or driver failed to start; ports must be unused')
        if not call('/status')['ready']:
            raise ValueError('driver not ready')
        created = call('/session', {'capabilities': {'alwaysMatch': {'browserName': 'chrome',
            'goog:chromeOptions': {'binary': os.environ['P1_CHROME_BINARY'], 'args':
                ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-logging', '--log-level=3']},
            'goog:loggingPrefs': {'browser': 'ALL', 'performance': 'OFF'}}}})
        session = created['sessionId']
        proof['session_sha256'] = hashlib.sha256(session.encode()).hexdigest()
        call('/session/' + session + '/timeouts', {'script': 130000, 'pageLoad': 60000, 'implicit': 0})
        call('/session/' + session + '/window/rect', {'width': 1440, 'height': 1000})
        call('/session/' + session + '/url', {'url': proof['navigation_url']})
        proof['navigation_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        proof['status'] = 'fresh-product-session'
        proof_path.write_text(json.dumps(proof, indent=2) + '\n')
        environment = dict(os.environ, P1_WEBDRIVER_SESSION=session, P1_BROWSER_BOOT=str(proof_path),
                           P1_CONSUMER_SOURCE=str(source), MANUAL_EVIDENCE=str(root))
        with (root / 'product-scenario.log').open('wb') as log:
            result = subprocess.run(['python3', str(scenario)], cwd=source, env=environment,
                                    stdout=log, stderr=subprocess.STDOUT, timeout=1200)
        proof['exit_code'] = result.returncode
        proof['source_after'] = identity(source)
        if proof['source_after'] != manifest['consumer']:
            raise ValueError('consumer changed during scenario')
        proof['status'] = 'scenario-exited'
        raise SystemExit(result.returncode)
    except Exception as error:
        proof['status'] = 'failed'
        proof['error'] = type(error).__name__
        proof['exit_code'] = 1
        raise
    finally:
        if session:
            if proof['exit_code'] != 0:
                try:
                    capture_failure(root, source, manifest, proof, session, call)
                except Exception as error:
                    proof['diagnostic_error_type'] = type(error).__name__
            try:
                request = urllib.request.Request('http://127.0.0.1:9515/session/' + session, method='DELETE')
                urllib.request.urlopen(request, timeout=10).close()
            except Exception:
                pass
        import signal
        for process in processes:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        proof_path.write_text(json.dumps(proof, indent=2) + '\n')


if __name__ == '__main__':
    main()
