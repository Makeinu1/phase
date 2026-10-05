import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapter, EngineSnapshot, GameState } from "../../adapter/types";
import type { InteractionSubmission } from "../../adapter/generated/interaction";
import { nextSnapshotSeq } from "../../adapter/types";
import { useGameStore } from "../../stores/gameStore";
import { abandonPendingDispatches, dispatchInteraction } from "../dispatch";
import { bindSandboxUndoAdoption } from "../sandboxPrecastUndo";

const submission = { interactionId: "old-prompt", response: { type: "choose", data: { choiceId: "a" } } } as InteractionSubmission;
function snapshot(): EngineSnapshot {
  return { seq: nextSnapshotSeq(), state: { waiting_for: { type: "Priority", data: { player: 0 } }, players: [], objects: {}, battlefield: [], stack: [] } as unknown as GameState,
    legalResult: { actions: [], autoPassRecommended: false } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function install(submitInteraction = vi.fn(async () => ({ events: [] }))) {
  const getSnapshot = vi.fn(async () => snapshot());
  const adapter = { submitInteraction, getSnapshot, dispose: vi.fn() } as unknown as EngineAdapter;
  const initial = snapshot();
  useGameStore.setState({ adapter, gameId: "sandbox-game", gameMode: "p2p-host", gameState: initial.state, lastCommittedSeq: initial.seq });
  return { adapter, getSnapshot, adopt: bindSandboxUndoAdoption(adapter, "sandbox-game") };
}

beforeEach(() => { vi.restoreAllMocks(); abandonPendingDispatches(); useGameStore.getState().reset(); });

describe("Sandbox Undo UI adoption and interaction continuations (fixture only)", () => {
  it("adopts the engine pair without using the UI state history as restore authority", async () => {
    const { adopt } = install();
    useGameStore.setState({ stateHistory: [snapshot().state] });
    const restored = snapshot();
    await adopt(restored);
    expect(useGameStore.getState().gameState).toBe(restored.state);
    expect(useGameStore.getState().lastCommittedSeq).toBe(restored.seq);
    expect(useGameStore.getState().stateHistory).toEqual([]);
  });

  it("rejects an obsolete snapshot before committing", async () => {
    const { adopt } = install();
    const stale = snapshot();
    useGameStore.setState({ lastCommittedSeq: stale.seq + 1 });
    await expect(adopt(stale)).rejects.toThrow("refused");
  });

  it("rejects when commitEngineSnapshot returns false", async () => {
    const { adopt } = install();
    vi.spyOn(useGameStore.getState(), "commitEngineSnapshot").mockReturnValue(false);
    await expect(adopt(snapshot())).rejects.toThrow("refused");
  });

  it("refuses the same adapter after its game-session generation changes", async () => {
    const { adopt } = install();
    useGameStore.setState({ gameSessionGeneration: useGameStore.getState().gameSessionGeneration + 1 });
    await expect(adopt(snapshot())).rejects.toThrow("replaced");
  });

  it("drops an interaction submit continuation after Undo invalidates its generation", async () => {
    const pending = deferred<{ events: [] }>();
    const { getSnapshot, adopt } = install(vi.fn(() => pending.promise));
    const dispatch = dispatchInteraction(submission, 0);
    const restored = snapshot();
    await adopt(restored);
    pending.resolve({ events: [] });
    await dispatch;
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(useGameStore.getState().gameState).toBe(restored.state);
  });

  it("drops an interaction snapshot continuation after Undo adoption", async () => {
    const { getSnapshot, adopt } = install();
    const pending = deferred<EngineSnapshot>();
    getSnapshot.mockReturnValueOnce(pending.promise);
    const dispatch = dispatchInteraction(submission, 0);
    await Promise.resolve();
    expect(getSnapshot).toHaveBeenCalledOnce();
    const restored = snapshot();
    await adopt(restored);
    pending.resolve(snapshot());
    await dispatch;
    expect(useGameStore.getState().gameState).toBe(restored.state);
  });

  it("drops a rejected old interaction rather than reporting it in a new session", async () => {
    const pending = deferred<{ events: [] }>();
    install(vi.fn(() => pending.promise));
    const dispatch = dispatchInteraction(submission, 0);
    useGameStore.setState({ gameSessionGeneration: useGameStore.getState().gameSessionGeneration + 1 });
    pending.reject(new Error("old session failed"));
    await expect(dispatch).resolves.toBeUndefined();
  });

  it("still commits an interaction in its current session", async () => {
    const { getSnapshot } = install();
    const after = snapshot();
    getSnapshot.mockResolvedValueOnce(after);
    await dispatchInteraction(submission, 0);
    expect(useGameStore.getState().gameState).toBe(after.state);
  });
});
