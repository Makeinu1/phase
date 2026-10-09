import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// The worker module's top level only assigns `self.onmessage` and declares
// `cardDbLoaded`; `canonicalCardNames` and `get_card_face_data` are stubbed
// here. `default` stands in for the wasm-bindgen `init` the worker's own
// `init()` request case invokes.
const wasm = vi.hoisted(() => ({
  canonicalCardNames: vi.fn(),
  get_card_face_data: vi.fn(),
}));
vi.mock("@wasm/engine", () => ({ default: vi.fn(), ...wasm }));

describe("engine worker — canonicalCardNames request", () => {
  let fakeSelf: { postMessage: ReturnType<typeof vi.fn>; onmessage: unknown };

  beforeAll(async () => {
    fakeSelf = { postMessage: vi.fn(), onmessage: null };
    vi.stubGlobal("self", fakeSelf);
    await import("../engine-worker");
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("answers a canonical-name request with the engine's list", async () => {
    wasm.canonicalCardNames.mockReturnValue(["Revival // Revenge", null]);

    await (fakeSelf.onmessage as (e: unknown) => unknown)({
      data: { type: "canonicalCardNames", id: 1, names: ["Revival/Revenge", "Not A Card"] },
    });

    expect(wasm.canonicalCardNames).toHaveBeenCalledWith(["Revival/Revenge", "Not A Card"]);
    expect(wasm.get_card_face_data).not.toHaveBeenCalled();
    expect(fakeSelf.postMessage).toHaveBeenCalledWith({
      type: "result",
      id: 1,
      data: ["Revival // Revenge", null],
    });
  });
});


describe("experimental Local worker boundary", () => {
  let fakeSelf: { postMessage: ReturnType<typeof vi.fn>; onmessage: unknown };
  const bootstrap = vi.fn();
  const verify = vi.fn();
  beforeEach(async () => {
    vi.resetModules();
    bootstrap.mockReset().mockReturnValue({ events: [], log_entries: [] });
    verify.mockReset().mockReturnValue(0);
    vi.doMock("@wasm/engine", () => ({ default: vi.fn(), initialize_experimental_local_game: bootstrap, experimental_local_actor: verify }));
    fakeSelf = { postMessage: vi.fn(), onmessage: null };
    vi.stubGlobal("self", fakeSelf);
    await import("../engine-worker");
  });
  afterEach(() => vi.unstubAllGlobals());
  const send = (data: Record<string, unknown>) => (fakeSelf.onmessage as (e: unknown) => Promise<void>)({ data });
  it("forwards the valid fields and normalizes verification", async () => {
    const request = { seed: 42, deckData: null, formatConfig: null, matchConfig: null, playerCount: 2, firstPlayer: 0 };
    await send({ ...request, type: "initializeExperimentalLocalGame", id: 1 });
    expect(bootstrap).toHaveBeenCalledWith(request);
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "result", id: 1, data: { events: [], log_entries: [], localContinuationContext: null } });
    await send({ type: "experimentalLocalActor", id: 2 });
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "result", id: 2, data: 0 });
    verify.mockReturnValue(1);
    await send({ type: "experimentalLocalActor", id: 3 });
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "result", id: 3, data: null });
  });
  it("refuses every extra field before WASM", async () => {
    for (const key of ["actor", "authenticatedActor", "owner", "session", "ticket", "enrollment", "worker", "unknown"]) {
      await send({ type: "initializeExperimentalLocalGame", id: 4, [key]: 0 });
      expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "error", id: 4, message: "Invalid experimental Local request" });
    }
    expect(bootstrap).not.toHaveBeenCalled();
    await send({ type: "initializeExperimentalLocalGame", id: 5, seed: 42 });
    expect(bootstrap).toHaveBeenCalledOnce();
  });
  it("forwards a startup trusted checkpoint inside the single initializer", async () => {
    const request = { seed: 42, trustedCheckpoint: '{"state":{},"precast_shortcut_runtime":null}' };
    await send({ ...request, type: "initializeExperimentalLocalGame", id: 9 });
    expect(bootstrap).toHaveBeenCalledExactlyOnceWith(request);
  });
  it("retains the existing typed initialization refusal", async () => {
    bootstrap.mockReturnValue({ error: true, engine_occupied: true, reasons: ["occupied"] });
    await send({ type: "initializeExperimentalLocalGame", id: 6 });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "error", id: 6, message: "Finish or leave your current game before starting a new one.", engineOccupied: true });
    expect(fakeSelf.postMessage.mock.lastCall?.[0].message).not.toContain("occupied");
  });
  it("loads an off namespace and refuses bootstrap while verification is null", async () => {
    vi.resetModules();
    vi.doMock("@wasm/engine", () => ({ default: vi.fn(), initialize_experimental_local_game: undefined, experimental_local_actor: undefined }));
    await import("../engine-worker");
    await send({ type: "initializeExperimentalLocalGame", id: 7 });
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "error", id: 7, message: "Experimental Local bootstrap unavailable" });
    await send({ type: "experimentalLocalActor", id: 8 });
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "result", id: 8, data: null });
  });
});

