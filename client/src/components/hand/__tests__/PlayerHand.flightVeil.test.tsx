import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GameAction } from "../../../adapter/types.ts";
import type { InteractionChoiceId } from "../../../adapter/generated/interaction";
import { useAnimationStore } from "../../../stores/animationStore.ts";
import { useGameStore } from "../../../stores/gameStore.ts";
import { useUiStore } from "../../../stores/uiStore.ts";
import { gameObjectFactory } from "../../../test/factories/gameObjectFactory.ts";
import { gameStateFactory } from "../../../test/factories/gameStateFactory.ts";
import { handFanVerticalMetrics } from "../handFanPresentation.ts";
import { PlayerHand, type ManualHandCastController } from "../PlayerHand.tsx";

const { dispatchActionMock } = vi.hoisted(() => ({ dispatchActionMock: vi.fn() }));
vi.mock("../../../game/dispatch.ts", () => ({ dispatchAction: dispatchActionMock }));

vi.mock("../../../hooks/useCardImage.ts", () => ({
  useCardImage: () => ({
    src: "card.png",
    isLoading: false,
    isRotated: false,
    isFlip: false,
  }),
}));

const GRAVEYARD_CARD = 301;
const HAND_CARD = 302;

function castSpell(objectId: number): GameAction {
  return { type: "CastSpell", data: { object_id: objectId, card_id: 1, targets: [] } };
}

/** Hand card H plus a castable graveyard card G, which the fan renders as a wing card. */
function setGraveyardWingState({
  hand = [HAND_CARD],
  graveyard = [GRAVEYARD_CARD],
}: { hand?: number[]; graveyard?: number[] } = {}) {
  const gyCard = gameObjectFactory.withId(GRAVEYARD_CARD).inGraveyard().named("Encore Card").build();
  const handCard = gameObjectFactory.withId(HAND_CARD).inHand().named("Hand Card").build();
  const gameState = gameStateFactory
    .withPlayers({ id: 0, hand, graveyard }, 1)
    .withObjects(gyCard, handCard)
    .build();
  useGameStore.setState({
    gameState,
    spellCosts: {},
    legalActionsByObject: graveyard.includes(GRAVEYARD_CARD)
      ? { [String(GRAVEYARD_CARD)]: [castSpell(GRAVEYARD_CARD)] }
      : {},
  });
}

const surfaces = [
  {
    name: "own-hand card",
    id: HAND_CARD,
    selector: `[data-hand-card][data-object-id="${HAND_CARD}"]`,
    remove: () => setGraveyardWingState({ hand: [] }),
  },
  {
    name: "castable graveyard fan card",
    id: GRAVEYARD_CARD,
    selector: `[data-zone-fan-card][data-object-id="${GRAVEYARD_CARD}"]`,
    remove: () => setGraveyardWingState({ graveyard: [] }),
  },
];

beforeEach(() => {
  useAnimationStore.getState().clearQueue();
  setGraveyardWingState();
});

afterEach(() => {
  cleanup();
  useAnimationStore.getState().clearQueue();
  useGameStore.setState({ gameState: null, spellCosts: {}, legalActionsByObject: {} });
  useUiStore.setState({ debugInteractionMode: false, pendingAbilityChoice: null });
  dispatchActionMock.mockClear();
});

