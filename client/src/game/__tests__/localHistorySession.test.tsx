import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError, nextSnapshotSeq, type ActionResult, type EngineSnapshot, type GameAction } from "../../adapter/types";
import type { InteractionSubmission } from "../../adapter/generated/interaction";
import { buildEngineAdapterMock } from "../../test/factories/engineAdapterFactory";
import { buildGameState, buildLegalActionsResult, buildPriorityWaitingFor } from "../../test/factories/gameStateFactory";
import { nextGameSessionGeneration, useGameStore } from "../../stores/gameStore";
import { useUiStore } from "../../stores/uiStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { useGameplayPreferencesSync } from "../../hooks/useGameplayPreferencesSync";
import { UndoButton } from "../../components/board/UndoButton";
import { FORMAT_REGISTRY } from "../../data/formatRegistry";
import { endLocalHistorySession, startLocalHistorySession } from "../localHistorySession";
import { dispatchAction, dispatchActionForGameSession, dispatchInteraction, restoreGameState } from "../dispatch";

vi.mock("../../services/gamePersistence", async importOriginal => ({
  ...await importOriginal<typeof import("../../services/gamePersistence")>(),
  saveAuthoritativeGame: vi.fn().mockResolvedValue(undefined),
  saveAuthoritativeGameStrict: vi.fn().mockResolvedValue(undefined),
}));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};
const pass: GameAction = { type: "PassPriority" };
const capability = { interactionId: "fixture-issued", response: { type: "choose", data: { choiceId: "fixture-choice" } } } as InteractionSubmission;
const refusal = () => new AdapterError("ACTION_REJECTED", "fixture refusal", false, undefined, {
  code: "invalid_action", disposition: "invalid", message: "fixture refusal", related_object_ids: [],
});

// Boundary fixture only. This deliberately does not claim Rust/WASM semantics.
function fixture() {
  let engine = buildGameState({ waiting_for: buildPriorityWaitingFor(), phase_stops: { 0: [] }, priority_passing_modes: { 0: "Standard" } });
  const client = {};
  const accepted = (action: GameAction): ActionResult => {
    if (action.type === "SetPhaseStops") engine.phase_stops = { 0: action.data.stops };
    else if (action.type === "SetPriorityPassingMode") engine.priority_passing_modes = { 0: action.data.mode };
    else engine.turn_number++;
    return { waiting_for: engine.waiting_for,
      events: [{ type: "TurnStarted", data: { player_id: 0, turn_number: engine.turn_number } }],
      log_entries: [{ seq: 0, turn: engine.turn_number, phase: engine.phase, category: "Turn", segments: [{ type: "Text", value: "fixture applied" }] }],
    };
  };
  const submit = vi.fn(async (action: GameAction) => accepted(action));
  const interaction = vi.fn(async () => accepted(pass));
  const snapshot = vi.fn(async (): Promise<EngineSnapshot> => ({ state: structuredClone(engine), legalResult: buildLegalActionsResult(), seq: nextSnapshotSeq() }));
  const exported = () => JSON.stringify({ state: engine, secret: "fixture-only", rng: "18446744073709551615" });
  const capture = vi.fn(async () => exported());
  const restore = vi.fn(async (raw: string, current?: () => boolean) => { if (!current || current()) engine = JSON.parse(raw).state; });
  const dispose = vi.fn();
  const adapter = Object.assign(buildEngineAdapterMock(engine, {
    submitAction: submit, submitInteraction: interaction, getSnapshot: snapshot,
    exportPersistenceState: capture, restoreTrustedState: restore, dispose,
  }), { getEngineClient: () => client });
  return { adapter, submit, interaction, snapshot, capture, restore, dispose, exported, accepted };
}

async function bind(f = fixture()) {
  const pair = await f.snapshot();
  useGameStore.setState({ adapter: f.adapter, gameId: "fixture-local", gameMode: "local", gameSessionGeneration: nextGameSessionGeneration(), lastCommittedSeq: 0 });
  useGameStore.getState().commitEngineSnapshot(pair);
  startLocalHistorySession(f.adapter);
  return f;
}

async function init(f = fixture()) {
  await useGameStore.getState().initGame("fixture-local", f.adapter, { player: { main_deck: ["Forest"] }, opponent: { main_deck: ["Forest"] } },
    FORMAT_REGISTRY.find(f => f.format === "Limited")!.default_config, 2, undefined, 0, "best-effort", true);
  return f;
}

