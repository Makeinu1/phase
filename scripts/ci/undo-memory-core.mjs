// Legal setup reused from control 0d74cf03 undo-f-wasm-restore.mjs.
// Samples are boundary observations, not synchronous allocation peaks or live heap.
export async function prepare(engine, fixture, config, report = () => {}) {
let stage = "prepare", failedCheck, progress, lastActionType, lastOutcomeStatus;
const {cards, minTurn, caseId} = config;
const trace=[];
const check = (ok, code) => { if (!ok) { failedCheck = code; throw Error(code); } };
try {
  check(engine.ping() === "phase-rs engine ready", "real-engine");
  report({stage:"database-load-start"});
  check(engine.load_card_database(fixture) === 2, "official-two-card-fixture");
  const format = engine.getFormatRegistry().find(entry => entry.format === "Limited")?.default_config;
  check(format, "engine-limited-format");
  const decks = { player: { main_deck: [...Array(cards - 8).fill("Forest"), ...Array(8).fill("Grizzly Bears")] },
    opponent: { main_deck: Array(cards).fill("Forest") } };
  report({stage:"game-initialize-start"});
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
      if(step % 25 === 0) report({stage:"legal-setup-progress",...progress});
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

report({stage:"legal-setup-start"});
const {cast, pre} = reachOrdinaryCast("legal-setup");
report({stage:"legal-setup-complete",reachedTurn:pre.turn_number,traceLength:trace.length});
const metadata = {reachedTurn:pre.turn_number,traceLength:trace.length,
 preUtf8Bytes:new TextEncoder().encode(engine.export_game_state_json()).byteLength,
 objectCount:Object.keys(pre.objects).length,battlefieldCount:pre.battlefield.length,
 stackCount:pre.stack.length, censusCycles:config.undo ? config.repeats : 0};
const replay=[];
report({stage:"census-start",cycles:config.undo?config.repeats:0});
if(config.undo) {
 const binding=engine.host_precast_undo_status().binding;
 engine.enable_host_precast_undo(binding);
 for(let i=1;i<=config.repeats;i++) {
  const beforeReplay=engine.has_replay_recording();
  check(engine.submit_action(0,cast).status==="applied","census-cast");
  const receipt=engine.host_precast_undo_status().receipt;
  check(engine.restore_host_precast_undo(binding,receipt).phase==="Consumed","census-restore");
  const restored=state();
  for(const field of ["players","objects","battlefield","stack","waiting_for","priority_player","phase","turn_number","rng_seed","rng_word_pos"]) {
   check(JSON.stringify(restored[field])===JSON.stringify(pre[field]),"census-pre-equality");
  }
  if([1,2,4,8,16,32].includes(i)) report({stage:"census-progress",cycle:i});
  if([1,2,4,8,16,32].includes(i)) replay.push({cycle:i,before:beforeReplay,after:engine.has_replay_recording()});
 }
 engine.disable_host_precast_undo();
}
report({stage:"census-complete"});
return {cast,trace,metadata:{...metadata,samePreValidated:config.undo,replay}};
} catch { report({stage:"preparation-failed",failedCheck:failedCheck??"runtime",progress});throw Error("legal-preparation-failed"); }
}
export async function measure(engine,memory,fixture,config,observe,prepared,report = () => {}) {
const {caseId,cards,minTurn,repeats}=config;
let stage="replay";
report({stage:"measurement-replay-start"});
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
 samples.push({iteration,cycleClass:iteration===1?"first":iteration>1?"after-first-restore":"baseline",boundary,linearBytes:memory.buffer.byteLength,linearHighWaterBytes:highWater,...observe()});
}
stage="measurement";report({stage:"measurement-start"});sample(0,"prepared");
for(let i=1;i<=repeats;i++) {
 const result=engine.submit_action(0,prepared.cast);
 const armed=engine.host_precast_undo_status();
 if(result.status!=="applied" || (config.undo && armed.phase!=="Armed")) throw Error();
 if([1,2,4,8,16,32].includes(i)) sample(i,"saved");
 if(config.undo) {
  if(engine.restore_host_precast_undo(binding,armed.receipt).phase!=="Consumed") throw Error();
  if([1,2,4,8,16,32].includes(i)) sample(i,"restored");
 }
}
engine.disable_host_precast_undo();engine.clear_game_state();sample(repeats,"cleared");report({stage:"measurement-complete"});
return {pass:true,caseId,cards,minTurn,repeats,undo:config.undo,census:prepared.metadata,samples,liveHeap:"UNMEASURED",synchronousAllocationPeak:"UNMEASURED",stateEquality:"not observed in hot interval; existing fixed restore control must pass separately",retainedSnapshot:"one host Option; no byte cap",plateauClaim:"non-shrink or plateau alone does not establish a leak or zero allocations"};
} catch {return {pass:false,caseId,stage,failureClass:stage==="measurement"?"measurement-error-not-automatically-memory":"preparation-failure"};}
}
// Expand one factor at a time only after CI validates this measurement contract.
// Planned: repeat40/128, size80/128, size160/128, history40/minTurn12/128.
export const cases = [
 {caseId:"smoke40-off",cards:40,minTurn:1,repeats:1,undo:false},
 {caseId:"repeat40-on",cards:40,minTurn:1,repeats:32,undo:true}
];

// Node size expansion follows the validated 40-short contract.
// Compare reachedTurn/traceLength as well as structural counts: a common seed
// does not guarantee identical preparation history at different deck sizes.
export const nodeCases = [...cases,
 {caseId:"short80-off",cards:80,minTurn:1,repeats:1,undo:false},
 {caseId:"short80-on",cards:80,minTurn:1,repeats:32,undo:true},
 {caseId:"short160-off",cards:160,minTurn:1,repeats:1,undo:false},
 {caseId:"short160-on",cards:160,minTurn:1,repeats:32,undo:true}
];
