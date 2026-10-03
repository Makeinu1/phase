import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineAdapter, GameAction, GameEvent, GameState, SubmitResult } from "../../../adapter/types.ts";
import { AdapterError, AdapterErrorCode, nextSnapshotSeq } from "../../../adapter/types.ts";
import { useGameStore } from "../../../stores/gameStore.ts";
import { useMultiplayerStore } from "../../../stores/multiplayerStore.ts";
import { usePreferencesStore } from "../../../stores/preferencesStore.ts";
import { buildEngineAdapterMock } from "../../../test/factories/engineAdapterFactory.ts";
import { buildLegalActionsResult, gameStateFactory } from "../../../test/factories/gameStateFactory.ts";
import { abandonPendingDispatches } from "../../../game/dispatch.ts";
import { SandboxLifeCorrection } from "../SandboxLifeCorrection.tsx";

interface Harness {
  adapter: EngineAdapter;
  initialState: GameState;
  applySetLife: (action: GameAction, actor: number) => SubmitResult;
  currentEngineState: () => GameState;
}

function makeSandboxGameState(): GameState {
  const state = gameStateFactory
    .withPlayers({ id: 0, life: 20 }, { id: 1, life: 18 })
    .build();
  return {
    ...state,
    active_player: 1,
    turn_decision_controller: 0,
    format_config: { ...state.format_config, allow_debug_actions: true },
    debug_permitted: [0],
  };
}

function makeHarness(): Harness {
  const initialState = makeSandboxGameState();
  let engineState = initialState;

  const applySetLife = (action: GameAction, actor: number): SubmitResult => {
    if (action.type !== "Debug" || action.data.type !== "SetLife") {
      return { events: [] };
    }

    const { player_id: targetPlayerId, life } = action.data.data;
    const previous = engineState.players.find((player) => player.id === targetPlayerId);
    if (!previous) return { events: [] };
    engineState = {
      ...engineState,
      players: engineState.players.map((player) =>
        player.id === targetPlayerId ? { ...player, life } : player,
      ),
    };

    const events: GameEvent[] = [
      {
        type: "LifeChanged",
        data: { player_id: targetPlayerId, amount: life - previous.life, new_total: life },
      },
      {
        type: "DebugActionUsed",
        data: { player_id: actor, description: `SetLife (Player ${targetPlayerId + 1} → ${life})` },
      },
    ];
    return { events };
  };

  const adapter = buildEngineAdapterMock(initialState, {
    submitAction: vi.fn(async (action: GameAction, actor: number) => applySetLife(action, actor)),
    getState: vi.fn(async () => engineState),
    getLegalActions: vi.fn(async () => buildLegalActionsResult()),
  });

  const nextGeneration = useGameStore.getState().gameSessionGeneration + 1;
  act(() => {
    useMultiplayerStore.setState({ activePlayerId: 0, isSpectator: false });
    useGameStore.setState({
      gameId: "sandbox-life-correction-test",
      gameMode: "ai",
      gameState: initialState,
      adapter,
      gameSessionGeneration: nextGeneration,
      engineCommitEpoch: 0,
      lastCommittedSeq: 0,
      waitingFor: initialState.waiting_for,
      events: [],
      eventHistory: [],
      legalActions: [],
    });
  });

  return {
    adapter,
    initialState,
    applySetLife,
    currentEngineState: () => engineState,
  };
}

function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Life correction" }));
  return screen.getByRole("dialog", { name: "Sandbox life correction" });
}

function setNewLife(value: string) {
  fireEvent.change(screen.getByRole("spinbutton", { name: "New life total" }), {
    target: { value },
  });
}

