// Diagnose the existing Local hotseat start boundary through the real App.
// Saved decks are inputs. Every Keep is a product click/controller operation.
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import i18n from './src/i18n';
import { App } from './src/App';
import { useGameStore } from './src/stores/gameStore';
import { usePreferencesStore } from './src/stores/preferencesStore';
import { useConnectivityStore } from './src/stores/connectivityStore';
import { getPlayerId } from './src/hooks/usePlayerId';
import { currentLocalHistory } from './src/game/localHistorySession';

const check = (ok, code) => { if (!ok) throw Error(code); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const game = () => useGameStore.getState();
const hash = async raw => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), n => n.toString(16).padStart(2, '0')).join('');
const NativeWorker = globalThis.Worker, workers = [], checks = [], scenarios = [];
let serial = 0, initializationSerial = 0, targetSerial = 0, stage = 'bootstrap', root;
class ObservedWorker extends NativeWorker {
  identity = ++serial; requests = {}; actions = []; actionRequests = new Map(); terminated = false; sessions = [];
  constructor(url, options) {
    super(url, options); workers.push(this);
    this.addEventListener('message', event => {
      const record = this.actionRequests.get(event.data.id);
      if (record) {
        record.responseType = event.data.type;
        record.resultStatus = event.data.data?.status ?? null;
        this.actionRequests.delete(event.data.id);
      }
    });
  }
  postMessage(message, transfer) {
    this.requests[message.type] = (this.requests[message.type] ?? 0) + 1;
    if (message.type === 'submitAction' || message.type === 'submitAiActionProposal') {
      const source = message.type === 'submitAction' ? message : message.proposal;
      const record = { transport: message.type, actor: source.actor, action: source.action };
      this.actions.push(record); this.actionRequests.set(message.id, record);
    }
    if (message.type === 'initializeGame') this.sessions.push({ serial: ++initializationSerial, observedGameIdAtSend: game().gameId, adapter: game().adapter, actionStart: this.actions.length });
    super.postMessage(message, transfer ?? []);
  }
  terminate() { super.terminate(); this.terminated = true; }
}
globalThis.Worker = ObservedWorker;
const observations = () => workers.map(w => ({ identity: w.identity, terminated: w.terminated, requests: w.requests, actions: w.actions,
  initializations: w.sessions.map(({ serial, observedGameIdAtSend }) => ({ serial, observedGameIdAtSend })) }));
