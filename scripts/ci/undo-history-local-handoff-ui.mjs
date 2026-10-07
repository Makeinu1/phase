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
import { EngineWorkerClient } from './src/adapter/engine-worker-client';
import { useMultiplayerStore } from './src/stores/multiplayerStore';
import { equalRekey, stable } from './qa-history-comparator.mjs';

const check = (ok, code) => { if (!ok) throw Error(code); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const game = () => useGameStore.getState();
const hash = async raw => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), n => n.toString(16).padStart(2, '0')).join('');
const NativeWorker = globalThis.Worker, workers = [], checks = [], handoffs = [];
let stage = 'bootstrap', serial = 0, targetSerial = 0, root, owned;
let retirement;
const trace = name => retirement?.timeline.push({ name, observedAtMs: performance.now() });
const originalSubmit = EngineWorkerClient.prototype.submitAction;
// QA delays propagation of the real disposal rejection only. The native RPC
// still settles at exit; no successful reply is replayed into a retired client.
EngineWorkerClient.prototype.submitAction = function(actor, action) {
  const nativePromise = originalSubmit.call(this, actor, action);
  const probe = retirement;
  if (!probe || this.worker !== probe.worker || action.type !== 'PassPriority') return nativePromise;
  check(++probe.nativeCalls === 1, 'only-one-original-old-submit');
  probe.client = this; probe.nativeStatus = 'pending'; trace('old-native-RPC-started');
  return nativePromise.then(() => {
    probe.nativeStatus = 'resolved'; throw Error('held-old-success-must-not-resolve-before-exit');
  }, async error => {
    probe.nativeStatus = 'rejected'; probe.nativeError = String(error); trace('old-native-RPC-rejected');
    check(error.message === 'Worker disposed' && probe.worker.terminated, 'actual-dispose-rejection-after-real-worker-termination');
    await probe.continuationGate;
    trace('old-real-rejection-propagated'); throw error;
  });
};
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
        const held = { id: event.data.id, requestType: request.type, action: request.record, responseType: event.data.type, released: false,
          release: () => { held.released = true; this.held = null; this.deliver(event); } };
        this.held = held; return;
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
  terminate() { super.terminate(); this.terminated = true; this.pending.clear(); this.handler = null; if (retirement?.worker === this) trace('old-Worker-terminated'); }
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
// Retain collection contents and freeze evidence at its actual observation time.
const snapshot = value => JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Map
  ? { qaType: 'Map', entries: [...item.entries()] } : item instanceof Set ? { qaType: 'Set', values: [...item] } : item));
const view = () => {
  const s = game(), ui = useUiStore.getState();
  return snapshot({ state: s.gameState, legal: { actions: s.legalActions, byObject: s.legalActionsByObject, autoPassRecommended: s.autoPassRecommended,
    spellCosts: s.spellCosts, shortcuts: s.manaPaymentShortcutActions, offers: s.endContinuousEffectOffers, activationBlockReasons: s.activationBlockReasons, stuckDiagnostic: s.stuckDiagnostic },
    logs: s.logHistory, events: s.eventHistory, currentEvents: s.events, nextLogSeq: s.nextLogSeq,
    pending: { selected: ui.selectedCardIds, ability: ui.pendingAbilityChoice, attackers: ui.selectedAttackers, blocker: ui.pendingBlocker },
    entries: s.localHistory.entries, seat: getPlayerId(), phaseStops: usePreferencesStore.getState().phaseStops,
    priorityMode: usePreferencesStore.getState().priorityPassingMode, fullControl: ui.fullControl, manualMana: ui.manualManaOverride });
};
function mark(name) { checks.push(name); globalThis.__qaProgress = { stage, checks: [...checks], localHistory: game().localHistory, waitingFor: game().waitingFor }; }
async function priorityControl() {
  let control;
  const tooltip = i18n.t('game:actionButton.priorityTooltip').trim();
  await until(() => {
    const controls = [...document.querySelectorAll('[data-action-button-panel] button[aria-describedby]')].filter(b => visible(b)
      && document.getElementById(b.getAttribute('aria-describedby'))?.textContent.trim() === tooltip);
    check(controls.length <= 1, 'ordinary-PassPriority-control-is-unambiguous'); control = controls[0]; return !!control;
  }, 'real-ordinary-priority-button');
  control.dataset.qaHandoffTarget = String(++targetSerial);
  return { control, selector: `[data-qa-handoff-target="${targetSerial}"]` };
}
const mutations = worker => Object.fromEntries(Object.entries(worker.requests).filter(([name]) =>
  /^(submit|restore|initialize|reset|resume|applySeatMutation|setMultiplayer)/.test(name)));
