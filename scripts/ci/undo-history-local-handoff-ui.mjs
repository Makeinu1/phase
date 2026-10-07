// Finite real App Local hotseat flow. Deck seeds and response holds are QA inputs;
// all game operations, seat handoffs and Undo are ordinary product CDP clicks.
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import i18n from './src/i18n';
import { App } from './src/App';
import { useGameStore } from './src/stores/gameStore';
import { useUiStore } from './src/stores/uiStore';
import { usePreferencesStore } from './src/stores/preferencesStore';
import { useConnectivityStore } from './src/stores/connectivityStore';
import { getPlayerId } from './src/hooks/usePlayerId';
import { currentLocalHistory } from './src/game/localHistorySession';
import { equalRekey, stable } from './qa-history-comparator.mjs';

const check = (ok, code) => { if (!ok) throw Error(code); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const game = () => useGameStore.getState();
const hash = async raw => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), n => n.toString(16).padStart(2, '0')).join('');
const NativeWorker = globalThis.Worker, workers = [], checks = [], handoffs = [];
let stage = 'bootstrap', serial = 0, targetSerial = 0, root, owned;
class ObservedWorker extends NativeWorker {
  identity = ++serial; handler = null; pending = new Map(); requests = {}; actions = []; gate = null; held = null;
  gameId = null; adapter = null; terminated = false; restores = [];
  constructor(url, options) {
    super(url, options); workers.push(this);
    this.addEventListener('message', event => {
      const request = this.pending.get(event.data.id);
      if (request?.record) request.record.responseType = event.data.type;
      if (request?.type === this.gate) {
        check(event.data.type === 'result', 'hold-requires-real-worker-success'); this.gate = null;
        this.held = { requestType: request.type, release: () => { this.held = null; this.deliver(event); } }; return;
      }
      this.deliver(event);
    });
  }
  set onmessage(handler) { this.handler = handler; }
  get onmessage() { return this.handler; }
  deliver(event) { this.pending.delete(event.data.id); this.handler?.call(this, event); }
  postMessage(message, transfer) {
    const request = { type: message.type };
    this.requests[message.type] = (this.requests[message.type] ?? 0) + 1;
    if (message.type === 'submitAction') { request.record = { actor: message.actor, action: message.action }; this.actions.push(request.record); }
    if (message.type === 'initializeGame') { this.gameId = game().gameId; this.adapter = game().adapter; }
    if (message.type === 'restoreState') this.restores.push(message.stateJson);
    this.pending.set(message.id, request); super.postMessage(message, transfer ?? []);
  }
  terminate() { super.terminate(); this.terminated = true; this.pending.clear(); this.handler = null; }
}
globalThis.Worker = ObservedWorker;
async function until(predicate, code) { for (let n = 0; n < 2400; n++) { if (predicate()) return; await wait(10); } check(false, code); }
function visible(element) {
  const r = element?.getBoundingClientRect(); if (!r || !r.width || !r.height) return false;
  for (const fx of [.5, .2, .8]) for (const fy of [.5, .2, .8]) {
    const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
    if (hit && (hit === element || element.contains(hit))) return true;
  } return false;
}
async function input(selector, options = {}) {
  globalThis.__qaUiRequest = { selector, ...options };
  await new Promise(resolve => { globalThis.__qaUiClicked = resolve; });
}
async function button(text) {
  let found;
  await until(() => { found = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled && visible(b)); return !!found; }, `real-visible-enabled-button:${text}`);
  found.dataset.qaHandoffTarget = String(++targetSerial); await input(`[data-qa-handoff-target="${targetSerial}"]`);
}
const raw = () => game().adapter.exportPersistenceState();
const pending = () => game().waitingFor?.type === 'MulliganDecision' ? game().waitingFor.data.pending.map(e => e.player) : [];
const view = () => {
  const s = game(), ui = useUiStore.getState();
  return { state: s.gameState, legal: { actions: s.legalActions, byObject: s.legalActionsByObject, autoPassRecommended: s.autoPassRecommended,
    spellCosts: s.spellCosts, shortcuts: s.manaPaymentShortcutActions, offers: s.endContinuousEffectOffers, activationBlockReasons: s.activationBlockReasons, stuckDiagnostic: s.stuckDiagnostic },
    logs: s.logHistory, events: s.eventHistory, currentEvents: s.events, nextLogSeq: s.nextLogSeq,
    pending: { selected: ui.selectedCardIds, ability: ui.pendingAbilityChoice, attackers: ui.selectedAttackers, blocker: ui.pendingBlocker },
    entries: s.localHistory.entries, seat: getPlayerId(), phaseStops: usePreferencesStore.getState().phaseStops,
    priorityMode: usePreferencesStore.getState().priorityPassingMode, fullControl: ui.fullControl, manualMana: ui.manualManaOverride };
};
function mark(name) { checks.push(name); globalThis.__qaProgress = { stage, checks: [...checks], localHistory: game().localHistory, waitingFor: game().waitingFor }; }
async function verifySelectedHand(seat) {
  const expected = seat === 0 ? 'Forest' : 'Island', other = seat === 0 ? 1 : 0;
  await until(() => document.querySelectorAll('[data-hand-card]').length > 0, 'selected-hand-rendered-after-explicit-reveal');
  const state = game().gameState, ids = state.players[seat].hand, otherIds = state.players[other].hand;
  const displayed = [...document.querySelectorAll('[data-hand-card]')].map(e => Number(e.dataset.objectId));
  check(getPlayerId() === seat && displayed.length === ids.length && displayed.every(id => ids.includes(id)), 'actual-hand-DOM-belongs-only-to-explicit-selected-seat');
  check(ids.length > 0 && ids.every(id => state.objects[id]?.name === expected), 'viewer-hand-identities-match-selected-fixed-deck');
  check(otherIds.every(id => !displayed.includes(id) && state.objects[id]?.name === 'Hidden Card'), 'other-hand-identities-engine-masked-and-no-private-hand-DOM');
  return { seat, expected, handCount: ids.length, otherHandCount: otherIds.length, selectedHandMatches: true, otherHandMasked: true };
}
async function handoff(seat) {
  const before = await raw(), seq = game().lastCommittedSeq, entries = game().localHistory.entries, actions = owned.actions.length;
  await input(`[data-local-seat-handoff="${seat}"]`);
  await until(() => game().localHistory?.concealed && game().localHistory.viewerReady && game().localHistory.phase === 'idle', 'handoff-filtered-view-and-legals-ready-before-reveal');
  check(!document.querySelector('[data-player-hand]') && !document.querySelector('[data-hand-card]'), 'handoff-no-private-hand-DOM');
  check(document.querySelector('[data-local-seat-hidden="true"]') && getPlayerId() === seat, 'handoff-opaque-boundary-and-explicit-seat');
  const after = await raw();
  check(before === after && game().lastCommittedSeq === seq && game().localHistory.entries === entries && owned.actions.length === actions, 'handoff-no-engine-mutation-or-history-seq');
  await input('[data-local-seat-reveal="true"]');
  await until(() => !game().localHistory.concealed && visible(document.querySelector(`[data-local-selected-seat="${seat}"]`)), 'receiver-explicitly-reveals-matching-seat');
  check(usePreferencesStore.getState().priorityPassingMode === (game().gameState.priority_passing_modes?.[seat] ?? 'Standard'), 'seat-settings-match-engine-no-other-seat-POST');
  handoffs.push({ seat, entries, seq, submits: actions, engineUnchanged: true, handView: await verifySelectedHand(seat) });
}
async function campaign() {
  await i18n.changeLanguage('en');
  localStorage.setItem('phase-deck:QA Local Forest', JSON.stringify({ main: [{ name: 'Forest', count: 40 }], sideboard: [], format: 'Limited' }));
  localStorage.setItem('phase-deck:QA Local Island', JSON.stringify({ main: [{ name: 'Island', count: 40 }], sideboard: [], format: 'Limited' }));
  localStorage.setItem('phase-active-deck', 'QA Local Forest');
  useConnectivityStore.getState().setForcedOffline(true);
  usePreferencesStore.setState({ nativeEngineEnabled: false, phaseStops: [], priorityPassingMode: 'FullControl', animationSpeedMultiplier: 0,
    aiSeats: [{ difficulty: 'Medium', deckId: 'saved:QA Local Island' }], aiBracketFilter: null, cedhMode: false });
  const gameId = crypto.randomUUID();
  history.replaceState(null, '', `/game/${gameId}?mode=local&history=1&format=Limited&players=2&first=play`);
  const node = document.createElement('div'); node.id = 'root'; document.body.append(node); root = createRoot(node); root.render(React.createElement(App));
  await until(() => game().gameId === gameId && currentLocalHistory()?.ownsSession() && game().localHistory?.phase === 'idle' && pending().length === 2, 'real-new-Local-owned-opening');
  owned = workers.find(w => !w.terminated && w.gameId === gameId && w.adapter === game().adapter);
  check(owned && workers.filter(w => !w.terminated && w.gameId === gameId).length === 1, 'one-owned-dedicated-worker');
  check(owned.actions.length === 2 && owned.actions.every(a => a.actor === 0 && ['SetPhaseStops', 'SetPriorityPassingMode'].includes(a.action.type)), 'existing-two-startup-preferences-only');
  stage = 'real-Keep-zero-and-busy-switch-rejection'; owned.gate = 'submitAction'; await button('Keep Hand');
  await until(() => owned.held && game().localHistory.phase === 'busy', 'real-Keep-response-held-at-existing-Worker-boundary');
  const count = owned.actions.length, disabled = document.querySelector('[data-local-seat-handoff="1"]');
  check(disabled?.disabled && getPlayerId() === 0, 'busy-handoff-disabled');
  await input('[data-local-seat-handoff="1"]', { attemptDisabled: true });
  check(getPlayerId() === 0 && !game().localHistory.concealed && owned.actions.length === count, 'real-click-busy-handoff-rejected-without-submit');
  owned.held.release(); await until(() => game().localHistory.phase === 'idle' && JSON.stringify(pending()) === '[1]', 'Keep-zero-terminal');
  await verifySelectedHand(0); mark('Keep-zero-and-busy-switch-rejection');
  stage = 'explicit-seat-one-Keep'; await handoff(1); await button('Keep Hand');
  await until(() => game().localHistory.phase === 'idle' && !['MulliganDecision', 'OpeningHandBottomCards'].includes(game().waitingFor?.type), 'both-real-Keep-complete');
  check(owned.actions.filter(a => a.action.type === 'MulliganDecision').map(a => a.actor).join(',') === '0,1', 'two-Keep-actions-explicitly-authored-by-separate-selected-seats');
  check(getPlayerId() === 1, 'waiting-actor-does-not-auto-switch-selected-seat');
  mark('explicit-handoff-and-Keep-one');
  stage = 'ordinary-passes-to-land'; let passes = 0;
  for (let n = 0; n < 16; n++) {
    if (getPlayerId() !== 0 && game().waitingFor?.data?.player === 0) await handoff(0);
    if (getPlayerId() === 0 && game().legalActions.some(a => a.type === 'PlayLand')) break;
    const actor = game().waitingFor?.data?.player;
    check(game().waitingFor?.type === 'Priority' && Number.isInteger(actor), 'finite-opening-awaits-normal-priority');
    if (getPlayerId() !== actor) await handoff(actor);
    let control;
    const passTooltip = i18n.t('game:actionButton.priorityTooltip').trim();
    await until(() => {
      const controls = [...document.querySelectorAll('[data-action-button-panel] button[aria-describedby]')].filter(b => !b.disabled && visible(b) && document.getElementById(b.getAttribute('aria-describedby'))?.textContent.trim() === passTooltip);
      check(controls.length <= 1, 'ordinary-PassPriority-control-is-unambiguous'); control = controls[0]; return !!control;
    }, 'real-ordinary-priority-button');
    control.dataset.qaHandoffTarget = String(++targetSerial); const roots = game().localHistory.entries, submitted = owned.actions.length;
    await input(`[data-qa-handoff-target="${targetSerial}"]`);
    await until(() => game().localHistory.phase === 'idle' && game().localHistory.entries === roots + 1, 'ordinary-pass-committed');
    const authored = owned.actions.slice(submitted);
    check(authored.length === 1 && authored[0].actor === actor && authored[0].action.type === 'PassPriority' && authored[0].responseType === 'result', 'ordinary-control-submits-only-real-PassPriority-by-selected-actor'); passes++;
  }
  check(getPlayerId() === 0 && game().legalActions.some(a => a.type === 'PlayLand'), 'finite-land-priority-reached');
  const land = game().legalActions.find(a => a.type === 'PlayLand'), objectId = land.data.object_id;
  check(game().gameState.objects[objectId]?.name === 'Forest', 'ordinary-real-Forest-hand-action');
  const preRaw = await raw(), pre = view();
  await input(null, { captureOnly: true, screenshot: 'local-handoff-pre-land' });
  stage = 'real-land-and-single-root-Undo';
  await input(`[data-hand-card][data-object-id="${objectId}"]`, { double: true });
  await until(() => game().localHistory.phase === 'idle' && game().localHistory.entries === pre.entries + 1 && game().gameState.objects[objectId]?.zone === 'Battlefield', 'actual-hand-double-click-plays-one-land-root');
  check(owned.actions.at(-1).actor === 0 && owned.actions.at(-1).action.type === 'PlayLand' && owned.actions.at(-1).responseType === 'result', 'land-real-engine-success');
  await input(null, { captureOnly: true, screenshot: 'local-handoff-land-post' });
  await input('[data-local-history-undo="true"]');
  await until(() => game().localHistory.phase === 'idle' && game().localHistory.entries === pre.entries, 'one-land-root-Undo-terminal');
  const undoRaw = await raw(); equalRekey(preRaw, undoRaw);
  const restored = view();
  const publicState = state => { const copy = { ...state }; for (const key of ['interaction_session_id', 'interaction_generation', 'next_interaction_serial', 'active_interaction_slots']) delete copy[key]; return JSON.stringify(stable(copy)); };
  check(publicState(pre.state) === publicState(restored.state), 'complete-viewer-state-PRE-except-fresh-interaction-authority');
  for (const key of ['legal', 'logs', 'events', 'currentEvents', 'nextLogSeq', 'pending', 'entries', 'seat', 'phaseStops', 'priorityMode', 'fullControl', 'manualMana']) check(JSON.stringify(stable(pre[key])) === JSON.stringify(stable(restored[key])), `exact-PRE-${key}`);
  check(owned.restores.length === 1 && owned.restores[0] === preRaw, 'restore-input-is-exact-opaque-PRE-not-UI');
  check(game().stateHistory.length === 0 && getPlayerId() === 0 && !game().localHistory.concealed, 'Undo-keeps-explicit-viewer-seat');
  await input(null, { captureOnly: true, screenshot: 'local-handoff-undo-pre-restored' });
  mark('one-land-Undo-full-engine-RNG-PRE-view-legals-and-history');
  stage = 'real-land-reexecution'; await input(`[data-hand-card][data-object-id="${objectId}"]`, { double: true });
  await until(() => game().localHistory.phase === 'idle' && game().localHistory.entries === pre.entries + 1 && game().gameState.objects[objectId]?.zone === 'Battlefield', 'restored-hand-can-reexecute-land-through-real-UI');
  await input(null, { captureOnly: true, screenshot: 'local-handoff-land-reexecution' });
  check(owned.actions.filter(a => a.action.type === 'PlayLand').length === 2, 'exactly-two-normal-land-submissions');
  mark('restored-land-real-UI-reexecution');
  const result = { pass: true, gameId, checks, handoffs, passes, selectedSeat: getPlayerId(), preRawSha256: await hash(preRaw), undoRawSha256: await hash(undoRaw),
    preRaw, undoRaw, fullOpaquePreRestored: true, freshInteractionAuthorityOnly: true, viewerLegalAndDisplayHistoryEqual: true, busySwitchRejected: true,
    worker: { identity: owned.identity, actions: owned.actions, requests: owned.requests, dedicated: true },
    actionOrigin: 'actual App/GamePage/GameProvider and CDP product clicks only; no harness game submission or seat mutation',
    limitations: ['old-seat delayed read/click and settings isolation regression tests are fixture boundary tests, not a two-client synchronization/privacy proof',
      'unsettled old continuation across sessions NOT RUN', 'DEV new Local only; no AI history, P2P, multiplayer sync, all-card or Safari campaign'] };
  root.unmount(); await until(() => !currentLocalHistory() && game().adapter === null && owned.terminated, 'App-unmount-ends-owned-worker');
  result.worker.terminated = owned.terminated; stage = 'complete'; return result;
}
globalThis.__qaStart = () => { void campaign().then(r => { globalThis.__qaResult = r; }, error => {
  globalThis.__qaResult = { pass: false, stage, failure: String(error), checks, handoffs, route: location.pathname, waitingFor: game().waitingFor, localHistory: game().localHistory,
    actions: owned?.actions, requests: owned?.requests, ui: document.body.innerText.slice(0, 2400) }; root?.unmount();
}); };
