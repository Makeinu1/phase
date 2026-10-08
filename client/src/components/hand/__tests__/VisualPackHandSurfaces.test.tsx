import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";

import type { GameAction, GameObject, LocalContinuationPublication } from "../../../adapter/types.ts";
import type { InteractionChoice, InteractionChoiceId, InteractionId, InteractionSessionId, ManualCastUnsupportedReason, ManualResolutionSource, ViewerInteraction } from "../../../adapter/generated/interaction";
import { useCardBackImage, useCardImage } from "../../../hooks/useCardImage.ts";
import { useCardHover } from "../../../hooks/useCardHover.ts";
import { useGameStore } from "../../../stores/gameStore.ts";
import { useUiStore } from "../../../stores/uiStore.ts";
import { useMultiplayerStore } from "../../../stores/multiplayerStore.ts";
import { usePreferencesStore } from "../../../stores/preferencesStore.ts";
import { buildGameObject, buildObjectMap, gameObjectFactory } from "../../../test/factories/gameObjectFactory.ts";
import { buildGameState, buildPlayers, gameStateFactory } from "../../../test/factories/gameStateFactory.ts";
import { buildEngineAdapterMock } from "../../../test/factories/engineAdapterFactory.ts";
import { GamePage } from "../../../pages/GamePage.tsx";
import { ZONE_THEME } from "../../../viewmodel/zoneAffordance.ts";
import { CompanionFanCard } from "../CompanionFanCard.tsx";
import { MobileHandDrawer } from "../MobileHandDrawer.tsx";
import { OpponentHand } from "../OpponentHand.tsx";

const { dispatchActionMock, dispatchInteractionMock, mobile } = vi.hoisted(() => ({
  dispatchActionMock: vi.fn(), dispatchInteractionMock: vi.fn(), mobile: { value: true },
}));
vi.mock("../../../providers/GameProvider.tsx", () => ({
  GameProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../../game/sessionCleanup.ts", () => ({ clearPromptOverlayState: vi.fn() }));
vi.mock("../../../hooks/useGameDispatch.ts", () => ({ useGameDispatch: () => dispatchActionMock }));
vi.mock("../../../game/dispatch.ts", () => ({
  dispatchAction: dispatchActionMock, dispatchInteraction: dispatchInteractionMock,
  dispatchResolveAll: vi.fn(), processRemoteUpdate: vi.fn(), restoreGameState: vi.fn(), currentSnapshot: new Map(),
}));
vi.mock("../../../hooks/useIsMobile.ts", () => ({ useIsMobile: () => mobile.value }));
vi.mock("../../../audio/useAudioContext.ts", () => ({ useAudioContext: () => undefined }));
vi.mock("../../../hooks/useGameplayPreferencesSync.ts", () => ({ useGameplayPreferencesSync: () => undefined }));
vi.mock("../../../hooks/useCardDataMeta.ts", () => ({ useCardDataMeta: () => null, formatRelativeDate: () => "" }));
vi.mock("../../../hooks/useEngineCardData.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useEngineCardData.ts")>()),
  useEngineCardData: () => null, useCardParseDetails: () => null, useCardRulings: () => null,
}));
vi.mock("../../../components/board/BattlefieldBackground.tsx", () => ({ BattlefieldBackground: () => null }));
vi.mock("../../../components/board/GameBoard.tsx", () => ({ GameBoard: () => null }));
vi.mock("../../../components/stack/StackDisplay.tsx", () => ({ StackDisplay: () => null }));
vi.mock("../../../components/debug/DebugPanel.tsx", () => ({ DebugPanel: () => null }));
vi.mock("../../../components/hud/HUD.tsx", () => ({ HUD: () => null }));

vi.mock("../../../hooks/useCardImage.ts", () => ({
  useCardBackImage: vi.fn(() => ({ src: "installed-back.png", isLoading: false })),
  useCardImage: vi.fn(),
}));
vi.mock("../../../hooks/useCardHover.ts", () => ({
  useCardHover: vi.fn(() => hoverResult()),
}));

const mockUseCardImage = vi.mocked(useCardImage);
const mockUseCardBackImage = vi.mocked(useCardBackImage);
const mockUseCardHover = vi.mocked(useCardHover);

