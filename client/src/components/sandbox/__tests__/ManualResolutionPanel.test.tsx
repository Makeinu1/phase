import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGameStore } from "../../../stores/gameStore";
import { useManualPickStore } from "../../../stores/manualPickStore";
import { ManualResolutionPanel } from "../ManualResolutionPanel";
import type { ManualResolutionCommandPort } from "../manual-resolution-ui-contract";

const dispatchAction = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../game/dispatch", () => ({ dispatchAction }));
vi.mock("../../../services/engineRuntime", () => ({
  listTokenPresets: async () => [
    { id: "t-treasure-1", category: { PredefinedArtifact: { kind: "Treasure" } }, fidelity: "Full", pt_provenance: "FixedOrAbsent",
      body: { display_name: "Treasure", power: null, toughness: null, core_types: ["Artifact"], subtypes: ["Treasure"], supertypes: [], colors: [], keywords: [] } },
    { id: "t-treasure-2", category: { PredefinedArtifact: { kind: "Treasure" } }, fidelity: "Full", pt_provenance: "FixedOrAbsent",
      body: { display_name: "Treasure", power: null, toughness: null, core_types: ["Artifact"], subtypes: ["Treasure"], supertypes: [], colors: [], keywords: [] } },
    { id: "t-soldier", category: "Creature", fidelity: "Full", pt_provenance: "FixedOrAbsent", type_line: "Token Creature — Soldier",
      body: { display_name: "Soldier", power: 1, toughness: 1, core_types: ["Creature"], subtypes: ["Soldier"], supertypes: [], colors: ["White"], keywords: [] } },
    { id: "t-ooze", category: "Creature", fidelity: "Full", pt_provenance: { SourceDefinedOrDynamic: { power: "X", toughness: "X" } },
      body: { display_name: "Ooze", power: 0, toughness: 0, core_types: ["Creature"], subtypes: ["Ooze"], supertypes: [], colors: ["Green"], keywords: [] } },
  ],
}));
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

  it("deals damage and puts +1/+1 counters on picked permanents by the chosen amount", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderPanel();
    act(() => useManualPickStore.getState().pickObject(10));
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.click(screen.getByRole("button", { name: "Deal 3 damage" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({ type: "DealDamage", data: { object_ids: [10], player_ids: [], amount: 3 } }));
    act(() => useManualPickStore.getState().pickObject(10));
    await user.click(screen.getByRole("button", { name: "Put 3 +1/+1 counter(s)" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({
      type: "ModifyCounters", data: { object_id: 10, counter_type: "P1P1", delta: 3 },
    }));
    act(() => useManualPickStore.getState().pickObject(10));
    await user.selectOptions(screen.getByRole("combobox", { name: "Counter kind" }), "custom");
    await user.type(screen.getByRole("textbox", { name: "Other name" }), "Oil");
    await user.click(screen.getByRole("button", { name: "Remove 3 Oil counter(s)" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({
      type: "ModifyCounters", data: { object_id: 10, counter_type: "oil", delta: -3 },
    }));
  });

  it("puts down the picks with the clear button or Esc", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderPanel();
    act(() => useManualPickStore.getState().pickObject(10));
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(useManualPickStore.getState().selectedObjectIds).toEqual([]);
    act(() => useManualPickStore.getState().pickPlayer(1));
    await user.keyboard("{Escape}");
    expect(useManualPickStore.getState().selectedPlayerId).toBeNull();
  });

  it("makes a picked player lose life", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderPanel();
    act(() => useManualPickStore.getState().pickPlayer(0));
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.click(screen.getByRole("button", { name: "Lose life" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({ type: "LoseLife", data: { player_id: 0, amount: 2 } }));
    act(() => useManualPickStore.getState().pickPlayer(1));
    await user.click(screen.getByRole("button", { name: "Get 2 poison counter(s)" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({ type: "GivePlayerCounters", data: { player_id: 1, kind: "Poison", amount: 2 } }));
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

  it("looks at a hand privately, searches a library, and shuffles it", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderPanel();
    act(() => useManualPickStore.getState().showZone(1, "hand"));
    await user.click(screen.getByRole("button", { name: "Look at hand" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({ type: "LookAtCards", data: { player_id: 1, scope: { type: "Hand" } } }));

    act(() => useManualPickStore.getState().showZone(1, "library"));
    await user.click(screen.getByRole("button", { name: "Search library" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({
      type: "LookAtCards", data: { player_id: 1, scope: { type: "Library", data: { top: null } } },
    }));
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.click(screen.getByRole("button", { name: "Look at top 2" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({
      type: "LookAtCards", data: { player_id: 1, scope: { type: "Library", data: { top: 2 } } },
    }));
    await user.click(screen.getByRole("button", { name: "Shuffle" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({ type: "ShuffleLibrary", data: { player_id: 1 } }));
  });

  it("narrows a long searched library by name", async () => {
    const user = userEvent.setup();
    const library = Array.from({ length: 14 }, (_, index) => 30 + index);
    useGameStore.setState({
      gameState: {
        players: [{ id: 0, life: 40, hand: [], graveyard: [], library }, { id: 1, life: 40, hand: [], graveyard: [], library: [] }],
        exile: [],
        objects: Object.fromEntries(library.map((id) => [id, object(id, 0, "Library", id === 40 ? "Demonic Tutor" : `Forest ${id}`)])),
      } as never,
    });
    renderPanel();
    act(() => useManualPickStore.getState().showZone(0, "library"));
    await user.type(screen.getByRole("searchbox", { name: "Filter by name" }), "tutor");
    expect(screen.getByRole("button", { name: "Demonic Tutor" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forest 30" })).toBeNull();
  });

  it("creates the resolving card's own tokens, common ones, and searched ones", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    const current = useGameStore.getState().gameState as unknown as { objects: Record<number, unknown> };
    useGameStore.setState({
      gameState: { ...current, objects: { ...current.objects, 201: { ...object(201, 0, "Stack", "Thoughtseize"), source_related_token_ids: ["t-soldier"] } } } as never,
    });
    renderPanel();
    const shelf = await screen.findByTestId("manual-token-shelf");
    expect(await within(shelf).findByRole("button", { name: "Soldier 1/1 (White)" })).toBeInTheDocument();
    expect(within(shelf).getAllByRole("button", { name: "Treasure" })).toHaveLength(1);
    await user.click(within(shelf).getByRole("button", { name: "+" }));
    await user.click(within(shelf).getByRole("button", { name: "Treasure" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({
      type: "CreateToken",
      data: { request: { type: "Preset", data: { preset_id: "t-treasure-1", owner: 0, enter_with_counters: [] } }, run_etb: true, count: 2 },
    }));
    await user.type(within(shelf).getByRole("searchbox", { name: "Search tokens" }), "ooze");
    expect(within(shelf).queryByRole("button", { name: /Ooze/ })).toBeNull();
  });

  it("makes a token copy of a picked permanent", async () => {
    const user = userEvent.setup();
    setBoard({ revealed: false });
    renderPanel();
    act(() => useManualPickStore.getState().pickObject(10));
    await user.click(screen.getByRole("button", { name: "Create 1 token copy(ies)" }));
    expect(dispatchAction).toHaveBeenCalledWith(debug({
      type: "CreateTokenCopy", data: { source_id: 10, owner: 0, nonlegendary: false, count: 1 },
    }));
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