describe("SandboxLifeCorrection", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_PHASE_SANDBOX", "1");
    usePreferencesStore.getState().setAnimationSpeedMultiplier(0);
    abandonPendingDispatches();
  });

  afterEach(() => {
    cleanup();
    abandonPendingDispatches();
    useMultiplayerStore.setState({ activePlayerId: 0, isSpectator: false });
    useGameStore.setState({
      gameId: null,
      gameMode: null,
      gameState: null,
      adapter: null,
      waitingFor: null,
      events: [],
      eventHistory: [],
      engineCommitEpoch: 0,
      lastCommittedSeq: 0,
    });
    usePreferencesStore.getState().setAnimationSpeedMultiplier(1);
    vi.unstubAllEnvs();
  });

  it("requires both a development build and the explicit sandbox flag", () => {
    makeHarness();
    vi.stubEnv("VITE_PHASE_SANDBOX", "");
    const first = render(<SandboxLifeCorrection />);
    expect(screen.queryByRole("button", { name: "Life correction" })).toBeNull();
    first.unmount();

    vi.stubEnv("VITE_PHASE_SANDBOX", "1");
    vi.stubEnv("DEV", false);
    render(<SandboxLifeCorrection />);
    expect(screen.queryByRole("button", { name: "Life correction" })).toBeNull();
  });

  it("hides in a remote game even when this local sandbox flag is enabled", () => {
    makeHarness();
    act(() => useGameStore.setState({ gameMode: "online" }));

    render(<SandboxLifeCorrection />);

    expect(screen.queryByRole("button", { name: "Life correction" })).toBeNull();
  });

  it("submits SetLife through useGameDispatch and confirms the committed engine snapshot", async () => {
    const harness = makeHarness();
    render(<SandboxLifeCorrection />);
    openPanel();
    fireEvent.change(screen.getByRole("combobox", { name: "Player" }), { target: { value: "1" } });
    expect(screen.getByRole("spinbutton", { name: "New life total" })).toHaveValue(18);
    setNewLife("17");

    fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));

    expect(await screen.findByText("The engine confirmed the life correction.")).toBeInTheDocument();
    expect(harness.adapter.submitAction).toHaveBeenCalledWith(
      { type: "Debug", data: { type: "SetLife", data: { player_id: 1, life: 17 } } },
      0,
    );
    expect(useGameStore.getState().engineCommitEpoch).toBe(1);
    expect(useGameStore.getState().gameState?.players[1]?.life).toBe(17);
    expect(harness.currentEngineState().players[1]?.life).toBe(17);
    expect(screen.getByText("17")).toBeInTheDocument();
  });

  it("sends nothing when cancelled before submission and starts fresh after reopening", () => {
    const harness = makeHarness();
    render(<SandboxLifeCorrection />);
    openPanel();
    setNewLife("23");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(harness.adapter.submitAction).not.toHaveBeenCalled();

    openPanel();
    expect(screen.getByRole("spinbutton", { name: "New life total" })).toHaveValue(20);
  });

  it("does not apply a draft after the engine snapshot changes during editing", () => {
    const harness = makeHarness();
    render(<SandboxLifeCorrection />);
    openPanel();
    setNewLife("23");

    const updatedState: GameState = {
      ...harness.initialState,
      players: harness.initialState.players.map((player) =>
        player.id === 0 ? { ...player, life: 19 } : player,
      ),
    };
    act(() => {
      useGameStore.getState().commitEngineSnapshot(
        { state: updatedState, legalResult: buildLegalActionsResult(), seq: nextSnapshotSeq() },
        { events: [], logEntries: [] },
      );
    });

    expect(screen.getByRole("alert")).toHaveTextContent("The game changed while editing.");
    expect(screen.queryByRole("button", { name: "Apply correction" })).toBeNull();
    expect(harness.adapter.submitAction).not.toHaveBeenCalled();
  });

  it("does not apply a draft to a different game session", () => {
    const harness = makeHarness();
    render(<SandboxLifeCorrection />);
    openPanel();
    setNewLife("23");

    act(() => {
      useGameStore.setState((state) => ({ gameSessionGeneration: state.gameSessionGeneration + 1 }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent("The game changed while editing.");
    expect(screen.queryByRole("button", { name: "Apply correction" })).toBeNull();
    expect(harness.adapter.submitAction).not.toHaveBeenCalled();
  });

  it("does not treat a swallowed stale-action no-op as success", async () => {
    const harness = makeHarness();
    vi.mocked(harness.adapter.submitAction).mockRejectedValueOnce(
      new AdapterError(AdapterErrorCode.STALE_ACTION, "stale action", false),
    );
    render(<SandboxLifeCorrection />);
    openPanel();
    setNewLife("21");

    fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));

    expect(await screen.findByText("The engine did not confirm this correction. Check the current snapshot before trying again.")).toBeInTheDocument();
    expect(useGameStore.getState().engineCommitEpoch).toBe(0);
    expect(useGameStore.getState().gameState?.players[0]?.life).toBe(20);
  });

  it("rejects duplicate submits while an adapter request is pending", async () => {
    const harness = makeHarness();
    let finish!: () => void;
    vi.mocked(harness.adapter.submitAction).mockImplementationOnce((action, actor) =>
      new Promise((resolve) => {
        finish = () => resolve(harness.applySetLife(action, actor));
      }),
    );
    render(<SandboxLifeCorrection />);
    openPanel();
    setNewLife("21");

    const form = screen.getByRole("form", { name: "Sandbox life correction" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(harness.adapter.submitAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(await screen.findByText("The engine confirmed the life correction.")).toBeInTheDocument();
  });

  it("continues an already-submitted correction after the panel closes", async () => {
    const harness = makeHarness();
    let finish!: () => void;
    vi.mocked(harness.adapter.submitAction).mockImplementationOnce((action, actor) =>
      new Promise((resolve) => {
        finish = () => resolve(harness.applySetLife(action, actor));
      }),
    );
    render(<SandboxLifeCorrection />);
    openPanel();
    setNewLife("22");
    fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));
    expect(screen.getByText("Correction submitted; closing this panel will not cancel it.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(harness.adapter.submitAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      await Promise.resolve();
    });

    expect(useGameStore.getState().gameState?.players[0]?.life).toBe(22);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a rejected adapter submission without claiming that life changed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.adapter.submitAction).mockRejectedValueOnce(new Error("sandbox action rejected"));
    render(<SandboxLifeCorrection />);
    openPanel();
    setNewLife("21");

    fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));

    expect(await screen.findByText("The correction could not be submitted.")).toBeInTheDocument();
    expect(useGameStore.getState().gameState?.players[0]?.life).toBe(20);
  });
});
