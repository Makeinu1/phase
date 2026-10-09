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
import struct
import zlib
import urllib.request


class EvidenceFailure(ValueError):
    def __init__(self, stage, reason):
        self.stage, self.reason = stage, reason
        super().__init__(reason)


def validate_operations(report, consumer, execution):
    """Require explicit operation completion; image receipts are observations."""
    def reject(reason):
        raise EvidenceFailure('operation-assertions', reason)
    if not isinstance(report, dict) or report.get('status') != 'passed':
        reject('operation-report-not-passed')
    if report.get('consumer') != consumer or report.get('consumer_execution') != execution:
        reject('operation-report-provenance-mismatch')
    primary = report.get('primary')
    if (not isinstance(primary, dict) or type(primary.get('code')) is not int
            or primary['code'] != 0 or primary.get('reason') != 'completed'
            or primary.get('stage') != 'operations-complete' or report.get('secondary') != []):
        reject('operation-primary-not-success')
    stages = report.get('stages')
    if not isinstance(stages, dict):
        reject('required-operation-stages-missing')
    for stage in ['initial', 'life19', 'finish']:
        item = stages.get(stage)
        if not isinstance(item, dict):
            reject('required-operation-stage-missing:' + stage)
        if item.get('status') != 'passed' or item.get('assertions_completed') is not True:
            reject('required-operation-stage-incomplete:' + stage)


def valid_png(data):
    """Check saved PNG chunks/CRC and compressed pixels with the stdlib."""
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return False
    offset, chunks, compressed = 8, [], bytearray()
    while offset + 12 <= len(data):
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        end = offset + 12 + length
        if end > len(data):
            return False
        kind, content = data[offset + 4:offset + 8], data[offset + 8:end - 4]
        if zlib.crc32(kind + content) != struct.unpack('>I', data[end - 4:end])[0]:
            return False
        if not chunks and (kind != b'IHDR' or length != 13
                or not all(struct.unpack('>II', content[:8]))):
            return False
        if kind == b'IHDR':
            if chunks:
                return False
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', content)
            # Chromium screenshots use non-interlaced RGB/RGBA, eight bits.
            if depth != 8 or color not in {2, 6} or (compression, filtering, interlace) != (0, 0, 0):
                return False
            row_bytes = 1 + width * (3 if color == 2 else 4)
            pixel_bytes = row_bytes * height
            if pixel_bytes > 32 * 1024 * 1024:
                return False
        chunks.append(kind)
        if kind == b'IDAT':
            compressed.extend(content)
        offset = end
        if kind == b'IEND':
            if length != 0 or offset != len(data) or not compressed:
                return False
            try:
                decoder = zlib.decompressobj()
                pixels = decoder.decompress(compressed, pixel_bytes + 1)
                return (len(pixels) == pixel_bytes and decoder.eof and not decoder.unused_data
                        and all(pixels[row * row_bytes] <= 4 for row in range(height)))
            except zlib.error:
                return False
    return False


def finish_matches(initial, ended):
    """Begin already popped this occurrence; Finish releases its carrier.

    Ordinary stack entries, whether zero or nonzero, are not the resolving
    entry. Require its exact public identity to disappear without popping them.
    """
    entry = initial.get('manualStackEntryId')
    count = initial.get('stackCount')
    return (initial.get('manualPhase') == 'open' and type(entry) is int
            and initial.get('resolvingEntryId') == entry
            and type(count) is int and count >= 0
            and ended.get('manualPhase') == 'closed' and ended.get('waitingType') == 'Priority'
            and ended.get('life', [])[:1] == [19]
            and ended.get('sourceId') == initial.get('sourceId')
            and ended.get('manualStackEntryId') == entry
            and 'resolvingEntryId' in ended and ended['resolvingEntryId'] is None
            and type(ended.get('stackCount')) is int and ended['stackCount'] == count)


