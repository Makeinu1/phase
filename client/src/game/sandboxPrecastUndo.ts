import type { EngineAdapter, EngineSnapshot } from "../adapter/types";
import { useGameStore } from "../stores/gameStore";
import { useUiStore } from "../stores/uiStore";
import { useAnimationStore } from "../stores/animationStore";
import { abandonPendingDispatches } from "./dispatch";

/** Adopt an engine result; the UI never supplies a checkpoint to restore. */
export function bindSandboxUndoAdoption(adapter: EngineAdapter, gameId: string): (snapshot: EngineSnapshot) => Promise<void> {
  const generation = useGameStore.getState().gameSessionGeneration;
  return async (snapshot) => {
    const current = useGameStore.getState();
    if (current.adapter !== adapter || current.gameId !== gameId
      || current.gameSessionGeneration !== generation || current.gameState === null) {
      throw new Error("Undo UI session was replaced");
    }
    // Check before any UI side effect. No history/log append bypasses the seq gate.
    if (snapshot.seq < current.lastCommittedSeq) throw new Error("Undo snapshot adoption was refused");
    abandonPendingDispatches();
    useAnimationStore.getState().clearQueue();
    useUiStore.getState().clearSelectedCards();
    useUiStore.getState().clearCombatSelection();
    useUiStore.getState().setPendingAbilityChoice(null);
    if (!current.commitEngineSnapshot(snapshot, {
      extraState: { events: [], stateHistory: [], restoredStackAutomation: null },
    })) throw new Error("Undo snapshot adoption was refused");
  };
}