describe.each(surfaces)("PlayerHand flight veil: $name", ({ id, selector, remove }) => {
  function node(container: HTMLElement) {
    return container.querySelector<HTMLElement>(selector);
  }

  it("mounts hidden with no entrance when its object is already flight-veiled", () => {
    useAnimationStore.getState().veilFlight(id);

    const { container } = render(<PlayerHand />);

    expect(node(container)!.style.visibility).toBe("hidden");
    expect(node(container)!.style.opacity).toBe("1");
  });

  it("keeps today's entrance when it mounts unveiled", () => {
    const { container } = render(<PlayerHand />);

    const restingY = handFanVerticalMetrics(false).restingY;
    expect(node(container)!.style.opacity).toBe("0");
    expect(node(container)!.style.transform).toBe(`translateY(${restingY + 10}px)`);
    expect(node(container)!.style.visibility).toBe("");
  });

  it("shows without replaying the entrance once the flight releases it", () => {
    useAnimationStore.getState().veilFlight(id);
    const { container } = render(<PlayerHand />);

    act(() => useAnimationStore.getState().unveilFlight(id));

    expect(node(container)!.style.visibility).toBe("");
    expect(node(container)!.style.opacity).toBe("1");
  });

  it("stays hidden through an exit that began while veiled", () => {
    useAnimationStore.getState().veilFlight(id);
    const { container } = render(<PlayerHand />);

    act(() => remove());
    act(() => useAnimationStore.getState().unveilFlight(id));

    // Still mounted: the exit animation is running.
    expect(node(container)).not.toBeNull();
    expect(node(container)!.style.visibility).toBe("hidden");
  });

  it("shows again once it re-enters mid-exit and the flight releases it", () => {
    useAnimationStore.getState().veilFlight(id);
    const { container } = render(<PlayerHand />);
    const surface = node(container);

    act(() => remove());
    act(() => setGraveyardWingState());
    act(() => useAnimationStore.getState().unveilFlight(id));

    // Same node: the re-added card reused the exiting instance.
    expect(node(container)).toBe(surface);
    expect(node(container)!.style.visibility).toBe("");
  });
});

describe("PlayerHand flight veil: per-object keying", () => {
  it("hides only the veiled card's surface", () => {
    useAnimationStore.getState().veilFlight(GRAVEYARD_CARD);

    const { container } = render(<PlayerHand />);

    const fanCard = container.querySelector<HTMLElement>(
      `[data-zone-fan-card][data-object-id="${GRAVEYARD_CARD}"]`,
    );
    const handCard = container.querySelector<HTMLElement>(
      `[data-hand-card][data-object-id="${HAND_CARD}"]`,
    );
    expect(fanCard!.style.visibility).toBe("hidden");
    expect(handCard!.style.visibility).toBe("");
  });
});

describe("PlayerHand shared manual controller", () => {
  function controller(): ManualHandCastController {
    return { availabilityFor: (objectId) => objectId === HAND_CARD ? { type: "supported", data: {
      choiceId: "native-manual-choice" as InteractionChoiceId,
      source: { actor: 0, sourceId: HAND_CARD, sourceIncarnation: 9, stackEntryId: null,
        castTurnJournalIndex: null, cardId: 1, name: "Hand Card" },
    } } : null,
    submit: vi.fn().mockResolvedValue(undefined), attempt: null, message: null,
    lookupBusy: false, checkStatus: vi.fn().mockResolvedValue(undefined) };
  }

  beforeEach(() => {
    const state = useGameStore.getState().gameState!;
    useGameStore.setState({ gameMode: "local", waitingFor: state.waiting_for,
      legalActionsByObject: { [HAND_CARD]: [castSpell(HAND_CARD)] } });
  });

  it("keeps desktop selection local and delegates its explicit Manual choice", () => {
    const manualCast = controller();
    render(<PlayerHand manualCast={manualCast} />);
    fireEvent.click(screen.getByRole("button", { name: "Hand Card" }));
    fireEvent.click(screen.getByRole("button", { name: "Resolution options for Hand Card" }));
    expect(screen.getByText(/Its automatic spell body will be skipped/)).toBeInTheDocument();
    expect(manualCast.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cast with manual resolution" }));
    expect(manualCast.submit).toHaveBeenCalledExactlyOnceWith(HAND_CARD);
    expect(dispatchActionMock).not.toHaveBeenCalled();
  });

  it("keeps desktop ordinary choice on its existing dispatch and shows the shared original status", () => {
    const manualCast = controller();
    const { rerender } = render(<PlayerHand manualCast={manualCast} />);
    fireEvent.click(screen.getByRole("button", { name: "Hand Card" }));
    fireEvent.click(screen.getByRole("button", { name: "Resolution options for Hand Card" }));
    fireEvent.click(screen.getByRole("button", { name: "Cast normally" }));
    expect(dispatchActionMock).toHaveBeenCalledExactlyOnceWith(castSpell(HAND_CARD));
    expect(manualCast.submit).not.toHaveBeenCalled();

    manualCast.attempt = { objectId: GRAVEYARD_CARD, cardName: "Original Spell", status: "indeterminate" };
    rerender(<PlayerHand manualCast={manualCast} />);
    expect(screen.getByRole("status").parentElement).toHaveTextContent("Original Spell");
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(manualCast.checkStatus).toHaveBeenCalledExactlyOnceWith();
  });
});