describe("Worker frame revisions belong only to admitted Local authority (mock native boundary)", () => {
  const context = { ownerLineage: "owner.frames", interactionSessionId: "session.frames", restoreEpoch: 0, adapterGeneration: 10 };
  const restoredContext = { ...context, interactionSessionId: "session.restored", restoreEpoch: 1, adapterGeneration: 11 };
  const presentation = { outcome: "resumed", automatedResolutionCount: 1, omittedEventCount: 0, logEntries: [] };
  let fakeSelf: { postMessage: ReturnType<typeof vi.fn>; onmessage: unknown };
  const raw = vi.fn();
  const submit = vi.fn();
  const readState = vi.fn();
  const readLegal = vi.fn();
  const send = (data: Record<string, unknown>) => (fakeSelf.onmessage as (event: unknown) => Promise<void>)({ data });
  const reply = (id: number) => [...fakeSelf.postMessage.mock.calls].reverse().find(([message]) => message.id === id)?.[0];
  const current = () => ({ context: restoredContext, frameSequence: 0, snapshot: { state: { life: 18 }, actions: [], events: [] } });
  beforeEach(async () => {
    vi.resetModules();
    raw.mockReset().mockReturnValue({ status: "applied", result: { events: [], log_entries: [] } });
    submit.mockReset().mockReturnValue({ type: "localContinuation", receipt: null, appliedResult: null, current: current() });
    readState.mockReset().mockReturnValue({ life: 20 });
    readLegal.mockReset().mockReturnValue({ actions: [] });
    vi.doMock("@wasm/engine", () => ({ default: vi.fn(),
      initialize_game: () => ({ events: [], log_entries: [] }),
      initialize_multiplayer_host_game: () => ({ events: [], log_entries: [] }),
      initialize_experimental_local_game: () => ({ events: [], log_entries: [], localContinuationContext: context }),
      experimental_local_actor: () => 0,
      submit_action: raw, submit_interaction_js: submit,
      submit_ai_action_proposal: () => ({ status: "applied", result: { events: [] } }),
      get_game_state: readState, get_legal_actions_js: readLegal,
      get_viewer_snapshot_js: () => ({ state: { life: 20 }, actions: [] }),
      restore_game_state: () => {}, clear_game_state: () => {}, set_multiplayer_mode: () => {},
      resume_restored_game_state: () => presentation,
      resume_multiplayer_host_state: () => presentation,
    }));
    fakeSelf = { postMessage: vi.fn(), onmessage: null };
    vi.stubGlobal("self", fakeSelf);
    await import("../engine-worker");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps long ordinary play and snapshot reads outside the Local counter and metadata", async () => {
    await send({ type: "initializeGame", id: 1, seed: 42 });
    expect(reply(1).data).toEqual({ events: [], log_entries: [] });
    for (let index = 0; index < 128; index += 1) {
      const actionId = index * 2 + 2;
      await send({ type: "submitAction", id: actionId, actor: 0, action: { type: "PassPriority" } });
      expect(reply(actionId).data).toEqual({ events: [], log_entries: [] });
      await send({ type: "getSnapshot", id: actionId + 1 });
      expect(reply(actionId + 1).data).toEqual({ state: { life: 20 }, legalResult: { actions: [] } });
    }
    expect(raw).toHaveBeenCalledTimes(128);
    expect(readState).toHaveBeenCalledTimes(128);
    expect(readLegal).toHaveBeenCalledTimes(128);
    const ordinary = { interactionId: "ordinary.frame", response: { type: "choose", data: { choiceId: "ordinary.choice" } } };
    submit.mockReturnValueOnce({ status: "applied", result: { events: [], log_entries: [] } });
    await send({ type: "submitInteraction", id: 290, actor: 0, submission: ordinary });
    expect(reply(290).data).toEqual({ events: [], log_entries: [] });
    await send({ type: "initializeExperimentalLocalGame", id: 300, seed: 42 });
    expect(reply(300).data.frameSequence).toBe(1);
    await send({ type: "getViewerSnapshot", id: 301, viewerId: 0, localContinuation: true });
    expect(reply(301).data.current.frameSequence).toBe(1);
    await send({ type: "submitAction", id: 302, actor: 0, action: { type: "PassPriority" } });
    expect(reply(302).data).toEqual({ events: [], log_entries: [] });
    await send({ type: "getViewerSnapshot", id: 303, viewerId: 0, localContinuation: true });
    await send({ type: "getViewerSnapshot", id: 304, viewerId: 0, localContinuation: true });
    expect(reply(303).data.current.frameSequence).toBe(2);
    expect(reply(304).data.current.frameSequence).toBe(2);
    await send({ type: "getSnapshot", id: 305 });
    expect(reply(305).data).toEqual({ state: { life: 20 }, legalResult: { actions: [] } });
    submit.mockReturnValueOnce({ status: "applied", result: { events: [], log_entries: [] } });
    await send({ type: "submitInteraction", id: 306, actor: 0, submission: ordinary });
    expect(reply(306).data).toEqual({ events: [], log_entries: [] });
    await send({ type: "getViewerSnapshot", id: 307, viewerId: 0, localContinuation: true });
    expect(reply(307).data.current.frameSequence).toBe(3);
  });

  it.each([
    { type: "initializeGame", seed: 43 },
    { type: "initializeMultiplayerHostGame", seed: 43 },
    { type: "restoreState", stateJson: "trusted.fixture" },
    { type: "resumeMultiplayerHostState", stateJson: "trusted.fixture" },
    { type: "resetGame" },
    { type: "setMultiplayerMode", enabled: true },
  ])("retires Local ordering on successful $type without adding it to the ordinary result", async (operation) => {
    await send({ type: "initializeExperimentalLocalGame", id: 1, seed: 42 });
    await send({ type: "submitAction", id: 2, actor: 0, action: { type: "PassPriority" } });
    await send({ ...operation, id: 3 });
    expect(reply(3).type).toBe("result");
    if (reply(3).data !== null) expect(reply(3).data).not.toHaveProperty("frameSequence");
    if (operation.type === "resumeMultiplayerHostState") expect(reply(3).data.snapshot).not.toHaveProperty("frameSequence");
    await send({ type: "getViewerSnapshot", id: 4, viewerId: 0, localContinuation: true });
    expect(reply(4)).toMatchObject({ type: "error", message: "Authenticated Local continuation unavailable" });
    await send({ type: "initializeExperimentalLocalGame", id: 5, seed: 44 });
    expect(reply(5).data.frameSequence).toBe(1);
  });

  it("keeps same-owner restore monotonic and advances ordinary resident commits only during admission", async () => {
    const proposal = { token: "ordinary.ai", actor: 0, action: { type: "PassPriority" } };
    await send({ type: "submitAiActionProposal", id: 1, proposal });
    await send({ type: "resumeRestoredGameState", id: 2 });
    expect(reply(2).data.snapshot).not.toHaveProperty("frameSequence");
    await send({ type: "initializeExperimentalLocalGame", id: 3, seed: 42 });
    await send({ type: "submitInteraction", id: 4, actor: 0,
      submission: { type: "localContinuation", operation: "restore", context, checkpoint: "trusted.fixture" } });
    expect(reply(4).data.current.context).toEqual(restoredContext);
    expect(reply(4).data.current.frameSequence).toBe(2);
    await send({ type: "getViewerSnapshot", id: 5, viewerId: 0, localContinuation: true });
    expect(reply(5).data.current.frameSequence).toBe(2);
    await send({ type: "submitAiActionProposal", id: 6, proposal });
    await send({ type: "resumeRestoredGameState", id: 7 });
    expect(reply(7).data.snapshot).not.toHaveProperty("frameSequence");
    await send({ type: "getViewerSnapshot", id: 8, viewerId: 0, localContinuation: true });
    expect(reply(8).data.current.frameSequence).toBe(4);
    expect(submit).toHaveBeenCalledExactlyOnceWith(0, {
      type: "localContinuation", operation: "restore", context, checkpoint: "trusted.fixture",
    });
  });
});

