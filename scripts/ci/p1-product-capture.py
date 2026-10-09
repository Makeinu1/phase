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


BOUNDED_K1_SCOPE = ('Local K1 checked-restore and real UI continuation to paid play22 with explicit fixture opponent driver; '
                    'K1-only acceptance when passed; full S8, opponent UI, two-client S9, '
                    'S1 life18/play21, Undo and full S1-S12 unaccepted')


S1_1A_SCOPE = 'S1-1a and S12c prepayment Manual UI with explicit fixture opponent passes; not full P1, opponent UI, two-client, Undo or Recovery acceptance'


class EvidenceFailure(ValueError):
    def __init__(self, stage, reason):
        self.stage, self.reason = stage, reason
        super().__init__(reason)


def validate_operations(report, consumer, execution, paidplay=False, restore_driver=False, s1_1a=False):
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
    required = (['prepayment', 'manual-options', 'manual-cast', 'initial', 'life18', 'finish', 'paidplay21'] if s1_1a else ['initial', 'life19', 'finish'] + (['paidplay22'] if paidplay else []) + (['checked-restore-k1', 'fixture-opponent-pass'] if restore_driver else []))
    for stage in required:
        item = stages.get(stage)
        if not isinstance(item, dict):
            reject('required-operation-stage-missing:' + stage)
        if item.get('status') != 'passed' or item.get('assertions_completed') is not True:
            reject('required-operation-stage-incomplete:' + stage)
    if s1_1a:
        validate_s1_1a(report)
    if paidplay:
        paid = report.get('paid_before_resolution')
        if (not isinstance(paid, dict) or paid.get('life') != [19, 20]
                or type(paid.get('ownManaCount')) is not int or paid['ownManaCount'] != 0
                or type(paid.get('stackCount')) is not int or paid['stackCount'] != 1
                or paid.get('waitingType') != 'Priority' or paid.get('manualPhase') == 'open'
                or paid.get('resolvingEntryId', 'missing') is not None
                or paid.get('nextCardId', 'missing') is not None or paid.get('nextInGraveyard') is not False):
            reject('paid-before-resolution-incomplete')
    if restore_driver:
        if report.get('scope') != BOUNDED_K1_SCOPE:
            reject('bounded-k1-scope-mismatch')
        restore = report.get('checked_restore_k1')
        checks = restore.get('contextChecks') if isinstance(restore, dict) else None
        expected_checks = {'sameOwner', 'newSession', 'nextRestoreEpoch', 'nextAdapterGeneration'}
        if (not paidplay or not isinstance(restore, dict) or restore.get('ok') is not True
                or restore.get('method') != 'existing-live-export-and-authenticated-checked-restore'
                or not isinstance(checks, dict) or set(checks) != expected_checks
                or any(value is not True for value in checks.values())
                or not isinstance(restore.get('checkpoint_sha256'), str)
                or not re.fullmatch('[0-9a-f]{64}', restore['checkpoint_sha256'])):
            reject('checked-restore-k1-incomplete')
        before, after = restore.get('before'), restore.get('after')
        preserved = ['life', 'manualPhase', 'sourceId', 'sourceName', 'stackCount', 'manualStackEntryId',
                     'resolvingEntryId', 'waitingType', 'priorityPlayer', 'ownManaCount', 'nextCardId']
        if (not isinstance(before, dict) or not isinstance(after, dict)
                or before.get('life') != [20, 20] or before.get('manualPhase') != 'open'
                or type(before.get('sourceId')) is not int or type(before.get('manualStackEntryId')) is not int
                or before.get('resolvingEntryId') != before['manualStackEntryId']
                or type(before.get('stackCount')) is not int or before['stackCount'] != 0
                or type(before.get('ownManaCount')) is not int or before['ownManaCount'] != 1
                or type(before.get('nextCardId')) is not int
                or any(key not in before or key not in after or before[key] != after[key] for key in preserved)):
            reject('checked-restore-k1-public-occurrence-mismatch')
        driver = report.get('fixture_opponent_driver')
        if (not isinstance(driver, dict) or driver.get('ok') is not True
                or driver.get('mode') != 'explicit-local-fixture-opponent-driver'
                or driver.get('action') != 'PassPriority' or type(driver.get('actor')) is not int or driver['actor'] != 1
                or type(driver.get('commands')) is not int or driver['commands'] != 1
                or driver.get('opponent_ui') is not False or driver.get('two_client') is not False):
            reject('fixture-opponent-driver-incomplete')
        pending = driver.get('before')
        if (not isinstance(pending, dict) or pending.get('waitingType') != 'Priority'
                or type(pending.get('priorityPlayer')) is not int or pending['priorityPlayer'] != 1
                or type(pending.get('stackCount')) is not int or pending['stackCount'] != 1
                or type(pending.get('ownManaCount')) is not int or pending['ownManaCount'] != 0
                or pending.get('life') != [19, 20] or pending.get('manualPhase') == 'open'
                or pending.get('resolvingEntryId', 'missing') is not None
                or pending.get('nextCardId', 'missing') is not None or pending.get('nextInGraveyard') is not False):
            reject('fixture-opponent-driver-boundary-mismatch')


