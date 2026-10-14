import type { GameAction } from "../adapter/types";
import { dispatchAction } from "../game/dispatch";
import { useGameStore } from "../stores/gameStore";
import { useManualUndoStore } from "../stores/manualUndoStore";
import { useManualPickStore } from "../stores/manualPickStore";

/**
 * Dev-server-only read/setup hook for the fork's browser acceptance driver.
 * Reads go through the committed store; writes go through the ordinary
 * authenticated dispatcher, exactly like a UI control. Never bundled into
 * production builds (imported only under `import.meta.env.DEV`).
 */
declare global {
  interface Window {
    __phaseAcceptance?: {
      state: () => unknown;
      waitingFor: () => unknown;
      manualUndo: () => unknown;
      legal: () => unknown;
      manualPick: () => unknown;
      dispatch: (action: GameAction, actor?: number) => Promise<void>;
    };
  }
}

window.__phaseAcceptance = {
  state: () => useGameStore.getState().gameState,
  waitingFor: () => useGameStore.getState().waitingFor,
  manualUndo: () => useManualUndoStore.getState().checkpoint,
  manualPick: () => {
    const { active, selectedObjectIds, selectedPlayerId, openZone } = useManualPickStore.getState();
    return { active, selectedObjectIds, selectedPlayerId, openZone };
  },
  legal: () => {
    const s = useGameStore.getState();
    return { actions: s.legalActions.map((a) => a.type), byObject: Object.keys(s.legalActionsByObject), stuck: s.stuckDiagnostic };
  },
  dispatch: (action, actor) => dispatchAction(action, actor),
};
