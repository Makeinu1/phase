import { create } from "zustand";

/** Zones a paused manual resolution's actor can open from the board. */
export type ManualBoardZone = "hand" | "graveyard" | "exile" | "library";

/**
 * Paper-style picking while a manual resolution is paused: clicking a
 * permanent or a card in an open zone picks it, clicking a player's plate
 * picks that player, and clicking a hand or pile opens it in the manual
 * panel. Display selection only — the panel submits engine instructions for
 * what was picked, and the engine decides what they do.
 */
interface ManualPickState {
  active: boolean;
  selectedObjectIds: number[];
  selectedPlayerId: number | null;
  openZone: { playerId: number; zone: ManualBoardZone } | null;
  setActive: (active: boolean) => void;
  pickObject: (objectId: number) => void;
  pickPlayer: (playerId: number) => void;
  showZone: (playerId: number, zone: ManualBoardZone) => void;
  clearSelection: () => void;
}

const EMPTY = { selectedObjectIds: [], selectedPlayerId: null, openZone: null };

export const useManualPickStore = create<ManualPickState>()((set, get) => ({
  active: false,
  ...EMPTY,
  setActive: (active) => {
    if (get().active !== active) set({ active, ...EMPTY });
  },
  pickObject: (objectId) => {
    if (!get().active) return;
    const selected = get().selectedObjectIds;
    set({
      selectedPlayerId: null,
      selectedObjectIds: selected.includes(objectId)
        ? selected.filter((id) => id !== objectId)
        : [...selected, objectId],
    });
  },
  pickPlayer: (playerId) => {
    if (!get().active) return;
    set({ selectedPlayerId: playerId, selectedObjectIds: [] });
  },
  showZone: (playerId, zone) => {
    if (!get().active) return;
    set({ openZone: { playerId, zone }, selectedObjectIds: [], selectedPlayerId: null });
  },
  clearSelection: () => set({ selectedObjectIds: [], selectedPlayerId: null }),
}));
