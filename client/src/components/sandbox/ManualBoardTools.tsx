import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DebugAction, GameObject, ObjectId, PlayerId } from "../../adapter/types";
import { dispatchAction } from "../../game/dispatch";
import { useGameStore } from "../../stores/gameStore";
import { useUiStore } from "../../stores/uiStore";

/**
 * Board tools for a paused manual resolution: the actor works through the
 * spell's text as target -> zone -> card -> verb. Every verb submits one
 * engine Sandbox correction; the engine decides whether it is admitted while
 * the resolution is paused and what it does (a discard is a real discard, a
 * reveal goes through the engine's reveal). This component only shows the
 * engine-provided state and maps each button to one correction.
 */
export interface ManualBoardToolsPlayer {
  readonly id: PlayerId;
  readonly name: string;
}

export interface ManualBoardToolsProps {
  readonly viewerId: PlayerId;
  readonly players: readonly ManualBoardToolsPlayer[];
  readonly focusedPlayerId: PlayerId | null;
  readonly onFocusPlayer: (player: ManualBoardToolsPlayer) => void;
}

type ToolZone = "hand" | "graveyard" | "exile" | "library";

type Verb =
  | "discard"
  | "exileIt"
  | "toBattlefield"
  | "toBattlefieldMine"
  | "toHand"
  | "toGraveyard"
  | "toLibraryTop"
  | "toLibraryBottom";

/** Which verbs a card offers from the zone the actor is looking at. */
function verbsFor(zone: ToolZone, ownedByViewer: boolean): Verb[] {
  const mine: Verb[] = ownedByViewer ? [] : ["toBattlefieldMine"];
  switch (zone) {
    case "hand":
      return ["discard", "exileIt", "toBattlefield", ...mine, "toLibraryTop", "toLibraryBottom"];
    case "graveyard":
      return ["toBattlefield", ...mine, "toHand", "exileIt", "toLibraryTop", "toLibraryBottom"];
    case "exile":
      return ["toBattlefield", ...mine, "toHand", "toGraveyard", "toLibraryTop", "toLibraryBottom"];
    case "library":
      return ["toHand", "toGraveyard", "exileIt", "toBattlefield", ...mine, "toLibraryBottom"];
  }
}

function correctionsFor(verb: Verb, object: GameObject, viewerId: PlayerId): DebugAction[] {
  const move = (to_zone: "Battlefield" | "Hand" | "Graveyard" | "Exile"): DebugAction => ({
    type: "MoveToZone", data: { object_id: object.id, to_zone, simulate: false },
  });
  switch (verb) {
    case "discard":
      return [{ type: "Discard", data: { object_id: object.id } }];
    case "exileIt":
      return [move("Exile")];
    case "toBattlefield":
      return [move("Battlefield")];
    case "toBattlefieldMine":
      return [move("Battlefield"), { type: "SetController", data: { object_id: object.id, controller: viewerId } }];
    case "toHand":
      return [move("Hand")];
    case "toGraveyard":
      return [move("Graveyard")];
    case "toLibraryTop":
      return [{ type: "MoveToZone", data: { object_id: object.id, to_zone: "Library", library_position: { type: "Top" }, simulate: false } }];
    case "toLibraryBottom":
      return [{ type: "MoveToZone", data: { object_id: object.id, to_zone: "Library", library_position: { type: "Bottom" }, simulate: false } }];
  }
}

