import { create } from "zustand";

/**
 * One table-agreed "undo the manual play" checkpoint for an experimental Local
 * manual-resolution game.
 *
 * The engine owns the restore itself: `checkpoint` is the opaque trusted
 * envelope exported immediately before the manual cast, and restoring it goes
 * through the authenticated Local continuation (which advances its restore
 * epoch). This store only remembers that one checkpoint and when it stops
 * being offered: it stays available for the whole manual episode, and once
 * the episode has ended it is released by the very next submitted action.
 */
export interface ManualUndoCheckpoint {
  readonly checkpoint: string;
  readonly cardName: string;
  /** Whether the checkpoint precedes a manual cast or a later designation. */
  readonly kind: "cast" | "designation";
  /** The episode was observed in the engine-provided derived view. */
  readonly episodeSeen: boolean;
  /** The episode has ended (finished, countered, or fizzled). */
  readonly episodeEnded: boolean;
}

interface ManualUndoState {
  checkpoint: ManualUndoCheckpoint | null;
  capture: (checkpoint: string, cardName: string, kind: "cast" | "designation") => void;
  /** Track the engine's derived manual episode for the held checkpoint. */
  observeEpisode: (episodeActive: boolean) => void;
  /** Called at every action/interaction submission boundary. */
  releaseAfterEpisode: () => void;
  clear: () => void;
}

export const useManualUndoStore = create<ManualUndoState>()((set, get) => ({
  checkpoint: null,
  capture: (checkpoint, cardName, kind) =>
    set({ checkpoint: { checkpoint, cardName, kind, episodeSeen: false, episodeEnded: false } }),
  observeEpisode: (episodeActive) => {
    const current = get().checkpoint;
    if (!current || current.episodeEnded) return;
    if (episodeActive && !current.episodeSeen) {
      set({ checkpoint: { ...current, episodeSeen: true } });
    } else if (!episodeActive && current.episodeSeen) {
      set({ checkpoint: { ...current, episodeEnded: true } });
    }
  },
  releaseAfterEpisode: () => {
    if (get().checkpoint?.episodeEnded) set({ checkpoint: null });
  },
  clear: () => set({ checkpoint: null }),
}));