def validate_s1_1a(report):
    def require(condition, reason):
        if not condition:
            raise EvidenceFailure('operation-assertions', 's1-1a-' + reason)
    require(report.get('scope') == S1_1A_SCOPE and report.get('fixture') == '1a.B', 'scope-fixture-mismatch')
    pre, paid, begin, life, end, next_paid, next_done = (report.get(k) for k in
        ['prepayment', 'manual_paid_before_begin', 'begin', 'life_applied', 'finished', 'paid_before_resolution', 'ordinary_completed'])
    require(all(isinstance(x, dict) for x in [pre, paid, begin, life, end, next_paid, next_done]), 'public-boundaries-missing')
    source, entry = pre.get('sourceCardId'), begin.get('manualStackEntryId')
    require(type(source) is int and type(entry) is int and type(pre.get('nextCardId')) is int, 'source-occurrence-missing')
    require(pre.get('sourceInHand') is True and pre.get('sourceInGraveyard') is False
        and pre.get('manualPhase') is None and pre.get('resolvingEntryId') is None
        and pre.get('stackCount') == 0 and pre.get('life') == [20,20] and pre.get('ownManaCount') == 2
        and pre.get('waitingType') == 'Priority' and pre.get('priorityPlayer') == 0, 'not-before-designation-payment')
    require(report.get('prepayment_scope_visible') is True and report.get('own_area_label') == 'You', 'real-scope-own-area-label-missing')
    require(paid.get('life') == [20,20] and paid.get('ownManaCount') == 1 and paid.get('stackCount') == 1
        and paid.get('manualPhase') == 'armed' and paid.get('sourceId') == source
        and paid.get('resolvingEntryId') is None and paid.get('waitingType') == 'Priority', 'manual-payment-boundary-mismatch')
    require(begin.get('life') == [20,20] and begin.get('ownManaCount') == 1 and begin.get('stackCount') == 0
        and begin.get('manualPhase') == 'open' and begin.get('sourceId') == source
        and begin.get('resolvingEntryId') == entry, 'begin-boundary-mismatch')
    require(life.get('life') == [18,20] and life.get('ownManaCount') == 1 and life.get('stackCount') == 0
        and life.get('manualPhase') == 'open' and life.get('sourceId') == source
        and life.get('manualStackEntryId') == entry and life.get('resolvingEntryId') == entry, 'apply-boundary-mismatch')
    require(finish_matches(begin, end, own_life=18) and end.get('sourceInGraveyard') is True
        and end.get('ownManaCount') == 1, 'finish-boundary-mismatch')
    require(next_paid.get('life') == [18,20] and next_paid.get('ownManaCount') == 0 and next_paid.get('stackCount') == 1
        and next_paid.get('manualPhase') == 'closed' and next_paid.get('resolvingEntryId') is None
        and next_paid.get('waitingType') == 'Priority' and next_paid.get('nextCardId', 'missing') is None
        and next_paid.get('nextInGraveyard') is False, 'ordinary-payment-boundary-mismatch')
    require(next_done.get('life') == [21,20] and next_done.get('ownManaCount') == 0 and next_done.get('stackCount') == 0
        and next_done.get('manualPhase') == 'closed' and next_done.get('resolvingEntryId') is None
        and next_done.get('waitingType') == 'Priority' and next_done.get('nextCardId', 'missing') is None
        and next_done.get('nextInGraveyard') is True, 'ordinary-completion-boundary-mismatch')
    drivers = report.get('fixture_opponent_drivers')
    require(isinstance(drivers, list) and len(drivers) == 2, 'fixture-driver-count')
    for driver, boundary, amount, mana, phase in zip(drivers, [paid, next_paid], [20,18], [1,0], ['armed','closed']):
        require(isinstance(driver, dict) and driver.get('ok') is True and driver.get('mode') == 'explicit-local-fixture-opponent-driver'
            and driver.get('action') == 'PassPriority' and type(driver.get('actor')) is int and driver['actor'] == 1
            and type(driver.get('commands')) is int and driver['commands'] == 1
            and driver.get('opponent_ui') is False and driver.get('two_client') is False, 'fixture-driver-invalid')
        b = driver.get('before')
        require(isinstance(b, dict) and b.get('life') == [amount,20] and b.get('ownManaCount') == mana
            and b.get('manualPhase') == phase and b.get('priorityPlayer') == 1 and b.get('waitingType') == 'Priority'
            and b.get('stackCount') == 1 and b.get('resolvingEntryId') is None
            and b.get('sourceId') == source and b.get('manualStackEntryId') == boundary.get('manualStackEntryId'), 'fixture-driver-boundary')
    for state, changes, departed, terminals, next_departed in [
        (pre, [], 0, 0, 0), (begin, [], 0, 0, 0),
        (life, [{'amount':-2,'total':18}],0,0,0), (end,[{'amount':-2,'total':18}],1,1,0),
        (next_done,[{'amount':-2,'total':18},{'amount':3,'total':21}],1,1,1)]:
        require(state.get('publicEvents') == {'lifeChanges':changes,'sourceDepartures':departed,
            'manualTerminals':terminals,'nextDepartures':next_departed}, 'event-boundary-mismatch')
    summary = report.get('receipt_summary')
    require(isinstance(summary, dict) and summary.get('appliedResults') == 3, 'receipt-delivery-count')
    receipts = summary.get('completed')
    require(isinstance(receipts, list) and len(receipts) == 3 and all(isinstance(r,dict) for r in receipts), 'receipt-count')
    cast_receipts = [r for r in receipts if r.get('stackEntryId', 'missing') is None]
    operation_receipts = [r for r in receipts if r.get('stackEntryId') == entry]
    require(len(cast_receipts) == 1 and len(operation_receipts) == 2
        and cast_receipts[0].get('sourceId') == source and cast_receipts[0].get('lifeChanges') == []
        and cast_receipts[0].get('terminalCount') == 0, 'cast-receipt-mismatch')
    require(all(r.get('sourceId') == source and r.get('stackEntryId') == entry for r in operation_receipts)
        and sorted(r.get('terminalCount', -1) for r in operation_receipts) == [0,1]
        and [e for r in operation_receipts for e in r.get('lifeChanges', [])] == [{'amount':-2,'total':18}], 'receipt-source-event-mismatch')
    require(report.get('prepayment_full_control') is True, 'full-control-not-confirmed')
    commands = report.get('click_commands', [])
    ordinary_clicks = [c for c in commands if c.get('operation') == 'paidplay-normal-direct']
    require(len(ordinary_clicks) == 1 and ordinary_clicks[0].get('native_double_click_verified') is True, 'trusted-double-click-missing')
    require(all(any(c.get('operation') == stage and c.get('status') == 'completed' for c in commands)
        for stage in ['prepayment-full-control','manual-card-select','manual-options','manual-cast','manual-response','player-area-select','life18','finish','paidplay-normal-direct','paidplay-response']), 'native-clicks-missing')


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


