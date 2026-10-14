import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGameStore } from "../../../stores/gameStore";
import { useManualPickStore } from "../../../stores/manualPickStore";
import { ManualResolutionPanel } from "../ManualResolutionPanel";
import type { ManualResolutionCommandPort } from "../manual-resolution-ui-contract";

const dispatchAction = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../game/dispatch", () => ({ dispatchAction }));
vi.mock("../../card/CardImage", () => ({ CardImage: ({ cardName }: { cardName: string }) => <span>{cardName}</span> }));

function object(id: number, owner: number, zone: string, name: string, visible = true) {
  return { id, owner, controller: owner, zone, name, display_visible_to_viewer: visible };
}

function setBoard({ revealed }: { revealed: boolean }) {
  useGameStore.setState({
    gameState: {
      players: [
        { id: 0, life: 40, hand: [], graveyard: [], library: [] },
        { id: 1, life: 40, hand: [11], graveyard: [13], library: [14] },
      ],
      exile: [],
      objects: {
        10: object(10, 1, "Battlefield", "Opposing Bear"),
        11: object(11, 1, "Hand", revealed ? "Secret One" : "Hidden Card", revealed),
        13: object(13, 1, "Graveyard", "Fallen Giant"),
        14: object(14, 1, "Library", "Hidden Card", false),
      },
    } as never,
  });
}

function makePort() {
  const submit = vi.fn(async (request: Parameters<ManualResolutionCommandPort["submitManualResolutionCommand"]>[0]) =>
    ({ binding: request.binding, status: "completed" as const }));
  const port = {
    receiptSessionIdentity: {},
    getUnresolvedManualResolutionRequest: () => null,
    submitManualResolutionCommand: submit,
    reconcileManualResolution: vi.fn(),
  } as unknown as ManualResolutionCommandPort;
  return { port, submit };
}

function renderPanel(operable = true) {
  const { port, submit } = makePort();
  render(
    <ManualResolutionPanel
      viewerId={0}
      source={{ name: "Thoughtseize", stackEntryId: 201, sourceObjectId: 201 }}
      operable={operable}
      finish={operable ? { interactionId: "i.1" as never, adapterGeneration: 10, port } : null}
      playerName={(id) => (id === 0 ? "Ari" : "Mira")}
      undoControl={<button type="button">Undo to before casting</button>}
    />,
  );
  return { submit };
}

const debug = (data: unknown) => ({ type: "Debug", data });

describe("ManualResolutionPanel", () => {
  beforeEach(() => {
    dispatchAction.mockClear();
    act(() => useManualPickStore.getState().setActive(true));
  });
  afterEach(() => {
    cleanup();
    act(() => {
      useManualPickStore.getState().setActive(false);
      useGameStore.getState().reset();
    });
  });

  it("shows the resolving card and asks for a pick on the board", () => {
    setBoard({ revealed: false });
    renderPanel();
    expect(screen.getByTestId("manual-source-card")).toHaveTextContent("Thoughtseize");
    expect(screen.getByText("Click a card, player, hand, or graveyard on the board")).toBeInTheDocument();
  });

  it("destroys a permanent picked on the board", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderPanel();
    act(() => useManualPickStore.getState().pickObject(10));
    await user.click(screen.getByRole("checkbox", { name: "Can't be regenerated" }));
    await user.click(screen.getByRole("button", { name: "Destroy" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({ type: "Destroy", data: { object_ids: [10], regeneration: "Forbidden" } }));
    expect(useManualPickStore.getState().selectedObjectIds).toEqual([]);
  });

  it("makes a picked player lose life", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderPanel();
    act(() => useManualPickStore.getState().pickPlayer(0));
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.click(screen.getByRole("button", { name: "Lose life" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({ type: "LoseLife", data: { player_id: 0, amount: 2 } }));
  });

  it("reveals a hidden hand opened from the board, then discards from it", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderPanel();
    act(() => useManualPickStore.getState().showZone(1, "hand"));
    expect(screen.getByText("1 hidden")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal hand" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({ type: "RevealHand", data: { player_id: 1 } }));

    act(() => setBoard({ revealed: true }));
    await user.click(screen.getByRole("button", { name: "Secret One" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({ type: "Discard", data: { object_id: 11 } }));
  });

  it("puts an opponent's graveyard card onto the battlefield under the viewer's control", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderPanel();
    act(() => useManualPickStore.getState().showZone(1, "graveyard"));
    await user.click(screen.getByRole("button", { name: "Fallen Giant" }));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Put onto the battlefield under your control" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({
      type: "PutCards", data: { object_ids: [13], destination: { type: "Battlefield", data: { control: "Actor" } } },
    }));
  });

  it("finishes through the manual-resolution port", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    const { submit } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(submit).toHaveBeenCalledWith({
      binding: { interactionId: "i.1", adapterGeneration: 10 },
      command: { type: "finish", stackEntryId: 201, sourceObjectId: 201 },
    });
  });

  it("offers only the card and Undo while the spell still waits on the stack", () => {
    setBoard({ revealed: false });
    renderPanel(false);
    expect(screen.queryByRole("button", { name: "Finish" })).toBeNull();
    expect(screen.queryByTestId("manual-instructions")).toBeNull();
    expect(screen.getByRole("button", { name: "Undo to before casting" })).toBeInTheDocument();
  });
});