def validate_required_images(root, manifest, execution):
    """Recheck the three existing capture receipts and saved public bytes."""
    def reject(reason):
        raise EvidenceFailure('required-images', reason)
    try:
        steps = json.loads((root / 'step-index.json').read_text())
    except (OSError, ValueError):
        reject('required-image-index-unreadable')
    if not isinstance(steps, list) or any(not isinstance(item, dict) for item in steps):
        reject('required-image-index-invalid')
    observations = {}
    for step in ['same-source', 'life19', 'finish']:
        matches = [item for item in steps if item.get('step') == step]
        if len(matches) != 1:
            reject('required-image-count:' + step)
        item = matches[0]
        if (item.get('status') != 'observation-only' or type(item.get('exit_code')) is not int
                or item['exit_code'] != 0):
            reject('required-image-receipt-invalid:' + step)
        if (item.get('runtime') != manifest['runtime'] or item.get('consumer') != manifest['consumer']
                or item.get('validation') != manifest['validation']
                or item.get('consumer_execution') != execution
                or not isinstance(item.get('served'), dict)
                or item['served'].get('engine_wasm_bg.wasm')
                    != manifest['artifacts']['engine_wasm_bg.wasm']['sha256']):
            reject('required-image-provenance-mismatch:' + step)
        for kind, relative in [('screenshot', 'screenshots/' + step + '.png'),
                               ('state', 'states/' + step + '.json')]:
            receipt = item.get(kind)
            if not isinstance(receipt, dict) or receipt.get('path') != relative:
                reject('required-' + kind + '-receipt-invalid:' + step)
            try:
                data = (root / relative).read_bytes()
            except OSError:
                reject('required-' + kind + '-missing:' + step)
            if not data:
                reject('required-' + kind + '-empty:' + step)
            if hashlib.sha256(data).hexdigest() != receipt.get('sha256'):
                reject('required-' + kind + '-hash-mismatch:' + step)
            if kind == 'screenshot' and not valid_png(data):
                reject('required-screenshot-invalid-png:' + step)
            if kind == 'state':
                try:
                    state = json.loads(data)
                except ValueError:
                    reject('required-state-invalid:' + step)
                if (not isinstance(state, dict) or not isinstance(state.get('life'), list)
                        or len(state['life']) != 2 or any(type(life) is not int for life in state['life'])
                        or type(state.get('stackCount')) is not int or state['stackCount'] < 0
                        or any(key not in state or (state[key] is not None and type(state[key]) is not int)
                               for key in ['manualStackEntryId', 'resolvingEntryId'])
                        or (state.get('manualPhase') is not None and not isinstance(state['manualPhase'], str))
                        or state.get('manualPhase') not in {'open', 'closed', None}
                        or 'manualPhase' not in state or 'sourceId' not in state
                        or (state['sourceId'] is not None and type(state['sourceId']) is not int)
                        or 'sourceName' not in state or 'waitingType' not in state
                        or (state['sourceName'] is not None and not isinstance(state['sourceName'], str))
                        or (state['waitingType'] is not None and not isinstance(state['waitingType'], str))):
                    reject('required-state-invalid:' + step)
                observations[step] = state
    initial, life, finish = (observations[step] for step in ['same-source', 'life19', 'finish'])
    if (initial['life'][0] != 20 or initial['manualPhase'] != 'open' or initial['sourceId'] is None
            or type(initial['manualStackEntryId']) is not int
            or initial['resolvingEntryId'] != initial['manualStackEntryId']):
        reject('required-state-content-mismatch:same-source')
    if (life['life'][0] != 19 or life['manualPhase'] != 'open' or life['sourceId'] != initial['sourceId']
            or life['manualStackEntryId'] != initial['manualStackEntryId']
            or life['resolvingEntryId'] != initial['manualStackEntryId']
            or life['stackCount'] != initial['stackCount']):
        reject('required-state-content-mismatch:life19')
    if not finish_matches(initial, finish):
        reject('required-state-content-mismatch:finish')
    return {'required_steps': ['same-source', 'life19', 'finish'], 'verified_count': 3}


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
    runtime_artifacts = {name: item for name, item in manifest['artifacts'].items()
                         if name.endswith(('.js', '.wasm'))}
    if installed.get('installed_artifacts') != runtime_artifacts:
        raise ValueError('incomplete executable runtime installation')
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
        for name, item in runtime_artifacts.items():
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
                  'consumer_execution': boot['consumer_execution'],
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
