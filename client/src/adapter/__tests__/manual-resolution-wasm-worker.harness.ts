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
// Full inputs, envelopes and resident observations are compared only in memory.
// Evidence contains fixed case IDs, assertion booleans and public identity hashes.
type ControlEvidence = {
  initializationAccepted?: boolean; stateInstalled?: boolean; replayInstalled?: boolean;
  viewerRngRedacted?: boolean; trustedSeedPreserved?: boolean;
  defaultsMatched?: boolean; refusalClassMatched?: boolean; typedDiscriminatorsMatched?: boolean;
  clientCodeMatched?: boolean; residentPreserved?: boolean; reachGuard?: string;
};
type Control = { name: string; status: "pass"; evidence: ControlEvidence };
type ArtifactEvidence = {
  wasmHash: string; servedGlueHash: string;
  supplied: {
    candidate_sha: string; baseline_sha: string; candidate_tree: string; baseline_tree: string;
    glue_sha256: string;
  };
};
type Evidence = Control[] | ArtifactEvidence | Record<string, boolean | number> | null;
type AssertionStage = "row" | "initialize" | "observe" | "viewer-redaction" | "trusted-defaults"
  | "default-fields" | "refusal" | "resident-preservation" | "ordinary-action";
type Row = {
  name: string; status: "pending" | "pass" | "fail"; evidence: Evidence;
  error?: string; caseId?: string | null; stage?: AssertionStage;
};
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
let activeCaseId: string | null = null;
let activeStage: AssertionStage = "row";
const params = new URLSearchParams(location.search);
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
  matchConfig: { match_type: "Bo1", loop_detection: { type: "Off" } }, playerCount: 2, firstPlayer: 0,
};

type AssertionCode =
  | "boundary-object" | "artifact-fetch" | "worker-error-type" | "observation-failure"
  | "ordinary-init-rejected" | "ordinary-init-envelope" | "ordinary-init-events" | "worker-result"
  | "ordinary-install" | "viewer-rng-redaction" | "default-seed" | "default-player-count" | "default-format"
  | "default-match-type" | "default-loop-detection" | "wasm-refusal-envelope" | "wasm-refusal-reasons"
  | "wasm-refusal-reason-type" | "wasm-refusal-class" | "wasm-bracket-discriminator"
  | "wasm-occupied-discriminator" | "wasm-refusal-classifier" | "worker-refusal" | "worker-refusal-class"
  | "worker-bracket-discriminator" | "worker-occupied-discriminator" | "client-error-type" | "client-error-code"
  | "refusal-resident-preservation" | "card-db-load" | "malformed-match-seed" | "malformed-match-type"
  | "malformed-match-loop-detection" | "checkpoint-mode" | "limited-authority" | "served-wasm-identity"
  | "served-glue-identity" | "baseline-source-identity" | "source-identity" | "glue-identity"
  | "ordinary-decision" | "human-decision" | "issued-action" | "action-snapshot-change" | "action-recorded-once";

class AssertionFailure extends Error {
  constructor(readonly code: AssertionCode) { super(code); }
}

function check(condition: unknown, code: AssertionCode): asserts condition {
  if (!condition) throw new AssertionFailure(code);
}

function failureCode(error: unknown): string {
  return error instanceof AssertionFailure ? error.code : "boundary-failure";
}

