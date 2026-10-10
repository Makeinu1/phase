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
AUTO_CONTROL = os.environ.get('P1_UI_CASE') if os.environ.get('P1_UI_CASE') in {'auto-s','auto-n','auto-v'} else None
SPLIT_APPLY = os.environ.get('P1_UI_CASE') == 'prepayment1c'
PREPAYMENT = SPLIT_APPLY or os.environ.get('P1_UI_CASE') == 'prepayment1a'
NATIVE_CHECKS = SPLIT_APPLY and os.environ.get('P1_NATIVE_CHECKS') == '1'
report = {'scope': (CHECKS.AUTO_V_SCOPE if AUTO_CONTROL=='auto-v' else CHECKS.AUTO_CONTROLS_SCOPE) if AUTO_CONTROL else (CHECKS.S1_1C_SCOPE if SPLIT_APPLY else CHECKS.S1_1A_SCOPE) if PREPAYMENT else CHECKS.BOUNDED_K1_SCOPE,
          'control_case': AUTO_CONTROL, 'fixture': ('11c.V.B' if AUTO_CONTROL=='auto-v' else '1a.B') if AUTO_CONTROL else ('1c.B' if SPLIT_APPLY else '1a.B') if PREPAYMENT else '1c.K1', 'status': 'starting', 'assertions': [],
          'stages': {name: {'status': 'not_run', 'assertions_completed': False}
                     for name in (['control-initial','control-full-control','control-paid','control-response','control-completed'] if AUTO_CONTROL else ['prepayment', 'manual-options', 'manual-cast', 'initial'] + (['life19', 'life18', 'historical-lookup'] if SPLIT_APPLY else ['life18']) + ['finish', 'paidplay21'] if PREPAYMENT else ['initial', 'life19', 'finish', 'paidplay22'])}, 'secondary': [],
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
    last = {'matchCount': 0, 'firstMatch': None}
    while time.monotonic() < deadline:
        matches = call('/elements', {'using': using, 'value': selector})
        last = {'matchCount': len(matches), 'firstMatch': None}
        if matches:
            identifier = matches[0]['element-6066-11e4-a52e-4f735466cecf']
            displayed = call('/element/' + identifier + '/displayed')
            enabled = call('/element/' + identifier + '/enabled') if displayed else None
            last['firstMatch'] = {'index': 0, 'displayed': displayed, 'enabled': enabled}
            if displayed and enabled:
                return identifier
        time.sleep(0.25)
    failure = {'operation': stage, 'phase': 'element-acquisition', 'locator': selector, 'using': using,
        'condition': 'first-match-visible-and-enabled', 'lastObservation': last}
    original_error = report.get('webdriver_error')
    try:
        failure['publicStateAtFailure'] = observe()
    except Exception as error:
        failure['publicStateObservationError'] = type(error).__name__
    finally:
        if original_error is None: report.pop('webdriver_error', None)
        else: report['webdriver_error'] = original_error
    report['control_acquisition_failure'] = failure
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
const expectedTop = expectedPoint ? document.elementFromPoint(expectedPoint.x, expectedPoint.y) : null;
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
 expectedWebDriverPointTop: describe(expectedTop),
 expectedWebDriverPointHitsTarget: !!expectedTop && (expectedTop === target || target.contains(expectedTop)),
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


def start_native_input_observation(selector):
    # Passive capture of real browser input only; no event dispatch or product writes.
    return call('/execute/sync', {'script': """
const selector = arguments[0];
const types = ['pointerdown', 'pointerup', 'click', 'dblclick', 'gotpointercapture', 'lostpointercapture'];
const events = [], identities = new WeakMap(); let nextIdentity = 1, dropped = 0;
const identify = node => {
  if (!(node instanceof Element)) return null;
  if (!identities.has(node)) identities.set(node, nextIdentity++);
  const card = node.closest('[data-hand-card]');
  return {tag: node.tagName, identity: identities.get(node),
    ownCardId: card?.matches(selector) ? Number(card.getAttribute('data-object-id')) : null,
    isRequestedCard: node.matches(selector), withinRequestedCard: !!card?.matches(selector)};
};
const listener = event => {
  if (events.length >= 40) { dropped++; return; }
  events.push({type: event.type, detail: event.detail, trusted: event.isTrusted,
    button: event.button, clientPoint: {x: event.clientX, y: event.clientY},
    browserTimestamp: event.timeStamp, observedAt: performance.now(),
    target: identify(event.target), pointTop: identify(document.elementFromPoint(event.clientX, event.clientY)),
    publicStateBeforeHandler: window.__p1Observe()});
};
for (const type of types) document.addEventListener(type, listener, {capture: true, passive: true});
window.__p1NativeInputObservation = () => {
  for (const type of types) document.removeEventListener(type, listener, true);
  delete window.__p1NativeInputObservation;
  return {events, dropped, publicStateAfterCommand: window.__p1Observe()};
};
return {installed: true, maxEvents: 40};
""", 'args': [selector]})


def finish_native_input_observation():
    return call('/execute/sync', {'script': 'return window.__p1NativeInputObservation();', 'args': []})


def click(selector, using='css selector', double=False):
    identifier = element(selector, using)
    if selector.startswith('[data-hand-card]'):
        prepare_hand_click(selector, identifier)
    report['click_observation'] = hit_observation(selector, using=using)
    commands = report.setdefault('click_commands', [])
    command = {'ordinal': len(commands) + 1, 'operation': stage, 'using': using,
               'locator': selector, 'before': report['click_observation'],
               'kind': 'native-pointer-double-click' if double else 'native-element-click',
               'status': 'attempting', 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    commands.append(command)
    if double and report['click_observation'].get('expectedWebDriverPointHitsTarget') is not True:
        command.update(status='failed', reason='native-origin-obstructed',
                       finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        raise AssertionError('Existing ordinary card native origin is obstructed')
    try:
        if double:
            command['native_input_observation'] = start_native_input_observation(selector)
            # Existing HandCard.onDoubleClick calls the same ordinary playCard
            # as the menu's Cast normally button. Native pointer input reaches
            # the browser's normal event target; it never forces a DOM handler.
            try:
                call('/actions', {'actions': [{'type': 'pointer', 'id': 'p1-hand-pointer',
                    'parameters': {'pointerType': 'mouse'}, 'actions': [
                        {'type': 'pointerMove', 'duration': 0,
                         'origin': {'element-6066-11e4-a52e-4f735466cecf': identifier}, 'x': 0, 'y': 0},
                        {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0},
                        {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0}]}]})
            finally:
                original_native_error = report.get('webdriver_error')
                try:
                    command['native_input_observation'] = finish_native_input_observation()
                except Exception as diagnostic_error:
                    command['native_input_observation_error_type'] = type(diagnostic_error).__name__
                finally:
                    if original_native_error is None:
                        report.pop('webdriver_error', None)
                    else:
                        report['webdriver_error'] = original_native_error
            observation = command.get('native_input_observation', {})
            events = observation.get('events', [])
            requested = int(re.search(r'data-object-id="(\d+)"', selector)[1])
            clicks = [e for e in events if e.get('type') == 'click']
            doubles = [e for e in events if e.get('type') == 'dblclick']
            def on_requested(e):
                target = e.get('target') or {}
                return e.get('trusted') is True and target.get('ownCardId') == requested and target.get('withinRequestedCard') is True
            verified = (observation.get('dropped') == 0 and len(clicks) == 2 and len(doubles) == 1
                and [e.get('type') for e in events if e.get('type') in {'click','dblclick'}] == ['click','click','dblclick']
                and [e.get('detail') for e in clicks] == [1,2] and doubles[0].get('detail') == 2
                and all(on_requested(e) for e in clicks + doubles))
            command['native_double_click_verified'] = verified
            if len(clicks) == 2 and all(type(e.get('browserTimestamp')) in {int,float} for e in clicks):
                command['observed_click_interval_ms'] = clicks[1]['browserTimestamp'] - clicks[0]['browserTimestamp']
            if not verified:
                command['reason'] = 'native-double-click-not-observed'
                raise AssertionError('Required trusted ordinary card dblclick did not occur')
        else:
            call('/element/' + identifier + '/click', {})
        command['status'] = 'completed'
        command['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    except AssertionError:
        command.update(status='failed', finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        report['failed_click_operation'] = stage
        raise
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


def checked_restore_current_k1():
    return call('/execute/async', {'script': """
const done = arguments[arguments.length - 1];
(async () => {
  const {useGameStore} = await import('/src/stores/gameStore.ts');
  const {adapter, gameMode} = useGameStore.getState();
  const cap = adapter?.localContinuation?.();
  if (gameMode !== 'local' || !cap || typeof adapter.exportPersistenceState !== 'function') throw new Error('Restore entrance unavailable');
  const beforeState = window.__p1Observe();
  if (beforeState.manualPhase !== 'open' || beforeState.life[0] !== 20 || beforeState.stackCount !== 0
      || beforeState.resolvingEntryId !== beforeState.manualStackEntryId) throw new Error('Expected live K1');
  const before = await cap.readCurrent();
  const checkpoint = await adapter.exportPersistenceState();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(checkpoint));
  const restored = await cap.restore(checkpoint);
  const a = before.current?.context, b = restored.current?.context;
  const afterState = window.__p1Observe();
  done({ok: true, method: 'existing-live-export-and-authenticated-checked-restore',
    checkpoint_sha256: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join(''),
    contextChecks: {sameOwner: !!a && !!b && a.ownerLineage === b.ownerLineage,
      newSession: !!a && !!b && a.interactionSessionId !== b.interactionSessionId,
      nextRestoreEpoch: !!a && !!b && b.restoreEpoch === a.restoreEpoch + 1,
      nextAdapterGeneration: !!a && !!b && b.adapterGeneration === a.adapterGeneration + 1},
    before: beforeState, after: afterState});
})().catch(e => done({ok: false, error_type: e?.name ?? 'Error'}));
""", 'args': []})


def drive_fixture_opponent_pass_once(expected_life=19, expected_mana=0, expected_phase="closed"):
    assert (expected_life, expected_mana, expected_phase) in {(20, 1, None), (19, 0, 'closed'), (20, 1, 'armed'), (18, 0, 'closed')}
    # Explicit fixture participant driver, not an opponent UI click or shared client.
    return call('/execute/async', {'script': """
const done = arguments[arguments.length - 1];
const [life, mana, phase] = arguments;
(async () => {
  const {useGameStore} = await import('/src/stores/gameStore.ts');
  const {dispatchAction} = await import('/src/game/dispatch.ts');
  const before = window.__p1Observe();
  if (useGameStore.getState().gameMode !== 'local' || before.waitingType !== 'Priority'
      || before.priorityPlayer !== 1 || before.stackCount !== 1 || before.ownManaCount !== mana
      || before.life[0] !== life || before.manualPhase !== phase || before.resolvingEntryId !== null)
    throw new Error('Unexpected opponent driver state');
  await dispatchAction({type: 'PassPriority'}, 1);
  done({ok: true, mode: 'explicit-local-fixture-opponent-driver', action: 'PassPriority', actor: 1,
    before, after: window.__p1Observe(), commands: 1, opponent_ui: false, two_client: false});
})().catch(e => done({ok: false, error_type: e?.name ?? 'Error'}));
""", 'args': [expected_life, expected_mana, expected_phase]})


def capture(step):
    call('/execute/async', {'script': 'const done = arguments[arguments.length-1]; requestAnimationFrame(() => requestAnimationFrame(() => done(true)));', 'args': []})
    subprocess.run(['python3', str(VALIDATION / 'scripts/ci/p1-product-capture.py'),
        '--evidence', str(ROOT), '--step', step,
        '--state-script', str(VALIDATION / 'scripts/ci/p1-public-state.js')], check=True)


def resolve_control(completed_life=22):
    """Observe completion while waiting for our actual enabled priority control."""
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        state = observe()
        if state['life'][0] == completed_life:
            return None
        if state['waitingType'] == 'Priority' and state['priorityPlayer'] == 0 and state['stackCount'] == 1:
            matches = call('/elements', {'using': 'xpath', 'value': '//button[normalize-space()="Resolve"]'})
            for match in matches:
                identifier = match['element-6066-11e4-a52e-4f735466cecf']
                if call('/element/' + identifier + '/displayed') and call('/element/' + identifier + '/enabled'):
                    latest = observe()
                    if latest['life'][0] == completed_life:
                        return None
                    if latest['waitingType'] == 'Priority' and latest['priorityPlayer'] == 0 and latest['stackCount'] == 1:
                        return identifier
        time.sleep(0.25)
    raise AssertionError('Ordinary resolution neither completed nor offered an own priority control')



def run_auto_control():
    global stage
    def passed(name):
        report['stages'][name] = {'status':'passed','assertions_completed':True}
    stage = 'control-initial'
    initial = wait_for(lambda x: x['life']==[20,20] and x['ownManaCount']==2 and x['stackCount']==0
        and x['manualPhase'] is None and x['waitingType']=='Priority' and x['priorityPlayer']==0)
    assert initial['sourceInHand'] is True and type(initial['sourceCardId']) is int and type(initial['nextCardId']) is int
    assert initial['publicEvents']==dict(lifeChanges=[],sourceDepartures=0,manualTerminals=0,nextDepartures=0)
    report['control_initial']=initial
    passed(stage)
    stage='control-full-control'
    click('[data-mobile-action-right] button[aria-label="Full Control Off"][aria-pressed="false"]')
    report['control_on']=call('/execute/sync',{'script': """return document.querySelector('[data-mobile-action-right] button[aria-label="Full Control On"][aria-pressed="true"]') !== null;""", 'args':[]})
    assert report['control_on'] is True
    passed(stage)
    stage='capture-control-initial'
    capture('control-initial')
    selected=initial['vanilla']['id'] if AUTO_CONTROL=='auto-v' else initial['sourceCardId' if AUTO_CONTROL=='auto-s' else 'nextCardId']
    report['selected_card_id']=selected
    stage='control-normal-direct'
    click('[data-hand-card][data-object-id="'+str(selected)+'"]',double=True)
    stage='control-paid'
    paying=wait_for(lambda x: x['waitingType']=='ManaPayment' or
        (x['waitingType']=='Priority' and x['stackCount']==1 and x['ownManaCount']==1))
    if paying['waitingType']=='ManaPayment':
        click('//button[normalize-space()="Pay"]','xpath')
    paid=wait_for(lambda x: x['waitingType']=='Priority' and x['stackCount']==1 and x['ownManaCount']==1)
    assert paid['life']==[20,20] and paid['manualPhase'] is None and paid['resolvingEntryId'] is None
    report['control_paid']=paid
    passed(stage)
    stage='control-response'
    wait_for(lambda x:x['waitingType']=='Priority' and x['priorityPlayer']==0 and x['stackCount']==1)
    click('//button[normalize-space()="Resolve"]','xpath')
    wait_for(lambda x:x['waitingType']=='Priority' and x['priorityPlayer']==1)
    driver=drive_fixture_opponent_pass_once(20,1,None)
    report['fixture_opponent_driver']=driver
    assert driver.get('ok') is True and driver.get('commands')==1
    passed(stage)
    stage='control-completed'
    total=20 if AUTO_CONTROL=='auto-v' else 18 if AUTO_CONTROL=='auto-s' else 23
    completed=wait_for(lambda x:x['life']==[total,20] and x['stackCount']==0 and x['waitingType']=='Priority')
    assert completed['ownManaCount']==1 and completed['manualPhase'] is None and completed['resolvingEntryId'] is None
    report['control_completed']=completed
    passed(stage)
    CHECKS.validate_control_boundaries(report)
    stage='capture-control-completed'
    capture('control-completed')
    report['primary']={'stage':'operations-complete','code':0,'reason':'completed'}
    report['status']='passed'


def run_s1_1a():
    global stage
    def passed(name):
        report['stages'][name] = {'status': 'passed', 'assertions_completed': True}
    def opponent(life, mana, phase):
        wait_for(lambda x: x['waitingType'] == 'Priority' and x['priorityPlayer'] == 0)
        click('//button[normalize-space()="Resolve"]', 'xpath')
        wait_for(lambda x: x['waitingType'] == 'Priority' and x['priorityPlayer'] == 1)
        driver = drive_fixture_opponent_pass_once(life, mana, phase)
        assert driver.get('ok') is True and type(driver.get('commands')) is int and driver['commands'] == 1
        report.setdefault('fixture_opponent_drivers', []).append(driver)
    stage = 'prepayment'
    pre = wait_for(lambda x: x['waitingType'] == 'Priority' and x['priorityPlayer'] == 0
        and x['manualPhase'] is None and x['life'] == [20,20] and x['ownManaCount'] == 2 and x['stackCount'] == 0)
    assert type(pre['sourceCardId']) is int and pre['sourceInHand'] and type(pre['nextCardId']) is int
    report['prepayment'] = pre
    assert pre['publicEvents']['lifeChanges'] == [] and pre['publicEvents']['sourceDepartures'] == 0
    receipts = call('/execute/async', {'script': '''
const done = arguments[arguments.length-1];
import('/src/stores/gameStore.ts').then(({useGameStore}) => {
 const cap = useGameStore.getState().adapter?.localContinuation?.();
 if (!cap) return done(false);
 const unique = new Map(), originals = []; let delivered = 0, publications = 0, latest = null;
 const stop = cap.subscribe(p => {
  latest = p;
  publications++;
  const r = p.receipt;
  if (r?.status !== 'completed') return;
  const a = r.attempt;
  if (!unique.has(a.attemptId)) {
   originals.push(r);
   unique.set(a.attemptId, {
   sourceId: a.source?.sourceId ?? null, stackEntryId: a.source?.stackEntryId ?? null,
   lifeChanges: (r.result?.events ?? []).filter(e=>e.type==='LifeChanged' && e.data.player_id===0)
    .map(e=>({amount:e.data.amount,total:e.data.new_total})),
   terminalCount: (r.result?.events ?? []).filter(e=>e.type==='StackResolved' && e.data.object_id===a.source?.stackEntryId).length});
  }
  if (p.appliedResult) delivered++;
 });
 window.__p1ReceiptSummary = () => ({completed: [...unique.values()], appliedResults: delivered});
 window.__p1StopReceipts = () => { stop(); originals.length = 0; unique.clear(); latest = null;
  delete window.__p1NativeChecks; delete window.__p1LookupFirst; delete window.__p1ReceiptSummary; delete window.__p1StopReceipts; return true; };
 const nativeFailure = (phase,step,error,completedChecks) => {
  const messages = new Map([
   ['No replay recording available. Start a game first, or it was invalidated by an undo/restore.','replay-recording-unavailable'],
   ['Native original phase unavailable','phase-unavailable'],['Replay actions unavailable','replay-schema'],
   ['Expected actual Manual current','current-mismatch'],['Original resend changed certified result','original-result-mismatch'],
   ['Original resends changed resident/publication/replay','resident-invariant'],['Fresh Manual source/frame unavailable','fresh-frame'],
   ['Distinct negative attempt required','negative-identity'],['Unexpected admission failure','admission-error'],
   ['Wrong actor admitted','actor-admitted'],['Admission refusal changed state','admission-invariant'],
   ['Old interaction not atomically refused','old-refusal'],['Old interaction refusal changed GameState/replay','old-invariant']]);
  const message = typeof error==='string' ? error : error?.message;
  return {status:'failed',phase,step,completedChecks:[...completedChecks],reason:messages.get(message) ?? 'unclassified-native-check-exception',
   exception:{name:['Error','TypeError','SyntaxError'].includes(error?.name)?error.name:typeof error==='string'?'String':'Unknown',message:messages.has(message)?message:null}};
 };
 window.__p1NativeChecks = async phase => {
  let probeStep='phase-admission'; const completedChecks=[];
  try {
  const [{unwrapClientGameState}, {sameLocalContinuationValue}] = await Promise.all([
   import('/src/adapter/wasm-adapter.ts'), import('/src/adapter/types.ts')]);
  const adapter = useGameStore.getState().adapter, engine = adapter?.getEngineClient();
  const losses = originals.filter(r => r.attempt.submission.response.type==='manualResolution'
   && r.attempt.submission.response.data.decision.type==='loseOwnLife'
   && r.attempt.submission.response.data.decision.data.amount===1
   && r.result?.events?.some(e=>e.type==='LifeChanged' && e.data.player_id===0));
  const total = phase==='before-second' ? 19 : phase==='after-second' ? 18 : null;
  if (!engine || total===null || losses.length !== (total===19 ? 1 : 2)) throw new Error('Native original phase unavailable');
  const counts = () => ({publications,appliedResults:delivered,completed:unique.size});
  const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),n=>n.toString(16).padStart(2,'0')).join('');
  const checkpoint = async () => {
   probeStep='checkpoint-replay-export';
   const replay = await engine.exportReplayLog();
   probeStep='checkpoint-replay-parse'; const parsed = JSON.parse(replay);
   if (!Array.isArray(parsed.actions)) throw new Error('Replay actions unavailable');
   probeStep='checkpoint-state-export'; const state = await adapter.exportPersistenceState();
   probeStep='checkpoint-hash';
   const hashes={stateSha256:await digest(state),replaySha256:await digest(replay),replayActions:parsed.actions.length};
   completedChecks.push('checkpoint'); return hashes;
  };
  const before = window.__p1Observe(), countsBefore = counts(), hashesBefore = await checkpoint();
  probeStep='current-invariant';
  if (before.life[0]!==total || before.manualPhase!=='open') throw new Error('Expected actual Manual current');
  const queries = [];
  for (const [index, original] of losses.entries()) for (const operation of ['register','apply','lookup']) {
   probeStep='original-'+(index===0?'qL1':'qL2')+'-'+operation;
   const reply = await engine.submitLocalContinuation(0,{type:'localContinuation',operation,attempt:original.attempt});
   const current = reply.current && unwrapClientGameState(reply.current.snapshot.state);
   if (reply.receipt?.status!=='completed' || reply.appliedResult!==null || reply.receipt.rejection!==null
    || !sameLocalContinuationValue(original.attempt,reply.receipt.attempt)
    || !sameLocalContinuationValue(original.result,reply.receipt.result)
    || current?.players?.[0]?.life!==total) throw new Error('Original resend changed certified result');
   completedChecks.push((index===0?'qL1':'qL2')+'-'+operation);
   queries.push({subject:index===0?'qL1':'qL2',operation,status:reply.receipt.status,
    sameOriginal:true,sameOriginalResult:true,appliedResultNull:true,rejectionNull:true,
    historicalLife:original.result.events.filter(e=>e.type==='LifeChanged' && e.data.player_id===0).map(e=>({amount:e.data.amount,total:e.data.new_total})),
    loseLifeEffects:original.result.events.filter(e=>e.type==='EffectResolved' && e.data.kind==='LoseLife' && e.data.source_id===original.attempt.source.sourceId).length,
    currentLife:current.players.map(p=>p.life),sameSource:sameLocalContinuationValue(original.attempt.source,current.derived?.manual_resolution?.source)});
  }
  const afterResends = window.__p1Observe(), countsAfterResends = counts(), hashesAfterResends = await checkpoint();
  probeStep='resend-invariant';
  if (!sameLocalContinuationValue(before,afterResends) || !sameLocalContinuationValue(countsBefore,countsAfterResends)
   || !sameLocalContinuationValue(hashesBefore,hashesAfterResends)) throw new Error('Original resends changed resident/publication/replay');
  const result = {phase,method:'same-actual-UI-original-native-register-apply-lookup',before,after:afterResends,
   countsBefore,countsAfter:countsAfterResends,hashesBefore,hashesAfter:hashesAfterResends,
   queries,adapterPublishedHistoricalReply:false,qL2PrecommitCustodyProven:false};
  if (total===19) {
   probeStep='fresh-frame';
   const first = losses[0], frame = latest?.current, state = frame && unwrapClientGameState(frame.snapshot.state);
   const opportunity = frame?.snapshot.viewerInteraction?.opportunities.find(o=>o.response.type==='schema'
    && o.response.data.spec.type==='manualResolution' && o.response.data.candidates.some(c=>c.surfaces.some(s=>s.type==='action' && s.data.code==='finishManualResolution')));
   if (!opportunity || opportunity.interactionId===first.attempt.submission.interactionId
    || state?.players?.[0]?.life!==19 || !sameLocalContinuationValue(first.attempt.source,state.derived?.manual_resolution?.source)) throw new Error('Fresh Manual source/frame unavailable');
   const fresh = {context:frame.context,attemptId:crypto.randomUUID(),source:first.attempt.source,
    submission:{interactionId:opportunity.interactionId,response:{type:'manualResolution',data:{decision:{type:'loseOwnLife',data:{amount:1}}}}}};
   const old = {context:frame.context,attemptId:crypto.randomUUID(),source:first.attempt.source,submission:first.attempt.submission};
   if (old.attemptId===fresh.attemptId || old.attemptId===first.attempt.attemptId) throw new Error('Distinct negative attempt required');
   probeStep='actor-register'; let actorRejected = false;
   try { await engine.submitLocalContinuation(1,{type:'localContinuation',operation:'register',attempt:fresh}); }
   catch (e) { if (e?.message!=='Authenticated Local continuation unavailable') throw new Error('Unexpected admission failure'); actorRejected=true; }
   if (!actorRejected) throw new Error('Wrong actor admitted');
   completedChecks.push('actor-refusal');
   const actorAfter = window.__p1Observe(), actorCountsAfter = counts(), actorHashesAfter = await checkpoint();
   probeStep='admission-invariant';
   if (!sameLocalContinuationValue(before,actorAfter) || !sameLocalContinuationValue(countsBefore,actorCountsAfter)
    || !sameLocalContinuationValue(hashesBefore,actorHashesAfter)) throw new Error('Admission refusal changed state');
   probeStep='old-register';
   const refused = await engine.submitLocalContinuation(0,{type:'localContinuation',operation:'register',attempt:old});
   const current = refused.current && unwrapClientGameState(refused.current.snapshot.state);
   if (refused.receipt?.status!=='notApplied' || refused.receipt.rejection?.code!=='invalid_interaction_response'
    || refused.receipt.result!==null || refused.appliedResult!==null || !sameLocalContinuationValue(old,refused.receipt.attempt)
    || !sameLocalContinuationValue(frame.context,refused.current?.context) || current?.players?.[0]?.life!==19) throw new Error('Old interaction not atomically refused');
   const oldAfter = window.__p1Observe(), oldCountsAfter = counts(), oldHashesAfter = await checkpoint();
   probeStep='old-invariant';
   if (!sameLocalContinuationValue(before,oldAfter) || !sameLocalContinuationValue(countsBefore,oldCountsAfter)
    || !sameLocalContinuationValue(hashesBefore,oldHashesAfter)) throw new Error('Old interaction refusal changed GameState/replay');
   completedChecks.push('old-refusal');
   result.refusals={method:'real-Worker-register-only-admission-and-old-interaction',calls:2,actor:1,
    admissionErrorMatched:true,admissionReceiptReturned:false,freshInteractionDifferentFromOld:true,
    oldBindingNewAttempt:true,separateNegativeAttempts:true,currentContextMatched:true,sameOriginal:true,
    rawOldStatus:refused.receipt.status,oldRejection:refused.receipt.rejection.code,resultNull:true,appliedResultNull:true,
    actorAfter,actorCountsAfter,actorHashesAfter,oldAfter,oldCountsAfter,oldHashesAfter,
    gameStateUnchanged:true,ledgerUnchangedClaim:false,refusalUi:false};
  }
  return result;
  } catch(error) { return nativeFailure(phase,probeStep,error,completedChecks); }
 };
 window.__p1LookupFirst = async () => {
  const [{unwrapClientGameState}, {sameLocalContinuationValue}] = await Promise.all([
   import('/src/adapter/wasm-adapter.ts'), import('/src/adapter/types.ts')]);
  const losses = originals.filter(r => r.attempt.submission.response.type==='manualResolution' && r.attempt.submission.response.data.decision.type==='loseOwnLife' && r.attempt.submission.response.data.decision.data.amount===1 && r.result?.events?.some(e => e.type==='LifeChanged' && e.data.player_id===0));
  if (losses.length !== 2) throw new Error('Two actual Apply originals required');
  const [first, second] = losses, a = first.attempt;
  const before = window.__p1Observe();
  const countsBefore = {publications, appliedResults:delivered, completed:unique.size};
  const reply = await useGameStore.getState().adapter.getEngineClient().submitLocalContinuation(0,
   {type:'localContinuation',operation:'lookup',attempt:a});
  const current = reply.current && unwrapClientGameState(reply.current.snapshot.state);
  const binding = {interactionId:a.submission.interactionId,adapterGeneration:a.context.adapterGeneration};
  const source = {stackEntryId:a.source.stackEntryId,sourceObjectId:a.source.sourceId,adapterGeneration:a.context.adapterGeneration};
  const request = {binding,command:{type:'lose-life',affectedPlayerId:0,amount:1,
   stackEntryId:a.source.stackEntryId,sourceObjectId:a.source.sourceId}};
  const reconciled = await cap.commandPortFactory(source).reconcileManualResolution(request);
  const after = window.__p1Observe();
  return {method:'native-read-only-original-lookup-and-client-terminal-cache-reconcile', nativeLookupCount:1,
   before, after, countsBefore, countsAfter:{publications,appliedResults:delivered,completed:unique.size},
   differentInteractions:a.submission.interactionId !== second.attempt.submission.interactionId,
   differentAttempts:a.attemptId !== second.attempt.attemptId,
   sameOriginal:sameLocalContinuationValue(a,reply.receipt?.attempt),
   sameSource:first.attempt.source.sourceId===second.attempt.source.sourceId && first.attempt.source.stackEntryId===second.attempt.source.stackEntryId,
   nativeStatus:reply.receipt?.status, nativeRejectionNull:reply.receipt?.rejection===null,
   sameOriginalResult:sameLocalContinuationValue(first.result,reply.receipt?.result), nativeAppliedResultNull:reply.appliedResult===null,
   historicalLifeChanges:(reply.receipt?.result?.events ?? []).filter(e=>e.type==='LifeChanged' && e.data.player_id===0).map(e=>({amount:e.data.amount,total:e.data.new_total})),
   historicalTerminalCount:(reply.receipt?.result?.events ?? []).filter(e=>e.type==='StackResolved').length,
   currentLife:current?.players?.map(p=>p.life),currentSourceId:current?.derived?.manual_resolution?.source?.sourceId,
   currentEntryId:current?.resolving_stack_entry?.id,currentPhase:current?.derived?.manual_resolution?.phase,
   sameContext:sameLocalContinuationValue(a.context,reply.current?.context),
   cacheStatus:reconciled.status,cacheOriginalBinding:sameLocalContinuationValue(binding,reconciled.binding),
   adapterPublishedHistoricalReply:false};
 };
 done(true);
}, () => done(false));
''', 'args': []})
    assert receipts is True
    passed('prepayment')
    stage = 'prepayment-full-control'
    click('[data-mobile-action-right] button[aria-label="Full Control Off"][aria-pressed="false"]')
    control_on = call('/execute/sync', {'script': 'return document.querySelector(\'[data-mobile-action-right] button[aria-label="Full Control On"][aria-pressed="true"]\') !== null;', 'args': []})
    report['full_control_confirmation'] = {'phase': 'on-confirmation', 'found': control_on}
    assert control_on is True
    report['prepayment_full_control'] = True
    stage = 'manual-card-select'
    click('[data-hand-card][data-object-id="' + str(pre['sourceCardId']) + '"]')
    stage = 'manual-options'
    click('//button[normalize-space()="Resolution options for P1 Self Loss"]', 'xpath')
    disclosure = call('/execute/sync', {'script': "return document.body.textContent.includes('Its automatic spell body will be skipped');", 'args': []})
    assert disclosure is True and observe()['ownManaCount'] == 2 and observe()['stackCount'] == 0
    report['prepayment_scope_visible'] = True
    passed('manual-options')
    stage = 'capture-prepayment'
    capture('prepayment')
    stage = 'manual-cast'
    click('//button[normalize-space()="Cast with manual resolution"]', 'xpath')
    state = wait_for(lambda x: x['waitingType'] == 'ManaPayment' or
        (x['waitingType'] == 'Priority' and x['ownManaCount'] == 1 and x['stackCount'] == 1))
    if state['waitingType'] == 'ManaPayment':
        click('//button[normalize-space()="Pay"]', 'xpath')
    paid = wait_for(lambda x: x['waitingType'] == 'Priority' and x['ownManaCount'] == 1 and x['stackCount'] == 1)
    assert paid['life'] == [20,20] and paid['manualPhase'] == 'armed'
    assert paid['sourceId'] == pre['sourceCardId'] and paid['resolvingEntryId'] is None
    report['manual_paid_before_begin'] = paid
    passed('manual-cast')
    stage = 'manual-response'
    opponent(20, 1, 'armed')
    began = wait_for(lambda x: x['manualPhase'] == 'open' and x['life'] == [20,20])
    assert began['sourceId'] == pre['sourceCardId'] and began['stackCount'] == 0 and began['ownManaCount'] == 1
    assert type(began['manualStackEntryId']) is int and began['resolvingEntryId'] == began['manualStackEntryId']
    assert began['publicEvents']['lifeChanges'] == [] and began['publicEvents']['sourceDepartures'] == 0 and began['publicEvents']['manualTerminals'] == 0
    report['begin'] = began
    passed('initial')
    stage = 'capture-same-source'
    capture('same-source')
    panel = '//section[@aria-labelledby][.//h2[normalize-space()="Manual resolution"]]'
    stage = 'player-area-select'
    label = call('/execute/sync', {'script': "return document.querySelector('[data-testid=\"player-area-0\"] > button[aria-pressed]')?.textContent;", 'args': []})
    assert isinstance(label, str) and 'You' in label and 'Opp 1' not in label
    click('[data-testid="player-area-0"] > button[aria-pressed]')
    report['own_area_label'] = 'You'
    changes = []
    for amount_value, total in ([(1,19),(1,18)] if SPLIT_APPLY else [(2,18)]):
        stage = 'life' + str(total)
        amount = element(panel + '//input[@type="number"]', 'xpath')
        call('/element/' + amount + '/clear', {})
        call('/element/' + amount + '/value', {'text': str(amount_value)})
        click(panel + '//button[@type="submit"]', 'xpath')
        life = wait_for(lambda x: x['life'] == [total,20] and x['manualPhase'] == 'open')
        changes.append({'amount': -amount_value, 'total': total})
        assert life['sourceId'] == began['sourceId'] and life['resolvingEntryId'] == began['manualStackEntryId']
        assert life['publicEvents']['lifeChanges'] == changes
        assert life['publicEvents']['sourceDepartures'] == 0 and life['publicEvents']['manualTerminals'] == 0
        report['life_first' if total == 19 else 'life_applied'] = life
        passed(stage)
        stage = 'capture-life' + str(total)
        capture('life' + str(total))
        if NATIVE_CHECKS:
            stage = 'native-original-checks'
            phase = 'before-second' if total == 19 else 'after-second'
            checked = call('/execute/async', {'script': "const done=arguments[arguments.length-1]; window.__p1NativeChecks(arguments[0]).then(done,()=>done({status:'failed',phase:arguments[0],step:'unhandled',completedChecks:[],reason:'unclassified-native-check-exception',exception:{name:'Unknown',message:null}}));", 'args': [phase]})
            report.setdefault('native_original_checks', []).append(checked)
            CHECKS.validate_native_original_checks(report, complete=total == 18)
    if SPLIT_APPLY:
        stage = 'historical-lookup'
        lookup = call('/execute/async', {'script': "const done=arguments[arguments.length-1]; window.__p1LookupFirst().then(done,()=>done(null));", 'args': []})
        report['historical_lookup'] = lookup
        CHECKS.validate_historical_lookup(report)
        passed('historical-lookup')
        stage = 'capture-historical-lookup'
        capture('historical-lookup')
    stage = 'finish'
    click(panel + '//button[normalize-space()="Finish"]', 'xpath')
    ended = wait_for(lambda x: CHECKS.finish_matches(began, x, own_life=18))
    assert ended['sourceInGraveyard'] is True and ended['ownManaCount'] == 1
    assert ended['publicEvents']['lifeChanges'] == changes
    assert ended['publicEvents']['sourceDepartures'] == 1 and ended['publicEvents']['manualTerminals'] == 1
    report['finished'] = ended
    passed('finish')
    stage = 'capture-finish'
    capture('finish')
    stage = 'paidplay-normal-direct'
    click('[data-hand-card][data-object-id="' + str(pre['nextCardId']) + '"]', double=True)
    stage = 'paidplay-payment'
    paying = wait_for(lambda x: x['waitingType'] == 'ManaPayment' or
        (x['waitingType'] == 'Priority' and x['stackCount'] == 1 and x['ownManaCount'] == 0))
    if paying['waitingType'] == 'ManaPayment':
        click('//button[normalize-space()="Pay"]', 'xpath')
    paid_next = wait_for(lambda x: x['waitingType'] == 'Priority' and x['stackCount'] == 1 and x['ownManaCount'] == 0)
    assert paid_next['life'] == [18,20] and paid_next['manualPhase'] == 'closed' and paid_next['resolvingEntryId'] is None
    report['paid_before_resolution'] = paid_next
    stage = 'paidplay-response'
    opponent(18, 0, 'closed')
    ordinary = wait_for(lambda x: x['life'] == [21,20] and x['stackCount'] == 0 and x['waitingType'] == 'Priority')
    assert ordinary['ownManaCount'] == 0 and ordinary['nextInGraveyard'] is True and ordinary['nextCardId'] is None
    assert ordinary['resolvingEntryId'] is None and ordinary['manualPhase'] == 'closed'
    assert ordinary['publicEvents']['lifeChanges'] == changes + [{'amount': 3, 'total': 21}]
    assert ordinary['publicEvents']['sourceDepartures'] == 1 and ordinary['publicEvents']['manualTerminals'] == 1
    assert ordinary['publicEvents']['nextDepartures'] == 1
    report['ordinary_completed'] = ordinary
    if NATIVE_CHECKS:
        stage = 'native-final-replay'
        replay = call('/execute/async', {'script': '''
const done=arguments[arguments.length-1];
(async()=>{
 const {useGameStore}=await import('/src/stores/gameStore.ts');
 const text=await useGameStore.getState().adapter.getEngineClient().exportReplayLog();
 const parsed=JSON.parse(text), entry=arguments[0];
 if (!Array.isArray(parsed.actions)) throw new Error('Replay actions unavailable');
 const matching=parsed.actions.filter(a=>a.actor===0 && a.action?.data?.stack_entry_id===entry);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
 done({method:'real-Worker-read-only-replay',sha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join(''),
  actions:parsed.actions.length,manualLife:matching.filter(a=>a.action.type==='ApplyManualLifeLoss').length,
  manualFinish:matching.filter(a=>a.action.type==='FinishManualResolution').length});
})().catch(()=>done(null));
''', 'args': [began['manualStackEntryId']]})
        report['native_final_replay'] = replay
        CHECKS.validate_native_original_checks(report, final=True)
    report['receipt_summary'] = call('/execute/sync', {'script': 'return window.__p1ReceiptSummary();', 'args': []})
    rs = report['receipt_summary']
    assert len(rs['completed']) == (4 if SPLIT_APPLY else 3) and rs['appliedResults'] == (4 if SPLIT_APPLY else 3)
    cast_receipts = [r for r in rs['completed'] if r['stackEntryId'] is None]
    operation_receipts = [r for r in rs['completed'] if r['stackEntryId'] == began['manualStackEntryId']]
    assert len(cast_receipts) == 1 and cast_receipts[0]['sourceId'] == began['sourceId']
    assert cast_receipts[0]['lifeChanges'] == [] and cast_receipts[0]['terminalCount'] == 0
    assert len(operation_receipts) == (3 if SPLIT_APPLY else 2)
    assert all(r['sourceId'] == began['sourceId'] and r['stackEntryId'] == began['manualStackEntryId'] for r in operation_receipts)
    assert sorted(r['terminalCount'] for r in operation_receipts) == ([0,0,1] if SPLIT_APPLY else [0,1])
    assert [e for r in operation_receipts for e in r['lifeChanges']] == changes
    passed('paidplay21')
    stage = 'capture-paidplay21'
    capture('paidplay21')
    report['primary'] = {'stage': 'operations-complete', 'code': 0, 'reason': 'completed'}
    report['status'] = 'passed'


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
Promise.all([import('/src/stores/gameStore.ts'), import('/src/stores/uiStore.ts'),
  import('/src/hooks/usePlayerId.ts'), import('/src/viewmodel/cardActionChoice.ts')]).then(
  ([{useGameStore}, {useUiStore}, {getPlayerId, getCanActForWaitingState}, {resolveSingleActionDispatch}]) => {
  window.__p1Observe = () => {
    const s = useGameStore.getState(), g = s.gameState;
    const v = g?.derived?.manual_resolution;
    const sourceId = Object.values(g?.objects ?? {}).find(o => o.name === 'P1 Self Loss')?.id ?? null;
    const vanilla = Object.values(g?.objects ?? {}).find(o => o.name === 'P1 Vanilla V') ?? null;
    const nextId = g?.players?.[0]?.hand?.find(id => g.objects?.[id]?.name === 'Next Ordinary Play') ?? null;
    if (nextId !== null) window.__p1NextSource = nextId;
    const nextObject = nextId === null ? null : g?.objects?.[nextId];
    const nextActions = nextId === null ? [] : s.legalActionsByObject?.[String(nextId)] ?? [];
    return {life: g?.players?.map(p => p.life) ?? [],
      vanilla: vanilla ? {id:vanilla.id,name:vanilla.name,zone:vanilla.zone,controller:vanilla.controller,
        inHand:(g?.players?.[0]?.hand ?? []).includes(vanilla.id),inBattlefield:(g?.battlefield ?? []).includes(vanilla.id),
        power:vanilla.power,toughness:vanilla.toughness,cost:vanilla.mana_cost,
        abilityCounts:['abilities','trigger_definitions','replacement_definitions','static_definitions','keywords'].map(k=>Array.isArray(vanilla[k])?vanilla[k].length:null),
        spellCasts:(s.eventHistory ?? []).filter(e=>e.type==='SpellCast' && e.data.object_id===vanilla.id).length,
        battlefieldEntries:(s.eventHistory ?? []).filter(e=>e.type==='ZoneChanged' && e.data.object_id===vanilla.id && e.data.from==='Stack' && e.data.to==='Battlefield').length,
        effects:(s.eventHistory ?? []).filter(e=>e.type==='EffectResolved' && e.data.source_id===vanilla.id).length} : null,
      sourceCardId: sourceId, sourceInHand: sourceId !== null && (g?.players?.[0]?.hand ?? []).includes(sourceId),
      sourceInGraveyard: sourceId !== null && (g?.players?.[0]?.graveyard ?? []).includes(sourceId),
      publicEvents: {lifeChanges: (s.eventHistory ?? []).filter(e=>e.type==='LifeChanged' && e.data.player_id===0).map(e=>({amount:e.data.amount,total:e.data.new_total})),
        sourceDepartures: (s.eventHistory ?? []).filter(e=>e.type==='ZoneChanged' && e.data.object_id===sourceId && e.data.from==='Stack' && e.data.to==='Graveyard').length,
        nextDepartures: (s.eventHistory ?? []).filter(e=>e.type==='ZoneChanged' && e.data.object_id===window.__p1NextSource && e.data.from==='Stack' && e.data.to==='Graveyard').length,
        manualTerminals: (s.eventHistory ?? []).filter(e=>e.type==='StackResolved' && e.data.object_id===v?.source?.stackEntryId).length},
      manualPhase: v?.phase ?? null, sourceId: v?.source?.sourceId ?? null,
      sourceName: v?.source?.name ?? null, stackCount: g?.stack?.length ?? null,
      manualStackEntryId: v?.source?.stackEntryId ?? null,
      resolvingEntryId: g?.resolving_stack_entry?.id ?? null,
      waitingType: s.waitingFor?.type ?? null,
      priorityPlayer: s.waitingFor?.type === 'Priority' ? s.waitingFor.data.player : null,
      ownManaCount: g?.players?.[0]?.mana_pool?.mana?.length ?? null,
      nextCardId: g?.players?.[0]?.hand?.find(id => g.objects?.[id]?.name === 'Next Ordinary Play') ?? null,
      nextPlayObservation: {localPlayerId: getPlayerId(), canActForWaitingState: getCanActForWaitingState(),
        debugInteractionMode: useUiStore.getState().debugInteractionMode, nextObjectExists: !!nextObject,
        legalActionCount: nextActions.length, legalActionTypes: nextActions.slice(0,20).map(a => a.type),
        legalActionObjectIds: nextActions.slice(0,20).map(a => a.data?.object_id ?? null),
        automaticActionType: nextObject ? resolveSingleActionDispatch(nextActions, nextObject)?.type ?? null : null,
        pendingChoiceObjectId: useUiStore.getState().pendingAbilityChoice?.objectId ?? null},
      nextInGraveyard: g?.players?.[0]?.graveyard?.some(id => g.objects?.[id]?.name === 'Next Ordinary Play') ?? false};
  };
  done(true);
}, () => done(false));
""", 'args': []})
    assert ready, 'Public observer module could not load'
    if AUTO_CONTROL:
        run_auto_control()
    elif PREPAYMENT:
        run_s1_1a()
    else:
        stage = 'initial'
        initial = wait_for(lambda s: s['manualPhase'] == 'open' and s['life'][:1] == [20])
        assert initial['sourceId'] is not None
        assert initial['stackCount'] == 0, 'K1 Begin already popped the sole ordinary stack entry'
        assert type(initial['manualStackEntryId']) is int and initial['resolvingEntryId'] == initial['manualStackEntryId']
        stage = 'checked-restore-k1'
        restore = checked_restore_current_k1()
        report['checked_restore_k1'] = restore
        assert restore.get('ok') is True and all(value is True for value in restore['contextChecks'].values())
        initial = wait_for(lambda current: current == restore['after'])
        for key in ['life', 'manualPhase', 'sourceId', 'sourceName', 'stackCount', 'manualStackEntryId', 'resolvingEntryId', 'waitingType', 'priorityPlayer', 'ownManaCount', 'nextCardId']:
            assert restore['before'][key] == restore['after'][key], 'K1 restore changed a public occurrence field'
        report['stages']['checked-restore-k1'] = {'status': 'passed', 'assertions_completed': True}
        report['assertions'].append('Live engine persistence exported in memory and authenticated K1 checked restore preserved public occurrence/Begin state while renewing session, epoch and adapter generation; subsequent Apply/Finish use current real UI')
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
        stage = 'paidplay-normal-direct'
        assert ended['ownManaCount'] == 1 and type(ended['nextCardId']) is int
        next_id = ended['nextCardId']
        click('[data-hand-card][data-object-id="' + str(next_id) + '"]', double=True)
        command = report['click_commands'][-1]
        events = command['native_input_observation']['events']
        command['dblclick_received_by_requested_card'] = any(e['type'] == 'dblclick' and e['trusted']
            and e['target']['withinRequestedCard'] for e in events if e.get('target'))
        assert command['dblclick_received_by_requested_card'], 'Native pointer pair did not deliver a trusted dblclick to the requested card'
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
        if paid['priorityPlayer'] == 0:
            stage = 'paidplay-own-pass-before-driver'
            resolve = resolve_control()
            assert resolve is not None
            before_own_pass = observe()
            assert before_own_pass['priorityPlayer'] == 0 and before_own_pass['stackCount'] == 1
            call('/element/' + resolve + '/click', {})
            report['own_pass_before_driver'] = {'method': 'native-own-Resolve', 'before': before_own_pass}
            wait_for(lambda current: current['waitingType'] == 'Priority' and current['priorityPlayer'] == 1
                     and current['stackCount'] == 1 and current['ownManaCount'] == 0)
        stage = 'fixture-opponent-pass'
        driver = drive_fixture_opponent_pass_once()
        report['fixture_opponent_driver'] = driver
        assert driver.get('ok') is True and type(driver.get('commands')) is int and driver['commands'] == 1
        report['stages']['fixture-opponent-pass'] = {'status': 'passed', 'assertions_completed': True}
        stage = 'paidplay-resolve'
        # Explicit fixture opponent pass uses the ordinary command pipeline. Any
        # remaining own pass still uses the actual UI; never click again
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
        report['assertions'].append('Existing ordinary card double-click paid the remaining one mana; normal priority resolution gained exactly three life to22, moved the next card to graveyard and left no manual carrier')
        report['primary'] = {'stage': 'operations-complete', 'code': 0, 'reason': 'completed'}
        report['status'] = 'passed'
except Exception as error:
    exit_code = 1
    report['status'] = 'failed'
    report['error_type'] = type(error).__name__
    reason = ('required-capture-failed' if stage.startswith('capture-')
              else 'required-control-not-visible-and-enabled' if report.get('control_acquisition_failure', {}).get('operation') == stage
              else 'full-control-on-not-confirmed' if stage == 'prepayment-full-control' and 'full_control_confirmation' in report and report['full_control_confirmation'].get('found') is not True
              else 'native-double-click-not-observed' if report.get('click_commands', [{}])[-1].get('reason') == 'native-double-click-not-observed'
              else 'webdriver-command-failed' if 'webdriver_error' in report
              else 'operation-assertion-failed' if isinstance(error, AssertionError)
              else 'scenario-command-failed')
    report['primary'] = {'stage': stage, 'code': 1, 'reason': reason}
    if stage in {'capture-control-completed', 'capture-finish', 'capture-paidplay21', 'capture-paidplay22'} and all(item['assertions_completed'] is True for item in report['stages'].values()):
        report['primary'] = {'stage': 'operations-complete', 'code': 0, 'reason': 'completed'}
        report['secondary'].append({'stage': stage, 'code': 1, 'reason': 'required-capture-failed'})
        report['status'] = 'incomplete'
finally:
    if PREPAYMENT:
        try:
            report['receipt_observer_stopped'] = call('/execute/sync', {'script': 'return window.__p1StopReceipts ? window.__p1StopReceipts() : true;', 'args': []})
        except Exception:
            report['secondary'].append({'stage': 'receipt-observer-cleanup', 'code': 1, 'reason': 'receipt-observer-cleanup-failed'})
            exit_code = exit_code or 1
            report['status'] = 'incomplete' if report['primary']['code'] == 0 else 'failed'
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
