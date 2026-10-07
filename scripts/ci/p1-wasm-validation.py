#!/usr/bin/env python3
"""Build one immutable P1 candidate using the V0 resource/source guard.

Outputs live outside both checkouts. Preflight never builds product Rust.
The same manifest is checked before consumer installation; no old WASM fallback.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def identity(root):
    if git(root, 'status', '--porcelain'):
        raise ValueError('source checkout must be clean')
    return {'sha': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['preflight', 'build', 'install-runtime'])
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--candidate-sha', required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}', args.candidate_sha):
        raise ValueError('full candidate SHA required')
    source, evidence = args.source.resolve(), args.evidence.resolve()
    validation = Path(__file__).resolve().parents[2]
    if source == validation or evidence.is_relative_to(source) or evidence.is_relative_to(validation):
        raise ValueError('use separate product, validation and evidence directories')
    product = identity(source)
    if product['sha'] != args.candidate_sha:
        raise ValueError('candidate SHA mismatch')
    guard = validation / 'scripts/ci/manual-integration-guard.py'
    environment = dict(os.environ, MANUAL_EXPECTED_SOURCE_SHA=args.candidate_sha,
                       MANUAL_EVIDENCE=str(evidence), RUNNER_TEMP=os.environ.get('RUNNER_TEMP', '/tmp'),
                       CARGO_TARGET_DIR=str(evidence / 'target'), CARGO_BUILD_JOBS='1', CARGO_INCREMENTAL='0')
    if subprocess.run(['bash', '-c', 'command -v tilt >/dev/null && tilt get uiresource clippy >/dev/null 2>&1'],
                      cwd=source).returncode == 0:
        raise ValueError('Tilt is active; do not start a competing build')
    evidence.mkdir(parents=True, exist_ok=True)

    def guarded(label, command):
        result = subprocess.run(['python3', str(guard), label, *command], cwd=source, env=environment,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (evidence / (label + '.control.log')).write_bytes(result.stdout)
        if result.returncode:
            raise SystemExit(result.returncode)

    if args.mode == 'install-runtime':
        manifest = json.loads((evidence / 'manifest.json').read_text())
        if manifest['status'] != 'built' or manifest['runtime'] != product or manifest['consumer'] != product:
            raise ValueError('runtime provenance does not match this consumer')
        for name, value in manifest['artifacts'].items():
            path = evidence / 'runtime' / name
            if sha(path) != value['sha256'] or path.stat().st_size != value['size']:
                raise ValueError('runtime content mismatch: ' + name)
        destination = source / 'client/src/wasm'
        destination.mkdir(parents=True, exist_ok=True)
        for name in manifest['artifacts']:
            if not name.endswith(('.js', '.wasm', '.ts')) or '..' in Path(name).parts:
                raise ValueError('unexpected runtime path')
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(evidence / 'runtime' / name, path)
        if identity(source) != product:
            raise ValueError('consumer tracked source changed during runtime installation')
        (evidence / 'consumer-install.json').write_text(json.dumps({'consumer': product, 'exit_code': 0}) + '\n')
        return

    manifest_path = evidence / 'manifest.json'
    if manifest_path.exists():
        raise ValueError('use a fresh evidence directory; never overwrite a recorded attempt')
    manifest = {'schema_version': 1, 'status': 'preflight', 'runtime': product, 'consumer': product,
                'validation': identity(validation), 'guard_sha256': sha(guard),
                'runner_sha256': sha(Path(__file__).resolve()),
                'inputs': {name: sha(source / name) for name in
                           ['Cargo.lock', 'Cargo.toml', '.cargo/config.toml', 'rust-toolchain.toml', 'client/pnpm-lock.yaml']},
                'build': ['cargo', 'build', '--locked', '-p', 'engine-wasm', '--target', 'wasm32-unknown-unknown',
                          '--profile', 'wasm-dev', '--no-default-features', '--features',
                          'manual_resolution_local_bootstrap', '--message-format=json'],
                'environment': {key: environment.get(key) for key in
                                ['CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS', 'CARGO_INCREMENTAL', 'RUNNER_TEMP']},
                'tools': {}, 'artifacts': {}}
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    try:
        guarded('p1-source-preflight', ['cargo', 'metadata', '--locked', '--no-deps', '--format-version', '1'])
        for tool in ['rustc', 'cargo', 'pnpm'] + (['wasm-bindgen'] if args.mode == 'build' else []):
            manifest['tools'][tool] = subprocess.check_output([tool, '--version'], cwd=source, env=environment, text=True).strip()
        if args.mode == 'preflight':
            manifest['status'] = 'preflight-pass'
            return
        if manifest['tools']['wasm-bindgen'] != 'wasm-bindgen 0.2.121':
            raise ValueError('wasm-bindgen must match Cargo.lock: 0.2.121')
        guarded('candidate-wasm-enabled-build', manifest['build'])
        raw = evidence / 'target/wasm32-unknown-unknown/wasm-dev/engine_wasm.wasm'
        manifest['raw_wasm'] = {'sha256': sha(raw), 'size': raw.stat().st_size}
        guarded('candidate-wasm-enabled-bindgen', ['wasm-bindgen', '--target', 'web', '--out-name', 'engine_wasm',
                '--out-dir', str(evidence / 'runtime'), str(raw)])
        manifest['artifacts'] = {str(path.relative_to(evidence / 'runtime')):
                                 {'sha256': sha(path), 'size': path.stat().st_size}
                                 for path in sorted((evidence / 'runtime').rglob('*')) if path.is_file()}
        if not {'engine_wasm.js', 'engine_wasm_bg.wasm', 'engine_wasm.d.ts', 'engine_wasm_bg.wasm.d.ts'} <= manifest['artifacts'].keys():
            raise ValueError('incomplete bindgen output')
        if identity(source) != product:
            raise ValueError('candidate changed during build')
        manifest['status'] = 'built'
    except BaseException:
        manifest['status'] = 'failed'
        raise
    finally:
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
