import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InteractionChoiceId, InteractionId } from "../../../adapter/generated/interaction";
import type { ViewerInteraction, WaitingFor } from "../../../adapter/types.ts";
import { useGameStore } from "../../../stores/gameStore.ts";
import { useMultiplayerStore } from "../../../stores/multiplayerStore.ts";
import { buildGameObject } from "../../../test/factories/gameObjectFactory.ts";
import { buildGameState, buildPlayer } from "../../../test/factories/gameStateFactory.ts";
import { CardChoiceModal } from "../CardChoiceModal.tsx";

const dispatchMock = vi.fn();

vi.mock("../../../hooks/useGameDispatch.ts", () => ({
  useGameDispatch: () => dispatchMock,
}));

const card = buildGameObject({
  id: 41, card_id: 41, owner: 0, controller: 0, zone: "Library", name: "Visible library card",
});

function selectInteraction(id: string): ViewerInteraction {
  return {
    waitingForKind: { code: "select", simultaneous: null, terminal: false },
    authorizedSubmitters: [0],
    canSubmit: true,
    autoPassRecommended: false,
    opportunities: [{
      interactionId: id as InteractionId,
      response: {
        type: "schema",
        data: {
          spec: { type: "select", data: { constraint: { type: "count", data: { min: 0, max: 1 } }, confirm: "explicit" } },
          candidates: [{ id: `${id}.card.41` as InteractionChoiceId, surfaces: [], status: { type: "available" } }],
        },
      },
      surfaces: [],
      progress: { selected: 0, minimum: 0, maximum: 1, aggregate: null, confirmable: true },
    }],
    attachmentFans: {},
    attachmentViews: {},
    availability: { type: "inputRequired" },
  };
}

// Store/projection fixture and mocked dispatch only. This exercises the real
// CardChoiceModal controls, not a live engine, WASM, or P2P connection.
function setPrompt(interactionId: string) {
  const waitingFor: WaitingFor = { type: "ScryChoice", data: { player: 0, cards: [41] } };
  useGameStore.setState({
    gameMode: "online",
    gameState: buildGameState({
      players: [buildPlayer({ id: 0, library: [41] }), buildPlayer({ id: 1 })],
      objects: { 41: card },
      waiting_for: waitingFor,
    }),
    waitingFor,
    viewerInteraction: selectInteraction(interactionId),
  });
}

describe("consecutive Scry prompt identity (UI fixture)", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    useMultiplayerStore.setState({ activePlayerId: 0, isSpectator: false });
  });

  afterEach(() => {
    cleanup();
    useGameStore.setState({ gameState: null, waitingFor: null, viewerInteraction: null });
  });

  it("preserves the player's Bottom selection on a rerender of the same interaction", () => {
    setPrompt("fixture.scry.1.1");
    render(<CardChoiceModal />);
    fireEvent.click(screen.getByRole("button", { name: "Top" }));

    act(() => setPrompt("fixture.scry.1.1"));

    expect(screen.getByRole("button", { name: "Bottom" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    expect(dispatchMock).toHaveBeenCalledExactlyOnceWith({ type: "SelectCards", data: { cards: [] } });
  });

  it("starts a new interaction with the same card IDs on Top instead of resubmitting the previous Bottom selection", () => {
    setPrompt("fixture.scry.1.1");
    render(<CardChoiceModal />);
    fireEvent.click(screen.getByRole("button", { name: "Top" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    expect(dispatchMock).toHaveBeenCalledExactlyOnceWith({ type: "SelectCards", data: { cards: [] } });
    dispatchMock.mockClear();

    // A one-card library can offer that same card again after an earlier scry,
    // including when it was put on Bottom. Only the authoritative prompt ID
    // changes here; keep the component mounted and the card payload identical.
    act(() => setPrompt("fixture.scry.1.2"));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    expect(dispatchMock).toHaveBeenCalledExactlyOnceWith({ type: "SelectCards", data: { cards: [41] } });
    expect(screen.getByRole("button", { name: "Top" })).toBeInTheDocument();
  });
});