export function ManualBoardTools({ viewerId, players, focusedPlayerId, onFocusPlayer }: ManualBoardToolsProps) {
  const { t } = useTranslation("game");
  const gameState = useGameStore((s) => s.gameState);
  const [zone, setZone] = useState<ToolZone>("hand");
  const [selectedId, setSelectedId] = useState<ObjectId | null>(null);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setSelectedId(null); setError(null); }, [focusedPlayerId, zone]);

  const focused = players.find((player) => player.id === focusedPlayerId) ?? null;
  const playerState = focused ? gameState?.players.find((player) => player.id === focused.id) : undefined;
  const objects = gameState?.objects ?? {};

  const zoneIds = (which: ToolZone): ObjectId[] => {
    if (!playerState || !gameState) return [];
    switch (which) {
      case "hand": return playerState.hand;
      case "graveyard": return playerState.graveyard;
      case "library": return playerState.library;
      case "exile": return gameState.exile.filter((id) => objects[id]?.owner === playerState.id);
    }
  };
  // The engine's display-identity flag is the single authority for what this
  // viewer may see; hidden cards are only counted.
  const visible = (id: ObjectId) => objects[id]?.display_visible_to_viewer === true;
  const ids = zoneIds(zone);
  const shown = ids.filter(visible);
  const hiddenCount = ids.length - shown.length;
  const selected = selectedId !== null && shown.includes(selectedId) ? objects[selectedId] : undefined;

  const submit = async (actions: DebugAction[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const action of actions) await dispatchAction({ type: "Debug", data: action });
      setSelectedId(null);
    } catch (submitError) {
      setError(t("manualResolution.tools.failed", { reason: submitError instanceof Error ? submitError.message : String(submitError) }));
    } finally {
      setBusy(false);
    }
  };

  const zoneLabel = (which: ToolZone) => t(`manualResolution.tools.${which}`);
  const chip = (active: boolean) => `rounded-md border px-2.5 py-1 text-xs ${active
    ? "border-cyan-200 bg-cyan-900 text-cyan-50" : "border-white/15 bg-slate-900 text-slate-200 hover:bg-slate-800"}`;

  return (
    <section aria-label={t("manualResolution.tools.title")} data-testid="manual-board-tools"
      className="mt-2 rounded-xl border border-cyan-200/20 bg-slate-950/95 p-3 text-slate-100 shadow-lg">
      <h3 className="text-sm font-semibold">{t("manualResolution.tools.title")}</h3>
      <p className="mt-1 text-xs text-slate-400">{t("manualResolution.sandboxHint")}</p>

      <div role="group" aria-label={t("manualResolution.tools.target")} className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-slate-400">{t("manualResolution.tools.target")}</span>
        {players.map((player) => (
          <button key={player.id} type="button" aria-pressed={player.id === focusedPlayerId}
            onClick={() => onFocusPlayer(player)} className={chip(player.id === focusedPlayerId)}>
            {player.name}
          </button>
        ))}
      </div>

      {!focused || !playerState ? (
        <p className="mt-2 text-xs text-slate-300">{t("manualResolution.tools.chooseTarget")}</p>
      ) : (
        <>
          <div role="tablist" aria-label={t("manualResolution.tools.zones")} className="mt-2 flex flex-wrap gap-1.5">
            {(["hand", "graveyard", "exile", "library"] as const).map((which) => (
              <button key={which} type="button" role="tab" aria-selected={zone === which}
                onClick={() => setZone(which)} className={chip(zone === which)}>
                {zoneLabel(which)} {zoneIds(which).length}
              </button>
            ))}
          </div>

          {focused.id !== viewerId && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span>{t("manualResolution.tools.life", { life: playerState.life })}</span>
              <button type="button" disabled={busy} className={chip(false)}
                onClick={() => void submit([{ type: "SetLife", data: { player_id: focused.id, life: playerState.life - 1 } }])}>
                {t("manualResolution.tools.lifeMinus")}
              </button>
              <button type="button" disabled={busy} className={chip(false)}
                onClick={() => void submit([{ type: "SetLife", data: { player_id: focused.id, life: playerState.life + 1 } }])}>
                {t("manualResolution.tools.lifePlus")}
              </button>
            </div>
          )}
          {focused.id === viewerId && (
            <p className="mt-2 text-xs text-slate-400">{t("manualResolution.tools.selfLifeHint")}</p>
          )}

          <div role="tabpanel" className="mt-2">
            {zone === "hand" && hiddenCount > 0 && (
              <button type="button" disabled={busy} className={chip(false)}
                onClick={() => void submit([{ type: "RevealHand", data: { player_id: focused.id } }])}>
                {t("manualResolution.tools.revealHand")}
              </button>
            )}
            {zone === "library" && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <label className="flex items-center gap-1">
                  {t("manualResolution.tools.count")}
                  <input type="number" min={1} max={playerState.library.length || 1} value={count}
                    onChange={(event) => setCount(Math.max(1, Number(event.target.value) || 1))}
                    className="w-14 rounded border border-white/15 bg-slate-900 px-1 py-0.5 text-slate-100" />
                </label>
                <button type="button" disabled={busy} className={chip(false)}
                  onClick={() => void submit([{ type: "Reveal", data: { player_id: focused.id, count } }])}>
                  {t("manualResolution.tools.revealTop", { count })}
                </button>
                <button type="button" disabled={busy} className={chip(false)}
                  onClick={() => void submit([{ type: "Mill", data: { player_id: focused.id, count } }])}>
                  {t("manualResolution.tools.millTop", { count })}
                </button>
              </div>
            )}
            {hiddenCount > 0 && (
              <p className="mt-1 text-xs text-slate-400">{t("manualResolution.tools.hiddenCount", { count: hiddenCount })}</p>
            )}
            {shown.length === 0 ? (
              <p className="mt-1 text-xs text-slate-400">{t("manualResolution.tools.empty")}</p>
            ) : (
              <ul className="mt-1 flex max-h-40 flex-wrap gap-1.5 overflow-auto" aria-label={zoneLabel(zone)}>
                {shown.map((id) => (
                  <li key={id}>
                    <button type="button" aria-pressed={selectedId === id}
                      onClick={() => {
                        setSelectedId(id);
                        useUiStore.getState().inspectObjectSticky(id, 0, "side", objects[id]?.name);
                      }}
                      className={chip(selectedId === id)}>
                      {objects[id]?.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {selected ? (
            <div role="group" aria-label={t("manualResolution.tools.selected", { card: selected.name })} className="mt-2 border-t border-white/10 pt-2">
              <p className="text-xs text-cyan-100">{t("manualResolution.tools.selected", { card: selected.name })}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {verbsFor(zone, selected.owner === viewerId).map((verb) => (
                  <button key={verb} type="button" disabled={busy} className={chip(false)}
                    onClick={() => void submit(correctionsFor(verb, selected, viewerId))}>
                    {t(`manualResolution.tools.${verb}`)}
                  </button>
                ))}
              </div>
            </div>
          ) : shown.length > 0 ? (
            <p className="mt-2 text-xs text-slate-400">{t("manualResolution.tools.chooseCard")}</p>
          ) : null}
          {error ? <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p> : null}
        </>
      )}
    </section>
  );
}