describe("opted-in Local history through existing entrances", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true); vi.stubEnv("VITE_PHASE_LOCAL_HISTORY", "1");
    endLocalHistorySession(); useGameStore.getState().reset();
    useGameStore.setState({ gameMode: "local" });
    usePreferencesStore.setState({ phaseStops: [], priorityPassingMode: "Standard" });
    useUiStore.setState({ fullControl: false, selectedCardIds: [], pendingAbilityChoice: null });
  });
  afterEach(() => { cleanup(); endLocalHistorySession(); useGameStore.getState().reset(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("records one submission per dispatch/store/interaction, and existing Undo restores PRE plus log/pending UI", async () => {
    const f = await bind(), pre = f.exported();
    render(<UndoButton />);
    expect(screen.getByRole("button")).toBeDisabled();
    await act(() => dispatchAction(pass));
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.capture.mock.invocationCallOrder[0]).toBeLessThan(f.submit.mock.invocationCallOrder[0]);
    expect(useGameStore.getState().stateHistory).toEqual([]);
    expect(useGameStore.getState().logHistory).toHaveLength(1);
    useUiStore.setState({ selectedCardIds: [999], pendingAbilityChoice: { objectId: 999, actions: [] } });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(useGameStore.getState().localHistory?.phase).toBe("idle"));
    expect(f.exported()).toBe(pre);
    expect(useGameStore.getState().logHistory).toEqual([]);
    expect(useGameStore.getState().eventHistory).toEqual([]);
    expect(useUiStore.getState().selectedCardIds).toEqual([]);
    expect(useUiStore.getState().pendingAbilityChoice).toBeNull();
    await act(() => useGameStore.getState().dispatch(pass));
    await act(() => dispatchInteraction(capability));
    expect(f.submit).toHaveBeenCalledTimes(2); expect(f.interaction).toHaveBeenCalledOnce();
    expect(useGameStore.getState().localHistory?.entries).toBe(2);
  });

  it("keeps every PRE beyond the old five-entry ring and prunes future only on an accepted replacement", async () => {
    const f = await bind(), pre = f.exported();
    for (let n = 0; n < 7; n++) await dispatchAction(pass);
    expect(useGameStore.getState().localHistory?.entries).toBe(7);
    await useGameStore.getState().undo();
    f.submit.mockRejectedValueOnce(refusal()); await dispatchAction(pass);
    expect(useGameStore.getState().localHistory?.entries).toBe(6);
    f.capture.mockRejectedValueOnce(Error("capture")); await dispatchAction(pass);
    expect(useGameStore.getState().localHistory?.entries).toBe(6);
    await dispatchAction(pass);
    for (let n = 0; n < 7; n++) await useGameStore.getState().undo();
    expect(f.exported()).toBe(pre); expect(useGameStore.getState().stateHistory).toEqual([]);
  });

  it("blocks duplicate/cross-entry submits and Undo until a delayed submission is terminal", async () => {
    const f = await bind(), gate = deferred(), reached = deferred();
    f.submit.mockImplementationOnce(async action => { reached.resolve(); await gate.promise; return f.accepted(action); });
    const pending = dispatchAction(pass); await reached.promise;
    await Promise.all([dispatchAction(pass), useGameStore.getState().dispatch(pass), dispatchInteraction(capability), useGameStore.getState().undo()]);
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.interaction).not.toHaveBeenCalled(); expect(f.restore).not.toHaveBeenCalled();
    expect(useGameStore.getState().localHistory?.phase).toBe("busy");
    gate.resolve(); await pending;
    expect(useGameStore.getState().localHistory).toMatchObject({ entries: 1, phase: "idle", canUndo: true });
  });

  it("capture failure sends nothing, while unknown post-mutation failure drains and recovers exact PRE before unlock", async () => {
    const f = await bind(), pre = f.exported();
    f.capture.mockRejectedValueOnce(Error("capture")); await dispatchAction(pass);
    expect(f.submit).not.toHaveBeenCalled(); expect(f.exported()).toBe(pre);
    f.submit.mockImplementationOnce(async action => { f.accepted(action); throw Error("unknown transport outcome"); });
    await dispatchAction(pass);
    expect(f.restore).toHaveBeenCalledOnce(); expect(f.exported()).toBe(pre);
    expect(useGameStore.getState().localHistory).toMatchObject({ phase: "idle", entries: 0 });
    await dispatchAction(pass); expect(useGameStore.getState().localHistory?.entries).toBe(1);
  });

  it.each(["false", "partial"])("recovers PRE and display after %s store adoption", async fault => {
    const f = await bind(), pre = f.exported(), commit = useGameStore.getState().commitEngineSnapshot;
    const injected = vi.fn<typeof commit>((pair, options) => {
      useGameStore.setState({ commitEngineSnapshot: commit });
      if (fault === "false") return false;
      commit(pair, options); throw Error("partial store adoption");
    });
    useGameStore.setState({ commitEngineSnapshot: injected });
    await dispatchAction(pass);
    expect(f.exported()).toBe(pre); expect(useGameStore.getState().logHistory).toEqual([]);
    expect(useGameStore.getState().localHistory).toMatchObject({ phase: "idle", entries: 0 });
  });

  it("a failed restore stays locked through retry and terminates its executor if recovery also fails", async () => {
    const f = await bind(); await dispatchAction(pass);
    f.restore.mockRejectedValue(Error("restore unavailable")); await useGameStore.getState().undo();
    expect(f.restore).toHaveBeenCalledTimes(2); expect(f.dispose).toHaveBeenCalledOnce();
    expect(useGameStore.getState().localHistory?.phase).toBe("stopped");
    await dispatchAction(pass); await useGameStore.getState().undo();
    expect(f.submit).toHaveBeenCalledOnce(); expect(useGameStore.getState().stateHistory).toEqual([]);
  });

  it.each(["capture", "submit", "restore"])("retired %s cannot adopt or clear a replacement session", async stage => {
    const f = await bind(), gate = deferred(), reached = deferred();
    let pending: Promise<void>;
    if (stage === "restore") {
      await dispatchAction(pass);
      f.restore.mockImplementationOnce(async () => { reached.resolve(); await gate.promise; });
      pending = useGameStore.getState().undo();
    } else if (stage === "capture") {
      f.capture.mockImplementationOnce(async () => { reached.resolve(); await gate.promise; return f.exported(); });
      pending = dispatchAction(pass);
    } else {
      f.submit.mockImplementationOnce(async action => { reached.resolve(); await gate.promise; return f.accepted(action); });
      pending = dispatchAction(pass);
    }
    await reached.promise; useGameStore.getState().reset();
    const replacement = await bind(); const replacementState = useGameStore.getState().gameState;
    useUiStore.setState({ selectedCardIds: [777] });
    gate.resolve(); await pending;
    expect(useGameStore.getState().adapter).toBe(replacement.adapter);
    expect(useGameStore.getState().gameState).toBe(replacementState);
    expect(useUiStore.getState().selectedCardIds).toEqual([777]);
    expect(useGameStore.getState().localHistory?.entries).toBe(0);
    if (stage === "capture") expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(["raw-submit", "raw-client", "external-pair", "legacy-restore"])("fails closed on %s without submitting an unrecorded mutation", async entrance => {
    const f = await bind();
    if (entrance === "raw-submit") expect(() => f.adapter.submitAction(pass, 0)).toThrow();
    if (entrance === "raw-client") expect(() => f.adapter.getEngineClient()).toThrow();
    if (entrance === "external-pair") expect(useGameStore.getState().commitEngineSnapshot(await f.snapshot())).toBe(false);
    if (entrance === "legacy-restore") await expect(restoreGameState(buildGameState())).resolves.toMatch(/blocked/);
    expect(f.submit).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledOnce();
    expect(useGameStore.getState().localHistory?.phase).toBe("stopped");
  });

  it("permits initialized card-data reads without opening initialize or restoring old Undo", async () => {
    const f = await bind(); await expect(f.adapter.initialize()).resolves.toBeUndefined();
    expect(f.dispose).not.toHaveBeenCalled();
    endLocalHistorySession(); await expect(f.adapter.initialize()).rejects.toThrow();
  });

  it("configures new Local before its first pair and avoids synchronous unrecorded preference sends", async () => {
    renderHook(() => useGameplayPreferencesSync());
    const f = await init();
    expect(f.submit.mock.calls.map(([a]) => a.type)).toEqual(["SetPhaseStops", "SetPriorityPassingMode"]);
    expect(useGameStore.getState().localHistory).toMatchObject({ phase: "idle", entries: 0 });
    expect(f.dispose).not.toHaveBeenCalled();
  });

  it("pending settings wait for a root, failure does not self-retry, and Undo aligns PRE settings/cache", async () => {
    const f = await init(); renderHook(() => useGameplayPreferencesSync());
    const gate = deferred(), reached = deferred();
    f.submit.mockImplementationOnce(async action => { reached.resolve(); await gate.promise; return f.accepted(action); });
    const pending = dispatchAction(pass); await reached.promise;
    act(() => usePreferencesStore.getState().setPriorityPassingMode("SkipLowUseWindows"));
    expect(f.submit).toHaveBeenCalledTimes(3);
    gate.resolve(); await pending;
    await waitFor(() => expect(useGameStore.getState().localHistory?.entries).toBe(2));
    expect(f.submit.mock.calls[f.submit.mock.calls.length - 1]?.[0]).toEqual({ type: "SetPriorityPassingMode", data: { mode: "SkipLowUseWindows" } });
    await act(() => useGameStore.getState().undo());
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("Standard");
    expect(useGameStore.getState().gameState?.priority_passing_modes?.[0]).toBe("Standard");
    const captures = f.capture.mock.calls.length;
    f.capture.mockRejectedValue(Error("persistent capture failure"));
    act(() => usePreferencesStore.getState().setPriorityPassingMode("SkipLowUseWindows"));
    await waitFor(() => expect(useGameStore.getState().localHistory?.notice).toBe("notStarted"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.capture).toHaveBeenCalledTimes(captures + 1);
    await expect(dispatchActionForGameSession({ type: "SetPriorityPassingMode", data: { mode: "SkipLowUseWindows" } }, f.adapter, useGameStore.getState().gameSessionGeneration)).rejects.toThrow();
  });

  it("rejects fallback before game creation and invalidates an initialization reservation on adapter replacement", async () => {
    const fallback = fixture(); fallback.adapter.getEngineClient = () => null as never;
    await expect(init(fallback)).rejects.toThrow(/module Worker/);
    expect(fallback.adapter.initializeGame).not.toHaveBeenCalled();
    const f = fixture(), gate = deferred(); f.adapter.initialize.mockImplementationOnce(() => gate.promise);
    const pending = init(f); const other = fixture().adapter;
    useGameStore.getState().setAdapter(other); gate.resolve();
    await expect(pending).rejects.toThrow(/Retired/);
    expect(useGameStore.getState().adapter).toBe(other); expect(f.adapter.initializeGame).not.toHaveBeenCalled();
  });

  it("Undo restores temporary Full Control and the persisted-mode presentation without a POST resend", async () => {
    const f = await init(); renderHook(() => useGameplayPreferencesSync());
    act(() => useUiStore.getState().toggleFullControl());
    await waitFor(() => expect(useGameStore.getState().localHistory?.entries).toBe(1));
    await act(() => useGameStore.getState().undo());
    expect(useUiStore.getState().fullControl).toBe(false);
    expect(useGameStore.getState().gameState?.priority_passing_modes?.[0]).toBe("Standard");
    expect(f.submit).toHaveBeenCalledTimes(3);
    useGameStore.getState().reset(); useGameStore.setState({ gameMode: "local" });
    usePreferencesStore.setState({ priorityPassingMode: "FullControl" });
    const other = await init();
    await act(() => dispatchAction(pass)); await act(() => useGameStore.getState().undo());
    expect(useUiStore.getState().fullControl).toBe(false);
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("FullControl");
    expect(other.submit).toHaveBeenCalledTimes(3);
  });

  it("opt-out/mode preflight sends nothing and failed setup terminates only its owned adapter", async () => {
    const f = fixture(); vi.stubEnv("VITE_PHASE_LOCAL_HISTORY", "0");
    await expect(init(f)).rejects.toThrow(/opted-in/); expect(f.adapter.initialize).not.toHaveBeenCalled();
    vi.stubEnv("VITE_PHASE_LOCAL_HISTORY", "1");
    f.submit.mockRejectedValueOnce(Error("setup failed")); await expect(init(f)).rejects.toThrow(/setup failed/);
    expect(f.dispose).toHaveBeenCalledOnce(); expect(useGameStore.getState().adapter).toBeNull();
  });
});
