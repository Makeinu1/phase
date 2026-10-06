// Isolated QA entry copied beside client/src by the driver. No product imports it.
import { WasmAdapter } from './src/adapter/wasm-adapter';
import { TrustedHistory } from './src/services/trustedHistory';
import { captureTrustedCheckpointString, releaseTrustedCheckpointString } from './src/services/trustedCheckpointString';
import { useGameStore } from './src/stores/gameStore';
import { FORMAT_REGISTRY } from './src/data/formatRegistry';
import { onEngineSlow } from './src/game/engineRecovery';
import { AdapterErrorCode } from './src/adapter/types';
import { canonical, stable, lossless, equalRekey } from './qa-history-comparator.mjs';

const check = (ok, code) => { if (!ok) throw Error(code); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const hash = async raw => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), n => n.toString(16).padStart(2, '0')).join('');
const checks = [], memoryStages = [];
let stage = 'bootstrap', adapter, history, session = 1, branch = 'branch-1', generation = 1, outerLocked = false;
let actionCount = 0, restoreCount = 0, exportObserved = null, restoreObserved = null;
let acceptedPair = null, acceptedEvents = [], acceptedLogs = [], actionRoot, commitFault, snapshotFault = false;
let captureFault = false, reserveFault = false, rejectRoot = false;
let actionTrace = [];
let rootActor = null, rootKind = null, rootSubmits = 0;
const workers = [], NativeWorker = globalThis.Worker;
// Only response delivery is held. Every request reaches the normal module Worker unchanged.
class ObservedWorker extends NativeWorker {
  handler = null;
  inFlight = new Map();
  gate = null;
  held = null;
  constructor(url, options) {
    super(url, options); workers.push(this);
    this.addEventListener('message', e => {
      const request = this.inFlight.get(e.data.id);
      if (request?.type === 'exportState' && e.data.type === 'result') exportObserved = e.data.data;
      if (this.gate && request?.type === this.gate.type && !this.held) {
        const gate = this.gate; this.gate = null;
        this.held = () => { this.held = null; this.deliver(e); };
        gate.reached.resolve(); return;
      }
      this.deliver(e);
    });
  }
  set onmessage(value) { this.handler = value; }
  get onmessage() { return this.handler; }
  deliver(e) { this.inFlight.delete(e.data.id); this.handler?.call(this, e); }
  postMessage(message, transfer) {
    this.inFlight.set(message.id, { type: message.type });
    if (message.type === 'submitAction' || message.type === 'submitInteraction') actionCount++;
    if (message.type === 'restoreState') { restoreCount++; restoreObserved = message.stateJson; }
    super.postMessage(message, transfer ?? []);
  }
  hold(type) { check(!this.gate && !this.held, 'one-delivery-gate'); this.gate = { type, reached: deferred() }; return this.gate.reached.promise; }
  release() { check(this.held, 'held-normal-response'); this.held(); }
  terminate() { super.terminate(); this.inFlight.clear(); this.held = this.gate = this.handler = null; const index = workers.indexOf(this); if (index >= 0) workers.splice(index, 1); }
}
globalThis.Worker = ObservedWorker;
const currentWorker = () => workers.at(-1);
const mark = name => { checks.push(name); globalThis.__qaProgress = { stage, checks: [...checks] }; };
const store = () => useGameStore.getState();
const binding = () => ({ gameId: 'qa-history', gameSessionGeneration: session, branchId: branch, generation, commitSeq: store().lastCommittedSeq });
const sameSession = b => store().adapter === adapter && store().gameId === b.gameId && store().gameSessionGeneration === b.gameSessionGeneration;
const sameCurrent = b => sameSession(b) && b.branchId === branch && b.generation === generation && b.commitSeq === store().lastCommittedSeq;
const state = async () => (await adapter.getSnapshot()).state;
const raw = () => adapter.exportPersistenceState();
const actions = async actor => { const result = await adapter.getLegalActionsForViewer(actor); return [...result.actions, ...Object.values(result.legalActionsByObject ?? {}).flat()].map(a => ({ type: a.type, ...(a.data ? { data: a.data } : {}) })); };
async function submit(actor, action) {
  if (rootActor !== null) { if (rootSubmits++ === 0 || rootKind === 'cast') check(actor === rootActor, 'root-intended-actor-matches-normal-submit'); }
  const result = await adapter.submitAction(action, actor);
  check(!result.disposition, 'normal-applied-result');
  actionTrace.push(stable(lossless(JSON.stringify({ actor, action, events: result.events ?? [] }))));
  acceptedEvents.push(...(result.events ?? [])); acceptedLogs.push(...(result.log_entries ?? []));
  return result;
}
async function idle({ landGoal = 0 } = {}) {
  const s = await state(), w = s.waiting_for, actor = w.data?.player;
  if (w.type === 'MulliganDecision') return submit(w.data.pending[0].player, { type: 'MulliganDecision', data: { choice: { type: 'Keep' } } });
  if (w.type === 'DeclareAttackers') return submit(actor, { type: 'DeclareAttackers', data: { attacks: [] } });
  if (w.type === 'DeclareBlockers') return submit(actor, { type: 'DeclareBlockers', data: { assignments: [] } });
  if (['SearchChoice', 'DiscardToHandSize', 'ScryChoice'].includes(w.type)) {
    const cards = [...w.data.cards].sort((a, b) => Number(s.objects[a].name === 'Rampant Growth') - Number(s.objects[b].name === 'Rampant Growth'));
    return submit(actor, { type: 'SelectCards', data: { cards: cards.slice(0, w.type === 'ScryChoice' ? cards.length : w.data.count) } });
  }
  if (w.type === 'OrderTriggers') return submit(actor, { type: 'OrderTriggers', data: { order: w.data.triggers.map((_, i) => i) } });
  check(w.type === 'Priority', 'bounded-supported-normal-prompt');
  if (landGoal && s.stack.length === 0) {
    const lands = s.battlefield.filter(id => s.objects[id].controller === actor && ['Forest', 'Island'].includes(s.objects[id].name));
    const available = (await actions(actor)).filter(a => a.type === 'PlayLand');
    if (lands.length < landGoal && available.length) {
      const forest = lands.filter(id => s.objects[id].name === 'Forest').length;
      const wanted = forest <= lands.length - forest ? 'Forest' : 'Island';
      return submit(actor, available.find(a => s.objects[a.data.object_id].name === wanted) ?? available[0]);
    }
  }
  return submit(actor, { type: 'PassPriority' });
}
async function seekReady() {
  for (let n = 0; n < 240; n++) {
    const s = await state();
    if (s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 0 && !s.stack.length
      && s.battlefield.filter(id => s.objects[id].controller === 0 && ['Forest', 'Island'].includes(s.objects[id].name)).length >= 3
      && (await actions(0)).some(a => a.type === 'CastSpell' && s.objects[a.data.object_id].name === 'Rampant Growth')) return;
    await idle({ landGoal: 3 });
  }
  check(false, 'bounded-natural-ready-setup');
}
async function cast() {
  const s = await state();
  const a = (await actions(0)).find(a => a.type === 'CastSpell' && s.objects[a.data.object_id].name === 'Rampant Growth');
  check(a, 'normal-rampant-growth-cast-legal'); await submit(0, a);
  for (let n = 0; n < 30; n++) { if ((await state()).waiting_for.type === 'Priority') return; await idle(); }
  check(false, 'bounded-cast-payment-completed');
}
async function resolveSpell() {
  for (let n = 0; n < 40; n++) { const s = await state(); if (s.waiting_for.type === 'Priority' && !s.stack.length) return; await idle(); }
  check(false, 'bounded-resolution-search-shuffle-completed');
}
async function priorityRoot() {
  await idle();
  for (let n = 0; n < 20; n++) { if ((await state()).waiting_for.type === 'Priority') return; await idle(); }
  check(false, 'bounded-priority-root');
}
async function issued(actor) {
  const view = await adapter.getViewerSnapshot(actor);
  for (const o of view.viewerInteraction.opportunities) {
    if (o.response.type !== 'exactChoices') continue;
    const c = o.response.data.choices.find(c => c.status.type === 'available' && c.surfaces.some(s => s.type === 'action' && s.data.code === 'passPriority'));
    if (c) return { interactionId: o.interactionId, response: { type: 'choose', data: { choiceId: c.id } } };
  }
  check(false, 'engine-issued-pass-capability');
}
async function fence() {
  check(outerLocked, 'external-mutation-lock-through-drain');
  const w = currentWorker(), engine = adapter.getEngineClient();
  for (let n = 0; n < 200 && w.inFlight.size; n++) await wait(5);
  check(!w.inFlight.size, 'all-owned-rpcs-terminal-before-ping');
  check(engine === adapter.getEngineClient(), 'captured-executor-fence');
  check(await engine.ping() === 'phase-rs engine ready', 'captured-worker-ping-after-drain');
}
const displayCopy = () => ({ events: store().events, eventHistory: store().eventHistory, logHistory: store().logHistory, nextLogSeq: store().nextLogSeq, stateHistory: store().stateHistory });
let beforeDisplay = null, pendingDisplay = null;
function newHistory() {
  beforeDisplay = pendingDisplay = null;
  const ports = {
    adapter: {
      exportPersistenceState: async () => { if (captureFault) throw Error('capture-injection'); beforeDisplay = displayCopy(); return raw(); },
      restoreTrustedState: (value, owner) => adapter.restoreTrustedState(value, owner),
      getSnapshot: async () => { if (snapshotFault) { snapshotFault = false; throw Error('snapshot-injection'); } return adapter.getSnapshot(); },
    },
    isCurrent: sameCurrent, isSessionCurrent: sameSession,
    prepareStorage: () => { if (reserveFault) throw Error('reservation-injection'); },
    submit: async (operation, parent) => {
      acceptedEvents = []; acceptedLogs = [];
      if (rejectRoot) {
        const before = await raw();
        try { await adapter.submitAction({ type: 'PlayLand', data: { object_id: 4294967295 } }, operation.actor); check(false, 'invalid-action-refused'); }
        catch (e) { check(e.code === AdapterErrorCode.ACTION_REJECTED, 'typed-terminal-rejection'); }
        check(before === await raw(), 'terminal-refusal-nonmutating'); return { status: 'rejected' };
      }
      await actionRoot();
      acceptedPair = await adapter.getSnapshot();
      return { status: 'accepted', rootId: operation.rootId, parent, commitSeq: acceptedPair.seq };
    },
    commitAccepted: receipt => {
      check(outerLocked && history.inspect().phase === 'submit', 'outer-lock-through-store-adoption');
      check(receipt.commitSeq === acceptedPair.seq, 'terminal-receipt-paired-snapshot');
      if (commitFault === 'before') throw Error('before-adoption-injection');
      const options = { events: acceptedEvents, logEntries: acceptedLogs };
      if (commitFault === 'false') {
        const future = { ...acceptedPair, seq: acceptedPair.seq + 1 };
        // Deliberate store ordering fault, not an engine acceptance receipt.
        store().commitEngineSnapshot(future);
        const logsBefore = store().logHistory.length;
        const accepted = store().commitEngineSnapshot(acceptedPair, { ...options, logEntries: [{ turn: 1, phase: 'Main1', message: 'QA stale-seq diagnostic' }] });
        check(accepted === false && store().logHistory.length === logsBefore + 1, 'false-store-result-still-appends-history'); return false;
      }
      const result = store().commitEngineSnapshot(acceptedPair, options);
      if (commitFault === 'partial') throw Error('after-store-adoption-injection');
      if (commitFault === 'session') useGameStore.setState({ gameSessionGeneration: ++session });
      return result;
    },
    fenceMutations: fence,
    commitRestore: (snapshot, previous) => {
      check(outerLocked && sameSession(previous), 'restore-owner-and-outer-lock');
      const result = store().commitEngineSnapshot(snapshot, { extraState: pendingDisplay ?? {} });
      check(result === true, 'restore-store-adoption-true');
      branch = `branch-${++generation}`;
      return binding();
    },
  };
  history = new TrustedHistory(ports, binding()); return ports;
}
async function locked(fn) { check(!outerLocked, 'no-overlapping-mutation'); outerLocked = true; try { return await fn(); } finally { if (!history || history.inspect().phase === 'idle' || history.inspect().phase === 'disposed') outerLocked = false; } }
async function perform(name, fn = priorityRoot) {
  const s = await state(), actor = s.waiting_for.data.player; check(Number.isInteger(actor), 'root-starts-at-actual-priority-actor');
  rootActor = actor; rootKind = fn === cast ? 'cast' : fn === resolveSpell ? 'resolution-with-both-priority-actors-and-caster-choice' : 'priority-advance-with-required-empty-combat-prompts'; rootSubmits = 0; actionRoot = fn;
  try { return await locked(() => history.perform({ rootId: name, actor })); }
  catch (error) { if (history.inspect().phase === 'recovery') pendingDisplay = beforeDisplay; throw error; }
  finally { if (history.inspect().phase === 'idle') pendingDisplay = null; rootActor = rootKind = null; }
}
async function recover() { check(outerLocked, 'recovery-external-lock-retained'); await history.recover(); check(history.inspect().phase === 'idle', 'recovery-unlocks-after-adoption'); outerLocked = false; pendingDisplay = null; }
async function initialize() {
  adapter = new WasmAdapter(); await adapter.initialize(); check(adapter.getEngineClient(), 'normal-worker-no-fallback');
  const names = (n, name) => Array(n).fill(name);
  const random = Math.random; Math.random = () => 0xF32002 / Number.MAX_SAFE_INTEGER;
  try { await adapter.initializeGame({ player: { main_deck: [...names(12, 'Forest'), ...names(12, 'Island'), ...names(8, 'Opt'), ...names(8, 'Rampant Growth')] }, opponent: { main_deck: names(40, 'Island') } }, FORMAT_REGISTRY.find(f => f.format === 'Limited').default_config, 2, undefined, 0); }
  finally { Math.random = random; }
  for (const actor of [0, 1]) await submit(actor, { type: 'SetPriorityPassingMode', data: { mode: 'FullControl' } });
  await seekReady();
  useGameStore.setState({ adapter, gameId: 'qa-history', gameSessionGeneration: session, gameMode: 'local', lastCommittedSeq: 0, events: [], eventHistory: [], logHistory: [], nextLogSeq: 0 });
  check(store().commitEngineSnapshot(await adapter.getSnapshot()), 'initial-real-pair-adopted');
  branch = `branch-${session}`; generation = 1; newHistory(); actionTrace = []; exportObserved = restoreObserved = null;
}
async function terminate() {
  adapter.dispose(); useGameStore.setState({ adapter: null, gameSessionGeneration: ++session, gameState: null, waitingFor: null, viewerInteraction: null, legalActions: [], legalActionsByObject: {}, spellCosts: {}, events: [], eventHistory: [], logHistory: [], stateHistory: [] }); history.dispose(); outerLocked = false;
  acceptedPair = beforeDisplay = pendingDisplay = exportObserved = restoreObserved = null; acceptedEvents = []; acceptedLogs = []; actionTrace = [];
}
// The driver invokes GC/heap measurements between these checkpoints; all large observations are dropped.
async function memoryMark(label) {
  exportObserved = restoreObserved = null; acceptedPair = beforeDisplay = null; actionTrace = []; acceptedEvents = []; acceptedLogs = [];
  memoryStages.push({ label, utf8RetainedBytes: history.inspect().retainedBytes, entries: history.inspect().entries.length, cursor: history.inspect().cursor });
  globalThis.__qaHeapStage = label;
  await new Promise(resolve => { globalThis.__qaContinue = resolve; });
  globalThis.__qaContinue = null; globalThis.__qaHeapStage = null;
}
async function campaign() {
  stage = 'normal-connection'; await initialize(); mark('normal-WasmAdapter-module-Worker-exact-WASM');
  for (const fault of ['capture', 'reserve']) {
    const count = actionCount; captureFault = fault === 'capture'; reserveFault = fault === 'reserve';
    await perform(fault).then(() => check(false, 'pre-submit-fault-refused'), () => {});
    check(actionCount === count && history.inspect().phase === 'idle' && history.inspect().cursor === 0, 'capture-reservation-failure-submit-zero');
    captureFault = reserveFault = false;
  } mark('capture-reservation-submit-zero');
  await perform('cast-payment', cast); let stack = await state();
  check(stack.stack.length === 1 && acceptedEvents.some(e => e.type === 'SpellCast'), 'real-cast-payment-on-stack');
  mark('real-cast-payment-on-stack');
  let beforeResolve = await raw(); await perform('resolve-search-shuffle', resolveSpell); let firstPost = await raw();
  const rngBefore = lossless(beforeResolve).state.rng_word_pos, rngAfter = lossless(firstPost).state.rng_word_pos;
  check(rngBefore !== rngAfter, 'real-search-shuffle-rng-progress');
  mark('real-search-shuffle-rng-progress');
  const actor = (await state()).waiting_for.data.player, stale = await issued(actor);
  const restoreBefore = restoreCount; await locked(() => history.undo());
  check(restoreCount === restoreBefore + 1 && restoreObserved === beforeResolve, 'opaque-pre-forwarded-byte-for-byte');
  equalRekey(beforeResolve, await raw());
  mark('opaque-PRE-byte-exact-full-envelope-RNG-restored');
  let staleBefore = await raw();
  await adapter.submitInteraction(stale, actor).then(() => check(false, 'old-capability-refused'), e => {
    globalThis.__qaStaleRejection = {
      adapterCode: [AdapterErrorCode.STALE_ACTION, AdapterErrorCode.ACTION_REJECTED].includes(e?.code) ? e.code : e?.code === undefined ? null : 'other',
      rejectionCode: e?.rejection?.code === 'stale_interaction' ? 'stale_interaction' : e?.rejection?.code === undefined ? null : 'other',
      disposition: e?.rejection?.disposition === 'stale' ? 'stale' : e?.rejection?.disposition === undefined ? null : 'other',
      recoverable: typeof e?.recoverable === 'boolean' ? e.recoverable : null,
    };
    check(e?.code === AdapterErrorCode.STALE_ACTION && e.rejection?.code === 'stale_interaction'
      && e.rejection.disposition === 'stale' && e.recoverable === false, 'typed-old-capability-rejection');
  });
  check(staleBefore === await raw(), 'old-capability-nonmutating'); mark('typed-old-capability-refused-state-byte-exact');
  await issued((await state()).waiting_for.data.player);
  await perform('resolve-replay', resolveSpell); equalRekey(firstPost, await raw());
  check(history.inspect().cursor === 2 && history.inspect().entries.length === 2, 'successful-branch-releases-future');
  mark('cast-payment-search-shuffle-undo-replay-full-envelope-RNG-byte-exact'); mark('old-capability-refused-fresh-normal-continuation');
  beforeResolve = firstPost = stack = staleBefore = null;
  await perform('fresh-capability', async () => { const actor = (await state()).waiting_for.data.player; check(actor === rootActor, 'fresh-capability-root-actor'); const result = await adapter.submitInteraction(await issued(actor), actor); check(!result.disposition, 'fresh-issued-capability-applied'); acceptedEvents.push(...(result.events ?? [])); acceptedLogs.push(...(result.log_entries ?? [])); });
  stage = 'delayed-submit'; const w = currentWorker(), reached = w.hold('submitAction'); let settled = false;
  const slow = []; const stopSlow = onEngineSlow(x => slow.push({ reason: x.reason, at: performance.now() })); const start = performance.now();
  const late = perform('late-priority').finally(() => { settled = true; }); await reached;
  const r0 = restoreCount; await history.undo().then(() => check(false, 'undo-locked-before-terminal'), () => {});
  check(restoreCount === r0 && !settled && outerLocked, 'pending-submit-no-restore');
  await wait(65_000); check(!settled && w.inFlight.size > 0 && slow.length === 1 && performance.now() - start >= 60_000, 'watchdog-notification-request-still-alive');
  w.release(); check(await late === 'accepted', 'late-terminal-normal-acceptance'); stopSlow();
  globalThis.__qaWatchdog = { elapsedMs: performance.now() - start, notifications: slow.map(x => ({ reason: x.reason, afterMs: x.at - start })), requestSurvivedNotification: true };
  mark('actual-60s-watchdog-and-65s-late-terminal');
  stage = 'failure-boundaries';
  for (const fault of ['before', 'false', 'partial']) {
    const old = history.inspect(), expected = await raw(), displayBefore = JSON.stringify(displayCopy()); commitFault = fault;
    await perform(`adoption-${fault}`).then(() => check(false, 'adoption-fault-refused'), () => {});
    check(history.inspect().phase === 'recovery' && outerLocked && history.inspect().cursor === old.cursor && history.inspect().entries.length === old.entries.length && history.inspect().retainedBytes > old.retainedBytes, 'adoption-failure-retains-ledger-PRE-lock');
    commitFault = null; await recover(); equalRekey(expected, await raw()); check(JSON.stringify(displayCopy()) === displayBefore, 'pending-recovery-display-history-side-effects-repaired');
  } mark('store-false-before-partial-adoption-recovery');
  await locked(() => history.undo()); const oldFuture = history.inspect(); rejectRoot = true;
  check(await perform('terminal-rejected') === 'rejected', 'rejected-root'); rejectRoot = false;
  check(history.inspect().cursor === oldFuture.cursor && history.inspect().entries.length === oldFuture.entries.length && history.inspect().retainedBytes === oldFuture.retainedBytes, 'refusal-keeps-future');
  const cancelReached = w.hold('exportState'), cancelActions = actionCount; const canceled = perform('cancel-capture'); await cancelReached; history.cancelPending(); w.release();
  check(await canceled === 'canceled' && actionCount === cancelActions && history.inspect().cursor === oldFuture.cursor && history.inspect().entries.length === oldFuture.entries.length && history.inspect().retainedBytes === oldFuture.retainedBytes, 'capture-cancel-submit-zero-future-preserved');
  snapshotFault = true; await locked(() => history.undo()).then(() => check(false, 'post-restore-snapshot-fault'), () => {});
  check(outerLocked && history.inspect().phase === 'recovery', 'post-restore-snapshot-failure-lock'); await recover(); mark('refusal-future-and-post-restore-snapshot-recovery');
  // Simulate loss of the transport delivery after the real engine already accepted it.
  const unknownRestoreCount = restoreCount, unknownReached = w.hold('submitAction'); const unknown = perform('unknown-terminal').then(() => check(false, 'unknown-submit-recovery'), () => {}); await unknownReached;
  w.onerror(new ErrorEvent('error', { message: 'QA injected transport delivery loss after real engine response' })); await unknown;
  check(outerLocked && history.inspect().phase === 'recovery', 'unknown-result-keeps-recovery-lock');
  const waitingRecovery = history.recover(); await wait(30); check(restoreCount === unknownRestoreCount && w.inFlight.size > 0, 'drain-waits-owned-terminal'); w.release(); await waitingRecovery; outerLocked = false; pendingDisplay = null;
  mark('unknown-transport-error-distinct-from-watchdog-drained-before-restore');
  stage = 'session-boundaries';
  let source = await raw(); const restoreReached = w.hold('restoreState'); const oldStore = store().engineCommitEpoch;
  const pendingUndo = locked(() => history.undo()).then(() => check(false, 'session-restore-refused'), () => {}); await restoreReached;
  useGameStore.setState({ gameSessionGeneration: ++session }); w.release(); await pendingUndo;
  check(store().engineCommitEpoch === oldStore && history.inspect().phase === 'recovery' && outerLocked, 'old-restore-result-never-adopted-to-new-session');
  adapter.dispose(); history.dispose(); outerLocked = false;
  // Real DB await with a newly initialized worker and old original exported string.
  adapter = new WasmAdapter(); await adapter.initialize(); const dbWorker = currentWorker(), dbReached = dbWorker.hold('loadCardDbFromUrl'); let owned = true;
  const pendingDbRestore = adapter.restoreTrustedState(source, () => owned).then(() => check(false, 'session-DB-restore-refused'), () => {}); await dbReached;
  const rc = restoreCount; owned = false; dbWorker.release(); await pendingDbRestore;
  check(restoreCount === rc, 'DB-session-change-restore-zero'); adapter.dispose();
  mark('real-DB-await-and-restore-await-stale-session-no-new-store-write');
  // Same adapter reinitialized after disposing its old Worker; no old PRE reaches it.
  adapter = new WasmAdapter(); await adapter.initialize(); const dead = currentWorker(), deadReached = dead.hold('loadCardDbFromUrl');
  const reincarnated = adapter.restoreTrustedState(source).then(() => check(false, 'old-executor-refused'), () => {}); await deadReached; adapter.dispose(); await reincarnated; await adapter.initialize();
  check(currentWorker() !== dead && !currentWorker().inFlight.size, 'fresh-worker-no-old-restore'); adapter.dispose();
  mark('real-adapter-reincarnation-never-restores-new-worker');
  source = null;
  stage = 'conditional-memory';
  // Fixed seed and six identical ordinary Priority roots; three forced GC rounds at each mark.
  for (const retained of [false, true]) {
    await initialize(); actionTrace = []; const initialDigest = await hash(JSON.stringify(canonical(await raw()))); await memoryMark(retained ? 'retained-before' : 'baseline-before');
    let bytesCaptured = 0; const preDigests = [];
    for (let n = 0; n < 6; n++) {
      if (retained) await perform(`memory-${n}`);
      else {
        const token = await captureTrustedCheckpointString(adapter); bytesCaptured += token.bytes; acceptedEvents = []; acceptedLogs = [];
        await priorityRoot(); check(store().commitEngineSnapshot(await adapter.getSnapshot(), { events: acceptedEvents, logEntries: acceptedLogs }), 'baseline-pair-adopted'); releaseTrustedCheckpointString(token);
      }
      preDigests.push(await hash(JSON.stringify(canonical(exportObserved))));
    }
    const traceDigest = await hash(JSON.stringify(actionTrace)), finalDigest = await hash(JSON.stringify(canonical(await raw())));
    globalThis.__qaMemoryTrace ??= []; globalThis.__qaMemoryTrace.push({ retained, roots: 6, traceDigest, initialDigest, finalDigest, preDigests, bytesCaptured: retained ? history.inspect().retainedBytes : bytesCaptured });
    await memoryMark(retained ? 'retained-six' : 'baseline-six-released');
    if (retained) { await locked(() => history.undo()); await perform('memory-branch'); await memoryMark('retained-future-discarded'); }
    await terminate(); await memoryMark(retained ? 'retained-session-ended' : 'baseline-session-ended');
  }
  for (const field of ['initialDigest', 'finalDigest', 'preDigests', 'traceDigest']) check(JSON.stringify(globalThis.__qaMemoryTrace[0][field]) === JSON.stringify(globalThis.__qaMemoryTrace[1][field]), 'memory-paired-complete-PRE-final-RNG-action-event-trace-identical');
  stage = 'complete';
  return { pass: true, scope: 'isolated actual WasmAdapter normal module Worker; one Worker / two actors; no product dispatch/P2P', checks, staleRejection: globalThis.__qaStaleRejection, watchdog: globalThis.__qaWatchdog, memoryStages, memoryTrace: globalThis.__qaMemoryTrace,
    claimsExcluded: ['product dispatch', 'two-seat synchronization/agreement/privacy', 'iPhone Safari', 'heap reclamation guarantee', 'product history budget'] };
}
globalThis.__qaRun = campaign;
globalThis.__qaResult = null;
globalThis.__qaStart = () => campaign().then(result => { globalThis.__qaResult = result; }, error => { globalThis.__qaResult = { pass: false, stage, checks, failure: String(error).slice(0, 180), staleRejection: globalThis.__qaStaleRejection, actionCount, restoreCount }; });
