// Two bounded response faults through the real App/GamePage/GameProvider route.
// Fixed saved decks are inputs; no game-store setup or harness action submission.
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import i18n from './src/i18n';
import { App } from './src/App';
import { useGameStore } from './src/stores/gameStore';
import { useUiStore } from './src/stores/uiStore';
import { usePreferencesStore } from './src/stores/preferencesStore';
import { useConnectivityStore } from './src/stores/connectivityStore';
import { currentLocalHistory } from './src/game/localHistorySession';
import { equalRekey, stable } from './qa-history-comparator.mjs';

const check = (ok, code) => { if (!ok) throw Error(code); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = async raw => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), n => n.toString(16).padStart(2, '0')).join('');
const game = () => useGameStore.getState();
const workers = [], checks = [], scenarios = [], NativeWorker = globalThis.Worker;
let serial = 0, targetSerial = 0, stage = 'bootstrap', root, owned;
class ObservedWorker extends NativeWorker {
  identity = ++serial; handler = null; requests = {}; pending = new Map();
  gameId = null; adapter = null; terminated = false; gate = null; held = null;
  restores = []; exports = []; mutationCount = 0;
  constructor(url, options) {
    super(url, options); workers.push(this);
    this.addEventListener('message', event => {
      const request = this.pending.get(event.data.id);
      if (!request) return this.deliver(event);
      if (request.type === 'exportState' && event.data.type === 'result') this.exports.push(event.data.data);
      if (request.type === this.gate) {
        check(event.data.type === 'result', 'fault-injection-requires-real-success-response');
        this.gate = null;
        const handler = this.handler;
        const held = { request, id: event.data.id, responseType: event.data.type,
          release: () => { this.held = null; this.deliver(event); },
          fail: () => { this.held = null; this.deliver(new MessageEvent('message', { data: { type: 'error', id: event.data.id, message: 'QA injected unknown reply failure' } })); },
          replaySettledOriginal: () => handler?.call(this, event) };
        this.held = held; return;
      }
      this.deliver(event);
    });
  }
  set onmessage(handler) { this.handler = handler; }
  get onmessage() { return this.handler; }
  deliver(event) { this.pending.delete(event.data.id); this.handler?.call(this, event); }
  postMessage(message, transfer) {
    this.pending.set(message.id, { type: message.type, actionType: message.action?.type });
    this.requests[message.type] = (this.requests[message.type] ?? 0) + 1;
    if (['submitAction', 'submitInteraction', 'restoreState', 'initializeGame', 'resetGame', 'applySeatMutation'].includes(message.type)) this.mutationCount++;
    if (message.type === 'initializeGame') { this.gameId = game().gameId; this.adapter = game().adapter; }
    if (message.type === 'restoreState') this.restores.push(message.stateJson);
    super.postMessage(message, transfer ?? []);
  }
  terminate() { super.terminate(); this.terminated = true; this.pending.clear(); this.handler = null; this.held = null; }
}
globalThis.Worker = ObservedWorker;
const observations = () => workers.map(w => ({ identity: w.identity, gameId: w.gameId, terminated: w.terminated, requests: w.requests }));
function mark(name) { checks.push(name); globalThis.__qaProgress = { stage, checks: [...checks], route: location.pathname, localHistory: game().localHistory }; }
async function until(predicate, code) { for (let n = 0; n < 2400; n++) { if (predicate()) return; await wait(10); } check(false, code); }
function visible(element) {
  const r = element?.getBoundingClientRect();
  if (!r || !r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight) return false;
  for (const fx of [.5, .2, .8]) for (const fy of [.5, .2, .8]) {
    const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
    if (hit && (hit === element || element.contains(hit))) return true;
  }
  return false;
}
async function input(selector, screenshot, key) {
  globalThis.__qaUiRequest = { selector, screenshot, key };
  await new Promise(resolve => { globalThis.__qaUiClicked = resolve; });
}
async function button(text, screenshot) {
  let found;
  await until(() => { found = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled && visible(b)); return !!found; }, `real-visible-button:${text}`);
  found.dataset.qaRouteTarget = String(++targetSerial);
  await input(`[data-qa-route-target="${targetSerial}"]`, screenshot);
}
async function peek() {
  await until(() => visible(document.querySelector('button[aria-label="Move dialog out of the way"]')), 'real-mulligan-peek-visible');
  await input('button[aria-label="Move dialog out of the way"]');
  await wait(350);
}
async function restorePeek() {
  const b = document.querySelector('button[aria-label="Restore dialog"]');
  check(visible(b), 'real-peek-restore-visible'); b.dataset.qaRouteTarget = String(++targetSerial);
  await input(`[data-qa-route-target="${targetSerial}"]`); await wait(350);
}
async function status(notice, screenshot) {
  const text = i18n.t(`game:board.localHistory.${notice}`);
  await peek();
  await until(() => [...document.querySelectorAll('[role="status"]')].some(e => e.textContent.trim() === text && visible(e)), 'recovery-or-stop-notice-visible-on-board');
  // A real menu click captures the visible board/status without altering game state.
  await input('button[aria-label="Game menu"]', screenshot);
  await input('button[aria-label="Game menu"]');
  return text;
}
function view() {
  const s = game(), ui = useUiStore.getState();
  return { state: s.gameState, legal: { actions: s.legalActions, byObject: s.legalActionsByObject, autoPassRecommended: s.autoPassRecommended,
    spellCosts: s.spellCosts, manaPaymentShortcutActions: s.manaPaymentShortcutActions, offers: s.endContinuousEffectOffers,
    activationBlockReasons: s.activationBlockReasons, stuckDiagnostic: s.stuckDiagnostic },
    logs: s.logHistory, events: s.eventHistory, nextLogSeq: s.nextLogSeq,
    pending: { selected: ui.selectedCardIds, ability: ui.pendingAbilityChoice, attackers: ui.selectedAttackers, blocker: ui.pendingBlocker, mobile: ui.mobileHandGesture },
    history: s.localHistory, oldRing: s.stateHistory.length, seq: s.lastCommittedSeq, generation: s.gameSessionGeneration, gameId: s.gameId };
}
function sameDisplay(pre) {
  const now = view();
  const publicState = state => {
    const copy = { ...state };
    for (const key of ['interaction_session_id', 'interaction_generation', 'next_interaction_serial', 'active_interaction_slots']) delete copy[key];
    return JSON.stringify(stable(copy));
  };
  check(publicState(now.state) === publicState(pre.state), 'restored-public-state-matches-pre-except-fresh-interaction-authority');
  for (const key of ['legal', 'logs', 'events', 'nextLogSeq', 'pending']) check(JSON.stringify(now[key]) === JSON.stringify(pre[key]), `restored-${key}-matches-pre`);
  check(now.history.entries === pre.history.entries && now.oldRing === 0, 'history-cursor-pre-old-ring-unused');
}
const raw = () => game().adapter.exportPersistenceState();
function path(id) { return `/game/${id}?mode=local&history=1&format=Limited&players=2&first=play`; }
async function start(id, first = false) {
  stage = `normal-route-init:${id}`;
  if (first) { history.replaceState(null, '', path(id)); const node = document.createElement('div'); node.id = 'root'; document.body.append(node); root = createRoot(node); root.render(React.createElement(App)); }
  else { history.pushState({ usr: null, key: crypto.randomUUID(), idx: (history.state?.idx ?? 0) + 1 }, '', path(id)); dispatchEvent(new PopStateEvent('popstate')); }
  await until(() => game().gameId === id && currentLocalHistory()?.ownsSession() && game().localHistory?.phase === 'idle', 'normal-GameProvider-initialized-owned-history');
  owned = workers.find(w => w.gameId === id && w.adapter === game().adapter && !w.terminated);
  check(owned && workers.filter(w => w.gameId === id && !w.terminated).length === 1, 'initializeGame-identifies-owned-worker-not-creation-order');
  await until(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Keep Hand' && visible(b)), 'normal-GamePage-opening-mulligan-ready');
  check(game().gameMode === 'local' && game().stateHistory.length === 0, 'new-Local-experiment-only');
  mark('normal-App-GamePage-GameProvider-dedicated-worker-owned-init');
}
async function holdKeep() {
  const worker = owned, before = await raw(), pre = view();
  const submits = worker.requests.submitAction;
  worker.gate = 'submitAction'; await button('Keep Hand');
  await until(() => !!worker.held, 'real-Keep-submit-result-held');
  check(worker.held.request.actionType === 'MulliganDecision' && worker.pending.has(worker.held.id), 'actual-UI-request-unsettled');
  const applied = await raw();
  check(!JSON.parse(applied).state.waiting_for.data.pending.some(e => e.player === 0), 'engine-applied-Keep-before-reply-fault');
  check(game().localHistory.phase === 'busy' && game().localHistory.entries === pre.history.entries && game().gameState === pre.state, 'lock-keeps-client-pre-before-unknown-result');
  await button('Keep Hand');
  check(worker.requests.submitAction === submits + 1 && document.querySelector('[data-local-history-undo]').disabled, 'inflight-repeat-UI-and-Undo-send-nothing');
  return { worker, before, pre, applied, submits, held: worker.held };
}
async function realKeepUndo(preRaw, preView) {
  const submits = owned.requests.submitAction, roots = game().localHistory.entries;
  await button('Keep Hand');
  await until(() => game().localHistory.phase === 'idle' && game().localHistory.entries === roots + 1, 'real-UI-Keep-accepted');
  check(owned.requests.submitAction === submits + 1, 'one-real-UI-root-one-submission');
  const post = await raw();
  // Opponent-deciding overlay covers the HUD button. Use actual existing Z,
  // never call store.undo or invent a hotseat/actor-1 setup operation.
  await input(null, null, 'z');
  await until(() => game().localHistory.phase === 'idle' && game().localHistory.entries === roots, 'existing-Z-Undo-terminal');
  equalRekey(preRaw, await raw()); sameDisplay(preView);
  return { origin: 'real-GamePage-Keep-Hand', undoOrigin: 'existing-Z-CDP-keyboard', postSha256: await hash(post), restoredPreSha256: await hash(await raw()) };
}
async function campaign() {
  await i18n.changeLanguage('en');
  // Normal saved-library inputs; no fixture engine or store.initGame shortcut.
  localStorage.setItem('phase-deck:QA Local Forest', JSON.stringify({ main: [{ name: 'Forest', count: 40 }], sideboard: [], format: 'Limited' }));
  localStorage.setItem('phase-deck:QA Local Island', JSON.stringify({ main: [{ name: 'Island', count: 40 }], sideboard: [], format: 'Limited' }));
  localStorage.setItem('phase-active-deck', 'QA Local Forest');
  useConnectivityStore.getState().setForcedOffline(true);
  usePreferencesStore.setState({ nativeEngineEnabled: false, phaseStops: [], priorityPassingMode: 'FullControl', animationSpeedMultiplier: 0,
    aiSeats: [{ difficulty: 'Medium', deckId: 'saved:QA Local Island' }], aiBracketFilter: null, cedhMode: false });
  const firstId = crypto.randomUUID(); await start(firstId, true);
  stage = 'scenario-one-auto-recovery';
  const one = await holdKeep();
  one.worker.gate = 'getSnapshot'; one.held.fail();
  await until(() => !!one.worker.held && game().localHistory.phase === 'recovery', 'known-PRE-recovery-fence-held');
  check(one.worker.held.request.type === 'getSnapshot' && one.worker.pending.has(one.worker.held.id), 'recovery-real-fence-unsettled');
  await button('Keep Hand');
  check(one.worker.requests.submitAction === one.submits + 1 && !game().localHistory.canUndo, 'recovery-input-lock-no-extra-mutation');
  one.worker.held.release();
  await until(() => game().localHistory.phase === 'idle' && game().localHistory.notice === 'rolledBack', 'known-PRE-auto-recovery-adopted');
  check(one.worker.restores.at(-1) === one.before, 'recovery-exact-engine-export-PRE');
  const restored = await raw(); equalRekey(one.before, restored); sameDisplay(one.pre);
  const recoveredNotice = await status('rolledBack', 'route-recovered'); await restorePeek();
  const continueResult = await realKeepUndo(restored, view());
  scenarios.push({ scenario: 1, pass: true, action: 'MulliganDecision/Keep', gameWorker: one.worker.identity,
    engineAppliedBeforeFault: true, responseFaults: 1, recoveryFenceHeld: true, duplicateAndRecoverySubmits: 1,
    exactRawPreUsed: true, fullEngineRekeyMatch: true, legalHistoryPendingMatch: true, visibleNotice: recoveredNotice, continuation: continueResult });
  mark('one-unknown-real-UI-reply-auto-PRE-recovery-visible-continue-Undo-PASS');
  stage = 'scenario-two-stop-exit-new-route';
  const two = await holdKeep(), retiredAdapter = game().adapter;
  two.worker.gate = 'restoreState'; two.held.fail();
  await until(() => !!two.worker.held && two.worker.held.request.type === 'restoreState', 'real-recovery-restore-response-held');
  const oldRestore = two.worker.held;
  check(two.worker.restores.at(-1) === two.before, 'failed-recovery-attempt-exact-PRE');
  oldRestore.fail();
  await until(() => game().localHistory.phase === 'stopped' && two.worker.terminated, 'failed-recovery-stops-owned-executor');
  const mutations = two.worker.mutationCount, stopped = JSON.stringify(view());
  await button('Keep Hand');
  check(two.worker.mutationCount === mutations && JSON.stringify(view()) === stopped && !game().localHistory.canUndo, 'stopped-repeat-real-UI-no-mutation-no-history-fallback');
  const stopNotice = await status('blocked', 'route-stopped');
  await input('button[aria-label="Game menu"]'); await button('Main Menu');
  await until(() => location.pathname === '/' && !currentLocalHistory() && game().adapter === null, 'existing-menu-exit-runs-Provider-cleanup');
  check(two.worker.terminated, 'exit-owned-worker-terminated');
  const newId = crypto.randomUUID(); await start(newId);
  check(owned !== two.worker && owned.adapter !== retiredAdapter && owned.gameId === newId, 'new-route-new-dedicated-worker-and-owner');
  const newPre = await raw(), newView = view(), newerWorker = owned;
  const continuation = await realKeepUndo(newPre, newView);
  const beforeLate = await raw(), beforeLateView = JSON.stringify(view()), beforeMutations = newerWorker.mutationCount;
  two.held.replaySettledOriginal(); oldRestore.replaySettledOriginal(); retiredAdapter.dispose();
  await wait(350);
  check(await raw() === beforeLate && JSON.stringify(view()) === beforeLateView && newerWorker.mutationCount === beforeMutations && currentLocalHistory()?.ownsSession(), 'settled-old-duplicate-response-and-repeated-teardown-cannot-change-new-session');
  // Verify continued UI operation/Undo after the retired-response challenge too.
  await realKeepUndo(beforeLate, view());
  scenarios.push({ scenario: 2, pass: true, action: 'MulliganDecision/Keep', responseFaults: 1, restoreReplyFaults: 1,
    stoppedPhase: true, visibleNotice: stopNotice, additionalStoppedMutations: 0, exit: 'real-Mulligan-Peek-GameMenu-MainMenu',
    oldWorker: two.worker.identity, oldWorkerTerminated: two.worker.terminated, newWorker: newerWorker.identity,
    newRoute: newId, continuation, oldSettledResultDuplicatesReplayed: 2, repeatedOldAdapterDispose: true, newStateLegalHistoryPendingLockUnchanged: true });
  mark('recovery-failure-stopped-real-exit-new-Local-old-settled-response-isolation-UI-Undo-PASS');
  stage = 'complete'; const workerObservations = observations(); root.unmount();
  check(newerWorker.terminated && !currentLocalHistory(), 'final-real-App-unmount-owned-worker-ended');
  return { pass: true, stage, checks, scenarios, workerObservations, normalRoute: 'real App with DevStrict GamePage/GameProvider; new Local deep link through BrowserRouter; no store.initGame/ProductSurface/direct dispatcher setup',
    faultBoundary: 'owned normal Worker result delivery only; original requests/engine state unchanged',
    limitations: ['Keep mutation only; Local seat-1 UI is not connected, so normal land route not claimed', 'fresh route reached by Browser history, not a Setup start button campaign', 'old request errors settled before delayed original duplicate replay; not an unsettled old continuation across sessions', 'no full spell lifecycle, AI, P2P, two-seat UI, Safari or retained heap campaign'] };
}
globalThis.__qaStart = () => { void campaign().then(r => { globalThis.__qaResult = r; }, error => {
  globalThis.__qaResult = { pass: false, stage, failure: String(error), checks, scenarios, route: location.pathname,
    waitingFor: game().waitingFor, localHistory: game().localHistory, ui: document.body.innerText.slice(0, 1600), workerObservations: observations() };
  root?.unmount();
}); };
