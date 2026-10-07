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
import { useLocalUiAction, useLocalPreferenceAction } from "../../hooks/useLocalSeat";
import { usePhaseStopCycle } from "../../components/controls/PhaseStopBar";
import { useDragToCast } from "../../hooks/useDragToCast";
import { useGameDispatch } from "../../hooks/useGameDispatch";
import { getPlayerId } from "../../hooks/usePlayerId";
import { LocalSeatBoundary } from "../../components/board/LocalSeatBoundary";
import { previewAutomaticManaPayment } from "../manaPaymentPreview";
import { UndoButton } from "../../components/board/UndoButton";
import { FORMAT_REGISTRY } from "../../data/formatRegistry";
import { captureLocalSeat, currentLocalHistory, endLocalHistorySession, initialLocalViewer, startLocalHistorySession } from "../localHistorySession";
import { dispatchAction as rawDispatch, dispatchActionForGameSession, dispatchInteraction as rawInteraction, restoreGameState } from "../dispatch";

vi.mock("../../services/gamePersistence", async importOriginal => ({
  ...await importOriginal<typeof import("../../services/gamePersistence")>(),
  saveAuthoritativeGame: vi.fn().mockResolvedValue(undefined),
  saveAuthoritativeGameStrict: vi.fn().mockResolvedValue(undefined),
}));

const dispatchAction = (action: GameAction, actor = captureLocalSeat()?.seat ?? 0) => rawDispatch(action, actor, { localSeat: captureLocalSeat() });
const dispatchInteraction = (submission: InteractionSubmission) => rawInteraction(submission, captureLocalSeat()?.seat ?? 0, captureLocalSeat());
const storeDispatch = (action: GameAction) => useGameStore.getState().dispatch(action, captureLocalSeat());
const undo = () => useGameStore.getState().undo(captureLocalSeat());

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
  const accepted = (action: GameAction, actor = 0): ActionResult => {
    if (action.type === "SetPhaseStops") engine.phase_stops = { ...engine.phase_stops, [actor]: action.data.stops };
    else if (action.type === "SetPriorityPassingMode") engine.priority_passing_modes = { ...engine.priority_passing_modes, [actor]: action.data.mode };
    else engine.turn_number++;
    return { waiting_for: engine.waiting_for,
      events: [{ type: "TurnStarted", data: { player_id: 0, turn_number: engine.turn_number } }],
      log_entries: [{ seq: 0, turn: engine.turn_number, phase: engine.phase, category: "Turn", presentation: { visibility: "Public", importance: "Essential", tone: "Neutral", boundary: "None" }, segments: [{ type: "Text", value: "fixture applied" }] }],
    };
  };
  const submit = vi.fn(async (action: GameAction, actor: number) => accepted(action, actor));
  const interaction = vi.fn(async () => accepted(pass));
  const snapshot = vi.fn(async (): Promise<EngineSnapshot> => ({ state: structuredClone(engine), legalResult: buildLegalActionsResult(), seq: nextSnapshotSeq() }));
  const viewer = vi.fn(async (seat: number) => {
    const state = structuredClone(engine);
    state.objects = { ...state.objects };
    return { state, ...buildLegalActionsResult({ actions: seat === 0 ? [pass] : [] }) };
  });
  const transition = vi.fn(async (seat: number, events: ActionResult["events"]) => ({ ...await viewer(seat), events }));
  const exported = () => JSON.stringify({ state: engine, secret: "fixture-only", rng: "18446744073709551615" });
  const capture = vi.fn(async () => exported());
  const restore = vi.fn(async (raw: string, current?: () => boolean) => { if (!current || current()) engine = JSON.parse(raw).state; });
  const dispose = vi.fn();
  const adapter = Object.assign(buildEngineAdapterMock(engine, {
    submitAction: submit, submitInteraction: interaction, getSnapshot: snapshot,
    exportPersistenceState: capture, restoreTrustedState: restore, dispose,
  }), { getEngineClient: () => client, getViewerSnapshot: viewer, getViewerTransitionSnapshot: transition });
  return { adapter, submit, interaction, snapshot, viewer, transition, capture, restore, dispose, exported, accepted };
}