describe("Local continuation Worker custody and lifecycle (mock native boundary)", () => {
  const context = { ownerLineage: "owner.fixture", interactionSessionId: "session.fixture", restoreEpoch: 0, adapterGeneration: 0 };
  const attempt = {
    context, attemptId: "original.loss.1",
    submission: { interactionId: "frame.1", response: { type: "manualResolution", data: { decision: { type: "loseOwnLife", data: { amount: 1 } } } } },
    source: { actor: 0, sourceId: 40, sourceIncarnation: 2, stackEntryId: 44, castTurnJournalIndex: 0, cardId: 1, name: "Fixture" },
  };
  let fakeSelf: { postMessage: ReturnType<typeof vi.fn>; onmessage: unknown };
  let queued: (() => void)[];
  let life: number;
  let status: "pending" | "completed" | "not-applied" | null;
  const submit = vi.fn();
  const raw = vi.fn();
  const restore = vi.fn();
  const nativeReply = (original = attempt, applied = false) => ({
    type: "localContinuation", receipt: { attempt: original, status, result: status === "completed" ? { events: [{ type: "LifeLost" }], log_entries: [] } : null, rejection: null },
    current: { context, frameSequence: 0, snapshot: { state: { life }, actions: [], events: [] } },
    appliedResult: applied ? { events: [{ type: "LifeLost" }], log_entries: [] } : null,
  });
  const send = (data: Record<string, unknown>) => (fakeSelf.onmessage as (e: unknown) => Promise<void>)({ data });
  const envelope = (operation: string, original = attempt) => ({ type: "localContinuation", operation, attempt: original });
  const reply = (id: number) => [...fakeSelf.postMessage.mock.calls].reverse().find(([message]) => message.id === id)?.[0];
  beforeEach(async () => {
    vi.resetModules(); queued = []; life = 20; status = null;
    submit.mockReset().mockImplementation((_actor, request) => {
      if (request.operation === "register" && status === null) status = "pending";
      if (request.operation === "lookup" && status === null) status = "not-applied";
      if (request.operation === "apply" && status === "pending") { life -= 1; status = "completed"; return nativeReply(request.attempt, true); }
      return nativeReply(request.attempt);
    });
    raw.mockReset().mockReturnValue({ status: "applied", result: { events: [], log_entries: [] } });
    restore.mockReset().mockReturnValue(undefined);
    vi.doMock("@wasm/engine", () => ({ default: vi.fn(),
      initialize_experimental_local_game: () => ({ events: [], log_entries: [], localContinuationContext: context }),
      experimental_local_actor: () => 0, submit_interaction_js: submit, submit_action: raw,
      restore_game_state: restore, clear_game_state: () => { status = "not-applied"; },
    }));
    fakeSelf = { postMessage: vi.fn(), onmessage: null };
    vi.stubGlobal("self", fakeSelf);
    vi.stubGlobal("queueMicrotask", (callback: () => void) => queued.push(callback));
    await import("../engine-worker");
    await send({ type: "initializeExperimentalLocalGame", id: 1 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("registers before execution, observes held pending without applying, and coalesces duplicate RPCs", async () => {
    await send({ type: "submitInteraction", id: 2, actor: 0, submission: envelope("register") });
    const first = send({ type: "submitInteraction", id: 3, actor: 0, submission: envelope("apply") });
    const duplicate = send({ type: "submitInteraction", id: 4, actor: 0, submission: envelope("apply") });
    expect(queued).toHaveLength(1);
    await send({ type: "submitInteraction", id: 5, actor: 0, submission: envelope("lookup") });
    expect(reply(5).data.receipt.status).toBe("pending");
    expect(reply(5).data.current.frameSequence).toBe(reply(2).data.current.frameSequence);
    expect(life).toBe(20);
    expect(submit.mock.calls.map(([, request]) => request.operation)).toEqual(["register", "lookup", "lookup", "lookup"]);
    await send({ type: "submitAction", id: 6, actor: 0, action: { type: "PassPriority" } });
    expect(reply(6)).toMatchObject({ type: "error", message: "Local continuation pending" });
    expect(raw).not.toHaveBeenCalled();
    queued.shift()!(); await Promise.all([first, duplicate]);
    expect(life).toBe(19);
    expect(reply(3).data.appliedResult).not.toBeNull();
    expect(reply(4).data.appliedResult).toBeNull();
    expect(reply(3).data.current.frameSequence).toBe(reply(4).data.current.frameSequence);
    await send({ type: "submitAction", id: 7, actor: 0, action: { type: "PassPriority" } });
    expect(raw).toHaveBeenCalledOnce();
    await send({ type: "submitInteraction", id: 8, actor: 0, submission: envelope("apply") });
    expect(queued).toHaveLength(0);
    expect(life).toBe(19);
    expect(reply(8).data.appliedResult).toBeNull();
    expect(reply(8).data.current.frameSequence).toBeGreaterThan(reply(3).data.current.frameSequence);
  });

  it("preserves held custody on failed public restore and fences an old queued apply after reset", async () => {
    await send({ type: "submitInteraction", id: 2, actor: 0, submission: envelope("register") });
    const applying = send({ type: "submitInteraction", id: 3, actor: 0, submission: envelope("apply") });
    restore.mockImplementationOnce(() => { throw new Error("invalid trusted envelope"); });
    await send({ type: "restoreState", id: 4, stateJson: "bad" });
    expect(reply(4)).toMatchObject({ type: "error", message: "invalid trusted envelope" });
    await send({ type: "submitInteraction", id: 5, actor: 0, submission: envelope("lookup") });
    expect(reply(5).data.receipt.status).toBe("pending");
    await send({ type: "resetGame", id: 6 });
    queued.shift()!(); await applying;
    expect(reply(3)).toMatchObject({ type: "error", message: "Local continuation lifecycle changed" });
    expect(submit.mock.calls.some(([, request]) => request.operation === "apply")).toBe(false);
    expect(life).toBe(20);
  });

  it("releases custody after a terminal echo with the same values in a different key order", async () => {
    const reordered = { source: { ...attempt.source }, submission: attempt.submission,
      attemptId: attempt.attemptId, context: { ...context } };
    submit.mockImplementation((_actor, request) => {
      if (request.operation === "register") status = "pending";
      if (request.operation === "apply") { life -= 1; status = "completed"; }
      return nativeReply(request.operation === "apply" ? reordered : attempt, request.operation === "apply");
    });
    await send({ type: "submitInteraction", id: 2, actor: 0, submission: envelope("register") });
    const applying = send({ type: "submitInteraction", id: 3, actor: 0, submission: envelope("apply") });
    queued.shift()!(); await applying;
    expect(life).toBe(19);
    await send({ type: "submitAction", id: 4, actor: 0, action: { type: "PassPriority" } });
    expect(raw).toHaveBeenCalledOnce();
    expect(reply(4).type).toBe("result");
  });

  it("never enqueues a late apply after native lookup certifies original absence", async () => {
    await send({ type: "submitInteraction", id: 2, actor: 0, submission: envelope("lookup") });
    await send({ type: "submitInteraction", id: 3, actor: 0, submission: envelope("apply") });
    expect(reply(3).data.receipt.status).toBe("not-applied");
    expect(queued).toHaveLength(0);
    expect(life).toBe(20);
    expect(submit.mock.calls.every(([, request]) => request.operation === "lookup")).toBe(true);
  });
});
