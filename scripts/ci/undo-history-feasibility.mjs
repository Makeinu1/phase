// Engine-only feasibility measurement. Opaque PRE bytes are the restore source.
// Never emit hands, libraries, capabilities, envelopes, or assertion values.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const [directoryArg, fixtureArg, outputArg, campaign] = process.argv.slice(2);
const output = path.resolve(outputArg);
mkdirSync(output, { recursive: true });
const sourceSha = 'e10955dc5977f1ba7c65cb1518cb8f4b1679fe92';
const authorityFields = ['interaction_session_id', 'interaction_generation', 'next_interaction_serial', 'active_interaction_slots'];
let stage = 'input', failedCheck, progress, lastActionType, lastOutcomeStatus, mismatchPaths;
let engine, wasmModule, stepCount = 0;
const sha = raw => createHash('sha256').update(raw).digest('hex');
const check = (value, code) => { if (!value) { failedCheck = code; throw Error(code); } };
const receipt = (name, value) => {
  const item = { sourceSha, campaign, ...value };
  // Synchronous writes preserve completed samples if the external watchdog stops us.
  writeFileSync(path.join(output, name + '.json'), JSON.stringify(item, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(item));
};
function memory() {
  const usage = process.memoryUsage();
  return { ...usage, maxRssBytes: process.resourceUsage().maxRSS * 1024,
    wasmMemoryBytes: wasmModule.memory.buffer.byteLength };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
// Tag every original string VALUE as well as every exact numeric token.
// Keys remain keys; number1 and an original string '@number:1' cannot collide.
// This comparator never round-trips JS-rounded u64 values into restore.
function lossless(raw) {
  let text = '', index = 0;
  while (index < raw.length) {
    if (raw[index] === '"') {
      const start = index++;
      while (index < raw.length) {
        if (raw[index] === '\\') { index += 2; continue; }
        if (raw[index++] === '"') break;
      }
      const token = raw.slice(start, index);
      let next = index; while (/\s/.test(raw[next] ?? '')) next++;
      text += raw[next] === ':' ? token : JSON.stringify('@string:' + JSON.parse(token));
    } else if (raw[index] === '-' || /[0-9]/.test(raw[index])) {
      const match = raw.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
      check(match, 'lossless-number-token');
      text += JSON.stringify('@number:' + match[0]); index += match[0].length;
    } else text += raw[index++];
  }
  return JSON.parse(text);
}
function canonical(raw) {
  const envelope = lossless(raw);
  check(envelope.state, 'trusted-envelope-state');
  for (const key of authorityFields) delete envelope.state[key];
  return stable(envelope);
}
function differentPaths(a, b) {
  if (isDeepStrictEqual(a, b)) return [];
  // Only fixed schema sections may reach a failure receipt. Dynamic object IDs,
  // array locations, journal keys and all differing values stay private.
  const found = [];
  for (const key of ['players', 'objects', 'battlefield', 'stack', 'waiting_for', 'rng_seed', 'rng_word_pos', 'phase', 'turn_number', 'transient_continuous_effects', 'debug_mode', 'debug_permitted']) {
    if (!isDeepStrictEqual(a.state?.[key], b.state?.[key])) found.push('state.' + key);
  }
  if (found.length === 0) found.push('other-authoritative-envelope-section');
  return found;
}
const rawState = () => engine.export_game_state_json();
const state = () => JSON.parse(rawState()).state; // Internal observations only.
function equalRaw(expected, actual, code) {
  const a = canonical(expected), b = canonical(actual);
  mismatchPaths = differentPaths(a, b);
  check(mismatchPaths.length === 0, code); mismatchPaths = undefined;
}
function legal(actor) {
  const result = engine.get_legal_actions_for_viewer_js(actor);
  return [...result.actions, ...Object.values(result.legalActionsByObject ?? {}).flat()]
    .map(a => ({ type: a.type, ...(a.data ? { data: a.data } : {}) }));
}
function submit(actor, action) {
  lastActionType = action.type;
  const outcome = engine.submit_action(actor, action);
  lastOutcomeStatus = outcome?.status;
  check(outcome?.status === 'applied' && outcome.result && !outcome.result.disposition, 'normal-action-applied');
  stepCount++;
  return outcome.result.events ?? [];
}
function oldCapability(actor, actionCode) {
  const view = engine.get_viewer_snapshot_js(actor);
  for (const opportunity of view.viewerInteraction.opportunities) {
    if (opportunity.response.type !== 'exactChoices') continue;
    const choice = opportunity.response.data.choices.find(c => c.status.type === 'available'
      && (!actionCode || c.surfaces.some(s => s.type === 'action' && s.data.code === actionCode)));
    if (choice) return { interactionId: opportunity.interactionId, response: { type: 'choose', data: { choiceId: choice.id } } };
  }
  check(false, 'real-issued-exact-interaction-capability');
}
function restore(raw, { stale, actor } = {}) {
  const oldSession = state().interaction_session_id;
  const start = performance.now();
  engine.restore_game_state(raw);
  const elapsed = performance.now() - start;
  const restored = rawState();
  equalRaw(raw, restored, 'entire-trusted-envelope-equality');
  check(state().interaction_session_id && state().interaction_session_id !== oldSession, 'fresh-interaction-namespace');
  if (stale) {
    const before = rawState();
    const outcome = engine.submit_interaction_js(actor, stale);
    check(outcome?.status === 'rejected' && outcome.rejection?.code === 'stale_interaction', 'old-issued-capability-rejected-as-stale');
    check(isDeepStrictEqual(lossless(before), lossless(rawState())), 'stale-capability-preserves-exact-state');
    const currentActor = state().waiting_for.data.player;
    const fresh = oldCapability(currentActor, 'passPriority'), beforeFresh = rawState();
    const accepted = engine.submit_interaction_js(currentActor, fresh);
    check(accepted?.status === 'applied' && accepted.result && !accepted.result.disposition, 'fresh-real-capability-applied');
    const afterFresh = rawState();
    // Control the exact semantic transition with the existing normal action path.
    // Diagnostic reinstalls/actions are not retained history points or product Redo.
    engine.restore_game_state(beforeFresh); equalRaw(beforeFresh, rawState(), 'fresh-capability-control-pre');
    submit(currentActor, { type: 'PassPriority' });
    equalRaw(afterFresh, rawState(), 'fresh-capability-equals-normal-legal-transition');
    engine.restore_game_state(raw); equalRaw(raw, rawState(), 'diagnostic-target-reinstalled');
  }
  oldCapability(state().waiting_for.data.player, 'passPriority');
  return elapsed;
}
function idleStep({ target, landGoal = 0, protectedNames = [] } = {}) {
  const current = state(), waiting = current.waiting_for;
  progress = { stepCount, turn: current.turn_number, phase: current.phase, waiting: waiting.type, stackDepth: current.stack.length };
  const actor = waiting.data?.player;
  if (waiting.type === 'MulliganDecision') return submit(waiting.data.pending[0].player, { type: 'MulliganDecision', data: { choice: { type: 'Keep' } } });
  if (waiting.type === 'DeclareAttackers') return submit(actor, { type: 'DeclareAttackers', data: { attacks: [] } });
  if (waiting.type === 'DeclareBlockers') return submit(actor, { type: 'DeclareBlockers', data: { assignments: [] } });
  if (waiting.type === 'DiscardToHandSize') {
    const cards = [...waiting.data.cards].sort((a, b) => Number(protectedNames.includes(current.objects[a].name)) - Number(protectedNames.includes(current.objects[b].name)));
    return submit(actor, { type: 'SelectCards', data: { cards: cards.slice(0, waiting.data.count) } });
  }
  if (['TargetSelection', 'TriggerTargetSelection'].includes(waiting.type)) {
    const targets = waiting.data.target_slots.map(slot => {
      const selected = slot.legal_targets.find(t => t.Object === target);
      check(selected, 'requested-target-is-engine-legal'); return selected;
    });
    return submit(actor, { type: 'SelectTargets', data: { targets } });
  }
  if (waiting.type === 'ScryChoice') return submit(actor, { type: 'SelectCards', data: { cards: waiting.data.cards } });
  if (waiting.type === 'SearchChoice') return submit(actor, { type: 'SelectCards', data: { cards: waiting.data.cards.slice(0, waiting.data.count) } });
  if (waiting.type === 'OrderTriggers') return submit(actor, { type: 'OrderTriggers', data: { order: waiting.data.triggers.map((_, i) => i) } });
  check(waiting.type === 'Priority', 'supported-legal-waiting-boundary');
  if (current.stack.length === 0 && landGoal > 0) {
    const lands = current.battlefield.filter(id => current.objects[id].controller === actor && ['Forest', 'Island'].includes(current.objects[id].name));
    const actions = legal(actor).filter(a => a.type === 'PlayLand');
    if (lands.length < landGoal && actions.length) {
      const counts = name => lands.filter(id => current.objects[id].name === name).length;
      const desired = counts('Forest') <= counts('Island') ? 'Forest' : 'Island';
      return submit(actor, actions.find(a => current.objects[a.data.object_id].name === desired) ?? actions[0]);
    }
  }
  return submit(actor, { type: 'PassPriority' });
}
function seek(predicate, options = {}) {
  for (let step = 0; step < 1600; step++) {
    const found = predicate(state()); if (found) return found;
    idleStep(options);
  }
  check(false, 'bounded-natural-setup-reached');
}
function finishDeclaration(options = {}) {
  const events = [];
  for (let step = 0; step < 30; step++) {
    if (state().waiting_for.type === 'Priority') return events;
    events.push(...idleStep(options));
  }
  check(false, 'bounded-root-declaration-completed');
}
function resolveAll(options = {}) {
  const events = [];
  for (let step = 0; step < 40; step++) {
    const current = state();
    if (current.waiting_for.type === 'Priority' && current.stack.length === 0) return events;
    events.push(...idleStep(options));
  }
  check(false, 'bounded-normal-resolution-completed');
}
function castNamed(actor, name, target) {
  const current = state();
  const cast = legal(actor).find(a => a.type === 'CastSpell' && current.objects[a.data.object_id].name === name);
  check(cast, 'required-normal-cast-is-legal');
  const events = [...submit(actor, cast), ...finishDeclaration({ target })];
  check(events.some(e => e.type === 'SpellCast'), 'actual-spell-cast-event');
  return { cast, events };
}
function init(playerCards, opponentCards, seed = 0xF32002) {
  engine.clear_game_state();
  const format = engine.getFormatRegistry().find(f => f.format === 'Limited')?.default_config;
  check(format, 'real-limited-format');
  const result = engine.initialize_game({ player: { main_deck: playerCards }, opponent: { main_deck: opponentCards } }, seed, format, null, 2, 0);
  check(!result.error && !engine.is_multiplayer_mode(), 'actual-local-init-not-multiplayer-bypass');
  for (const actor of [0, 1]) submit(actor, { type: 'SetPriorityPassingMode', data: { mode: 'FullControl' } });
}
const copies = (n, name) => Array(n).fill(name);
function spellReady(actor, name, lands) {
  return seek(current => current.waiting_for.type === 'Priority' && current.waiting_for.data.player === actor && current.stack.length === 0
    && current.battlefield.filter(id => current.objects[id].controller === actor && ['Forest', 'Island'].includes(current.objects[id].name)).length >= lands
    && legal(actor).some(a => a.type === 'CastSpell' && current.objects[a.data.object_id].name === name), { landGoal: lands, protectedNames: [name] });
}
function payment() {
  init([...copies(32, 'Forest'), ...copies(8, 'Grizzly Bears')], copies(40, 'Island'));
  spellReady(0, 'Grizzly Bears', 2);
  const mana = legal(0).find(a => a.type === 'TapLandForMana'); check(mana, 'separate-mana-activation'); submit(0, mana);
  const stale = oldCapability(0), pre = rawState();
  check(state().players[0].mana_pool.mana.length === 1, 'separate-prefloat-committed');
  castNamed(0, 'Grizzly Bears'); check(state().stack.length === 1, 'normal-creature-on-stack');
  const latency = restore(pre, { stale, actor: 0 });
  const start = performance.now(); castNamed(0, 'Grizzly Bears'); resolveAll();
  check(state().battlefield.some(id => state().objects[id].name === 'Grizzly Bears'), 'normal-recast-resolved');
  receipt('payment', { pass: true, checks: ['separate-mana-preserved', 'whole-cast-payment-rollback', 'stale-capability-rejected', 'fresh-legal-recast-resolved'], restoreMs: latency, continuationMs: performance.now() - start, memory: memory() });
}
function multistack() {
  init([...copies(32, 'Forest'), ...copies(8, 'Grizzly Bears')], [...copies(28, 'Island'), ...copies(12, 'Counterspell')]);
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 1 && s.stack.length === 0
    && s.battlefield.filter(id => s.objects[id].controller === 1 && s.objects[id].name === 'Island').length >= 2
    && s.players[1].hand.some(id => s.objects[id].name === 'Counterspell'), { landGoal: 2, protectedNames: ['Counterspell'] });
  spellReady(0, 'Grizzly Bears', 3);
  const { cast } = castNamed(0, 'Grizzly Bears');
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 1 && s.stack.length === 1);
  const stale = oldCapability(1), beforeResponse = rawState();
  castNamed(1, 'Counterspell', cast.data.object_id);
  check(state().stack.length === 2, 'two-real-spells-on-stack');
  resolveAll();
  submit(0, { type: 'Debug', data: { type: 'SetLife', data: { player_id: 0, life: 19 } } });
  check(state().players[0].life === 19, 'real-later-life-correction');
  const latency = restore(beforeResponse, { stale, actor: 1 });
  check(state().stack.length === 1 && state().players[0].life === 20, 'global-both-players-future-removed');
  // Branch differently: pass instead of recasting the response; the original spell resolves.
  resolveAll();
  check(state().objects[cast.data.object_id].zone === 'Battlefield', 'alternative-branch-legal-resolution');
  receipt('multistack', { pass: true, checks: ['nonempty-stack-checkpoint', 'actual-two-spell-response', 'later-correction-removed', 'whole-game-both-players-restored', 'fresh-alternative-continuation'], restoreMs: latency, networkDedup: 'NOT RUN', memory: memory() });
}
function rng() {
  init([...copies(12, 'Forest'), ...copies(12, 'Island'), ...copies(8, 'Opt'), ...copies(8, 'Rampant Growth')], copies(40, 'Island'));
  spellReady(0, 'Opt', 3);
  const beforeOpt = rawState();
  castNamed(0, 'Opt'); resolveAll(); const firstOpt = rawState();
  check(state().players[0].hand.length > JSON.parse(beforeOpt).state.players[0].hand.length - 1, 'actual-opt-draw');
  restore(beforeOpt); castNamed(0, 'Opt'); resolveAll(); equalRaw(firstOpt, rawState(), 'same-opt-branch-exact-private-state');
  spellReady(0, 'Rampant Growth', 3);
  const beforeShuffle = rawState(); const beforePos = lossless(beforeShuffle).state.rng_word_pos;
  castNamed(0, 'Rampant Growth'); resolveAll(); const firstShuffle = rawState();
  check(!isDeepStrictEqual(beforePos, lossless(firstShuffle).state.rng_word_pos), 'actual-shuffle-advances-rng');
  restore(beforeShuffle); castNamed(0, 'Rampant Growth'); resolveAll(); equalRaw(firstShuffle, rawState(), 'same-shuffle-branch-exact-private-state-and-rng');
  receipt('rng', { pass: true, checks: ['real-scry-and-draw', 'same-opt-private-state', 'real-library-search-and-shuffle', 'rng-advanced', 'restored-seed-offset-same-shuffle-result'], viewerPrivacy: 'NOT RUN: no additional viewer publication', memory: memory() });
}
function abilityResponse() {
  init([...copies(32, 'Forest'), ...copies(8, 'Seeker of Skybreak')], [...copies(32, 'Forest'), ...copies(8, 'Giant Growth')]);
  spellReady(0, 'Seeker of Skybreak', 2); castNamed(0, 'Seeker of Skybreak'); resolveAll();
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 1 && s.stack.length === 0
    && s.battlefield.some(id => s.objects[id].controller === 1 && s.objects[id].name === 'Forest')
    && s.players[1].hand.some(id => s.objects[id].name === 'Giant Growth'), { landGoal: 2, protectedNames: ['Giant Growth'] });
  const seeker = state().battlefield.find(id => state().objects[id].name === 'Seeker of Skybreak');
  const activation = () => legal(0).find(a => a.type === 'ActivateAbility' && a.data.source_id === seeker);
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 0 && s.stack.length === 0 && activation());
  const stale = oldCapability(0), beforeAbility = rawState();
  const abilityEvents = [...submit(0, activation()), ...finishDeclaration({ target: seeker })];
  check(abilityEvents.some(e => e.type === 'AbilityActivated') && state().stack.length === 1, 'actual-ability-root');
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 1 && s.stack.length === 1);
  castNamed(1, 'Giant Growth', seeker); check(state().stack.length === 2, 'ability-plus-spell-response-stack');
  resolveAll();
  submit(0, { type: 'Debug', data: { type: 'SetLife', data: { player_id: 1, life: 19 } } });
  check(state().players[1].life === 19, 'later-opponent-life-correction');
  const elapsed = restore(beforeAbility, { stale, actor: 0 });
  check(state().players[1].life === 20 && state().stack.length === 0, 'global-ability-response-correction-rollback');
  submit(0, activation()); finishDeclaration({ target: seeker }); resolveAll();
  receipt('ability-response', { pass: true, checks: ['actual-ability-target-and-tap', 'opponent-giant-growth-response', 'later-opponent-life-correction', 'both-players-whole-operation-root-restored', 'next-normal-ability-resolved'], restoreMs: elapsed, memory: memory() });
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], p50: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted[Math.floor((sorted.length - 1) * .95)], max: sorted.at(-1) };
}
function history() {
  init([...copies(12, 'Forest'), ...copies(12, 'Island'), ...copies(8, 'Seeker of Skybreak'), ...copies(8, 'Wake Thrasher')], copies(40, 'Island'));
  spellReady(0, 'Seeker of Skybreak', 3); castNamed(0, 'Seeker of Skybreak'); resolveAll();
  spellReady(0, 'Wake Thrasher', 3); castNamed(0, 'Wake Thrasher'); resolveAll();
  const seeker = state().battlefield.find(id => state().objects[id].name === 'Seeker of Skybreak');
  const wake = state().battlefield.find(id => state().objects[id].name === 'Wake Thrasher');
  const activation = () => legal(0).find(a => a.type === 'ActivateAbility' && a.data.source_id === seeker);
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 0 && s.stack.length === 0 && activation(), { landGoal: 3 });
  global.gc(); const baseline = memory();
  const retained = [], hashes = new Set(), captures = [], sizes = [];
  const numericSamples = path.join(output, 'capture-samples.jsonl');
  check(!existsSync(numericSamples), 'do-not-overwrite-or-retry-campaign');
  let totalBytes = 0, activationCount = 0, untapCount = 0, triggers = 0;
  for (let n = 1; n <= 1000; n++) {
    stage = 'actual-history-' + n;
    check(activation(), 'real-reusable-ability-legal');
    const start = performance.now(), raw = rawState(); captures.push(performance.now() - start);
    const bytes = Buffer.byteLength(raw); totalBytes += bytes; sizes.push(bytes);
    const digest = sha(JSON.stringify(canonical(raw))); check(!hashes.has(digest), 'independently-distinct-real-pre-state'); hashes.add(digest);
    const preEffects = state().transient_continuous_effects.length;
    const events = [...submit(0, activation()), ...finishDeclaration({ target: seeker }), ...resolveAll()];
    check(events.some(e => e.type === 'AbilityActivated'), 'real-activation-event'); activationCount++;
    const untaps = events.filter(e => e.type === 'PermanentUntapped' && e.data.object_id === seeker).length;
    check(untaps > 0 && !state().objects[seeker].tapped, 'actual-self-untap'); untapCount += untaps;
    const triggered = events.filter(e => e.type === 'EffectResolved' && e.data.source_id === wake && ['Pump', 'PumpSelf'].includes(e.data.kind)).length;
    check(triggered > 0 && state().transient_continuous_effects.length > preEffects, 'actual-wake-trigger-growth'); triggers += triggered;
    retained.push(raw);
    appendFileSync(numericSamples, JSON.stringify({ n, snapshotUtf8Bytes: bytes, captureMs: captures.at(-1), completedRealRoot: true }) + '\n');
    if ([50, 200, 1000].includes(n)) {
      global.gc(); const retainedMemory = memory();
      receipt('milestone-' + n, { pass: true, measurementPointsNotCaps: true, realRoots: activationCount, actualUntaps: untapCount, actualWakeTriggerEffectResolutions: triggers, distinctCanonicalPreSnapshots: hashes.size,
        cumulativeUtf8Bytes: totalBytes, snapshotBytes: distribution(sizes), captureMs: distribution(captures), baselineMemory: baseline, retainedMemory,
        memoryScope: 'whole Node process: growing engine Wake effects plus retained snapshot strings and measurement/runtime allocations; not isolated history-only RSS' });
      const current = rawState(), restoreSamples = [];
      for (const position of [0, Math.floor((n - 1) / 2), n - 1]) {
        const elapsed = restore(retained[position]);
        const continuationStart = performance.now();
        const continued = [...submit(0, activation()), ...finishDeclaration({ target: seeker }), ...resolveAll()];
        check(continued.some(e => e.type === 'AbilityActivated'), 'restored-real-history-legal-continuation');
        restoreSamples.push({ position, restoreMs: elapsed, continuationMs: performance.now() - continuationStart });
        restore(current); // Authentic diagnostic reinstall, not a product Redo/history point.
      }
      receipt('restore-' + n, { pass: true, historyLength: n, restoreSamples, diagnosticCurrentReinstalls: 3, authorityFieldsExcludedOnly: authorityFields });
    }
  }
  retained.length = 0; hashes.clear(); global.gc();
  receipt('history', { pass: true, workload: 'finite legal growing Seeker/Wake ability-loop stress; not ordinary-game frequency', realRoots: activationCount, afterHistoryReleaseMemory: memory(), releaseScope: 'paired whole-process observation; live game Wake effects remain, no pure history-only RSS attribution', ancestorTargetTruncationAndStaleTargetRefusal: 'NOT RUN: no product history-target controller', normalGameFullDb: 'NOT RUN', appUi: 'NOT RUN', twoSeatSync: 'NOT RUN', productPruningBudget: 'NOT CHOSEN' });
}

