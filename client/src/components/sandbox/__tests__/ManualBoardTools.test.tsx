import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGameStore } from "../../../stores/gameStore";
import { ManualBoardTools } from "../ManualBoardTools";

const dispatchAction = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../game/dispatch", () => ({ dispatchAction }));

const players = [{ id: 0, name: "Ari" }, { id: 1, name: "Mira" }];

function object(id: number, owner: number, zone: string, name: string, visible: boolean) {
  return { id, owner, controller: owner, zone, name, display_visible_to_viewer: visible };
}

function setBoard({ revealed }: { revealed: boolean }) {
  useGameStore.setState({
    gameState: {
      players: [
        { id: 0, life: 18, hand: [], graveyard: [], library: [] },
        { id: 1, life: 20, hand: [11, 12], graveyard: [13], library: [14] },
      ],
      exile: [],
      objects: {
        11: object(11, 1, "Hand", revealed ? "Secret One" : "Hidden Card", revealed),
        12: object(12, 1, "Hand", revealed ? "Secret Land" : "Hidden Card", revealed),
        13: object(13, 1, "Graveyard", "Fallen Giant", true),
        14: object(14, 1, "Library", "Hidden Card", false),
      },
    } as never,
  });
}

function renderTools(focusedPlayerId: number | null = 1) {
  return render(
    <ManualBoardTools viewerId={0} players={players} focusedPlayerId={focusedPlayerId} onFocusPlayer={() => {}} />,
  );
}

describe("ManualBoardTools", () => {
  beforeEach(() => dispatchAction.mockClear());
  afterEach(() => {
    cleanup();
    act(() => useGameStore.getState().reset());
  });

  it("asks for a target before offering zones", () => {
    setBoard({ revealed: false });
    renderTools(null);
    expect(screen.getByText("Select a player on the board or here.")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("keeps a hidden hand hidden and reveals it through the engine", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderTools();
    expect(screen.queryByRole("button", { name: "Secret One" })).toBeNull();
    expect(screen.getByText("2 hidden")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal hand" }));
    expect(dispatchAction).toHaveBeenCalledWith({ type: "Debug", data: { type: "RevealHand", data: { player_id: 1 } } });
  });

  it("discards a chosen card from a revealed hand as a real discard", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: true });
    renderTools();
    expect(screen.queryByRole("button", { name: "Reveal hand" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Secret One" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(dispatchAction).toHaveBeenCalledWith({ type: "Debug", data: { type: "Discard", data: { object_id: 11 } } });
  });

  it("returns an opponent's graveyard card under the viewer's control", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderTools();
    await user.click(screen.getByRole("tab", { name: /Graveyard/ }));
    await user.click(screen.getByRole("button", { name: "Fallen Giant" }));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Put onto the battlefield under your control" }));
    expect(dispatchAction.mock.calls).toEqual([
      [{ type: "Debug", data: { type: "MoveToZone", data: { object_id: 13, to_zone: "Battlefield", simulate: false } } }],
      [{ type: "Debug", data: { type: "SetController", data: { object_id: 13, controller: 0 } } }],
    ]);
  });

  it("adjusts another player's life and points the viewer to the life-loss operation", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    const { rerender } = renderTools();
    await user.click(screen.getByRole("button", { name: "Life −1" }));
    expect(dispatchAction).toHaveBeenCalledWith({ type: "Debug", data: { type: "SetLife", data: { player_id: 1, life: 19 } } });
    rerender(<ManualBoardTools viewerId={0} players={players} focusedPlayerId={0} onFocusPlayer={() => {}} />);
    expect(screen.queryByRole("button", { name: "Life −1" })).toBeNull();
    expect(screen.getByText("To lose your own life, enter the amount above and apply it.")).toBeInTheDocument();
  });
});
