"""One product-board smoke: trusted K1 -> life 20 to 19 -> Finish.

This is a bounded independent smoke, not the unavailable migration scenario
and not S1-S12 acceptance. Only public observations are written.
"""
import datetime
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(os.environ['MANUAL_EVIDENCE'])
VALIDATION = Path(__file__).resolve().parents[2]
SESSION = os.environ['P1_WEBDRIVER_SESSION']
BASE = 'http://127.0.0.1:9515/session/' + SESSION
report = {'scope': 'Local product UI smoke only; Undo and S1-S12 unaccepted',
          'fixture': '1c.K1', 'status': 'starting', 'assertions': [],
          'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}


def call(path, data=None):
    request = urllib.request.Request(BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=65) as response:
        value = json.load(response)['value']
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


def click(selector):
    call('/element/' + element(selector) + '/click', {})


def capture(step):
    call('/execute/async', {'script': 'const done = arguments[arguments.length-1]; requestAnimationFrame(() => requestAnimationFrame(() => done(true)));', 'args': []})
    subprocess.run(['python3', str(VALIDATION / 'scripts/ci/p1-product-capture.py'),
        '--evidence', str(ROOT), '--step', step,
        '--state-script', str(VALIDATION / 'scripts/ci/p1-public-state.js')], check=True)


try:
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
      waitingType: s.waitingFor?.type ?? null};
  };
  done(true);
}, () => done(false));
""", 'args': []})
    assert ready, 'Public observer module could not load'
    initial = wait_for(lambda s: s['manualPhase'] == 'open' and s['life'][:1] == [20])
    assert initial['sourceId'] is not None
    panel = '//section[@aria-labelledby][.//h2[normalize-space()="Manual resolution"]]'
    element(panel, 'xpath')
    capture('same-source')
    report['assertions'].append('trusted fixture reached Manual Open with own life 20')
    click('[data-testid="player-area-0"] > button[aria-pressed]')
    amount = element(panel + '//input[@type="number"]', 'xpath')
    call('/element/' + amount + '/clear', {})
    call('/element/' + amount + '/value', {'text': '1'})
    call('/element/' + element(panel + '//button[@type="submit"]', 'xpath') + '/click', {})
    after_life = wait_for(lambda s: s['life'][:1] == [19] and s['manualPhase'] == 'open')
    assert after_life['sourceId'] == initial['sourceId']
    capture('life19')
    report['assertions'].append('real Apply click lost one life on the same open source')
    # Locate the existing visible Finish button, then issue a real WebDriver click.
    finish = element(panel + '//button[normalize-space()="Finish"]', 'xpath')
    call('/element/' + finish + '/click', {})
    ended = wait_for(lambda s: s['manualPhase'] in [None, 'closed']
                     and s['stackCount'] == initial['stackCount'] - 1)
    assert ended['life'][0] == 19
    capture('finish')
    report['assertions'].append('real Finish click closed and removed exactly one stack entry; life stayed 19')
    report['status'] = 'passed'
except Exception as error:
    report['status'] = 'failed'
    report['error_type'] = type(error).__name__
    raise
finally:
    report['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    report['consumer'] = json.loads((ROOT / 'manifest.json').read_text())['consumer']
    (ROOT / 'ui-smoke-report.json').write_text(json.dumps(report, indent=2) + '\n')