function record(value: unknown): RecordValue {
  check(value !== null && typeof value === "object", "boundary-object");
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
  check(response.ok, "artifact-fetch");
  const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runRow(name: string, body: () => Promise<Evidence>): Promise<void> {
  activeCaseId = null;
  activeStage = "row";
  const row: Row = { name, status: "pending", evidence: null };
  rows.push(row);
  try {
    row.evidence = await body();
    row.status = "pass";
    activeCaseId = null;
    activeStage = "row";
  } catch (error) {
    row.status = "fail";
    row.error = failureCode(error);
    row.caseId = activeCaseId;
    row.stage = activeStage;
    if (name === "ordinary_initializer_preservation") row.evidence = controls;
    throw error;
  }
}

function addControl(endpoint: Endpoint, shell: Shell, name: string, evidence: ControlEvidence): void {
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
  // Capture records each reply before onmessage settles the awaited request.
  const worker = (client as unknown as { worker: Worker }).worker;
  worker.addEventListener("message", (event: MessageEvent<unknown>) => responses.push(record(event.data)), true);
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
        check(error instanceof Error, "worker-error-type");
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
        check(error instanceof Error && error.message.includes("NOT_INITIALIZED:"), "observation-failure");
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
  check(!outcome.error, "ordinary-init-rejected");
  check(classifyInitFailure(outcome.value) === null, "ordinary-init-envelope");
  check(Array.isArray(record(outcome.value).events), "ordinary-init-events");
  if (endpoint.name === "production-worker") check(outcome.response?.type === "result", "worker-result");
}

async function positive(endpoint: Endpoint, shell: Shell, name: string, input: Inputs): Promise<Observation> {
  activeCaseId = `${endpoint.name}.${shell}.${name}`;
  activeStage = "initialize";
  await endpoint.reset();
  const outcome = await endpoint.invoke(shell, input);
  assertSuccess(endpoint, outcome);
  activeStage = "observe";
  const observation = await endpoint.observe();
  check(observation.persistence !== null && observation.replay !== null, "ordinary-install");
  JSON.parse(observation.persistence);
  JSON.parse(observation.replay);
  addControl(endpoint, shell, name, {
    initializationAccepted: true, stateInstalled: true, replayInstalled: true,
  });
  activeCaseId = null;
  activeStage = "row";
  return observation;
}

function assertDefaults(observation: Observation, format: "Standard" | "FreeForAll", count: number): void {
  activeStage = "viewer-redaction";
  const state = stateFrom(observation.state);
  check(state.rng_seed === 0 && record(state).rng_word_pos === 0, "viewer-rng-redaction");
  activeStage = "trusted-defaults";
  const trustedState = stateFrom(JSON.parse(observation.persistence ?? "null"));
  const replay = record(JSON.parse(observation.replay ?? "null"));
  const header = record(replay.header);
  check(trustedState.rng_seed === 42 && header.seed === 42, "default-seed");
  activeStage = "default-fields";
  const match = record(header.match_config);
  check(state.players.length === count && header.player_count === count, "default-player-count");
  check(state.format_config?.format === format && record(header.format_config).format === format, "default-format");
  check(state.match_config?.match_type === "Bo1" && match.match_type === "Bo1", "default-match-type");
  // MatchConfig elides Off; the runtime field remains a tagged enum.
  check(record(state.loop_detection).type === "Off"
    && (match.loop_detection === undefined || record(match.loop_detection).type === "Off"), "default-loop-detection");
}

async function refusal(
  endpoint: Endpoint, shell: Shell, name: string, input: Inputs, reason: RegExp,
  kind: "deckValidation" | "bracketViolation" | "engineOccupied" | "workerMissingDb",
  reachGuard: string,
): Promise<void> {
  activeCaseId = `${endpoint.name}.${shell}.${name}`;
  activeStage = "observe";
  const before = await endpoint.observe();
  activeStage = "initialize";
  const outcome = await endpoint.invoke(shell, input);
  activeStage = "refusal";
  if (endpoint.name === "wasm-shell") {
    const envelope = record(outcome.value);
    check(envelope.error === true, "wasm-refusal-envelope");
    check(Array.isArray(envelope.reasons) && envelope.reasons.length > 0, "wasm-refusal-reasons");
    check(envelope.reasons.every((item) => typeof item === "string"), "wasm-refusal-reason-type");
    check(reason.test(envelope.reasons.join("; ")), "wasm-refusal-class");
    check((envelope.cedh_bracket_violation === true) === (kind === "bracketViolation"), "wasm-bracket-discriminator");
    check((envelope.engine_occupied === true) === (kind === "engineOccupied"), "wasm-occupied-discriminator");
    check(classifyInitFailure(envelope)?.kind === kind, "wasm-refusal-classifier");
  } else {
    check(outcome.error instanceof Error, "worker-error-type");
    const reasonsMessage = outcome.error.message.replace(/^Deck validation failed: /, "");
    check(reason.test(reasonsMessage) || kind === "engineOccupied", "worker-refusal-class");
    check(outcome.response?.type === "error", "worker-refusal");
    check((outcome.response.bracketViolation === true) === (kind === "bracketViolation"), "worker-bracket-discriminator");
    check((outcome.response.engineOccupied === true) === (kind === "engineOccupied"), "worker-occupied-discriminator");
    if (kind === "bracketViolation" || kind === "engineOccupied") {
      check(outcome.error instanceof AdapterError, "client-error-type");
      const expected = kind === "bracketViolation" ? AdapterErrorCode.BRACKET_VIOLATION : AdapterErrorCode.ENGINE_OCCUPIED;
      check(outcome.error.code === expected, "client-error-code");
    }
  }
  activeStage = "observe";
  const after = await endpoint.observe();
  activeStage = "resident-preservation";
  check(json(before) === json(after), "refusal-resident-preservation");
  addControl(endpoint, shell, name, {
    reachGuard, refusalClassMatched: true, typedDiscriminatorsMatched: true,
    ...(endpoint.name === "production-worker" && (kind === "bracketViolation" || kind === "engineOccupied")
      ? { clientCodeMatched: true } : {}), residentPreserved: true,
  });
  activeCaseId = null;
  activeStage = "row";
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
  check(await endpoint.loadDb() === 1, "card-db-load");
  for (const shell of ["local", "host"] as const) {
    const defaults = [
      { name: "omitted_defaults", input: {}, format: "Standard", count: 2 },
      { name: "null_defaults", input: { deckData: null, formatConfig: null, matchConfig: null }, format: "Standard", count: 2 },
      { name: "undeclared_four_seats", input: { playerCount: 4 }, format: "FreeForAll", count: 4 },
      { name: "malformed_match_fallback", input: { ...validLimited, seed: undefined, matchConfig: { match_type: "Malformed" } }, format: "Limited", count: 2 },
    ] as const;
    for (const fixture of defaults) {
      const observation = await positive(endpoint, shell, fixture.name, fixture.input);
      activeCaseId = `${endpoint.name}.${shell}.${fixture.name}`;
      // A malformed match still reaches real deck validation, install and replay.
      if (fixture.format === "Limited") {
        activeStage = "viewer-redaction";
        const state = stateFrom(observation.state);
        check(state.rng_seed === 0 && record(state).rng_word_pos === 0, "viewer-rng-redaction");
        activeStage = "trusted-defaults";
        const trustedState = stateFrom(JSON.parse(observation.persistence ?? "null"));
        const header = record(record(JSON.parse(observation.replay ?? "null")).header);
        check(trustedState.rng_seed === 42 && header.seed === 42, "malformed-match-seed");
        activeStage = "default-fields";
        check(state.match_config?.match_type === "Bo1" && record(header.match_config).match_type === "Bo1", "malformed-match-type");
        check(record(state.loop_detection).type === "Off"
          && (record(header.match_config).loop_detection === undefined
            || record(record(header.match_config).loop_detection).type === "Off"), "malformed-match-loop-detection");
      } else {
        assertDefaults(observation, fixture.format, fixture.count);
      }
      controls[controls.length - 1].evidence.defaultsMatched = true;
      controls[controls.length - 1].evidence.viewerRngRedacted = true;
      controls[controls.length - 1].evidence.trustedSeedPreserved = true;
      activeCaseId = null;
      activeStage = "row";
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
    check(params.get("artifact") === "baseline", "checkpoint-mode");
    check(limited?.format === "Limited", "limited-authority");
    await runRow("artifact_identity", async () => {
      const wasmUrl = "/src/wasm/engine_wasm_bg.wasm";
      const glueUrl = "/src/wasm/engine_wasm.js";
      const wasmHash = await sha256(wasmUrl);
      const servedGlueHash = await sha256(glueUrl);
      check(wasmHash === params.get("wasm_sha256"), "served-wasm-identity");
      check(servedGlueHash === params.get("served_glue_sha256"), "served-glue-identity");
      check(params.get("baseline_sha") === "8fcd0f33451058f55b110e707d50497545763615", "baseline-source-identity");
      const supplied = {
        candidate_sha: params.get("candidate_sha") ?? "", baseline_sha: "8fcd0f33451058f55b110e707d50497545763615",
        candidate_tree: params.get("candidate_tree") ?? "", baseline_tree: params.get("baseline_tree") ?? "",
        glue_sha256: params.get("glue_sha256") ?? "",
      };
      for (const identity of [supplied.candidate_sha, supplied.candidate_tree, supplied.baseline_tree]) {
        check(/^[a-f0-9]{40}$/.test(identity), "source-identity");
      }
      check(/^[a-f0-9]{64}$/.test(supplied.glue_sha256), "glue-identity");
      return { wasmHash, servedGlueHash, supplied };
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
      activeCaseId = "production-worker.local.issued_action_reach";
      activeStage = "ordinary-action";
      const before = await client!.getSnapshot();
      const state = stateFrom(before.state);
      check(state.waiting_for.type === "MulliganDecision", "ordinary-decision");
      check(state.waiting_for.data.pending.some((pending) => pending.player === 0), "human-decision");
      const action = before.legalResult.actions.find((candidate) =>
        candidate.type === "MulliganDecision" && candidate.data.choice.type === "Keep");
      check(action, "issued-action");
      await client!.submitAction(0, action);
      const after = await client!.getSnapshot();
      check(json(before.state) !== json(after.state), "action-snapshot-change");
      const replay = record(JSON.parse(await client!.exportReplayLog()));
      check(Array.isArray(replay.actions) && replay.actions.length === 1, "action-recorded-once");
      activeCaseId = null;
      activeStage = "row";
      return { ordinaryDecisionReached: true, humanDecisionIssued: true, engineIssuedAction: true,
        snapshotChanged: true, replayRecordedOnce: true, recordedActionCount: replay.actions.length };
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
      error: missingExports.length ? "experimental-exports-absent" : undefined,
    });
    window.manualWasmBootstrap.finish({
      status: "fail", reason: availability.initialize_experimental_local_game || availability.experimental_local_actor
        ? "unexpected-baseline-exports" : "expected-experimental-availability",
      artifact: "baseline", rows,
    });
  } catch (error) {
    window.manualWasmBootstrap.finish({
      status: "fail", reason: "incomplete-controls", artifact: "baseline",
      error: failureCode(error), caseId: activeCaseId, stage: activeStage, rows,
    });
  } finally {
    client?.dispose();
  }
}

void main();