function sessionWorker(afterInitialization) {
  const matches = workers.filter(w => !w.terminated && w.sessions.some(s => s.serial > afterInitialization && s.adapter === game().adapter));
  check(matches.length === 1, 'initializeGame-after-route-start-and-current-adapter-identifies-one-worker');
  return matches[0];
}
const pending = () => game().waitingFor?.type === 'MulliganDecision' ? game().waitingFor.data.pending.map(e => e.player) : [];
const raw = () => game().adapter.exportPersistenceState();
function mark(name) { checks.push(name); globalThis.__qaProgress = { stage, checks: [...checks], route: location.pathname, mode: game().gameMode, pending: pending() }; }
async function until(predicate, code) { for (let n = 0; n < 2400; n++) { if (predicate()) return; await wait(10); } check(false, code); }
async function input(selector, screenshot, key, captureOnly = false) {
  globalThis.__qaUiRequest = { selector, screenshot, key, captureOnly };
  await new Promise(resolve => { globalThis.__qaUiClicked = resolve; });
}
async function button(text, screenshot) {
  let found;
  await until(() => { found = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled && b.getBoundingClientRect().width); return !!found; }, `real-enabled-button:${text}`);
  found.dataset.qaProgressTarget = String(++targetSerial);
  await input(`[data-qa-progress-target="${targetSerial}"]`, screenshot);
}
function route(path) {
  history.pushState({ usr: null, key: crypto.randomUUID(), idx: (history.state?.idx ?? 0) + 1 }, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}
const localPath = (id, enabled) => `/game/${id}?mode=local${enabled ? '&history=1' : ''}&format=Limited&players=2&first=play`;
async function localStart(id, enabled, first = false) {
  const beforeInitialization = initializationSerial;
  stage = `Local-history-${enabled ? 'ON' : 'OFF'}-start`;
  if (first) {
    history.replaceState(null, '', localPath(id, enabled));
    const node = document.createElement('div'); node.id = 'root'; document.body.append(node);
    root = createRoot(node); root.render(React.createElement(App));
  } else route(localPath(id, enabled));
  await until(() => game().gameId === id && game().gameMode === 'local' && pending().includes(0) && pending().includes(1), 'real-Local-initialized-both-mulligans-pending');
  await until(() => enabled ? currentLocalHistory()?.ownsSession() && game().localHistory?.phase === 'idle' : !currentLocalHistory() && !game().localHistory, 'expected-history-mode');
  return sessionWorker(beforeInitialization);
}
async function localBlocked(id, enabled, first = false) {
  const worker = await localStart(id, enabled, first), start = worker.actions.length;
  stage = `Local-history-${enabled ? 'ON' : 'OFF'}-after-real-Keep`;
  await button('Keep Hand');
  await until(() => pending().length === 1 && pending()[0] === 1 && (!enabled || game().localHistory.phase === 'idle'), 'seat-zero-Keep-committed-seat-one-remains-pending');
  const before = await raw(), beforeView = JSON.stringify({ state: game().gameState, legal: game().legalActions, waiting: game().waitingFor });
  const count = worker.actions.length;
  await wait(1200);
  const after = await raw();
  check(before === after && beforeView === JSON.stringify({ state: game().gameState, legal: game().legalActions, waiting: game().waitingFor }), 'blocked-state-engine-and-display-stationary');
  check(worker.actions.length === count && count === start + 1, 'one-product-Keep-no-background-seat-one-submission');
  const submitted = worker.actions.slice(start);
  check(submitted[0].actor === 0 && submitted[0].action.type === 'MulliganDecision' && submitted[0].action.data.choice.type === 'Keep'
    && submitted[0].responseType === 'result', 'actual-seat-zero-Keep-success-response');
  const keepControls = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Keep Hand' && b.getBoundingClientRect().width).length;
  const message = i18n.t('game:gamePage.mulligan.opponentDeciding');
  check(getPlayerId() === 0 && keepControls === 0 && document.body.innerText.includes(message), 'seat-one-prompt-inaccessible-opponent-deciding-overlay');
  check(!game().legalActions.some(a => a.type === 'PlayLand'), 'no-legal-land-before-both-Keep');
  await input(null, enabled ? 'local-history-on-blocked' : 'local-history-off-blocked', null, true);
  scenarios.push({ mode: 'local', historyEnabled: enabled, gameId: id, worker: worker.identity, pass: true,
    result: 'existing-product-progression-blocked', pending: pending(), operationSeat: getPlayerId(), keepControls,
    visibleMessage: message, submissions: submitted, observationMs: 1200, stateStationary: true,
    rawStateSha256: await hash(after), landReached: false, landUndoReexecution: 'NOT RUN: no product seat-one decision path' });
  mark(`Local-history-${enabled ? 'ON' : 'OFF'}-same-seat-one-progress-blocker-confirmed`);
  return worker;
}
async function campaign() {
  await i18n.changeLanguage('en');
  localStorage.setItem('phase-deck:QA Local Forest', JSON.stringify({ main: [{ name: 'Forest', count: 40 }], sideboard: [], format: 'Limited' }));
  localStorage.setItem('phase-deck:QA Local Island', JSON.stringify({ main: [{ name: 'Island', count: 40 }], sideboard: [], format: 'Limited' }));
  localStorage.setItem('phase-active-deck', 'QA Local Forest');
  useConnectivityStore.getState().setForcedOffline(true);
  usePreferencesStore.setState({ nativeEngineEnabled: false, phaseStops: [], priorityPassingMode: 'FullControl', animationSpeedMultiplier: 0,
    aiSeats: [{ difficulty: 'Medium', deckId: 'saved:QA Local Island' }], aiBracketFilter: null, cedhMode: false });
  const onWorker = await localBlocked(crypto.randomUUID(), true, true);
  // The existing new-history Z shortcut returns the opening dialog so the
  // product's Peek/Menu exit can be used. This is Keep Undo, not land proof.
  await input(null, null, 'z');
  await until(() => pending().length === 2 && game().localHistory.phase === 'idle' && game().localHistory.entries === 0, 'existing-Undo-restores-opening-choice');
  await input('button[aria-label="Move dialog out of the way"]'); await wait(350);
  await input('button[aria-label="Game menu"]'); await button('Main Menu');
  await until(() => location.pathname === '/' && !currentLocalHistory() && game().adapter === null, 'existing-menu-Local-exit');
  check(onWorker.terminated, 'dedicated-Local-worker-ended');

  stage = 'actual-Setup-start-AI-control'; const beforeAiInitialization = initializationSerial; route('/setup?format=Limited');
  await button('Play'); await button('Start Match', 'setup-start-match');
  await until(() => location.pathname.startsWith('/game/') && new URLSearchParams(location.search).get('mode') === 'ai' && game().gameMode === 'ai' && pending().includes(0), 'Setup-starts-real-AI-game');
  const aiId = game().gameId, aiWorker = sessionWorker(beforeAiInitialization);
  const aiStart = aiWorker.sessions.findLast(s => s.serial > beforeAiInitialization && s.adapter === game().adapter).actionStart;
  check(aiWorker && !currentLocalHistory() && !game().localHistory, 'AI-control-is-separate-from-Local-history');
  await button('Keep Hand');
  await until(() => game().gameId === aiId && !!game().gameState && !!game().waitingFor
    && game().waitingFor.type !== 'MulliganDecision' && game().waitingFor.type !== 'OpeningHandBottomCards', 'actual-AI-controller-and-human-both-Keep-complete');
  // Include any AI opening decision made before the human dialog became ready.
  const aiActions = aiWorker.actions.slice(aiStart).filter(a => a.action.type === 'MulliganDecision');
  check(aiActions.some(a => a.actor === 0 && a.action.data.choice.type === 'Keep' && a.responseType === 'result')
    && aiActions.some(a => a.actor === 1 && a.action.data.choice.type === 'Keep' && a.responseType === 'result' && a.resultStatus === 'applied'), 'existing-AI-controller-applied-seat-one-Keep');
  await input(null, 'setup-ai-both-keep', null, true);
  scenarios.push({ mode: 'ai', historyEnabled: false, origin: 'real-Setup-Play-Start-Match', gameId: aiId,
    route: location.pathname + location.search, worker: aiWorker.identity, pass: true, bothKeepComplete: true,
    submissions: aiActions, waitingFor: game().waitingFor, localHistoryProof: false });
  mark('Setup-actual-start-is-AI-and-existing-AI-controller-completes-seat-one');

  // Diagnostic router navigation only; do not claim an OFF overlay exit UI.
  const offWorker = await localBlocked(crypto.randomUUID(), false);
  check(offWorker !== onWorker, 'OFF-uses-existing-shared-worker-not-dedicated-history-owner');
  stage = 'complete'; root.unmount();
  await until(() => !currentLocalHistory() && game().adapter === null, 'final-App-unmount-cleans-game-provider-after-scheduled-reset');
  return { pass: true, stage, checks, scenarios, workerObservations: observations(),
    classification: 'existing Local product seat plumbing/start-entry gap; reproduced with new history OFF',
    actionOrigin: 'actual App/GamePage/GameProvider; real CDP clicks and existing AI controller only; no direct actor-one/harness action submission',
    limitations: ['normal Local land/Undo/reexecution blocked before seat-one Keep', 'no Local Setup start button exists; Setup control starts mode=ai',
      '1200ms finite stationary observation plus source seat/controller analysis, not indefinite liveness claim',
      'unsettled old continuation across sessions NOT RUN', 'no P2P, two-client sync, all-card or Safari campaign'] };
}
globalThis.__qaStart = () => { void campaign().then(r => { globalThis.__qaResult = r; }, error => {
  globalThis.__qaResult = { pass: false, stage, failure: String(error), checks, scenarios, route: location.pathname + location.search,
    mode: game().gameMode, waitingFor: game().waitingFor, localHistory: game().localHistory,
    ui: document.body.innerText.slice(0, 2000), workerObservations: observations() };
  root?.unmount();
}); };
