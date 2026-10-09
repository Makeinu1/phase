"""Bounded product-board continuation: trusted K1 -> life19 -> Finish -> paid play22.

This is a bounded independent smoke, not the unavailable migration scenario
and not S1-S12 acceptance. Only public observations are written.
"""
import datetime
import base64
import hashlib
import html
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(os.environ['MANUAL_EVIDENCE'])
VALIDATION = Path(__file__).resolve().parents[2]
SESSION = os.environ['P1_WEBDRIVER_SESSION']
BASE = 'http://127.0.0.1:9515/session/' + SESSION
spec = importlib.util.spec_from_file_location('p1_capture_checks', VALIDATION / 'scripts/ci/p1-product-capture.py')
CHECKS = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CHECKS)
report = {'scope': 'Local K1 UI continuation to paid play22; S1 life18/play21, restore, Undo and full S1-S12 unaccepted',
          'fixture': '1c.K1', 'status': 'starting', 'assertions': [],
          'stages': {name: {'status': 'not_run', 'assertions_completed': False}
                     for name in ['initial', 'life19', 'finish', 'paidplay22']}, 'secondary': [],
          'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}


def click_error_details(message):
    """Retain only native click point and public tag identity, never raw HTML."""
    details = {}
    point = re.search(r'at point \((-?\d+),\s*(-?\d+)\)', message)
    if point:
        details['native_click_point'] = {'x': int(point[1]), 'y': int(point[2])}
    for key, prefix in [('target_at_error', 'Element '),
                        ('interceptor_at_error', 'Other element would receive the click: ')]:
        tag = re.search(re.escape(prefix) + r'<([A-Za-z][A-Za-z0-9-]*)([^>]{0,4096})>', message)
        if not tag:
            continue
        identity = {'tag': tag[1].upper()}
        for attr in ['id', 'class', 'aria-label', 'data-testid']:
            value = re.search(r'(?:^|\s)' + re.escape(attr) + r'=([\"\x27])(.*?)\1', tag[2])
            if value:
                identity[attr] = html.unescape(value[2])[:400]
        details[key] = identity
    return details


def call(path, data=None):
    request = urllib.request.Request(BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=65) as response:
            value = json.load(response)['value']
    except urllib.error.HTTPError as error:
        # Inspect the response in memory; retain only allowlisted W3C codes
        # and fixed categories, never a raw message, body, stack or session.
        try:
            value = json.loads(error.read(65536)).get('value', {})
            known = {'element click intercepted', 'element not interactable',
                'invalid argument', 'no such element', 'stale element reference',
                'javascript error', 'timeout', 'unknown error'}
            code = value.get('error')
            message = str(value.get('message', ''))
            category = ('click-received-by-other-element' if 'Other element would receive the click' in message
                else 'element-not-clickable-at-point' if 'is not clickable at point' in message
                else 'element-not-interactable' if 'element not interactable' in message
                else 'unclassified-webdriver-error')
            report['webdriver_error'] = {'http_status': error.code,
                'error': code if code in known else 'unrecognized-error', 'category': category}
            if code == 'element click intercepted':
                report['webdriver_error'].update(click_error_details(message))
                report['webdriver_error']['received_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        except (ValueError, TypeError, AttributeError):
            report['webdriver_error'] = {'http_status': error.code, 'error': 'unreadable-response'}
        raise RuntimeError('WebDriver command failed; see safe ui-smoke-report') from None
    if isinstance(value, dict) and 'error' in value:
        raise RuntimeError('WebDriver command failed: ' + value['error'])
    return value


def observe():
    return call('/execute/sync', {'script': 'return window.__p1Observe();', 'args': []})


def wait_for(predicate):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        value = observe()
        if predicate(value):
            return value
        time.sleep(0.25)
    raise AssertionError('Public state did not reach the required smoke step')


def element(selector, using='css selector'):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        matches = call('/elements', {'using': using, 'value': selector})
        if matches:
            identifier = matches[0]['element-6066-11e4-a52e-4f735466cecf']
            if call('/element/' + identifier + '/displayed') and call('/element/' + identifier + '/enabled'):
                return identifier
        time.sleep(0.25)
    raise AssertionError('Required product control did not become visible and enabled')


def hit_observation(selector, native_point=None, using='css selector'):
    # Public geometry only; no scrolling, focus or application-state changes.
    return call('/execute/sync', {'script': '''
const target = arguments[2] === 'xpath'
 ? document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
 : document.querySelector(arguments[0]);
const r = target.getBoundingClientRect();
const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
const top = document.elementFromPoint(x, y);
const describe = e => e ? {tag: e.tagName, id: e.id,
 className: typeof e.className === 'string' ? e.className.slice(0, 400) : '',
 ariaLabel: e.getAttribute('aria-label'), text: (e.innerText ?? '').slice(0, 300)} : null;
const rectValue = v => ({left: v.left, top: v.top, right: v.right, bottom: v.bottom});
const clientRects = Array.from(target.getClientRects()).slice(0, 10).map(rectValue);
const first = clientRects[0];
const expectedPoint = first ? {
 x: Math.floor((Math.max(0, first.left) + Math.min(innerWidth, first.right)) / 2),
 y: Math.floor((Math.max(0, first.top) + Math.min(innerHeight, first.bottom)) / 2)} : null;
const point = arguments[1];
const atNativePoint = point ? document.elementFromPoint(point.x, point.y) : null;
const ancestors = [];
for (let e = atNativePoint; e && ancestors.length < 8; e = e.parentElement) {
 const d = describe(e); delete d.text; ancestors.push(d);
}
return {selector: arguments[0], viewport: {width: innerWidth, height: innerHeight},
 sampledAt: new Date().toISOString(), browserTimeMs: performance.now(),
 scroll: {x: scrollX, y: scrollY},
 rect: rectValue(r), clientRects, expectedWebDriverPoint: expectedPoint,
 clippedViewport: {left: Math.max(0, r.left), top: Math.max(0, r.top),
  right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom)},
 center: {x, y}, target: describe(target), top: describe(top),
 nativePoint: point, nativePointTop: describe(atNativePoint), nativePointAncestors: ancestors,
 nativePointHitsTarget: !!atNativePoint && (atNativePoint === target || target.contains(atNativePoint)),
 centerHitsTarget: !!top && (top === target || target.contains(top))};
''', 'args': [selector, native_point, using]})


def prepare_hand_click(selector, identifier):
    # The real product uses Motion hand/card layout and cursor previews.
    # Hover does not itself expand the hand. Move the native pointer, then observe
    # a stable in-viewport hit target before the actual click. Partially clipped
    # hand cards remain legitimate product controls; record clipping, not reject it.
    # Never mutate the DOM, remove an overlay, or force a scripted click.
    report['hand_click_preparation'] = {'kind': 'native-hover-and-visible-stability',
                                        'before_hover': hit_observation(selector)}
    call('/actions', {'actions': [{'type': 'pointer', 'id': 'p1-hand-pointer',
        'parameters': {'pointerType': 'mouse'}, 'actions': [
            {'type': 'pointerMove', 'duration': 250,
             'origin': {'element-6066-11e4-a52e-4f735466cecf': identifier}, 'x': 0, 'y': 0}]}]})
    deadline, previous, consecutive = time.monotonic() + 10, None, 0
    while time.monotonic() < deadline:
        current = hit_observation(selector)
        report['hand_click_preparation']['last_observation'] = current
        rect, viewport = current['rect'], current['viewport']
        stable = tuple(round(rect[key], 1) for key in ['left', 'top', 'right', 'bottom']) + (
            viewport['width'], viewport['height'], current['scroll']['x'], current['scroll']['y'])
        report['hand_click_preparation']['fully_visible'] = (rect['left'] >= 0 and rect['top'] >= 0
                         and rect['right'] <= viewport['width'] and rect['bottom'] <= viewport['height'])
        if current['centerHitsTarget']:
            consecutive = consecutive + 1 if stable == previous else 1
            previous = stable
            if consecutive >= 3:
                report['hand_click_preparation']['status'] = 'stable-visible-unobstructed'
                return
        else:
            consecutive, previous = 0, None
        time.sleep(0.15)
    report['hand_click_preparation']['status'] = 'not-stable-visible-unobstructed'
    raise AssertionError('Native hovered hand card did not settle visibly without obstruction')


def click(selector, using='css selector'):
    identifier = element(selector, using)
    if selector.startswith('[data-hand-card]'):
        prepare_hand_click(selector, identifier)
    report['click_observation'] = hit_observation(selector, using=using)
    commands = report.setdefault('click_commands', [])
    command = {'ordinal': len(commands) + 1, 'operation': stage, 'using': using,
               'locator': selector, 'before': report['click_observation'],
               'status': 'attempting', 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    commands.append(command)
    try:
        call('/element/' + identifier + '/click', {})
        command['status'] = 'completed'
        command['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    except RuntimeError:
        original_error = dict(report.get('webdriver_error', {}))
        command.update(status='failed', error=original_error,
                       finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        report['failed_click_operation'] = stage
        try:
            report['click_observation_after_failure'] = hit_observation(selector,
                original_error.get('native_click_point'), using=using)
            command['after'] = report['click_observation_after_failure']
            if original_error.get('error') == 'element click intercepted':
                diagnostic = {'kind': 'immediate post-interception diagnostic; not acceptance',
                              'requested_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
                pixels = base64.b64decode(call('/screenshot'), validate=True)
                diagnostic['received_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                if not CHECKS.valid_png(pixels):
                    raise ValueError('Invalid diagnostic PNG')
                target = ROOT / 'screenshots/diagnostic-click-intercepted.png'
                if target.exists():
                    raise ValueError('Do not overwrite a click diagnostic')
                target.write_bytes(pixels)
                diagnostic['screenshot'] = {'path': 'screenshots/diagnostic-click-intercepted.png',
                                          'sha256': hashlib.sha256(pixels).hexdigest()}
                report['click_interception_diagnostic'] = diagnostic
                command['diagnostic'] = diagnostic
        except Exception as error:
            report['click_observation_after_failure_error_type'] = type(error).__name__
        finally:
            report['webdriver_error'] = original_error
        raise


def capture(step):
    call('/execute/async', {'script': 'const done = arguments[arguments.length-1]; requestAnimationFrame(() => requestAnimationFrame(() => done(true)));', 'args': []})
    subprocess.run(['python3', str(VALIDATION / 'scripts/ci/p1-product-capture.py'),
        '--evidence', str(ROOT), '--step', step,
        '--state-script', str(VALIDATION / 'scripts/ci/p1-public-state.js')], check=True)


def resolve_control():
    """Observe completion while waiting for our actual enabled priority control."""
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        state = observe()
        if state['life'][0] == 22:
            return None
        if state['waitingType'] == 'Priority' and state['priorityPlayer'] == 0 and state['stackCount'] == 1:
            matches = call('/elements', {'using': 'xpath', 'value': '//button[normalize-space()="Resolve"]'})
            for match in matches:
                identifier = match['element-6066-11e4-a52e-4f735466cecf']
                if call('/element/' + identifier + '/displayed') and call('/element/' + identifier + '/enabled'):
                    latest = observe()
                    if latest['life'][0] == 22:
                        return None
                    if latest['waitingType'] == 'Priority' and latest['priorityPlayer'] == 0 and latest['stackCount'] == 1:
                        return identifier
        time.sleep(0.25)
    raise AssertionError('Ordinary resolution neither completed nor offered an own priority control')


stage = 'application-observer'
exit_code = 0
try:
    report['consumer'] = json.loads((ROOT / 'manifest.json').read_text())['consumer']
    report['consumer_execution'] = json.loads(Path(os.environ['P1_BROWSER_BOOT']).read_text())['consumer_execution']
    call('/window/rect', {'width': 1440, 'height': 1000})
    # This closure reads existing public store fields; it never seeds or mutates
    # engine/store state and never exposes actor/context/receipt wire data.
    ready = call('/execute/async', {'script': """
const done = arguments[arguments.length - 1];
import('/src/stores/gameStore.ts').then(({useGameStore}) => {
  window.__p1Observe = () => {
    const s = useGameStore.getState(), g = s.gameState;
    const v = g?.derived?.manual_resolution;
    return {life: g?.players?.map(p => p.life) ?? [],
      manualPhase: v?.phase ?? null, sourceId: v?.source?.sourceId ?? null,
      sourceName: v?.source?.name ?? null, stackCount: g?.stack?.length ?? null,
      manualStackEntryId: v?.source?.stackEntryId ?? null,
      resolvingEntryId: g?.resolving_stack_entry?.id ?? null,
      waitingType: s.waitingFor?.type ?? null,
      priorityPlayer: s.waitingFor?.type === 'Priority' ? s.waitingFor.data.player : null,
      ownManaCount: g?.players?.[0]?.mana_pool?.mana?.length ?? null,
      nextCardId: g?.players?.[0]?.hand?.find(id => g.objects?.[id]?.name === 'Next Ordinary Play') ?? null,
      nextInGraveyard: g?.players?.[0]?.graveyard?.some(id => g.objects?.[id]?.name === 'Next Ordinary Play') ?? false};
  };
  done(true);
}, () => done(false));
""", 'args': []})
    assert ready, 'Public observer module could not load'
    stage = 'initial'
    initial = wait_for(lambda s: s['manualPhase'] == 'open' and s['life'][:1] == [20])
    assert initial['sourceId'] is not None
    assert initial['stackCount'] == 0, 'K1 Begin already popped the sole ordinary stack entry'
    assert type(initial['manualStackEntryId']) is int and initial['resolvingEntryId'] == initial['manualStackEntryId']
    panel = '//section[@aria-labelledby][.//h2[normalize-space()="Manual resolution"]]'
    element(panel, 'xpath')
    report['stages']['initial'] = {'status': 'passed', 'assertions_completed': True}
    stage = 'capture-same-source'
    capture('same-source')
    stage = 'player-area-select'
    report['assertions'].append('trusted fixture reached Manual Open with own life 20')
    click('[data-testid="player-area-0"] > button[aria-pressed]')
    amount = element(panel + '//input[@type="number"]', 'xpath')
    call('/element/' + amount + '/clear', {})
    call('/element/' + amount + '/value', {'text': '1'})
    call('/element/' + element(panel + '//button[@type="submit"]', 'xpath') + '/click', {})
    stage = 'life19'
    after_life = wait_for(lambda s: s['life'][:1] == [19] and s['manualPhase'] == 'open')
    assert after_life['sourceId'] == initial['sourceId']
    assert after_life['stackCount'] == initial['stackCount']
    assert after_life['resolvingEntryId'] == after_life['manualStackEntryId'] == initial['manualStackEntryId']
    report['stages']['life19'] = {'status': 'passed', 'assertions_completed': True}
    stage = 'capture-life19'
    capture('life19')
    report['assertions'].append('real Apply click lost one life on the same open source')
    # Locate the existing visible Finish button, then issue a real WebDriver click.
    stage = 'finish'
    finish = element(panel + '//button[normalize-space()="Finish"]', 'xpath')
    call('/element/' + finish + '/click', {})
    ended = wait_for(lambda s: CHECKS.finish_matches(initial, s))
    assert ended['life'][0] == 19
    report['stages']['finish'] = {'status': 'passed', 'assertions_completed': True}
    stage = 'capture-finish'
    capture('finish')
    report['assertions'].append('real Finish click closed the exact resolving entry and returned Priority; ordinary stack stayed empty and life stayed 19')
    # The native fixture has one remaining generic mana and a +3-life ordinary
    # spell. Continue from life19, hence 22; this is not the S1 life18 -> 21 path.
    stage = 'paidplay-select'
    assert ended['ownManaCount'] == 1 and type(ended['nextCardId']) is int
    next_id = ended['nextCardId']
    click('[data-hand-card][data-object-id="' + str(next_id) + '"]')
    stage = 'paidplay-options'
    click('//button[normalize-space()="Resolution options for Next Ordinary Play"]', 'xpath')
    stage = 'paidplay-normal'
    click('//button[normalize-space()="Cast normally"]', 'xpath')
    stage = 'paidplay-payment'
    paying = wait_for(lambda s: s['waitingType'] == 'ManaPayment'
                      or (s['waitingType'] == 'Priority' and s['stackCount'] == 1 and s['ownManaCount'] == 0))
    if paying['waitingType'] == 'ManaPayment':
        pay = element('//button[normalize-space()="Pay"]', 'xpath')
        call('/element/' + pay + '/click', {})
    paid = wait_for(lambda s: s['waitingType'] == 'Priority' and s['stackCount'] == 1 and s['ownManaCount'] == 0)
    assert paid['life'][0] == 19 and paid['manualPhase'] != 'open' and paid['resolvingEntryId'] is None
    assert paid['nextCardId'] is None and paid['nextInGraveyard'] is False
    report['paid_before_resolution'] = paid
    stage = 'paidplay-resolve'
    # Two native priority passes are the finite fixture's normal resolution
    # path. An automatic pass may finish it between clicks; never click again
    # after the observed life change.
    for _ in range(2):
        resolve = resolve_control()
        if resolve is None:
            break
        before = observe()
        if before['life'][0] == 22:
            break
        if before['waitingType'] != 'Priority' or before['priorityPlayer'] != 0 or before['stackCount'] != 1:
            continue
        call('/element/' + resolve + '/click', {})
        wait_for(lambda s: s['life'][0] == 22 or s['priorityPlayer'] != before['priorityPlayer'])
    ordinary = wait_for(lambda s: s['life'][0] == 22 and s['stackCount'] == 0 and s['waitingType'] == 'Priority')
    assert ordinary['ownManaCount'] == 0 and ordinary['resolvingEntryId'] is None
    assert ordinary['manualPhase'] != 'open' and ordinary['nextInGraveyard'] is True
    assert ordinary['nextCardId'] is None and ordinary['life'][1] == initial['life'][1]
    report['stages']['paidplay22'] = {'status': 'passed', 'assertions_completed': True}
    stage = 'capture-paidplay22'
    capture('paidplay22')
    report['assertions'].append('Cast normally paid the remaining one mana; normal priority resolution gained exactly three life to22, moved the next card to graveyard and left no manual carrier')
    report['primary'] = {'stage': 'operations-complete', 'code': 0, 'reason': 'completed'}
    report['status'] = 'passed'
except Exception as error:
    exit_code = 1
    report['status'] = 'failed'
    report['error_type'] = type(error).__name__
    reason = ('required-capture-failed' if stage.startswith('capture-')
              else 'webdriver-command-failed' if 'webdriver_error' in report
              else 'operation-assertion-failed' if isinstance(error, AssertionError)
              else 'scenario-command-failed')
    report['primary'] = {'stage': stage, 'code': 1, 'reason': reason}
    if stage == 'capture-finish' and all(item['assertions_completed'] is True for item in report['stages'].values()):
        report['primary'] = {'stage': 'operations-complete', 'code': 0, 'reason': 'completed'}
        report['secondary'].append({'stage': stage, 'code': 1, 'reason': 'required-capture-failed'})
        report['status'] = 'incomplete'
finally:
    report['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        (ROOT / 'ui-smoke-report.json').write_text(json.dumps(report, indent=2) + '\n')
    except Exception:
        report['secondary'].append({'stage': 'ui-smoke-report', 'code': 1, 'reason': 'required-report-save-failed'})
        exit_code = exit_code or 1
        report['status'] = 'incomplete' if report['primary']['code'] == 0 else 'failed'
        # Fixed, structured fallback only; no exception text or transport data.
        print(json.dumps({'primary': report['primary'], 'secondary': report['secondary'],
                          'status': report['status'], 'effective_exit': exit_code}))
raise SystemExit(exit_code)