function hoverResult(firedRef = { current: false }): ReturnType<typeof useCardHover> {
  return {
    handlers: {
      "data-card-hover": true,
      onPointerDown: vi.fn(), onPointerMove: vi.fn(), onPointerUp: vi.fn(),
      onPointerCancel: vi.fn(), onPointerLeave: vi.fn(), onContextMenu: vi.fn(),
    },
    firedRef,
  };
}

function secretOpponent(): GameObject {
  return buildGameObject({
    id: 22,
    card_id: 22,
    owner: 1,
    controller: 1,
    zone: "Hand",
    name: "SECRET FACE",
    printed_ref: { oracle_id: "secret-oracle", face_name: "SECRET FACE" },
    token_image_ref: {
      scryfall_id: "secret-printing",
      scryfall_oracle_id: "secret-token-oracle",
      face_name: "SECRET TOKEN",
      preset_id: "secret-preset",
    },
  });
}

function seed(object: GameObject): void {
  useGameStore.setState({
    gameMode: "local",
    gameState: buildGameState({
      players: buildPlayers([0, { id: 1, hand: [object.id] }]),
      objects: buildObjectMap(object),
      seat_order: [0, 1],
    }),
  });
  useUiStore.setState({ focusedOpponent: 1 });
}

beforeEach(() => seed(secretOpponent()));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ mobileHandOpen: false, focusedOpponent: null, previewSource: null, debugInteractionMode: false, pendingAbilityChoice: null });
  useGameStore.setState({ adapter: null, viewerInteraction: null });
});

describe("visual-pack opponent hand boundary", () => {
  it("renders a fixed back without mounting face or hover authority", () => {
    const { container } = render(<OpponentHand playerId={1} />);

    expect(mockUseCardImage).not.toHaveBeenCalled();
    expect(mockUseCardHover).not.toHaveBeenCalled();
    expect(mockUseCardBackImage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "Card back" })).toHaveAttribute(
      "src",
      "installed-back.png",
    );
    expect(container.innerHTML).not.toContain("SECRET");
    expect(container.innerHTML).not.toContain("secret-oracle");
  });

  it("uses projected visible identity and never degrades a failed face into a back", () => {
    const advanceFailedSource = vi.fn();
    mockUseCardImage.mockReturnValue({
      src: "installed-face.png",
      isLoading: false,
      isRotated: false,
      isFlip: false,
      rungs: { small: "installed-small.png", normal: "installed-normal.png" },
      advanceFailedSource,
    });

    const { rerender } = render(<OpponentHand playerId={1} showCards />);
    expect(mockUseCardImage).toHaveBeenCalledWith("SECRET FACE", expect.objectContaining({
      size: "small",
      oracleId: "secret-oracle",
      faceName: "SECRET FACE",
    }));
    expect(mockUseCardHover).toHaveBeenCalledWith(22);
    expect(mockUseCardBackImage).not.toHaveBeenCalled();
    const image = screen.getByRole("img", { name: "SECRET FACE" });
    fireEvent.error(image);
    expect(advanceFailedSource).toHaveBeenCalledWith("installed-face.png");

    mockUseCardImage.mockReturnValue({
      src: null,
      isLoading: false,
      isRotated: false,
      isFlip: false,
    });
    rerender(<OpponentHand playerId={1} showCards />);
    expect(screen.getByRole("img", { name: "SECRET FACE" })).toHaveTextContent("SECRET FACE");
    expect(mockUseCardBackImage).not.toHaveBeenCalled();
  });

  it("honors engine-projected visibility independently of debug showCards", () => {
    const projected = { ...secretOpponent(), display_visible_to_viewer: true };
    seed(projected);
    mockUseCardImage.mockReturnValue({
      src: "projected-face.png",
      isLoading: false,
      isRotated: false,
      isFlip: false,
    });

    render(<OpponentHand playerId={1} />);

    expect(mockUseCardImage).toHaveBeenCalledWith(
      "SECRET FACE",
      expect.objectContaining({ oracleId: "secret-oracle", faceName: "SECRET FACE" }),
    );
    expect(mockUseCardBackImage).not.toHaveBeenCalled();
  });
});

