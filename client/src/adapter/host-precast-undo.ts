import type { EngineSnapshot, GameState, LegalActionsResult } from "./types";

/** Local RPC receipts only. Neither the checkpoint nor the RNG leaves WASM. */
export interface HostPrecastUndoStatus {
  binding: string;
  enabled: boolean;
  phase: "Empty" | "Pending" | "Armed" | "Consumed" | "Invalidated";
  receipt: string | null;
}

export interface HostPrecastUndoWorkerResult {
  status: HostPrecastUndoStatus;
  snapshot: { state: GameState; legalResult: LegalActionsResult };
}

export interface HostPrecastUndoResult {
  status: HostPrecastUndoStatus;
  snapshot: EngineSnapshot;
}
