// Real generated WASM, one normal cast/restore lifecycle. No UI/RTC or secret logs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

let stage = "initialize";
let failedCheck;
let progress;
let lastActionType;
let lastOutcomeStatus;
function check(value, code) { if (!value) { failedCheck = code; throw Error(code); } }
try {
  const directory = path.resolve(process.argv[2]);
  const fixture = path.resolve(process.argv[3]);
  const engine = await import(pathToFileURL(path.join(directory, "engine_wasm.js")));
  await engine.default({ module_or_path: await WebAssembly.compile(await readFile(path.join(directory, "engine_wasm_bg.wasm"))) });
  check(engine.ping() === "phase-rs engine ready", "real-engine");
  check(engine.load_card_database(await readFile(fixture, "utf8")) === 2, "official-two-card-fixture");
  const format = engine.getFormatRegistry().find(entry => entry.format === "Limited")?.default_config;
  check(format, "engine-limited-format");
  const decks = { player: { main_deck: [...Array(32).fill("Forest"), ...Array(8).fill("Grizzly Bears")] },
    opponent: { main_deck: Array(40).fill("Forest") } };
  const initial = engine.initialize_multiplayer_host_game(decks, 0xF32002, format, null, 2, 0);
  check(!initial.error && engine.is_multiplayer_mode(), "authoritative-host-init");
  // Observation only: never feed exported JS state into any restore API.
  // The trusted export retains hidden-zone and interaction witnesses in memory;
  // client display projections deliberately redact those fields.
  const state = () => { const value = JSON.parse(engine.export_game_state_json()).state; check(value?.players?.length === 2, "engine-state-envelope"); return value; };
  const legal = actor => {
    const result = engine.get_legal_actions_for_viewer_js(actor);
    // The engine groups semantic mana actions here; flat actions omit them.
    return [...result.actions, ...Object.values(result.legalActionsByObject ?? {}).flat()]
      .map(action => ({ type: action.type, ...(action.data ? { data: action.data } : {}) }));
  };
  const submit = (actor, action) => {
    lastActionType = action.type;
    const outcome = engine.submit_action(actor, action);
    lastOutcomeStatus = ["applied", "rejected"].includes(outcome?.status) ? outcome.status : "unknown";
    check(outcome.status === "applied" && outcome.result && !outcome.result.disposition, "action-applied");
    return outcome.result;
  };
  function reachOrdinaryCast(setupStage) {
    stage = setupStage;
    for (const actor of [0,1]) submit(actor, { type: "SetPriorityPassingMode", data: { mode: "FullControl" } });
    let cast;
    for (let step = 0; step < 500 && !cast; step++) {
      const current = state();
      const waiting = current.waiting_for;
      progress = { step, turn: current.turn_number, phase: current.phase, waiting: waiting.type };
      if (waiting.type === "MulliganDecision") {
        submit(waiting.data.pending[0].player, { type: "MulliganDecision", data: { choice: { type: "Keep" } } });
      } else if (waiting.type === "DeclareAttackers") {
        submit(waiting.data.player, { type: "DeclareAttackers", data: { attacks: [] } });
      } else if (waiting.type === "DeclareBlockers") {
        submit(waiting.data.player, { type: "DeclareBlockers", data: { assignments: [] } });
      } else if (waiting.type === "DiscardToHandSize") {
        submit(waiting.data.player, { type: "SelectCards", data: { cards: waiting.data.cards.slice(0, waiting.data.count) } });
      } else {
        check(waiting.type === "Priority", "normal-priority-required");
        const actor = waiting.data.player;
        const actions = legal(actor);
        const lands = current.battlefield.filter(id => current.objects[id].controller === 0 && current.objects[id].name === "Forest");
        const land = actions.find(action => action.type === "PlayLand");
        if (actor === 0 && lands.length < 2 && land) { submit(actor, land); continue; }
        if (actor === 0 && lands.length === 2 && current.stack.length === 0) {
          cast = actions.find(action => action.type === "CastSpell" && current.objects[action.data.object_id].name === "Grizzly Bears");
          if (cast) break;
        }
        submit(actor, { type: "PassPriority" });
      }
    }
    check(cast, "ordinary-spell-reached-without-debug-or-state-injection");
    const mana = legal(0).find(action => action.type === "TapLandForMana");
    check(mana, "semantic-mana-action");
    submit(0, mana);
    const pre = state();
    check(pre.players[0].mana_pool.mana.length === 1 && pre.stack.length === 0, "prefloating-mana-reach");
    check(pre.waiting_for.type === "Priority" && pre.waiting_for.data.player === 0, "setup-caster-priority");
    return { cast, pre };
  }
  const { cast, pre } = reachOrdinaryCast("normal-game-actions");
  console.log(JSON.stringify({ pass: true, stage: "normal-game-setup", setup: "real engine legal actions; prefloating mana; no debug/state injection" }));
  const binding = engine.host_precast_undo_status().binding;
  engine.enable_host_precast_undo(binding);
  stage = "cast-and-checkpoint";
  const castResult = submit(0, cast);
  const armed = engine.host_precast_undo_status();
  const post = state();
  check(armed.phase === "Armed" && armed.receipt && castResult.events.some(event => event.type === "SpellCast"), "real-cast-checkpoint");
  check(post.stack.length === 1 && post.players[0].mana_pool.mana.length === 0 && post.objects[cast.data.object_id].zone === "Stack", "cast-payment-post");
  function refusal(bindingValue, receiptValue) {
    const before = state(); let refused = false;
    try { engine.restore_host_precast_undo(bindingValue, receiptValue); } catch { refused = true; }
    check(refused && isDeepStrictEqual(state(), before), "refusal-preserves-engine-state");
  }
  stage = "wrong-binding-refusal";
  refusal("stale.binding", armed.receipt);
  check(engine.host_precast_undo_status().phase === "Armed", "wrong-binding-does-not-consume");
  stage = "normal-restore";
  check(engine.restore_host_precast_undo(binding, armed.receipt).phase === "Consumed", "restore-consumed");
  const restored = state();
  for (const field of ["players", "battlefield", "stack", "waiting_for", "priority_player", "phase", "rng_seed", "rng_word_pos", "debug_mode", "debug_permitted"]) {
    check(isDeepStrictEqual(restored[field], pre[field]), "restore-pre-field-" + field);
  }
  check(restored.objects[cast.data.object_id].zone === "Hand", "restore-spell-to-hand");
  for (const id of pre.battlefield) check(restored.objects[id].tapped === pre.objects[id].tapped, "restore-land-taps");
  check(restored.interaction_session_id && post.interaction_session_id && !isDeepStrictEqual(restored.interaction_session_id, post.interaction_session_id), "restore-fresh-interaction-authority");
  stage = "one-use-refusal";
  refusal(binding, armed.receipt);
  stage = "recast-old-receipt-refusal";
  submit(0, cast);
  const recast = engine.host_precast_undo_status();
  check(recast.phase === "Armed" && recast.receipt !== armed.receipt, "fresh-recast-receipt");
  refusal(binding, armed.receipt);
  check(isDeepStrictEqual(engine.host_precast_undo_status(), recast), "old-receipt-preserves-fresh-armed-checkpoint");
  stage = "legal-pass-invalidates";
  submit(0, { type: "PassPriority" });
  check(engine.host_precast_undo_status().phase === "Invalidated", "pass-invalidates-before-guest-action");
  refusal(binding, recast.receipt);
  stage = "stale-host-binding";
  engine.set_multiplayer_mode(false); engine.clear_game_state();
  const next = engine.initialize_multiplayer_host_game(decks, 0xF32002, format, null, 2, 0);
  check(!next.error, "fresh-host-init");
  const nextBinding = engine.host_precast_undo_status().binding;
  check(nextBinding !== binding, "fresh-host-binding");
  const { cast: nextCast } = reachOrdinaryCast("fresh-host-game-actions");
  engine.enable_host_precast_undo(nextBinding);
  submit(0, nextCast);
  const nextArmed = engine.host_precast_undo_status();
  check(nextArmed.enabled && nextArmed.phase === "Armed" && nextArmed.receipt && nextArmed.binding === nextBinding, "fresh-host-valid-checkpoint");
  stage = "stale-host-binding";
  // Keep the fresh receipt valid: only the binding belongs to the previous host.
  refusal(binding, nextArmed.receipt);
  check(isDeepStrictEqual(engine.host_precast_undo_status(), nextArmed), "stale-binding-preserves-fresh-armed-checkpoint");
  check(engine.restore_host_precast_undo(nextBinding, nextArmed.receipt).phase === "Consumed", "fresh-binding-receipt-control-restores");
  console.log(JSON.stringify({ pass: true, sourceSha: "e10955dc5977f1ba7c65cb1518cb8f4b1679fe92",
    scope: "real WASM host API; ordinary fixture decks via game actions; no debug/state injection",
    checks: ["prefloating-mana", "normal-cast-checkpoint-restore", "wrong-binding-preserves", "one-use", "old-receipt-preserves-fresh-armed-checkpoint", "legal-pass-invalidates", "stale-binding-preserves-fresh-armed-checkpoint", "fresh-binding-receipt-control-restores"],
    runtimeRevision: "not exposed by public WASM API; native regression covers monotonic revision",
    rngWitness: "fixture seed/position equality only; no random draw or rewind guarantee",
    ui: "NOT RUN", twoSeatSync: "NOT RUN", memoryReclamation: "NOT RUN" }));
} catch {
  // Never serialize assertion values, hidden hands/libraries, bindings or receipts.
  console.error(JSON.stringify({ pass: false, stage, failedCheck: failedCheck ?? "wasm-api-or-runtime-error", progress, lastActionType, lastOutcomeStatus }));
  process.exitCode = 1;
}