def finish_matches(initial, ended, own_life=19):
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
            and ended.get('life', [])[:1] == [own_life]
            and ended.get('sourceId') == initial.get('sourceId')
            and ended.get('manualStackEntryId') == entry
            and 'resolvingEntryId' in ended and ended['resolvingEntryId'] is None
            and type(ended.get('stackCount')) is int and ended['stackCount'] == count)


def validate_required_images(root, manifest, execution, paidplay=False, s1_1a=False):
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
    required = ['prepayment','same-source','life18','finish','paidplay21'] if s1_1a else ['same-source', 'life19', 'finish'] + (['paidplay22'] if paidplay else [])
    for step in required:
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
    own_life = 18 if s1_1a else 19
    initial, life, finish = (observations[step] for step in ['same-source', 'life18' if s1_1a else 'life19', 'finish'])
    if s1_1a:
        pre = observations['prepayment']
        if (pre['life'] != [20,20] or pre['manualPhase'] is not None or pre['stackCount'] != 0
                or pre['resolvingEntryId'] is not None or pre.get('ownManaCount') != 2
                or pre.get('sourceInHand') is not True or pre.get('sourceCardId') != initial['sourceId']):
            reject('required-state-content-mismatch:prepayment')
    if (initial['life'][0] != 20 or initial['manualPhase'] != 'open' or initial['sourceId'] is None
            or type(initial['manualStackEntryId']) is not int
            or initial['resolvingEntryId'] != initial['manualStackEntryId']):
        reject('required-state-content-mismatch:same-source')
    if (life['life'][0] != own_life or life['manualPhase'] != 'open' or life['sourceId'] != initial['sourceId']
            or life['manualStackEntryId'] != initial['manualStackEntryId']
            or life['resolvingEntryId'] != initial['manualStackEntryId']
            or life['stackCount'] != initial['stackCount']):
        reject('required-state-content-mismatch:life19')
    if not finish_matches(initial, finish, own_life=own_life):
        reject('required-state-content-mismatch:finish')
    if paidplay or s1_1a:
        next_play = observations['paidplay21' if s1_1a else 'paidplay22']
        if (type(finish.get('ownManaCount')) is not int or finish['ownManaCount'] != 1
                or type(finish.get('nextCardId')) is not int or finish.get('nextInGraveyard') is not False
                or next_play['life'] != [21 if s1_1a else 22, initial['life'][1]]
                or next_play['stackCount'] != 0 or next_play['waitingType'] != 'Priority'
                or next_play['manualPhase'] == 'open' or next_play['resolvingEntryId'] is not None
                or type(next_play.get('ownManaCount')) is not int or next_play['ownManaCount'] != 0
                or next_play.get('nextCardId', 'missing') is not None
                or next_play.get('nextInGraveyard') is not True):
            reject('required-state-content-mismatch:paidplay22')
    return {'required_steps': required, 'verified_count': len(required)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--step', required=True)
    parser.add_argument('--state-script', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'(prepayment|same-source|life19|life18|finish|child|paidplay21|paidplay22|restore-k[0-4]|ack-(life|finish)-(applied|rejected|unknown|inflight))', args.step):
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