try {
  check(!isDeepStrictEqual(lossless('{"x":1}'), lossless('{"x":"@number:1"}')), 'comparator-preserves-number-string-type');
  check(!isDeepStrictEqual(lossless('{"x":18446744073709551614}'), lossless('{"x":18446744073709551615}')), 'comparator-preserves-u64-token');
  check(['payment', 'multistack', 'ability-response', 'rng', 'history'].includes(campaign), 'fixed-campaign');
  check(typeof global.gc === 'function', 'expose-gc-required');
  const directory = path.resolve(directoryArg), fixture = path.resolve(fixtureArg);
  const wasm = readFileSync(path.join(directory, 'engine_wasm_bg.wasm'));
  check(wasm.length === 295869347 && sha(wasm) === '1861c7d90af448a1c98d17bcd42e9dc6ad41f317a05afe2ec1cc13e4de2e450f', 'exact-e109-wasm-binary');
  check(sha(readFileSync(path.join(directory, 'engine_wasm.js'))) === 'cc3e67a1e4cf930a9107826aa676ee9b36a16494c92887897ec881251cc0ea6a', 'exact-generated-binding-pair');
  const fixtureRaw = readFileSync(fixture, 'utf8');
  check(Buffer.byteLength(fixtureRaw) === 79406 && sha(fixtureRaw) === '1849fbe675e2e5acac2b32e6f96fd8d4e2d67a8c426138452d32cb0db4f494db', 'exact-official-nine-card-fixture');
  engine = await import(pathToFileURL(path.join(directory, 'engine_wasm.js')));
  wasmModule = await engine.default({ module_or_path: await WebAssembly.compile(wasm) });
  check(engine.ping() === 'phase-rs engine ready' && engine.load_card_database(fixtureRaw) === 9, 'real-wasm-and-fixture-compatible');
  receipt('inputs', { pass: true, binaryProfile: 'unoptimized tool WASM; not release-device latency', fixtureCards: 9, node: process.version, memory: memory() });
  stage = campaign;
  ({ payment, multistack, 'ability-response': abilityResponse, rng, history })[campaign]();
} catch {
  receipt('failure', { pass: false, stage, failedCheck: failedCheck ?? 'wasm-api-or-runtime-error', progress, lastActionType, lastOutcomeStatus, mismatchPaths });
  process.exitCode = 1;
}
