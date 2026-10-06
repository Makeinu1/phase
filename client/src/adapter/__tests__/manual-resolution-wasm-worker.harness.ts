import initWasm, * as wasm from "@wasm/engine";
import { EngineWorkerClient } from "../engine-worker-client";
import { classifyInitFailure } from "../init-envelope";
import { AdapterError, AdapterErrorCode } from "../types";
import type { GameState, SubmitResult } from "../types";
import { formatMetadata } from "../../data/formatRegistry";

type RecordValue = Record<string, unknown>;
type Shell = "local" | "host";
type Inputs = {
  deckData?: unknown;
  seed?: number;
  formatConfig?: unknown;
  matchConfig?: unknown;
  playerCount?: number;
  firstPlayer?: number;
};
type Observation = { state: unknown; persistence: string | null; replay: string | null };
type Invocation = { value?: unknown; error?: Error; response?: RecordValue };
type Control = { name: string; status: "pass"; evidence: unknown };
type Row = { name: string; status: "pending" | "pass" | "fail"; evidence: unknown; error?: string };
type Endpoint = {
  name: "wasm-shell" | "production-worker";
  reset: () => Promise<void>;
  invoke: (shell: Shell, input: Inputs) => Promise<Invocation>;
  observe: () => Promise<Observation>;
  loadDb: () => Promise<number>;
};

declare global {
  interface Window {
    manualWasmBootstrap: {
      completionPromise: Promise<unknown>;
      finish: (result: unknown) => void;
    };
  }
}

const rows: Row[] = [];
const controls: Control[] = [];
const params = new URLSearchParams(location.search);
const startedAt = new Date().toISOString();
const basicName = "Bootstrap Blank Basic";
const basicDeck = (count = 40, bracketTier = "core") => ({
  main_deck: Array<string>(count).fill(basicName), bracket_tier: bracketTier,
});
const decks = (count = 40, bracketTier = "core") => ({
  player: basicDeck(count, bracketTier), opponent: basicDeck(count, bracketTier),
  ai_decks: [], ai_difficulties: [],
});
const dbText = JSON.stringify({
  [basicName.toLowerCase()]: {
    name: basicName,
    mana_cost: { type: "NoCost" },
    card_type: { supertypes: ["Basic"], core_types: ["Land"], subtypes: [] },
    power: null, toughness: null, loyalty: null, defense: null, oracle_text: null,
    abilities: [], triggers: [], static_abilities: [], replacements: [], keywords: [],
    bracket_signals: {
      game_changer: false, mass_land_denial: false, extra_turn: false, efficient_tutor: false,
    },
  },
});
const limited = formatMetadata("Limited")?.default_config;
const validLimited: Inputs = {
  deckData: decks(), seed: 117, formatConfig: limited,
  matchConfig: { match_type: "Bo1", loop_detection: "Off" }, playerCount: 2, firstPlayer: 0,
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): RecordValue {
  check(value !== null && typeof value === "object", "Expected an object at the real boundary");
  return value as RecordValue;
}