describe("visual-pack owned hand surfaces", () => {
  it("keeps companion normal rungs coupled and advances the exact source", () => {
    const advanceFailedSource = vi.fn();
    mockUseCardImage.mockReturnValue({
      src: "installed-companion-normal.png",
      isLoading: false,
      isRotated: false,
      isFlip: false,
      rungs: {
        small: "installed-companion-small.png",
        normal: "installed-companion-normal.png",
      },
      advanceFailedSource,
    });

    render(
      <CompanionFanCard
        companion={{ card: { card: { name: "Lurrus" }, count: 1 }, used: false }}
        canActivate={false}
        theme={ZONE_THEME.companion}
        rotation={0}
        arcOffset={0}
        restingY={0}
        hoverY={0}
        marginLeft={0}
        zIndex={1}
      />,
    );

    expect(mockUseCardImage).toHaveBeenCalledWith("Lurrus", { size: "normal" });
    const image = screen.getByRole("img", { name: "Lurrus" });
    expect(image).toHaveAttribute(
      "srcset",
      "installed-companion-small.png 146w, installed-companion-normal.png 488w",
    );
    fireEvent.error(image);
    expect(advanceFailedSource).toHaveBeenCalledWith("installed-companion-normal.png");
  });

  it("forwards the mobile hand object's current face and token provenance", () => {
    const token = buildGameObject({
      id: 31,
      owner: 0,
      controller: 0,
      zone: "Hand",
      name: "Localized Spirit",
      display_source: "Token",
      printed_ref: {
        oracle_id: "current-oracle",
        face_name: "Localized Spirit",
      },
      token_image_ref: {
        scryfall_id: "token-printing",
        scryfall_oracle_id: "token-oracle",
        face_name: "Spirit",
        preset_id: "token-preset",
      },
    });
    useGameStore.setState({
      gameMode: "local",
      gameState: buildGameState({
        players: buildPlayers([{ id: 0, hand: [token.id] }, 1]),
        objects: buildObjectMap(token),
        seat_order: [0, 1],
      }),
      legalActionsByObject: {},
      spellCosts: {},
    });
    useUiStore.setState({ mobileHandOpen: true });
    const advanceFailedSource = vi.fn();
    mockUseCardImage.mockReturnValue({
      src: "installed-token-normal.png",
      isLoading: false,
      isRotated: false,
      isFlip: false,
      rungs: { small: "installed-token-small.png", normal: "installed-token-normal.png" },
      advanceFailedSource,
    });

    render(<MobileHandDrawer />);

    expect(mockUseCardImage).toHaveBeenCalledWith(
      "Localized Spirit",
      expect.objectContaining({
        size: "normal",
        oracleId: "current-oracle",
        faceName: "Localized Spirit",
        isToken: true,
        tokenImageRef: expect.objectContaining({ scryfall_id: "token-printing" }),
      }),
    );
    const image = screen.getByRole("img", { name: "Localized Spirit" });
    expect(image).toHaveAttribute(
      "srcset",
      "installed-token-small.png 146w, installed-token-normal.png 488w",
    );
    fireEvent.error(image);
    expect(advanceFailedSource).toHaveBeenCalledWith("installed-token-normal.png");
  });

  it("closes and disables the mobile hand drawer when a local board choice begins", () => {
    const card = buildGameObject({
      id: 32,
      owner: 0,
      controller: 0,
      zone: "Hand",
      name: "Mobile Hand Card",
    });
    useGameStore.setState({
      gameMode: "local",
      gameState: buildGameState({
        players: buildPlayers([{ id: 0, hand: [card.id] }, 1]),
        objects: buildObjectMap(card),
        seat_order: [0, 1],
      }),
      legalActionsByObject: {},
      spellCosts: {},
    });
    useUiStore.setState({ mobileHandOpen: true });
    mockUseCardImage.mockReturnValue({
      src: "installed-hand-card.png",
      isLoading: false,
      isRotated: false,
      isFlip: false,
    });

    const { rerender } = render(<MobileHandDrawer />);
    expect(screen.getByRole("img", { name: "Mobile Hand Card" })).toBeInTheDocument();
    expect(mockUseCardHover).toHaveBeenCalledWith(card.id, "playerHand");
    useUiStore.setState({
      inspectedObjectId: card.id,
      previewSource: "playerHand",
      previewSticky: true,
    });

    rerender(<MobileHandDrawer interactionDisabled />);

    expect(screen.queryByRole("img", { name: "Mobile Hand Card" })).not.toBeInTheDocument();
    expect(useUiStore.getState().mobileHandOpen).toBe(false);
    expect(useUiStore.getState().inspectedObjectId).toBeNull();
  });
});