const json = value => JSON.stringify(stable(snapshot(value)));
function freshBoundary() {
  const s = game(), ui = useUiStore.getState();
  const privateDom = [...document.querySelectorAll('[data-player-hand], [data-hand-card], [data-local-seat-hidden], [data-local-selected-seat], [data-card-preview]')]
    .map(e => ({ tag: e.tagName, objectId: e.dataset.objectId ?? null, selectedSeat: e.dataset.localSelectedSeat ?? null,
      hidden: e.dataset.localSeatHidden ?? null, preview: e.hasAttribute('data-card-preview'), text: e.textContent,
      images: [...e.querySelectorAll('img')].map(image => ({ src: image.getAttribute('src'), alt: image.getAttribute('alt') })) }));
  return snapshot({ ...view(), localHistory: s.localHistory, gameId: s.gameId, gameMode: s.gameMode, sessionGeneration: s.gameSessionGeneration,
    seq: s.lastCommittedSeq, epoch: s.engineCommitEpoch, waitingFor: s.waitingFor, viewerInteraction: s.viewerInteraction,
    pendingUi: Object.fromEntries(['selectedCardIds', 'pendingAbilityChoice', 'selectedAttackers', 'pendingBlocker', 'attackerBands',
      'blockerAssignments', 'combatMode', 'isDragging', 'enchantmentsDialogPlayer', 'attachmentFanHostId', 'mobileHandOpen', 'mobileHandGesture',
      'selectedObjectId', 'hoveredObjectId', 'inspectedObjectId', 'inspectedCardName', 'previewSticky']
      .map(key => [key, ui[key]])), actionPending: useMultiplayerStore.getState().actionPending,
    preferences: Object.fromEntries(Object.entries(usePreferencesStore.getState()).filter(([, value]) => typeof value !== 'function')),
    privateDom });
}
async function retirePendingIntoFreshLocal() {
  stage = 'hold-real-old-success-before-exit';
  const oldWorker = owned, oldSession = currentLocalHistory(), oldAdapter = game().adapter;
  const oldIdentity = { gameId: game().gameId, gameSessionGeneration: game().gameSessionGeneration,
    localHistorySession: game().localHistory.session, worker: oldWorker.identity };
  let releaseContinuation;
  retirement = { worker: oldWorker, nativeCalls: 0, nativeStatus: 'not-started', dispatchStatus: 'not-started', timeline: [], dispatches: [],
    continuationGate: new Promise(resolve => { releaseContinuation = resolve; }) };
  const probe = retirement, originalDispatch = oldSession.dispatch.bind(oldSession);
  oldSession.dispatch = function(...args) {
    const promise = originalDispatch(...args), record = { request: args[0], actor: args[1], status: 'pending' };
    probe.dispatches.push(record);
    const primary = probe.dispatches.length === 1;
    if (primary) { probe.dispatchPromise = promise; probe.dispatchStatus = 'pending'; trace('old-logical-dispatch-started'); }
    promise.then(outcome => {
      record.status = outcome.status;
      if (primary) { probe.dispatchStatus = 'resolved'; probe.dispatchOutcome = outcome; trace('old-logical-dispatch-terminal'); }
    }, error => { record.status = 'rejected'; if (primary) { probe.dispatchStatus = 'rejected'; probe.dispatchError = String(error); trace('old-logical-dispatch-terminal'); } });
    return promise;
  };
  check(game().waitingFor?.type === 'Priority' && game().waitingFor.data.player === 0, 'old-real-legal-priority-before-held-action');
  oldWorker.gate = 'submitAction'; const pass = await priorityControl(); check(!pass.control.disabled, 'old-pass-initially-enabled');
  const oldView = json(view()), preOldRaw = await raw();
  await input(pass.selector);
  await until(() => oldWorker.held && probe.nativeStatus === 'pending' && game().localHistory.phase === 'busy', 'old-success-held-with-original-RPC-and-logical-dispatch-unsettled');
  const held = oldWorker.held;
  check(held.responseType === 'result' && held.action.actor === 0 && held.action.action.type === 'PassPriority'
    && probe.client.pending.has(held.id), 'actual-success-response-belongs-to-unsettled-original-RPC');
  trace('old-success-response-held');
  const postOldRaw = await raw(); check(postOldRaw !== preOldRaw, 'held-request-really-mutated-old-engine');
  check(json(view()) === oldView, 'held-success-not-yet-adopted-into-old-view');
  const mutationBeforeBusy = json(mutations(oldWorker)), roots = game().localHistory.entries;
  const duplicate = await priorityControl(); await input(duplicate.selector, { attemptDisabled: duplicate.control.disabled });
  const undo = document.querySelector('[data-local-history-undo="true"]'), seat = document.querySelector('[data-local-seat-handoff="1"]');
  check(undo?.disabled && seat?.disabled, 'busy-Undo-and-seat-handoff-disabled');
  await input('[data-local-history-undo="true"]', { attemptDisabled: true });
  await input('[data-local-seat-handoff="1"]', { attemptDisabled: true });
  check(json(mutations(oldWorker)) === mutationBeforeBusy && game().localHistory.entries === roots && getPlayerId() === 0
    && !game().localHistory.concealed && probe.nativeStatus === 'pending' && probe.dispatchStatus === 'pending', 'busy-duplicate-Undo-and-seat-clicks-no-additional-mutation');
  await input(null, { captureOnly: true, screenshot: 'local-retirement-old-request-pending' });
  trace('busy-clicks-checked'); mark('real-unsettled-success-busy-duplicate-Undo-seat-no-mutation');

  stage = 'ordinary-menu-exit-with-old-request-pending';
  await input(`button[aria-label="${i18n.t('common:gameMenu.menu')}"]`); await button(i18n.t('common:gameMenu.mainMenu'));
  await until(() => location.pathname === '/' && oldWorker.terminated && !currentLocalHistory() && game().adapter === null
    && probe.nativeStatus === 'rejected', 'ordinary-exit-terminates-old-Worker-and-actual-native-RPC');
  check(probe.dispatchStatus === 'pending' && probe.client.pending.size === 0 && !oldSession.ownsSession() && !held.released, 'old-logical-continuation-still-pending-after-real-disposal');
  trace('ordinary-exit-complete-logical-continuation-held');
  stage = 'fresh-DEV-Local-before-old-continuation-terminal';
  const newId = crypto.randomUUID();
  history.pushState({ usr: null, key: crypto.randomUUID(), idx: (history.state?.idx ?? 0) + 1 }, '', `/game/${newId}?mode=local&history=1&format=Limited&players=2&first=play`);
  dispatchEvent(new PopStateEvent('popstate'));
  await until(() => game().gameId === newId && currentLocalHistory()?.ownsSession() && game().localHistory?.phase === 'idle' && pending().length === 2, 'fresh-new-Local-owned-opening');
  owned = workers.find(w => !w.terminated && w.gameId === newId && w.adapter === game().adapter);
  const freshAdapter = game().adapter, freshSession = currentLocalHistory();
  const newIdentity = { gameId: newId, gameSessionGeneration: game().gameSessionGeneration, localHistorySession: game().localHistory.session, worker: owned?.identity };
  check(owned && workers.filter(w => !w.terminated && w.gameId === newId).length === 1 && freshAdapter !== oldAdapter && freshSession !== oldSession
    && Object.keys(oldIdentity).every(key => oldIdentity[key] !== newIdentity[key]), 'fresh-game-session-adapter-history-and-Worker-identities-distinct');
  check(probe.dispatchStatus === 'pending' && probe.nativeStatus === 'rejected', 'fresh-ready-before-old-logical-continuation-terminates');
  await verifySelectedHand(0); trace('fresh-Local-ready');
  await input(null, { captureOnly: true, screenshot: 'local-retirement-fresh-before-old-terminal' });
  const freshRaw = await raw(), freshView = freshBoundary(), newMutations = json(mutations(owned));
  stage = 'release-real-disposal-rejection-and-observe-old-terminal';
  trace('old-real-rejection-continuation-release'); releaseContinuation();
  const actualOutcome = await probe.dispatchPromise;
  await until(() => probe.dispatchStatus === 'resolved' && !oldSession.busy, 'actual-original-old-logical-dispatch-terminal-not-just-dropped-response');
  check(actualOutcome.status === 'failed' && probe.nativeError === 'Error: Worker disposed' && !held.released && oldWorker.terminated
    && oldSession.closed && oldSession.displays.size === 0, 'retired-old-dispatch-completes-and-releases-history');
  const afterRaw = await raw(), afterView = freshBoundary(), mutationsAfterTerminal = mutations(owned);
  check(freshRaw === afterRaw && json(freshView) === json(afterView) && json(mutations(owned)) === newMutations
    && game().adapter === freshAdapter && currentLocalHistory() === freshSession, 'fresh-canonical-viewer-legals-history-pending-settings-private-DOM-unchanged-across-old-terminal');
  await input(null, { captureOnly: true, screenshot: 'local-retirement-fresh-after-old-terminal' });
  mark('actual-dispose-RPC-rejection-old-continuation-terminal-fresh-boundary-unchanged');

  stage = 'fresh-legal-Keep-and-ordinary-Undo-after-old-terminal';
  const newPreRaw = await raw(), newPre = view(), count = owned.actions.length;
  await button('Keep Hand');
  await until(() => game().localHistory.phase === 'idle' && game().localHistory.entries === newPre.entries + 1 && json(pending()) === '[1]', 'fresh-legal-Keep-after-old-terminal');
  check(owned.actions.length === count + 1 && owned.actions.at(-1).actor === 0 && owned.actions.at(-1).action.type === 'MulliganDecision'
    && owned.actions.at(-1).responseType === 'result', 'fresh-real-Keep-success');
  await input(null, { captureOnly: true, screenshot: 'local-retirement-fresh-legal-keep' });
  await input(null, { key: 'z' });
  await until(() => game().localHistory.phase === 'idle' && game().localHistory.entries === newPre.entries && pending().length === 2, 'fresh-ordinary-Undo-after-old-terminal');
  const newUndoRaw = await raw(); equalRekey(newPreRaw, newUndoRaw);
  const withoutAuthority = state => { const copy = { ...state }; for (const key of ['interaction_session_id', 'interaction_generation', 'next_interaction_serial', 'active_interaction_slots']) delete copy[key]; return json(copy); };
  const newUndo = view(); check(withoutAuthority(newPre.state) === withoutAuthority(newUndo.state), 'fresh-Undo-complete-viewer-PRE-except-fresh-authority');
  for (const key of ['legal', 'logs', 'events', 'currentEvents', 'nextLogSeq', 'pending', 'entries', 'seat', 'phaseStops', 'priorityMode', 'fullControl', 'manualMana']) check(json(newPre[key]) === json(newUndo[key]), `fresh-Undo-exact-PRE-${key}`);
  check(owned.restores.length === 1 && owned.restores[0] === newPreRaw && game().stateHistory.length === 0, 'fresh-Undo-exact-engine-PRE-input');
  await input(null, { captureOnly: true, screenshot: 'local-retirement-fresh-undo-restored' }); mark('fresh-legal-operation-and-ordinary-Undo-success');
  const proof = { pass: true, oldIdentity, newIdentity, timeline: probe.timeline, originalNativeCalls: probe.nativeCalls,
    oldNativeStatus: probe.nativeStatus, oldNativeError: probe.nativeError, oldDispatchStatus: probe.dispatchStatus, oldDispatchOutcome: probe.dispatchOutcome,
    oldDispatches: probe.dispatches, heldSuccess: { id: held.id, responseType: held.responseType, action: held.action, released: held.released },
    oldEngineChangedBeforeExit: true, busyMutationsBefore: JSON.parse(mutationBeforeBusy), busyMutationsAfter: mutations(oldWorker), oldWorkerTerminated: oldWorker.terminated,
    distinctAdapterAndSessionObjects: true, freshRawBeforeOldTerminal: freshRaw, freshRawAfterOldTerminal: afterRaw,
    freshRawBeforeSha256: await hash(freshRaw), freshRawAfterSha256: await hash(afterRaw), freshViewBeforeOldTerminal: freshView, freshViewAfterOldTerminal: afterView,
    freshMutationsBeforeOldTerminal: JSON.parse(newMutations), freshMutationsAfterOldTerminal: mutationsAfterTerminal,
    freshKeepPreRaw: newPreRaw, freshKeepUndoRaw: newUndoRaw, freshKeepPreSha256: await hash(newPreRaw), freshKeepUndoSha256: await hash(newUndoRaw),
    freshWorker: { identity: owned.identity, actions: owned.actions, requests: owned.requests },
    challenge: 'actual successful old submit response held until disposal; original native RPC rejects at ordinary menu exit; only propagation of that real rejection is QA-delayed until a distinct DEV Local is ready; original logical dispatch then reaches its real failed terminal',
    limitations: ['native RPC settles at exit, not after fresh startup', 'controlled real-rejection continuation delay; no replay of old success, general race/Manual/two-client/P2P/privacy claim'] };
  retirement = null; return proof;
}
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
  const baselineWorker = owned, retiredContinuation = await retirePendingIntoFreshLocal();
  const result = { pass: true, gameId, checks, handoffs, passes, selectedSeat: getPlayerId(), preRawSha256: await hash(preRaw), undoRawSha256: await hash(undoRaw), retiredContinuation,
    preRaw, undoRaw, fullOpaquePreRestored: true, freshInteractionAuthorityOnly: true, viewerLegalAndDisplayHistoryEqual: true, busySwitchRejected: true,
    worker: { identity: baselineWorker.identity, actions: baselineWorker.actions, requests: baselineWorker.requests, dedicated: true, terminated: baselineWorker.terminated },
    actionOrigin: 'actual App/GamePage/GameProvider and CDP product clicks only; no harness game submission or seat mutation',
    limitations: ['old-seat delayed read/click and settings isolation regression tests are fixture boundary tests, not a two-client synchronization/privacy proof',
      'DEV new Local only; no AI history, P2P, multiplayer sync, all-card or Safari campaign'] };
  root.unmount(); await until(() => !currentLocalHistory() && game().adapter === null && owned.terminated, 'App-unmount-ends-owned-worker');
  retiredContinuation.freshWorker.terminated = owned.terminated; stage = 'complete'; return result;
}
globalThis.__qaStart = () => { void campaign().then(r => { globalThis.__qaResult = r; }, error => {
  globalThis.__qaResult = { pass: false, stage, failure: String(error), checks, handoffs, route: location.pathname, waitingFor: game().waitingFor, localHistory: game().localHistory,
    actions: owned?.actions, requests: owned?.requests, retirement: retirement && { nativeStatus: retirement.nativeStatus, nativeError: retirement.nativeError,
      dispatchStatus: retirement.dispatchStatus, timeline: retirement.timeline, dispatches: retirement.dispatches }, ui: document.body.innerText.slice(0, 2400) }; root?.unmount();
}); };
