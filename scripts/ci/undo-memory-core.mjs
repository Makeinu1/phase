// Legal setup reused from control 0d74cf03 undo-f-wasm-restore.mjs.
// Samples are boundary observations, not synchronous allocation peaks or live heap.
export async function prepare(engine, fixture, config) {
let stage = "prepare", failedCheck, progress, lastActionType, lastOutcomeStatus;
const {cards, minTurn, caseId} = config;
const trace=[];
const check = (ok, code) => { if (!ok) { failedCheck = code; throw Error(code); } };
try {
  check(engine.ping() === "phase-rs engine ready", "real-engine");
  check(engine.load_card_database(fixture) === 2, "official-two-card-fixture");
  const format = engine.getFormatRegistry().find(entry => entry.format === "Limited")?.default_config;
  check(format, "engine-limited-format");
  const decks = { player: { main_deck: [...Array(cards - 8).fill("Forest"), ...Array(8).fill("Grizzly Bears")] },
    opponent: { main_deck: Array(cards).fill("Forest") } };
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
    trace.push({actor,action});
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
        if (actor === 0 && lands.length === 2 && current.stack.length === 0 && current.turn_number >= minTurn) {
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

const {cast, pre} = reachOrdinaryCast("legal-setup");
return {cast,trace};
} catch { throw Error("legal-preparation-failed"); }
}
export async function measure(engine,memory,fixture,config,observe,prepared) {
const {caseId,cards,minTurn,repeats}=config;
let stage="replay";
try {
engine.load_card_database(fixture);
const format=engine.getFormatRegistry().find(e=>e.format==="Limited").default_config;
const decks={player:{main_deck:[...Array(cards-8).fill("Forest"),...Array(8).fill("Grizzly Bears")]},opponent:{main_deck:Array(cards).fill("Forest")}};
if(engine.initialize_multiplayer_host_game(decks,0xF32002,format,null,2,0).error) throw Error();
for(const {actor,action} of prepared.trace) if(engine.submit_action(actor,action).status!=="applied") throw Error();
const binding=engine.host_precast_undo_status().binding;
if(config.undo) engine.enable_host_precast_undo(binding);
let highWater=memory.buffer.byteLength;
const samples=[];
function sample(iteration,boundary) {
 highWater=Math.max(highWater,memory.buffer.byteLength);
 samples.push({iteration,boundary,linearBytes:memory.buffer.byteLength,linearHighWaterBytes:highWater,...observe()});
}
sample(0,"prepared"); stage="measurement";
for(let i=1;i<=repeats;i++) {
 const result=engine.submit_action(0,prepared.cast);
 const armed=engine.host_precast_undo_status();
 if(result.status!=="applied" || (config.undo && armed.phase!=="Armed")) throw Error();
 sample(i,"saved");
 if(config.undo) {
  if(engine.restore_host_precast_undo(binding,armed.receipt).phase!=="Consumed") throw Error();
  sample(i,"restored");
 }
}
engine.disable_host_precast_undo();engine.clear_game_state();sample(repeats,"cleared");
return {pass:true,caseId,cards,minTurn,repeats,undo:config.undo,samples,liveHeap:"UNMEASURED",synchronousAllocationPeak:"UNMEASURED",stateEquality:"not observed in hot interval; existing fixed restore control must pass separately",retainedSnapshot:"one host Option; no byte cap",plateauClaim:"non-shrink or plateau alone does not establish a leak or zero allocations"};
} catch {return {pass:false,caseId,stage,failureClass:stage==="measurement"?"measurement-error-not-automatically-memory":"preparation-failure"};}
}
// Expand one factor at a time only after CI validates this measurement contract.
// Planned: repeat40/128, size80/128, size160/128, history40/minTurn12/128.
export const cases = [
 {caseId:"smoke40-off",cards:40,minTurn:1,repeats:1,undo:false},
 {caseId:"smoke40-on",cards:40,minTurn:1,repeats:1,undo:true}
];