describe("GamePage shared manual hand entry", () => {
  const SPELL = 401;
  const OTHER_SPELL = 402;
  const ORDINARY = 403;
  const source: ManualResolutionSource = {
    actor: 0, sourceId: SPELL, sourceIncarnation: 7, stackEntryId: null,
    castTurnJournalIndex: null, cardId: 41, name: "Manual Hand Spell",
  };
  const choiceId = "opaque-native-manual-choice" as InteractionChoiceId;
  const interactionId = "native-hand-interaction" as InteractionId;
  const readCurrent = vi.fn();
  const lookupInteraction = vi.fn();

  function cast(objectId: number): GameAction {
    return { type: "CastSpell", data: { object_id: objectId, card_id: 41, targets: [] } };
  }

  function offers(reason?: ManualCastUnsupportedReason): ViewerInteraction {
    return {
      waitingForKind: { code: "choose", terminal: false, simultaneous: null }, authorizedSubmitters: [0], canSubmit: true, autoPassRecommended: false,
      attachmentFans: {}, attachmentViews: {}, availability: { type: "inputRequired" },
      opportunities: [{ interactionId, surfaces: [],
        progress: { selected: 0, minimum: 1, maximum: 1, aggregate: null, confirmable: true },
        response: { type: "exactChoices", data: { choices: [SPELL, OTHER_SPELL].map((id): InteractionChoice => ({
          id: `ordinary-choice-${id}` as InteractionChoiceId, status: { type: "available" },
          surfaces: [
            { type: "action", data: { code: "castSpell", actionId: null } },
            { type: "object", data: { role: "candidate", index: null, reference: String(id), name: null,
              zone: "hand", controller: 0, power: null, tapped: null } },
            { type: "manualCast", data: { availability: reason ? { type: "unsupported", data: { reason } }
              : { type: "supported", data: { choiceId: id === SPELL ? choiceId : "opaque-other-choice" as InteractionChoiceId,
                source: id === SPELL ? source : { ...source, sourceId: OTHER_SPELL, cardId: 42, name: "Other Manual Spell" } } } } },
          ],
        })) } },
      }],
    };
  }

  function publication(status: "pending" | "completed" | "indeterminate" | "not-applied"): LocalContinuationPublication {
    return { type: "localContinuation", current: null, appliedResult: null, engineSnapshot: null,
      receipt: { status, result: status === "completed" ? { events: [] } : null, rejection: null,
        attempt: { attemptId: "retained-original", source,
          context: { ownerLineage: "test-lineage", interactionSessionId: "test-session" as InteractionSessionId, restoreEpoch: 0, adapterGeneration: 10 },
          submission: { interactionId, response: { type: "choose", data: { choiceId } } } } } };
  }

  function page() {
    return <MemoryRouter initialEntries={["/game/manual-hand?mode=local"]}>
      <Routes><Route path="/game/:id" element={<GamePage />} /></Routes>
    </MemoryRouter>;
  }

  function openDrawer(container: HTMLElement) {
    fireEvent.click(container.querySelector("[data-player-hand]")!);
    expect(useUiStore.getState().mobileHandOpen).toBe(true);
  }

  function tap(name: string) {
    const card = screen.getAllByRole("img", { name }).map((image) => image.closest("button")).find(Boolean);
    fireEvent.click(card!);
  }

  beforeEach(() => {
    mobile.value = true;
    readCurrent.mockReset();
    lookupInteraction.mockReset();
    dispatchInteractionMock.mockReset().mockResolvedValue(publication("completed"));
    const cards = [
      gameObjectFactory.instant().inHand().withId(SPELL).named(source.name).build(),
      gameObjectFactory.instant().inHand().withId(OTHER_SPELL).named("Other Manual Spell").build(),
      gameObjectFactory.instant().inHand().withId(ORDINARY).named("Ordinary Hand Spell").build(),
    ];
    const state = gameStateFactory.withPlayers({ id: 0, hand: cards.map((card) => card.id) }, 1).withObjects(...cards).priority(0).build();
    act(() => {
      useGameStore.setState({ gameId: "manual-hand", gameMode: "local", gameState: state, waitingFor: state.waiting_for,
        legalActions: cards.map((card) => cast(card.id)), legalActionsByObject: Object.fromEntries(cards.map((card) => [card.id, [cast(card.id)]])),
        viewerInteraction: offers(), spellCosts: {}, localContinuationContext: null,
        adapter: buildEngineAdapterMock(state, { localContinuation: () => ({ readCurrent,
          lookupInteraction, submitInteraction: vi.fn(), restore: vi.fn(), commandPortFactory: vi.fn(), subscribe: () => () => undefined }) }),
      });
      useMultiplayerStore.setState({ activePlayerId: null, isSpectator: false });
      usePreferencesStore.setState({ multiplayerBoardLayout: "focused", multiplayerSplitLayoutNudgeDismissed: true });
      useUiStore.setState({ mobileHandOpen: false, debugInteractionMode: false, pendingAbilityChoice: null, enchantmentsDialogPlayer: null });
    });
    mockUseCardImage.mockReturnValue({ src: "hand-card.png", isLoading: false, isRotated: false, isFlip: false });
    mockUseCardHover.mockImplementation(() => hoverResult());
  });

  afterEach(() => {
    useGameStore.setState({ gameId: null, gameState: null, waitingFor: null, legalActions: [], legalActionsByObject: {} });
    mobile.value = true;
  });

  it("opens the sibling drawer on a mobile hand tap and submits the native choice only after displaying scope", async () => {
    const { container } = render(page());
    openDrawer(container);
    tap(source.name);

    expect(screen.getByRole("region", { name: `Resolution options for ${source.name}` })).toHaveTextContent("Its automatic spell body will be skipped.");
    expect(dispatchActionMock).not.toHaveBeenCalled();
    expect(dispatchInteractionMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cast with manual resolution" }));

    await waitFor(() => expect(dispatchInteractionMock).toHaveBeenCalledExactlyOnceWith(
      { interactionId, response: { type: "choose", data: { choiceId } } }, 0, source));
    expect(dispatchActionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["outsideOwnedControlledHandSpell", "Manual resolution requires a spell you own and control, cast normally from your hand."],
    ["resolutionHook", "This spell has a resolution hook outside the available manual scope."],
    ["anotherManualResolution", "Another manual resolution already owns the current source."],
  ] as const)("shows native unsupported %s before any payment and keeps ordinary play explicit", (reason, message) => {
    useGameStore.setState({ viewerInteraction: offers(reason) });
    const { container } = render(page());
    openDrawer(container);
    tap(source.name);

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cast with manual resolution" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cast with manual resolution" }));
    expect(dispatchActionMock).not.toHaveBeenCalled();
    expect(dispatchInteractionMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cast normally" }));
    expect(dispatchActionMock).toHaveBeenCalledExactlyOnceWith(cast(SPELL));
    expect(useUiStore.getState().mobileHandOpen).toBe(false);
  });

  it("keeps an ordinary sibling card on its existing direct touch play path", () => {
    const { container } = render(page());
    openDrawer(container);
    tap("Ordinary Hand Spell");
    expect(dispatchActionMock).toHaveBeenCalledExactlyOnceWith(cast(ORDINARY));
    expect(dispatchInteractionMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().mobileHandOpen).toBe(false);
  });

  it("threads the same native offer and submit callback into desktop selection", async () => {
    mobile.value = false;
    render(page());
    fireEvent.click(screen.getByRole("button", { name: source.name }));
    fireEvent.click(screen.getByRole("button", { name: `Resolution options for ${source.name}` }));
    expect(screen.getByText(/Its automatic spell body will be skipped/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cast with manual resolution" }));
    await waitFor(() => expect(dispatchInteractionMock).toHaveBeenCalledExactlyOnceWith(
      { interactionId, response: { type: "choose", data: { choiceId } } }, 0, source));
    expect(dispatchActionMock).not.toHaveBeenCalled();
  });

  it("withholds Manual mutation from a different viewing seat even with matching A source IDs", () => {
    const state = useGameStore.getState().gameState!;
    useGameStore.setState({ gameState: { ...state, active_player: 1, turn_decision_controller: 0,
      players: state.players.map((player) => player.id === 1 ? { ...player, hand: [SPELL] } : player) } });
    const { container } = render(page());
    openDrawer(container);
    expect(screen.getAllByRole("img", { name: source.name })).not.toHaveLength(0);
    tap(source.name);
    expect(screen.queryByRole("button", { name: "Cast with manual resolution" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    expect(dispatchInteractionMock).not.toHaveBeenCalled();
    expect(dispatchActionMock).toHaveBeenCalledExactlyOnceWith(cast(SPELL));
  });

  it("keeps spectator card taps as preview with no Manual or ordinary submission", () => {
    useGameStore.setState({ gameMode: "spectate" });
    const { container } = render(page());
    openDrawer(container);
    tap(source.name);
    expect(useUiStore.getState().inspectedObjectId).toBe(SPELL);
    expect(useUiStore.getState().previewSticky).toBe(true);
    expect(screen.queryByRole("button", { name: "Cast with manual resolution" })).not.toBeInTheDocument();
    expect(dispatchInteractionMock).not.toHaveBeenCalled();
    expect(dispatchActionMock).not.toHaveBeenCalled();
  });

  it("does not expose a Manual offer without native submit availability", () => {
    useGameStore.setState({ viewerInteraction: { ...offers(), canSubmit: false } });
    const { container } = render(page());
    openDrawer(container);
    tap(source.name);
    expect(screen.queryByRole("button", { name: "Cast with manual resolution" })).not.toBeInTheDocument();
    expect(dispatchInteractionMock).not.toHaveBeenCalled();
    expect(dispatchActionMock).toHaveBeenCalledExactlyOnceWith(cast(SPELL));
  });

  it.each(["pending", "indeterminate"] as const)("retains the %s original across reopen, new selection, fresh frames and perspective changes", async (status) => {
    dispatchInteractionMock.mockResolvedValue(publication(status));
    lookupInteraction.mockResolvedValueOnce(publication("indeterminate"))
      .mockResolvedValueOnce({ type: "localContinuation", current: null, appliedResult: null, engineSnapshot: null, receipt: null })
      .mockResolvedValueOnce(publication("completed"));
    const { container } = render(page());
    openDrawer(container);
    tap(source.name);
    fireEvent.click(screen.getByRole("button", { name: "Cast with manual resolution" }));
    await screen.findByRole("button", { name: "Check status" });
    expect(screen.getByRole("button", { name: "Cast normally" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    openDrawer(container);
    const fresh = offers();
    fresh.opportunities[0].interactionId = "later-fresh-interaction" as InteractionId;
    act(() => useGameStore.setState({ viewerInteraction: fresh }));
    tap("Other Manual Spell");
    expect(screen.getByRole("button", { name: "Cast with manual resolution" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cast normally" })).toBeEnabled();
    const statusNode = screen.getAllByRole("status").find((node) => node.textContent?.includes(status === "pending" ? "registered" : "Delivery is unknown"))!;
    expect(statusNode.parentElement).toHaveTextContent(source.name);
    expect(statusNode.parentElement).not.toHaveTextContent("Other Manual Spell");
    fireEvent.click(screen.getByRole("button", { name: "Cast with manual resolution" }));

    const state = useGameStore.getState().gameState!;
    act(() => useGameStore.setState({ gameState: { ...state, active_player: 1, turn_decision_controller: 0 } }));
    expect(screen.queryByRole("button", { name: "Cast with manual resolution" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    act(() => useGameStore.setState({ gameState: state }));

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(lookupInteraction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(lookupInteraction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Cast with manual resolution" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument());
    const original = dispatchInteractionMock.mock.calls[0]![0];
    expect(lookupInteraction.mock.calls.every(([submission]) => submission === original)).toBe(true);
    expect(readCurrent).not.toHaveBeenCalled();
    expect(dispatchInteractionMock).toHaveBeenCalledExactlyOnceWith({ interactionId, response: { type: "choose", data: { choiceId } } }, 0, source);
    expect(dispatchActionMock).not.toHaveBeenCalled();
  });

  it.each(["completed", "not-applied"] as const)("checks the captured cast capability after current reads and a replacement capability, releasing only its %s original", async (terminal) => {
    dispatchInteractionMock.mockResolvedValue(publication("indeterminate"));
    lookupInteraction.mockResolvedValueOnce(publication("indeterminate")).mockResolvedValueOnce(publication(terminal));
    // A watchdog may have already consumed the hand receipt; a later current
    // read can carry a different operation's successful receipt instead.
    readCurrent.mockResolvedValueOnce(publication("completed")).mockResolvedValueOnce({ ...publication("completed"),
      receipt: { ...publication("completed").receipt!, attempt: { ...publication("completed").receipt!.attempt,
        submission: { interactionId: "later-body-interaction" as InteractionId,
          response: { type: "manualResolution", data: { decision: { type: "loseOwnLife", data: { amount: 1 } } } } } } } });
    const { container } = render(page());
    openDrawer(container);
    tap(source.name);
    fireEvent.click(screen.getByRole("button", { name: "Cast with manual resolution" }));
    await screen.findByRole("button", { name: "Check status" });
    await readCurrent();
    await readCurrent();
    const replacementLookup = vi.fn().mockResolvedValue(publication("completed"));
    const state = useGameStore.getState().gameState!;
    act(() => useGameStore.setState({ adapter: buildEngineAdapterMock(state, { localContinuation: () => ({
      readCurrent, lookupInteraction: replacementLookup, submitInteraction: vi.fn(), restore: vi.fn(),
      commandPortFactory: vi.fn(), subscribe: () => () => undefined,
    }) }) }));
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(lookupInteraction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Cast normally" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument());
    expect(lookupInteraction.mock.calls.every(([submission]) => submission === dispatchInteractionMock.mock.calls[0]![0])).toBe(true);
    expect(replacementLookup).not.toHaveBeenCalled();
    expect(readCurrent).toHaveBeenCalledTimes(2);
    expect(dispatchInteractionMock).toHaveBeenCalledTimes(1);
    expect(dispatchActionMock).not.toHaveBeenCalled();
    if (terminal === "not-applied") expect(screen.getByText("The operation was not applied. You may try again.")).toBeInTheDocument();
  });

  it("keeps long-press preview and debug clicks ahead of manual selection", () => {
    const held = { current: true };
    mockUseCardHover.mockImplementation(() => hoverResult(held));
    const { container } = render(page());
    openDrawer(container);
    tap(source.name);
    expect(held.current).toBe(false);
    expect(screen.queryByRole("button", { name: "Cast with manual resolution" })).not.toBeInTheDocument();
    useUiStore.setState({ debugInteractionMode: true });
    tap(source.name);
    expect(useUiStore.getState().debugContextMenu).toMatchObject({ objectId: SPELL, surface: "game" });
    expect(useUiStore.getState().mobileHandOpen).toBe(false);
    expect(dispatchInteractionMock).not.toHaveBeenCalled();
    expect(dispatchActionMock).not.toHaveBeenCalled();
  });

  it("preserves the cycling action choice instead of silently consuming an ordinary hand card", () => {
    const action: GameAction = { type: "ActivateAbility", data: { source_id: ORDINARY, ability_index: 0 } };
    const state = useGameStore.getState().gameState!;
    const card = gameObjectFactory.instant().inHand().withId(ORDINARY).named("Ordinary Hand Spell")
      .build({ abilities: [{ consumes_source: true, description: "Cycling" }] });
    useGameStore.setState({ gameState: { ...state, objects: { ...state.objects, [ORDINARY]: card } },
      legalActionsByObject: { [ORDINARY]: [action] }, viewerInteraction: null });
    const { container } = render(page());
    openDrawer(container);
    tap("Ordinary Hand Spell");
    expect(useUiStore.getState().pendingAbilityChoice).toEqual({ objectId: ORDINARY, actions: [action] });
    expect(dispatchActionMock).not.toHaveBeenCalled();
    expect(dispatchInteractionMock).not.toHaveBeenCalled();
  });
});
