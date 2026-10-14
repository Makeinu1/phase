import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ensureCardLocale, type LocalizedFace } from "../../../services/engineRuntime.ts";
import { usePreferencesStore } from "../../../stores/preferencesStore.ts";
import { useGameStore } from "../../../stores/gameStore.ts";
import { buildStackEntry } from "../../../test/factories/gameStateFactory.ts";
import japanese from "../../../i18n/locales/ja/game.json";
import { StackEntry } from "../../stack/StackEntry.tsx";
import { TriggerOrderModal } from "../TriggerOrderModal.tsx";

vi.mock("../../../services/engineRuntime.ts", async (original) => ({
  ...await original<typeof import("../../../services/engineRuntime.ts")>(),
  ensureCardLocale: vi.fn(),
}));
vi.mock("../../../hooks/useCardImage.ts", () => ({
  useCardImage: () => ({ src: "/test-card.png", isLoading: false }),
}));

// Official printed text is a whole-card reference, NOT a translation of the
// one engine trigger. In particular, Guide also has a separate attack trigger.
const guideText = "これでないクリーチャー１体があなたのコントロール下で戦場に出るたび、１点のライフと {E} （エネルギー・カウンター１個）.を得る。\nあなたが攻撃するたび、{E}{E}{E}を支払ってもよい。そうしたとき、攻撃クリーチャー１体を対象とする。それの上に＋１/＋１カウンター２個と飛行カウンター１個を置く。それは他のタイプに加えて天使になる。";
const companionText = "神憑く相棒が戦場に出たとき、カード１枚を引く。";
const locale = new Map<string, LocalizedFace>([
  ["guide of souls", { name: "魂の導き手", oracle_text: guideText }],
  ["spirited companion", { name: "神憑く相棒", oracle_text: companionText }],
]);

function showPrompt(names = ["Guide of Souls", "Spirited Companion"]) {
  const dispatch = vi.fn().mockResolvedValue([]);
  useGameStore.setState({
    waitingFor: {
      type: "OrderTriggers",
      data: {
        player: 0,
        triggers: names.map((name, index) => ({
          source_id: index + 1,
          source_name: name,
          description: name === "Guide of Souls"
            ? "Whenever another creature you control enters, you gain 1 life and get {E}."
            : "When ~ enters, draw a card.",
        })),
      },
    },
    dispatch,
  });
  return dispatch;
}

beforeEach(async () => {
  vi.mocked(ensureCardLocale).mockResolvedValue(locale);
  i18n.addResourceBundle("ja", "game", japanese);
  usePreferencesStore.setState({ language: "ja" });
  await i18n.changeLanguage("ja");
});

afterEach(async () => {
  cleanup();
  useGameStore.getState().reset();
  usePreferencesStore.setState({ language: "en" });
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
});

it("shows the full Japanese reference beside the original ability and preserves the chosen order", async () => {
  const dispatch = showPrompt();
  const modal = render(<TriggerOrderModal />);
  expect(await screen.findByText("魂の導き手")).toBeInTheDocument();
  const rows = screen.getAllByRole("listitem");
  expect(within(rows[0]).getByText(/Whenever another creature you control enters/)).toBeInTheDocument();
  expect(within(rows[0]).getByText(/あなたが攻撃するたび/)).toBeInTheDocument();
  expect(within(rows[1]).getByText(companionText)).toBeInTheDocument();
  expect(screen.getAllByRole("region", { name: "日本語カード本文（参考）" })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "下へ移動" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "順序を確認" }));
  expect(dispatch).toHaveBeenCalledWith({ type: "OrderTriggers", data: { order: [1, 0] } });
  modal.unmount();

  const entry = buildStackEntry({
    kind: {
      type: "TriggeredAbility",
      data: { source_id: 2, source_name: "Spirited Companion", ability: { targets: [] } },
    },
  });
  const details = {
    source_name: "Spirited Companion",
    kind_label: "Triggered ability",
    ability_description: "When ~ enters, draw a card.",
  };
  const stack = render(<StackEntry entry={entry} index={0} isTop cardSize={{ width: 120, height: 168 }} details={details} />);
  expect(await screen.findByAltText("神憑く相棒")).toBeInTheDocument();
  expect(screen.getByText("誘発型能力")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "能力の原文とカード本文を見る" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("When Spirited Companion enters, draw a card.")).toBeInTheDocument();
  expect(within(dialog).getByText(companionText)).toBeInTheDocument();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const activated = buildStackEntry({ kind: { type: "ActivatedAbility", data: { source_id: 2, ability: { targets: [] } } } });
  stack.rerender(<StackEntry entry={activated} index={0} isTop cardSize={{ width: 120, height: 168 }} details={{ ...details, kind_label: "Activated ability 3" }} />);
  expect(screen.getByText("起動型能力 3")).toBeInTheDocument();
});

it("keeps the original when content is absent and never shows a previous card or language's reference", async () => {
  showPrompt();
  render(<TriggerOrderModal />);
  await screen.findByText("魂の導き手");
  let finish!: (map: Map<string, LocalizedFace>) => void;
  vi.mocked(ensureCardLocale).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  act(() => { showPrompt(["Unknown Card", "Another Card"]); });
  expect(screen.queryByText("魂の導き手")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "日本語カード本文（参考）" })).not.toBeInTheDocument();
  expect(screen.getByText("When Unknown Card enters, draw a card.")).toBeInTheDocument();
  await act(async () => { finish(new Map()); });
  expect(screen.queryByText(companionText)).not.toBeInTheDocument();

  vi.mocked(ensureCardLocale).mockResolvedValue(locale);
  act(() => { showPrompt(); });
  await screen.findByText("魂の導き手");
  await act(async () => {
    usePreferencesStore.setState({ language: "en" });
    await i18n.changeLanguage("en");
  });
  await waitFor(() => { expect(screen.getByText("Guide of Souls")).toBeInTheDocument(); });
  expect(screen.queryByText("魂の導き手")).not.toBeInTheDocument();
  expect(screen.getByText(/Whenever another creature you control enters/)).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Printed card text (reference)" })).not.toBeInTheDocument();
});