function stateFrom(value: unknown): GameState {
  return record(record(value).state) as unknown as GameState;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function sha256(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store" });
  check(response.ok, `Artifact fetch failed: ${url} (${response.status})`);
  const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runRow(name: string, body: () => Promise<unknown>): Promise<void> {
  const row: Row = { name, status: "pending", evidence: null };
  rows.push(row);
  try {
    row.evidence = await body();
    row.status = "pass";
  } catch (error) {
    row.status = "fail";
    row.error = error instanceof Error ? error.message : String(error);
    if (name === "ordinary_initializer_preservation") row.evidence = controls;
    throw error;
  }
}

function addControl(endpoint: Endpoint, shell: Shell, name: string, evidence: unknown): void {
  controls.push({ name: `${endpoint.name}.${shell}.${name}`, status: "pass", evidence });
}

// Runtime fixtures deliberately retain undefined and malformed values. The
// production client keeps its ordinary public signature; no new RPC is sent.
type RuntimeInitializer = (
  deck: unknown, seed: number | undefined, format: unknown, match: unknown,
  count: number | undefined, firstPlayer: number | undefined,
) => Promise<SubmitResult>;

function workerEndpoint(client: EngineWorkerClient): Endpoint {
  const responses: RecordValue[] = [];
  // Observe the real responses without replacing the client's promise handler.
  const worker = (client as unknown as { worker: Worker }).worker;
  worker.addEventListener("message", (event: MessageEvent<unknown>) => responses.push(record(event.data)));
  return {
    name: "production-worker",
    reset: async () => { await client.resetGame(); await client.setMultiplayerMode(false); },
    loadDb: () => client.loadCardDb(dbText),
    invoke: async (shell, input) => {
      const method = shell === "local" ? client.initializeGame : client.initializeMultiplayerHostGame;
      const initialize = method.bind(client) as unknown as RuntimeInitializer;
      try {
        const value = await initialize(
          input.deckData, input.seed, input.formatConfig, input.matchConfig,
          input.playerCount, input.firstPlayer,
        );
        return { value, response: responses[responses.length - 1] };
      } catch (error) {
        check(error instanceof Error, "Worker rejection must reconstruct an Error");
        return { error, response: responses[responses.length - 1] };
      }
    },
    observe: async () => {
      let state: unknown;
      let persistence: string | null;
      try {
        persistence = await client.exportState();
        state = await client.getState();
      } catch (error) {
        check(error instanceof Error && error.message.includes("NOT_INITIALIZED:"), "Unexpected observation failure");
        state = null;
        persistence = null;
      }
      const replay = await client.hasReplayRecording() ? await client.exportReplayLog() : null;
      return { state, persistence, replay };
    },
  };
}

function wasmEndpoint(): Endpoint {
  return {
    name: "wasm-shell",
    reset: async () => { wasm.clear_game_state(); wasm.set_multiplayer_mode(false); },
    loadDb: async () => wasm.load_card_database(dbText),
    invoke: async (shell, input) => {
      const initialize = shell === "local" ? wasm.initialize_game : wasm.initialize_multiplayer_host_game;
      return { value: initialize(
        input.deckData, input.seed, input.formatConfig, input.matchConfig,
        input.playerCount, input.firstPlayer,
      ) };
    },
    observe: async () => {
      const present = wasm.get_game_state() !== null;
      const persistence = present ? wasm.export_game_state_json() : null;
      return {
        state: present ? wasm.get_game_state() : null,
        persistence, replay: wasm.has_replay_recording() ? wasm.export_replay_log() : null,
      };
    },
  };
}

function assertSuccess(endpoint: Endpoint, outcome: Invocation): void {
  check(!outcome.error, `Ordinary ${endpoint.name} initialization failed: ${outcome.error?.message}`);
  check(classifyInitFailure(outcome.value) === null, `Ordinary shell returned an error: ${json(outcome.value)}`);
  check(Array.isArray(record(outcome.value).events), "Successful ordinary init must return actual events");
  if (endpoint.name === "production-worker") check(outcome.response?.type === "result", "Missing real Worker result");
}

async function positive(endpoint: Endpoint, shell: Shell, name: string, input: Inputs): Promise<Observation> {
  await endpoint.reset();
  const outcome = await endpoint.invoke(shell, input);
  assertSuccess(endpoint, outcome);
  const observation = await endpoint.observe();
  check(observation.persistence !== null && observation.replay !== null, "Successful init must install state and replay");
  addControl(endpoint, shell, name, {
    input, result: outcome.value, response: outcome.response,
    state: observation.state, persistence: JSON.parse(observation.persistence), replay: JSON.parse(observation.replay),
  });
  return observation;
}

function assertDefaults(observation: Observation, format: "Standard" | "FreeForAll", count: number): void {
  const state = stateFrom(observation.state);
  const replay = record(JSON.parse(observation.replay ?? "null"));
  const header = record(replay.header);
  const match = record(header.match_config);
  check(state.rng_seed === 42 && header.seed === 42, "Omitted seed must stay 42 in state and replay input");
  check(state.players.length === count && header.player_count === count, `Expected ${count} installed seats`);
  check(state.format_config?.format === format && record(header.format_config).format === format, `Wrong undeclared default: ${format}`);
  check(state.match_config?.match_type === "Bo1" && match.match_type === "Bo1", "Null/undefined/malformed match config must fall back to Bo1");
  // Off is intentionally elided by the engine's existing serde contract.
  check((state.loop_detection ?? "Off") === "Off" && (match.loop_detection ?? "Off") === "Off", "Default loop detection must stay Off");
}

async function refusal(
  endpoint: Endpoint, shell: Shell, name: string, input: Inputs, reason: RegExp,
  kind: "deckValidation" | "bracketViolation" | "engineOccupied" | "workerMissingDb",
  reachGuard: string,
): Promise<void> {
  const before = await endpoint.observe();
  const outcome = await endpoint.invoke(shell, input);
  if (endpoint.name === "wasm-shell") {
    const envelope = record(outcome.value);
    check(envelope.error === true, `${name} must return error:true from the actual WASM shell`);
    check(Array.isArray(envelope.reasons) && envelope.reasons.length > 0, `${name} must supply reasons`);
    check(envelope.reasons.every((item) => typeof item === "string"), "Refusal reasons must be strings");
    check(reason.test(envelope.reasons.join("; ")), `${name} returned the wrong refusal class: ${json(envelope)}`);
    check((envelope.cedh_bracket_violation === true) === (kind === "bracketViolation"), "cEDH typed discriminator was lost or spuriously set");
    check((envelope.engine_occupied === true) === (kind === "engineOccupied"), "Occupied typed discriminator was lost or spuriously set");
    check(classifyInitFailure(envelope)?.kind === kind, "Actual shell envelope was misclassified");
  } else {
    check(outcome.error && outcome.response?.type === "error", `${name} must reject through the production Worker/client`);
    const reasonsMessage = outcome.error.message.replace(/^Deck validation failed: /, "");
    check(reason.test(reasonsMessage) || kind === "engineOccupied", `${name} returned the wrong reconstructed reason`);
    check((outcome.response.bracketViolation === true) === (kind === "bracketViolation"), "Worker cEDH discriminator differs");
    check((outcome.response.engineOccupied === true) === (kind === "engineOccupied"), "Worker occupied discriminator differs");
    if (kind === "bracketViolation" || kind === "engineOccupied") {
      check(outcome.error instanceof AdapterError, "Typed Worker refusal must reconstruct AdapterError");
      const expected = kind === "bracketViolation" ? AdapterErrorCode.BRACKET_VIOLATION : AdapterErrorCode.ENGINE_OCCUPIED;
      check(outcome.error.code === expected, `Client must reconstruct ${expected}`);
    }
  }
  const after = await endpoint.observe();
  check(json(before) === json(after), `${name} changed resident state, persistence or replay after refusal`);
  addControl(endpoint, shell, name, {
    input, reachGuard, envelope: outcome.value, workerResponse: outcome.response,
    classifier: endpoint.name === "wasm-shell" ? classifyInitFailure(outcome.value) : undefined,
    reconstructedError: outcome.error ? {
      name: outcome.error.name, message: outcome.error.message,
      code: outcome.error instanceof AdapterError ? outcome.error.code : null,
    } : undefined,
    before, after,
  });
}

async function ordinaryControls(endpoint: Endpoint): Promise<void> {
  // This must precede database load. The two legs deliberately distinguish the
  // actual WASM missing-DB branch from the Worker's upstream missing-DB guard.
  for (const shell of ["local", "host"] as const) {
    await endpoint.reset();
    if (shell === "local") {
      await positive(endpoint, shell, "resident_without_database", { firstPlayer: 0 });
    }
    await refusal(endpoint, shell, "missing_database", validLimited,
      endpoint.name === "wasm-shell" ? /^Card database not loaded in engine worker\./ : /^Card database not loaded\. Call loadCardDb/,
      endpoint.name === "wasm-shell" ? "deckValidation" : "workerMissingDb", `${endpoint.name}.${shell}.valid_limited`);
  }
  check(await endpoint.loadDb() === 1, "The existing card-DB loader must load the synthetic basic");
  for (const shell of ["local", "host"] as const) {
    const defaults = [
      { name: "omitted_defaults", input: {}, format: "Standard", count: 2 },
      { name: "null_defaults", input: { deckData: null, formatConfig: null, matchConfig: null }, format: "Standard", count: 2 },
      { name: "undeclared_four_seats", input: { playerCount: 4 }, format: "FreeForAll", count: 4 },
      { name: "malformed_match_fallback", input: { ...validLimited, seed: undefined, matchConfig: { match_type: "Malformed" } }, format: "Limited", count: 2 },
    ] as const;
    for (const fixture of defaults) {
      const observation = await positive(endpoint, shell, fixture.name, fixture.input);
      // A malformed match still reaches real deck validation, install and replay.
      if (fixture.format === "Limited") {
        const state = stateFrom(observation.state);
        const header = record(record(JSON.parse(observation.replay ?? "null")).header);
        check(state.rng_seed === 42 && header.seed === 42, "Malformed-match fixture must also preserve omitted seed");
        check(state.match_config?.match_type === "Bo1" && record(header.match_config).match_type === "Bo1", "Malformed MatchConfig must fall back to Bo1");
        check((state.loop_detection ?? "Off") === "Off" && (record(header.match_config).loop_detection ?? "Off") === "Off", "Malformed MatchConfig must fall back to Off");
      } else {
        assertDefaults(observation, fixture.format, fixture.count);
      }
    }

    const failures = [
      { name: "malformed_format", input: { ...validLimited, formatConfig: { format: "Malformed" } }, reason: /^Format config deserialization failed:/ },
      { name: "format_player_count", input: { ...validLimited, playerCount: 4 }, reason: /player_count 4 is outside Limited's seat range 2-2/ },
      { name: "malformed_deck", input: { ...validLimited, deckData: { player: "malformed" } }, reason: /^Deck payload deserialization failed:/ },
      { name: "player_deck_validation", input: { ...validLimited, deckData: { ...decks(), player: { main_deck: ["Absent Fixture Card"] } } }, reason: /^Player deck: Unknown cards/ },
      { name: "opponent_deck_validation", input: { ...validLimited, deckData: { ...decks(), opponent: { main_deck: ["Absent Fixture Card"] } } }, reason: /^AI opponent deck: Unknown cards/ },
      { name: "empty_library_after_load", input: { ...validLimited, deckData: decks(0) }, reason: /^Empty library after deck load for seat\(s\): \[0, 1\]/ },
    ];
    for (const fixture of failures) {
      await positive(endpoint, shell, `valid_limited_for_${fixture.name}`, validLimited);
      // Host decoding is dominated by its occupied-engine guard; test its
      // preparation failures on an empty engine. Local failures keep the old resident.
      if (shell === "host") await endpoint.reset();
      await refusal(endpoint, shell, fixture.name, fixture.input, fixture.reason, "deckValidation",
        `${endpoint.name}.${shell}.valid_limited_for_${fixture.name}`);
    }
    await positive(endpoint, shell, "valid_limited", validLimited);

    const cedhDecks = { ...decks(40, "cedh"), ai_difficulties: ["CEDH"] };
    await positive(endpoint, shell, "all_cedh_bracket_reach", { ...validLimited, deckData: cedhDecks });
    if (shell === "host") await endpoint.reset();
    await refusal(endpoint, shell, "cedh_bracket_refusal", {
      ...validLimited, deckData: { ...cedhDecks, player: basicDeck(40, "core") },
    }, /seat 0 is not declared cEDH/, "bracketViolation", `${endpoint.name}.${shell}.all_cedh_bracket_reach`);

    const opposite: Shell = shell === "local" ? "host" : "local";
    await positive(endpoint, opposite, `resident_for_${shell}_occupied`, validLimited);
    await refusal(endpoint, shell, "occupied_direction", validLimited,
      shell === "local" ? /a multiplayer host session owns this engine/ : /engine already holds a game/,
      "engineOccupied", `${endpoint.name}.${opposite}.resident_for_${shell}_occupied`);
  }
  await endpoint.reset();
}

async function main(): Promise<void> {
  let client: EngineWorkerClient | undefined;
  try {
    check(params.get("artifact") === "baseline", "This tests-only checkpoint accepts explicit baseline mode only");
    check(limited?.format === "Limited", "Missing existing Limited registry authority");
    await runRow("artifact_identity", async () => {
      const wasmUrl = "/src/wasm/engine_wasm_bg.wasm";
      const glueUrl = "/src/wasm/engine_wasm.js";
      const wasmHash = await sha256(wasmUrl);
      const servedGlueHash = await sha256(glueUrl);
      check(wasmHash === params.get("wasm_sha256"), "Served WASM differs from the immutable baseline bindgen artifact");
      check(servedGlueHash === params.get("served_glue_sha256"), "Served glue differs from the alias module recorded by CI");
      check(params.get("baseline_sha") === "8fcd0f33451058f55b110e707d50497545763615", "Wrong immutable baseline source");
      for (const key of ["candidate_sha", "candidate_tree", "baseline_tree", "glue_sha256"]) {
        check(/^[a-f0-9]{40,64}$/.test(params.get(key) ?? ""), `Missing source/artifact identity: ${key}`);
      }
      return { wasmUrl, glueUrl, wasmHash, servedGlueHash, supplied: Object.fromEntries(params) };
    });
    await initWasm();
    client = new EngineWorkerClient();
    await client.initialize();
    const endpoint = workerEndpoint(client);
    await runRow("ordinary_initializer_preservation", async () => {
      await ordinaryControls(wasmEndpoint());
      await ordinaryControls(endpoint);
      return [...controls];
    });
    await runRow("ordinary_worker_action", async () => {
      await positive(endpoint, "local", "issued_action_reach", validLimited);
      const before = await client!.getSnapshot();
      const state = stateFrom(before.state);
      check(state.waiting_for.type === "MulliganDecision", "Valid Limited install must reach its ordinary mulligan decision");
      check(state.waiting_for.data.pending.some((pending) => pending.player === 0), "Human seat 0 must have an issued decision");
      const action = before.legalResult.actions.find((candidate) =>
        candidate.type === "MulliganDecision" && candidate.data.choice.type === "Keep");
      check(action, "The real engine must issue an ordinary Keep action");
      const result = await client!.submitAction(0, action);
      const after = await client!.getSnapshot();
      check(json(before.state) !== json(after.state), "The engine-issued action must change the actual Worker snapshot");
      const replay = record(JSON.parse(await client!.exportReplayLog()));
      check(Array.isArray(replay.actions) && replay.actions.length === 1, "Ordinary action must be recorded exactly once");
      return { action, result, before, after, replay };
    });

    // The production Worker imports this same Vite alias and has just proved
    // that it loads and runs the hashed WASM. Inspect its generated namespace;
    // never call a missing client method or post an unknown experimental RPC.
    const namespace = wasm as unknown as RecordValue;
    const availability = {
      initialize_experimental_local_game: typeof namespace.initialize_experimental_local_game === "function",
      experimental_local_actor: typeof namespace.experimental_local_actor === "function",
    };
    const missingExports = Object.entries(availability).filter(([, present]) => !present).map(([name]) => name);
    rows.push({
      name: "experimental_availability", status: missingExports.length ? "fail" : "pass", evidence: availability,
      error: missingExports.length ? `Missing required runtime exports: ${missingExports.join(", ")}` : undefined,
    });
    window.manualWasmBootstrap.finish({
      status: "fail", reason: availability.initialize_experimental_local_game || availability.experimental_local_actor
        ? "unexpected-baseline-exports" : "expected-experimental-availability",
      artifact: "baseline", startedAt, finishedAt: new Date().toISOString(), pageUrl: location.href, rows,
    });
  } catch (error) {
    window.manualWasmBootstrap.finish({
      status: "fail", reason: "incomplete-controls", artifact: params.get("artifact"),
      error: error instanceof Error ? error.message : String(error), startedAt,
      finishedAt: new Date().toISOString(), pageUrl: location.href, rows,
    });
  } finally {
    client?.dispose();
  }
}

void main();
