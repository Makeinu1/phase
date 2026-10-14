import { beforeEach, describe, expect, it } from "vitest";

import { useManualUndoStore } from "../manualUndoStore";

describe("manualUndoStore", () => {
  beforeEach(() => useManualUndoStore.getState().clear());

  it("keeps the pre-cast checkpoint through the episode and releases it on the next action after it ends", () => {
    const store = useManualUndoStore.getState();
    store.capture("{\"state\":{}}", "Rejoin the Fight");

    // Actions inside the episode (board corrections, Finish) keep it.
    store.observeEpisode(true);
    store.releaseAfterEpisode();
    expect(useManualUndoStore.getState().checkpoint?.cardName).toBe("Rejoin the Fight");

    // The episode ends; the checkpoint is still offered until someone acts.
    store.observeEpisode(false);
    expect(useManualUndoStore.getState().checkpoint?.episodeEnded).toBe(true);

    store.releaseAfterEpisode();
    expect(useManualUndoStore.getState().checkpoint).toBeNull();
  });

  it("does not treat the pre-publication gap as an ended episode", () => {
    const store = useManualUndoStore.getState();
    store.capture("{\"state\":{}}", "Fact or Fiction");

    // The derived view has not shown the episode yet.
    store.observeEpisode(false);
    store.releaseAfterEpisode();
    expect(useManualUndoStore.getState().checkpoint?.episodeEnded).toBe(false);
  });
});