async function bind(f = fixture()) {
  const pair = await initialLocalViewer(f.adapter, (await f.snapshot()).seq);
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
    await act(() => storeDispatch(pass));
    await act(() => dispatchInteraction(capability));
    expect(f.submit).toHaveBeenCalledTimes(2); expect(f.interaction).toHaveBeenCalledOnce();
    expect(useGameStore.getState().localHistory?.entries).toBe(2);
  });

  it("keeps every PRE beyond the old five-entry ring and prunes future only on an accepted replacement", async () => {
    const f = await bind(), pre = f.exported();
    for (let n = 0; n < 7; n++) await dispatchAction(pass);
    expect(useGameStore.getState().localHistory?.entries).toBe(7);
    await undo();
    f.submit.mockRejectedValueOnce(refusal()); await dispatchAction(pass);
    expect(useGameStore.getState().localHistory?.entries).toBe(6);
    f.capture.mockRejectedValueOnce(Error("capture")); await dispatchAction(pass);
    expect(useGameStore.getState().localHistory?.entries).toBe(6);
    await dispatchAction(pass);
    for (let n = 0; n < 7; n++) await undo();
    expect(f.exported()).toBe(pre); expect(useGameStore.getState().stateHistory).toEqual([]);
  });

  it("blocks duplicate/cross-entry submits and Undo until a delayed submission is terminal", async () => {
    const f = await bind(), gate = deferred(), reached = deferred();
    f.submit.mockImplementationOnce(async action => { reached.resolve(); await gate.promise; return f.accepted(action); });
    const pending = dispatchAction(pass); await reached.promise;
    await Promise.all([dispatchAction(pass), storeDispatch(pass), dispatchInteraction(capability), undo()]);
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
    f.restore.mockRejectedValue(Error("restore unavailable")); await undo();
    expect(f.restore).toHaveBeenCalledTimes(2); expect(f.dispose).toHaveBeenCalledOnce();
    expect(useGameStore.getState().localHistory?.phase).toBe("stopped");
    await dispatchAction(pass); await undo();
    expect(f.submit).toHaveBeenCalledOnce(); expect(useGameStore.getState().stateHistory).toEqual([]);
  });

  it.each(["capture", "submit", "restore"])("retired %s cannot adopt or clear a replacement session", async stage => {
    const f = await bind(), gate = deferred(), reached = deferred();
    let pending: Promise<void>;
    if (stage === "restore") {
      await dispatchAction(pass);
      f.restore.mockImplementationOnce(async () => { reached.resolve(); await gate.promise; });
      pending = undo();
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
    await act(() => undo());
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("Standard");
    expect(useGameStore.getState().gameState?.priority_passing_modes?.[0]).toBe("Standard");
    const captures = f.capture.mock.calls.length;
    f.capture.mockRejectedValue(Error("persistent capture failure"));
    act(() => usePreferencesStore.getState().setPriorityPassingMode("SkipLowUseWindows"));
    await waitFor(() => expect(useGameStore.getState().localHistory?.notice).toBe("notStarted"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.capture).toHaveBeenCalledTimes(captures + 1);
    await expect(dispatchActionForGameSession({ type: "SetPriorityPassingMode", data: { mode: "SkipLowUseWindows" } }, f.adapter, useGameStore.getState().gameSessionGeneration, 0, captureLocalSeat())).rejects.toThrow();
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
    await act(() => undo());
    expect(useUiStore.getState().fullControl).toBe(false);
    expect(useGameStore.getState().gameState?.priority_passing_modes?.[0]).toBe("Standard");
    expect(f.submit).toHaveBeenCalledTimes(3);
    useGameStore.getState().reset(); useGameStore.setState({ gameMode: "local" });
    usePreferencesStore.setState({ priorityPassingMode: "FullControl" });
    const other = await init();
    await act(() => dispatchAction(pass)); await act(() => undo());
    expect(useUiStore.getState().fullControl).toBe(false);
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("FullControl");
    expect(other.submit).toHaveBeenCalledTimes(3);
  });

  it("explicit handoff conceals the entire child until matching viewer/legals are ready, without history or mutation", async () => {
    const f = await init(), seq = useGameStore.getState().lastCommittedSeq, before = f.exported();
    const gate = deferred(), entered = deferred(), original = f.viewer.getMockImplementation()!;
    f.viewer.mockImplementationOnce(async seat => { entered.resolve(); await gate.promise; return original(seat); });
    render(<LocalSeatBoundary><span>private hand and log</span></LocalSeatBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Pass to Player 2" }));
    await entered.promise;
    expect(screen.queryByText("private hand and log")).toBeNull();
    expect(screen.getByRole("button", { name: "Loading Player 2" })).toBeDisabled();
    expect(getPlayerId()).toBe(1);
    await rawDispatch(pass); await storeDispatch(pass); await undo();
    expect(f.submit).toHaveBeenCalledTimes(2);
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Show Player 2" })).toBeEnabled());
    expect(screen.queryByText("private hand and log")).toBeNull();
    expect(useGameStore.getState().legalActions).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Show Player 2" }));
    expect(screen.getByText("private hand and log")).toBeInTheDocument();
    expect(useGameStore.getState().lastCommittedSeq).toBe(seq);
    expect(useGameStore.getState().localHistory?.entries).toBe(0);
    expect(f.exported()).toBe(before); expect(f.capture).not.toHaveBeenCalled();
  });

  async function switchTo(seat: number) {
    const binding = captureLocalSeat()!;
    await act(() => binding.session.handoff(seat, binding));
    act(() => currentLocalHistory()!.reveal(captureLocalSeat()!));
  }

  it("rejects old seat callbacks even after 0→1→0, unbound input and mismatched actors", async () => {
    const f = await init(); const hook = renderHook(() => useGameDispatch()), oldClick = hook.result.current;
    await switchTo(1); await switchTo(0);
    await oldClick(pass); await rawDispatch(pass); await rawInteraction(capability); await useGameStore.getState().dispatch(pass); await useGameStore.getState().undo();
    await dispatchAction(pass, 1);
    expect(f.submit).toHaveBeenCalledTimes(2); expect(f.interaction).not.toHaveBeenCalled();
    await act(() => hook.result.current(pass));
    expect(f.submit).toHaveBeenCalledTimes(3);
  });

  it("rejects retained pending UI and drag-release callbacks before they can touch the new seat", async () => {
    await init();
    const pending = renderHook(() => useLocalUiAction(s => s.setPendingAbilityChoice));
    const oldPending = pending.result.current, onPlay = vi.fn();
    const drag = renderHook(() => useDragToCast({ hasPriority: true, onPlay })), oldDrag = drag.result.current;
    await switchTo(1);
    act(() => useUiStore.getState().setPendingAbilityChoice({ objectId: 777, actions: [] }));
    act(() => oldPending({ objectId: 123, actions: [] }));
    expect(oldDrag({} as MouseEvent, { offset: { x: 0, y: -100 } } as never)).toBe(false);
    expect(onPlay).not.toHaveBeenCalled();
    expect(useUiStore.getState().pendingAbilityChoice?.objectId).toBe(777);
    await switchTo(0);
    act(() => oldPending({ objectId: 123, actions: [] }));
    expect(useUiStore.getState().pendingAbilityChoice).toBeNull();
  });

  it("old Full Control, phase stop and passing mode callbacks cannot submit settings for the new seat", async () => {
    const f = await init(); renderHook(() => useGameplayPreferencesSync());
    const controls = renderHook(() => ({ fullControl: useLocalUiAction(s => s.toggleFullControl),
      mode: useLocalPreferenceAction(s => s.setPriorityPassingMode), stops: usePhaseStopCycle("PreCombatMain").cyclePhase }));
    const old = controls.result.current;
    await switchTo(1);
    act(() => { old.fullControl(); old.mode("FullControl"); old.stops(); });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(useUiStore.getState().fullControl).toBe(false);
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("Standard");
    expect(usePreferencesStore.getState().phaseStops).toEqual([]); expect(f.submit).toHaveBeenCalledTimes(2);
  });

  it("busy submission rejects handoff and a retired delayed viewer cannot replace a new session", async () => {
    const f = await init(), binding = captureLocalSeat()!, gate = deferred(), entered = deferred();
    f.submit.mockImplementationOnce(async a => { entered.resolve(); await gate.promise; return f.accepted(a); });
    const action = dispatchAction(pass); await entered.promise;
    await binding.session.handoff(1, binding);
    expect(getPlayerId()).toBe(0); expect(useGameStore.getState().localHistory?.concealed).toBe(false);
    gate.resolve(); await action;
    const read = deferred(), reading = deferred(), original = f.viewer.getMockImplementation()!;
    f.viewer.mockImplementationOnce(async seat => { reading.resolve(); await read.promise; return original(seat); });
    const handoff = binding.session.handoff(1, binding); await reading.promise;
    useGameStore.getState().reset(); useGameStore.setState({ gameMode: "local" });
    const replacement = await init(), state = useGameStore.getState().gameState;
    read.resolve(); await handoff;
    expect(useGameStore.getState().adapter).toBe(replacement.adapter);
    expect(useGameStore.getState().gameState).toBe(state); expect(getPlayerId()).toBe(0);
  });

  it.each(["pair", "preferences"])("does not let synchronous %s subscribers retarget old handoff settings", async boundary => {
    await init(); const binding = captureLocalSeat()!;
    let replaced = false;
    const retire = () => {
      if (replaced) return;
      replaced = true; useGameStore.getState().reset();
      usePreferencesStore.setState({ priorityPassingMode: "FullControl" });
      useUiStore.setState({ fullControl: true, manualManaOverride: true });
    };
    const unsubscribe = boundary === "pair"
      ? useGameStore.subscribe(s => s.engineCommitEpoch, () => { if (useGameStore.getState().localHistory?.concealed) retire(); })
      : usePreferencesStore.subscribe(() => retire());
    await binding.session.handoff(1, binding); unsubscribe();
    expect(replaced).toBe(true);
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("FullControl");
    expect(useUiStore.getState().fullControl).toBe(true); expect(useUiStore.getState().manualManaOverride).toBe(true);
    expect(currentLocalHistory()).toBeNull();
  });

  it("a failed viewer stays concealed and stopped rather than exposing the previous hand", async () => {
    await init(); const binding = captureLocalSeat()!, f = binding.session.adapter;
    vi.mocked(f.getViewerSnapshot).mockRejectedValueOnce(Error("viewer unavailable"));
    render(<LocalSeatBoundary><span>private hand</span></LocalSeatBoundary>);
    await act(() => binding.session.handoff(1, binding));
    expect(useGameStore.getState().localHistory).toMatchObject({ phase: "stopped", concealed: true, viewerReady: false });
    expect(screen.queryByText("private hand")).toBeNull(); expect(screen.getByRole("link", { name: "Main Menu" })).toHaveAttribute("href", "/");
  });

  it("keeps settings per seat without switch submits, restores PRE and leaves Undo on the explicitly selected seat", async () => {
    usePreferencesStore.setState({ priorityPassingMode: "FullControl" });
    useUiStore.setState({ manualManaOverride: true });
    const f = await init(); renderHook(() => useGameplayPreferencesSync());
    await switchTo(1);
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("Standard");
    expect(useUiStore.getState().manualManaOverride).toBe(false);
    expect(f.submit).toHaveBeenCalledTimes(2);
    act(() => usePreferencesStore.getState().setPriorityPassingMode("SkipLowUseWindows"));
    await waitFor(() => expect(useGameStore.getState().localHistory?.entries).toBe(1));
    expect(f.submit.mock.calls[f.submit.mock.calls.length - 1]).toEqual([{ type: "SetPriorityPassingMode", data: { mode: "SkipLowUseWindows" } }, 1]);
    await switchTo(0);
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("FullControl");
    expect(useUiStore.getState().manualManaOverride).toBe(true);
    const preLogs = useGameStore.getState().logHistory.slice();
    await act(() => undo());
    expect(getPlayerId()).toBe(0); expect(useGameStore.getState().localHistory?.concealed).toBe(false);
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("FullControl");
    expect(useGameStore.getState().logHistory).toEqual(preLogs);
    await switchTo(1);
    expect(usePreferencesStore.getState().priorityPassingMode).toBe("Standard");
    expect(f.submit).toHaveBeenCalledTimes(3);
    expect(useGameStore.getState().localHistory?.entries).toBe(0);
  });

  it("old seat preview results are dropped before they can overwrite a newly selected seat", async () => {
    const f = await init(), gate = deferred();
    f.adapter.previewManaPayment = vi.fn(async () => { await gate.promise; return [123]; });
    const binding = captureLocalSeat()!;
    const preview = previewAutomaticManaPayment({ type: "CastSpell", data: { object_id: 1, card_id: 1, targets: [] } }, 0, binding);
    await switchTo(1); await switchTo(0); gate.resolve();
    expect(await preview).toBeNull();
    await expect(previewAutomaticManaPayment({ type: "CastSpell", data: { object_id: 1, card_id: 1, targets: [] } }, 0)).resolves.toBeNull();
  });

  it("retains only explicitly Public log entries and viewer-filtered events", async () => {
    const f = await init();
    f.submit.mockImplementationOnce(async a => ({ ...f.accepted(a), log_entries: [
      { seq: 0, turn: 1, phase: "PreCombatMain", category: "Turn", segments: [{ type: "Text", value: "unknown private" }] },
      { seq: 0, turn: 1, phase: "PreCombatMain", category: "Turn", segments: [{ type: "Text", value: "private draw" }], presentation: { visibility: "HiddenInformation", importance: "Diagnostic", tone: "Neutral", boundary: "None" } },
    ] }));
    f.transition.mockImplementationOnce(async seat => ({ ...await f.viewer(seat), events: [] }));
    await dispatchAction(pass);
    expect(useGameStore.getState().logHistory).toEqual([]); expect(useGameStore.getState().eventHistory).toEqual([]);
  });

  it("opt-out/mode preflight sends nothing and failed setup terminates only its owned adapter", async () => {
    const f = fixture(); vi.stubEnv("VITE_PHASE_LOCAL_HISTORY", "0");
    await expect(init(f)).rejects.toThrow(/opted-in/); expect(f.adapter.initialize).not.toHaveBeenCalled();
    vi.stubEnv("VITE_PHASE_LOCAL_HISTORY", "1");
    f.submit.mockRejectedValueOnce(Error("setup failed")); await expect(init(f)).rejects.toThrow(/setup failed/);
    expect(f.dispose).toHaveBeenCalledOnce(); expect(useGameStore.getState().adapter).toBeNull();
  });
});
