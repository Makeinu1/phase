import type { GameAction } from "../adapter/types";
import { dispatchAction } from "../game/dispatch";
import { useGameStore } from "../stores/gameStore";
import { useManualUndoStore } from "../stores/manualUndoStore";

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
      dispatch: (action: GameAction, actor?: number) => Promise<void>;
    };
  }
}

window.__phaseAcceptance = {
  state: () => useGameStore.getState().gameState,
  waitingFor: () => useGameStore.getState().waitingFor,
  manualUndo: () => useManualUndoStore.getState().checkpoint,
  dispatch: (action, actor) => dispatchAction(action, actor),
};
