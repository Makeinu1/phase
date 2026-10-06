// Isolated QA entry: actual product components, normal dispatcher and Worker.
// The fixed deck is test data; setup passes below each remain separate roots.
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './src/index.css';
import './src/i18n';
import { WasmAdapter } from './src/adapter/wasm-adapter';
import { useGameStore } from './src/stores/gameStore';
import { useUiStore } from './src/stores/uiStore';
import { usePreferencesStore } from './src/stores/preferencesStore';
import { dispatchAction } from './src/game/dispatch';
import { currentLocalHistory } from './src/game/localHistorySession';
import { useGameplayPreferencesSync } from './src/hooks/useGameplayPreferencesSync';
import { useKeyboardShortcuts } from './src/hooks/useKeyboardShortcuts';
import { FORMAT_REGISTRY } from './src/data/formatRegistry';
import { PlayerHand } from './src/components/hand/PlayerHand';
import { GameBoard } from './src/components/board/GameBoard';
import { UndoButton } from './src/components/board/UndoButton';
import { FullControlToggle } from './src/components/controls/FullControlToggle';
import { canonical, equalRekey } from './qa-history-comparator.mjs';

const check = (ok, code) => { if (!ok) throw Error(code); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = async raw => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), n => n.toString(16).padStart(2, '0')).join('');
const checks = [], operations = [], delayTrials = [], workers = [], NativeWorker = globalThis.Worker;
let stage = 'bootstrap', adapter, ownedGameWorker, workerSerial = 0, actionCount = 0, captureObserved, restoreObserved, root;
class ObservedWorker extends NativeWorker {
  handler = null; inFlight = new Map(); gate = null; held = null; heldRequest = null;
  identity = ++workerSerial; requests = {};
  constructor(url, options) {
    super(url, options); workers.push(this);
    this.addEventListener('message', e => {
      const request = this.inFlight.get(e.data.id);
      if (request?.type === 'exportState' && e.data.type === 'result') captureObserved = e.data.data;
      if (request?.type === this.gate && !this.held) {
        this.gate = null; this.heldRequest = { identity: this.identity, id: e.data.id, type: request.type, responseType: e.data.type };
        this.held = () => { this.held = null; this.deliver(e); }; return;
      }
      this.deliver(e);
    });
  }
  set onmessage(value) { this.handler = value; }
  get onmessage() { return this.handler; }
  deliver(e) { this.inFlight.delete(e.data.id); this.handler?.call(this, e); }
  postMessage(message, transfer) {
    this.inFlight.set(message.id, { type: message.type });
    this.requests[message.type] = (this.requests[message.type] ?? 0) + 1;
    if (['submitAction', 'submitInteraction'].includes(message.type)) actionCount++;
    if (message.type === 'restoreState') restoreObserved = message.stateJson;
    super.postMessage(message, transfer ?? []);
  }
  terminate() { super.terminate(); this.inFlight.clear(); this.handler = this.held = this.gate = null; const index = workers.indexOf(this); if (index >= 0) workers.splice(index, 1); }
}
globalThis.Worker = ObservedWorker;
const store = () => useGameStore.getState();
const workerInfo = () => workers.map(w => ({ identity: w.identity, ownedGame: w === ownedGameWorker, requests: { ...w.requests } }));
const raw = () => adapter.exportPersistenceState();
const mark = name => { checks.push(name); globalThis.__qaProgress = { stage, checks: [...checks], roots: store().localHistory?.entries }; };
async function until(predicate, code) {
  for (let n = 0; n < 400; n++) { if (predicate()) return; await wait(10); }
  check(false, code);
}
async function uiClick(selector, double = false, screenshot) {
  await until(() => !!document.querySelector(selector), 'existing-product-control-rendered');
  globalThis.__qaUiRequest = { selector, double, screenshot };
  await new Promise(resolve => { globalThis.__qaUiClicked = resolve; });
}
function ProductSurface() {
  useGameplayPreferencesSync(); useKeyboardShortcuts();
  useEffect(() => { globalThis.__qaSurfaceReady = true; return () => { globalThis.__qaSurfaceReady = false; }; }, []);
  return React.createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column', background: '#111827', color: 'white' } },
    React.createElement('div', { style: { position: 'relative', zIndex: 100, padding: 10, display: 'flex' } }, React.createElement(UndoButton), React.createElement(FullControlToggle)),
    React.createElement('div', { style: { flex: 1 } }, React.createElement(GameBoard, { effectiveMultiplayerBoardLayout: 'focused' })),
    React.createElement(PlayerHand));
}
const objectActions = () => Object.values(store().legalActionsByObject).flat();
const legalDisplay = () => {
  const s = store();
  return { actions: s.legalActions, legalActionsByObject: s.legalActionsByObject,
    autoPassRecommended: s.autoPassRecommended, spellCosts: s.spellCosts,
    manaPaymentShortcutActions: s.manaPaymentShortcutActions,
    endContinuousEffectOffers: s.endContinuousEffectOffers, activationBlockReasons: s.activationBlockReasons,
    stuckDiagnostic: s.stuckDiagnostic };
};
async function setupStep() {
  const state = store().gameState, w = state.waiting_for;
  let actor, action;
  if (w.type === 'MulliganDecision') { actor = w.data.pending[0].player; action = { type: 'MulliganDecision', data: { choice: { type: 'Keep' } } }; }
  else if (w.type === 'Priority') { actor = w.data.player; action = { type: 'PassPriority' }; }
  else if (w.type === 'DeclareAttackers') { actor = w.data.player; action = { type: 'DeclareAttackers', data: { attacks: [] } }; }
  else if (w.type === 'DeclareBlockers') { actor = w.data.player; action = { type: 'DeclareBlockers', data: { assignments: [] } }; }
  else if (w.type === 'DiscardToHandSize') { actor = w.data.player; action = { type: 'SelectCards', data: { cards: w.data.cards.slice(0, w.data.count) } }; }
  else check(false, 'bounded-normal-setup-prompt');
  const before = store().localHistory.entries, submits = actionCount;
  await dispatchAction(action, actor);
  check(store().localHistory.entries === before + 1 && actionCount === submits + 1, 'one-setup-submit-one-root');
  operations.push({ origin: 'harness-setup', actor, actionType: action.type, root: store().localHistory.entries });
}
async function ready(actionType, name) {
  for (let n = 0; n < 120; n++) {
    const state = store().gameState;
    const action = objectActions().find(a => a.type === actionType && state.objects[a.data.object_id].name === name);
    if (state.waiting_for.type === 'Priority' && state.waiting_for.data.player === 0 && action) return action.data.object_id;
    await setupStep();
  }
  check(false, 'bounded-natural-product-action-ready');
}
async function roundTrip(type, name, screenshot) {
  const id = await ready(type, name), before = await raw(), display = { legal: legalDisplay(), log: store().logHistory, events: store().eventHistory };
  const entries = store().localHistory.entries, submits = actionCount;
  const selector = `[data-hand-card][data-object-id="${id}"]`;
  const worker = ownedGameWorker; worker.gate = 'submitAction';
  await uiClick(selector, true);
  await until(() => !!worker.held, 'actual-product-submit-response-held');
  check(worker.heldRequest.type === 'submitAction' && worker.inFlight.has(worker.heldRequest.id)
    && store().localHistory.phase === 'busy' && store().localHistory.entries === entries, 'real-game-request-inflight-common-lock-before-client-adoption');
  // Another real double click must not create a second root or submit.
  await uiClick(selector, true);
  check(actionCount === submits + 1 && document.querySelector('[data-local-history-undo]').disabled, 'rapid-product-click-and-undo-locked');
  delayTrials.push({ actionType: type, workerIdentity: worker.identity, heldRequestType: worker.heldRequest.type,
    heldResponseType: worker.heldRequest.responseType, requestStillInFlight: worker.inFlight.has(worker.heldRequest.id),
    rootsBefore: entries, rootsWhileHeld: store().localHistory.entries, submissionsBefore: submits, submissionsAfterRepeatedUiInput: actionCount,
    phaseWhileHeld: store().localHistory.phase, undoDisabled: document.querySelector('[data-local-history-undo]').disabled });
  worker.held();
  await until(() => store().localHistory.phase === 'idle', 'product-commit-terminal');
  check(store().localHistory.entries === entries + 1 && captureObserved === before, 'one-product-operation-one-root-exact-pre');
  const after = await raw();
  check(type === 'PlayLand' ? store().gameState.battlefield.includes(id) : store().gameState.stack.some(e => e.source_id === id), 'existing-product-action-engine-applied');
  check(store().stateHistory.length === 0, 'old-five-entry-ring-unused');
  useUiStore.setState({ selectedCardIds: [id], pendingAbilityChoice: { objectId: id, actions: [] } });
  await uiClick('[data-local-history-undo]', false, `${screenshot}-before-undo`);
  await until(() => store().localHistory.phase === 'idle' && store().localHistory.entries === entries, 'existing-product-undo-terminal');
  const restored = await raw(); equalRekey(before, restored);
  check(restoreObserved === before, 'exact-engine-pre-used-never-display-state');
  check(JSON.stringify(legalDisplay()) === JSON.stringify(display.legal), 'legal-action-display-restored');
  check(JSON.stringify(store().logHistory) === JSON.stringify(display.log) && JSON.stringify(store().eventHistory) === JSON.stringify(display.events), 'display-history-restored');
  check(!useUiStore.getState().selectedCardIds.length && !useUiStore.getState().pendingAbilityChoice, 'pending-selection-cleared');
  check(document.querySelector(selector), 'card-visible-again-after-undo');
  await uiClick(selector, true, `${screenshot}-after-undo`);
  await until(() => store().localHistory.phase === 'idle' && store().localHistory.entries === entries + 1, 'product-reexecution-terminal');
  const replayed = await raw(); equalRekey(after, replayed);
  operations.push({ origin: 'existing-PlayerHand-double-click', actor: 0, actionType: type, root: entries + 1, undoOrigin: 'existing-UndoButton-click', rawPreSha256: await hash(before), preCanonicalSha256: await hash(JSON.stringify(canonical(before))), postCanonicalSha256: await hash(JSON.stringify(canonical(after))), replayCanonicalSha256: await hash(JSON.stringify(canonical(replayed))), rekeyComparison: true });
  mark(`${type}-existing-UI-Undo-reexecute-full-engine-envelope-legal-display-PASS`);
}
async function campaign() {
  stage = 'new-Local-init'; adapter = new WasmAdapter();
  useGameStore.getState().reset(); useGameStore.setState({ gameMode: 'local' });
  usePreferencesStore.setState({ phaseStops: [], priorityPassingMode: 'FullControl' });
  useUiStore.setState({ fullControl: false });
  const random = Math.random; Math.random = () => 0xF32002 / Number.MAX_SAFE_INTEGER;
  try { await store().initGame('qa-local-product-ui', adapter, { player: { main_deck: [...Array(24).fill('Forest'), ...Array(16).fill('Grizzly Bears')] }, opponent: { main_deck: Array(40).fill('Island') } }, FORMAT_REGISTRY.find(f => f.format === 'Limited').default_config, 2, undefined, 0, 'best-effort', true); }
  finally { Math.random = random; }
  check(currentLocalHistory()?.ownsSession() && workers.length === 1, 'new-local-dedicated-normal-worker');
  // Product card-data hooks may initialize a separate shared read Worker after
  // mounting. Keep the game executor's identity; never select "latest Worker".
  ownedGameWorker = workers[0];
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node); root.render(React.createElement(BrowserRouter, null, React.createElement(ProductSurface)));
  await until(() => globalThis.__qaSurfaceReady, 'existing-react-components-mounted'); mark('new-local-real-init-existing-components-no-provider-route-claim');
  stage = 'existing-UI-roundtrips'; await roundTrip('PlayLand', 'Forest', 'land');
  // A second Forest is a distinct product UI operation, never a grouped root.
  const second = await ready('PlayLand', 'Forest'); const entries = store().localHistory.entries;
  await uiClick(`[data-hand-card][data-object-id="${second}"]`, true);
  await until(() => store().localHistory.phase === 'idle' && store().localHistory.entries === entries + 1, 'second-forest-terminal');
  await roundTrip('CastSpell', 'Grizzly Bears', 'creature');
  await uiClick('[data-local-history-undo]', false, 'creature-post-reexecution');
  await until(() => store().localHistory.phase === 'idle', 'final-undo-terminal');
  check(store().stateHistory.length === 0, 'old-ring-never-touched');
  const workerObservations = workerInfo();
  check(workers.filter(w => w !== ownedGameWorker).every(w => !['initializeGame', 'initializeMultiplayerHostGame', 'submitAction', 'submitInteraction', 'submitAiActionProposal', 'restoreState', 'resetGame', 'setMultiplayerMode', 'applySeatMutation'].some(type => w.requests[type])), 'shared-read-workers-no-game-mutations');
  stage = 'complete'; root.unmount(); store().reset(); check(!workers.includes(ownedGameWorker) && !currentLocalHistory(), 'owned-game-worker-session-ended');
  return { pass: true, stage, checks, operations, delayTrials, actionCount, workerObservations, sharedReadWorkersRemaining: workers.length, ownedGameWorkerTerminated: true, rootSemantics: 'one product submission per root; each harness setup pass/keep/combat is a separate explicitly labelled root', scope: 'new Local init via store; actual existing PlayerHand/GameBoard/UndoButton plus normal dispatcher, coordinator and normal module Worker; product card-data hooks can use a distinct shared read Worker; fixed nine-card test database; not full GameProvider/GamePage route, AI, P2P, two-seat UI or Safari' };
}
globalThis.__qaStart = () => { void campaign().then(r => { globalThis.__qaResult = r; }, e => { globalThis.__qaResult = { pass: false, stage, failure: String(e), checks, operations, actionCount, workerObservations: workerInfo(), ownedGameWorkerAlive: workers.includes(ownedGameWorker), ownedGameRequests: ownedGameWorker ? [...ownedGameWorker.inFlight.values()].map(r => r.type) : [], ui: document.body.innerText.slice(0, 1000), waitingFor: store().waitingFor, localHistory: store().localHistory }; root?.unmount(); store().reset(); }); };
