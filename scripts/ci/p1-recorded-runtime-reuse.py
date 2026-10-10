#!/usr/bin/env python3
"""Reuse one reviewed producer artifact through GitHub's normal Actions API.

Existing GITHUB_TOKEN permissions only; one attempt, no alternate transport or
build fallback. Signed redirect URLs and credentials are never recorded.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.request
import zipfile

REPOSITORY = 'Makeinu1/phase'
RUN = 38028695073
HEAD = '8569fa2faf97e70a6b036d50d5cefcb2b6238892'
TREE = 'c9373de8f1114358532a37395d90b22a5b7ae734'
ARTIFACT = 11662043855
DIGEST = 'f972c4bc551810deaa60f66eb546152efadbab03c3c44cdf35bd6226acef4f3b'
SIZE = 37333442
PRODUCT = {'sha': '407989dad140e2fe08d4924529194273605737e7',
           'tree': '61d62030adbf24b76b9f5783fc7b1bc39fe1471b'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    source, evidence = args.source.resolve(), args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    receipt = {'kind': 'normal-actions-producer-reuse', 'status': 'starting',
               'producer_run': RUN, 'producer_head': HEAD, 'artifact_id': ARTIFACT,
               'zip_sha256': DIGEST, 'product': PRODUCT, 'attempts': 1,
               'new_permissions': False, 'build_fallback': False}
    def git(*argv):
        return subprocess.check_output(['git', '-C', str(source), *argv], text=True).strip()
    def request(path):
        req = urllib.request.Request('https://api.github.com/repos/' + REPOSITORY + path,
            headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'],
                     'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
        return urllib.request.urlopen(req, timeout=90)
    def metadata(path):
        with request(path) as response:
            return json.load(response)
    try:
        if (git('status', '--porcelain') or git('rev-parse', 'HEAD') != PRODUCT['sha']
                or git('rev-parse', 'HEAD^{tree}') != PRODUCT['tree']):
            raise ValueError('immutable consumer identity mismatch')
        if (evidence / 'manifest.json').exists():
            raise ValueError('fresh evidence directory required')
        receipt['stage'] = 'producer-metadata'
        run = metadata('/actions/runs/' + str(RUN))
        artifact = metadata('/actions/artifacts/' + str(ARTIFACT))
        if (run['head_sha'] != HEAD or run['run_attempt'] != 1 or run['status'] != 'completed'
                or run['event'] != 'push' or run['head_branch'] != 'experiment/manual-p1-validation-20261008'
                or run['path'] != '.github/workflows/p1-wasm-validation.yml'
                or artifact['name'] != 'p1-candidate-runtime-evidence' or artifact['expired']
                or artifact['size_in_bytes'] != SIZE or artifact.get('digest') != 'sha256:' + DIGEST
                or artifact['workflow_run']['id'] != RUN or artifact['workflow_run']['head_sha'] != HEAD):
            raise ValueError('producer artifact metadata mismatch')
        receipt['stage'] = 'normal-actions-download'
        # Follow only the official endpoint's redirect supplied by GitHub.
        # urllib strips Authorization across redirects to other hosts below.
        class SafeRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
                if redirected is not None:
                    redirected.remove_header('Authorization')
                return redirected
        req = urllib.request.Request('https://api.github.com/repos/' + REPOSITORY
            + '/actions/artifacts/' + str(ARTIFACT) + '/zip',
            headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'],
                     'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
        with urllib.request.build_opener(SafeRedirect()).open(req, timeout=90) as response:
            archive = response.read(SIZE + 1)
        if len(archive) != SIZE or hashlib.sha256(archive).hexdigest() != DIGEST:
            raise ValueError('producer ZIP size or digest mismatch')
        receipt['stage'] = 'verify-producer-runtime'
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            names = bundle.namelist()
            if len(names) != len(set(names)):
                raise ValueError('duplicate ZIP paths')
            manifest = json.loads(bundle.read('manifest.json'))
            validation = Path(__file__).resolve().parents[2]
            if (manifest['status'] != 'built' or manifest['schema_version'] != 1
                    or manifest['runtime'] != PRODUCT or manifest['consumer'] != PRODUCT
                    or manifest['validation'] != {'sha': HEAD, 'tree': TREE}
                    or manifest['guard_sha256'] != hashlib.sha256((validation / 'scripts/ci/manual-integration-guard.py').read_bytes()).hexdigest()
                    or manifest['runner_sha256'] != hashlib.sha256((validation / 'scripts/ci/p1-wasm-validation.py').read_bytes()).hexdigest()):
                raise ValueError('producer manifest provenance mismatch')
            expected_build = ['cargo', 'build', '--locked', '-p', 'engine-wasm', '--target',
                'wasm32-unknown-unknown', '--profile', 'wasm-dev', '--no-default-features',
                '--features', 'manual_resolution_local_bootstrap', '--message-format=json']
            expected_draft = ['cargo', 'build', '--locked', '-p', 'draft-wasm', '--target',
                'wasm32-unknown-unknown', '--profile', 'wasm-dev', '--features',
                'phase-ai/manual_resolution_prototype', '--message-format=json']
            if (manifest['build'] != expected_build or manifest['draft_build'] != expected_draft
                    or manifest['environment']['CARGO_BUILD_JOBS'] != '1'
                    or manifest['environment']['CARGO_INCREMENTAL'] != '0'
                    or manifest['tools']['wasm-bindgen'] != 'wasm-bindgen 0.2.121'):
                raise ValueError('producer build configuration mismatch')
            for tool in ['rustc', 'cargo', 'pnpm']:
                if manifest['tools'][tool] != subprocess.check_output([tool, '--version'], text=True).strip():
                    raise ValueError('producer toolchain mismatch: ' + tool)
            inputs = ['Cargo.lock', 'Cargo.toml', '.cargo/config.toml', 'rust-toolchain.toml', 'client/pnpm-lock.yaml']
            if manifest['inputs'] != {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in inputs}:
                raise ValueError('producer input hash mismatch')
            required = {prefix + suffix for prefix in ['engine_wasm', 'draft_wasm']
                        for suffix in ['.js', '_bg.wasm', '.d.ts', '_bg.wasm.d.ts']}
            if not required <= manifest['artifacts'].keys():
                raise ValueError('incomplete producer runtime')
            files = {}
            for name, item in manifest['artifacts'].items():
                if (Path(name).is_absolute() or '..' in Path(name).parts
                        or not name.endswith(('.js', '.wasm', '.d.ts'))):
                    raise ValueError('unexpected runtime path')
                data = bundle.read('runtime/' + name)
                if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                    raise ValueError('runtime artifact hash mismatch')
                files[name] = data
            for name, data in files.items():
                destination = evidence / 'runtime' / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            (evidence / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        receipt['status'] = 'verified'
        receipt['runtime_artifact_count'] = len(files)
    except urllib.error.HTTPError as error:
        receipt.update(status='blocked', http_status=error.code, error_type='HTTPError')
        raise SystemExit('Normal Actions reuse blocked at ' + receipt['stage'] + ': HTTP ' + str(error.code)) from None
    except Exception as error:
        receipt.update(status='failed', error_type=type(error).__name__)
        raise SystemExit('Normal Actions reuse failed at ' + receipt.get('stage', 'preflight')
                         + ': ' + type(error).__name__) from None
    finally:
        try:
            (evidence / 'runtime-reuse.json').write_text(json.dumps(receipt, indent=2) + '\n')
        except Exception:
            verified = receipt['status'] == 'verified'
            # Preserve any pending primary SystemExit (including HTTP status).
            # The fixed fallback contains no exception text or signed URL.
            fallback = {'primary': dict(receipt), 'status': 'incomplete' if verified else receipt['status'],
                        'secondary': [{'stage': 'runtime-reuse-receipt', 'code': 1,
                                       'reason': 'required-receipt-save-failed'}], 'effective_exit': 1}
            try:
                print(json.dumps(fallback))
            except Exception:
                pass
            if verified:
                raise SystemExit('Normal Actions reuse incomplete: required receipt save failed') from None


if __name__ == '__main__':
    main()
