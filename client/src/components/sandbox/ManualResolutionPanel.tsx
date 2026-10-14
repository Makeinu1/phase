import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { DebugAction, GameObject, ObjectId, PlayerId } from "../../adapter/types";
import type { InteractionId } from "../../adapter/generated/interaction";
import { dispatchAction } from "../../game/dispatch";
import { useGameStore } from "../../stores/gameStore";
import { useManualPickStore, type ManualBoardZone } from "../../stores/manualPickStore";
import { CardImage } from "../card/CardImage";
import type {
  ManualResolutionCommandPort,
  ManualResolutionRequest,
} from "./manual-resolution-ui-contract";

/**
 * The paused manual resolution, played like paper: the resolving card sits on
 * the left, the board is where things are picked (a permanent, a player's
 * plate, a hand, a pile), and this panel offers the instructions that fit
 * what was picked. Every instruction is one engine Sandbox instruction; the
 * engine runs the real effect and decides what it does.
 */
export interface ManualResolutionPanelProps {
  readonly viewerId: PlayerId;
  readonly source: { readonly name: string; readonly stackEntryId: ObjectId; readonly sourceObjectId: ObjectId };
  /** The viewer is performing this resolution now (it is paused open). */
  readonly operable: boolean;
  readonly finish: {
    readonly interactionId: InteractionId;
    readonly adapterGeneration: number;
    readonly port: ManualResolutionCommandPort;
  } | null;
  readonly playerName: (playerId: PlayerId) => string;
  readonly undoControl: ReactNode;
}

type Verb =
  | "destroy" | "exile" | "toHand" | "toGraveyard" | "discard"
  | "toBattlefield" | "toBattlefieldMine";

type CardZone = "Battlefield" | "Hand" | "Graveyard" | "Exile" | "Library";

/** The instructions a picked card offers from the zone it is in. */
function verbsFor(zone: CardZone, anyNotOwned: boolean): Verb[] {
  const mine: Verb[] = anyNotOwned ? ["toBattlefieldMine"] : [];
  switch (zone) {
    case "Battlefield": return ["destroy", "exile", "toHand", "toGraveyard"];
    case "Hand": return ["discard", "exile", "toBattlefield", ...mine];
    case "Graveyard": return ["toBattlefield", ...mine, "toHand", "exile"];
    case "Exile": return ["toBattlefield", ...mine, "toHand", "toGraveyard"];
    case "Library": return ["toHand", "toGraveyard", "exile", "toBattlefield", ...mine];
  }
}

function instructionsFor(verb: Verb, objects: readonly GameObject[], noRegeneration: boolean): DebugAction[] {
  const ids = objects.map((object) => object.id);
  const put = (destination: Extract<DebugAction, { type: "PutCards" }>["data"]["destination"]): DebugAction[] =>
    [{ type: "PutCards", data: { object_ids: ids, destination } }];
  switch (verb) {
    case "destroy":
      return [{ type: "Destroy", data: { object_ids: ids, regeneration: noRegeneration ? "Forbidden" : "Allowed" } }];
    case "discard":
      return ids.map((object_id) => ({ type: "Discard", data: { object_id } }));
    case "exile": return put({ type: "Exile" });
    case "toHand": return put({ type: "Hand" });
    case "toGraveyard": return put({ type: "Graveyard" });
    case "toBattlefield": return put({ type: "Battlefield", data: { control: "Owner" } });
    case "toBattlefieldMine": return put({ type: "Battlefield", data: { control: "Actor" } });
  }
}

const ZONES: readonly ManualBoardZone[] = ["hand", "graveyard", "exile", "library"];

export function ManualResolutionPanel({ viewerId, source, operable, finish, playerName, undoControl }: ManualResolutionPanelProps) {
  const { t } = useTranslation("game");
  const gameState = useGameStore((s) => s.gameState);
  const picked = useManualPickStore((s) => s.selectedObjectIds);
  const pickedPlayer = useManualPickStore((s) => s.selectedPlayerId);
  const openZone = useManualPickStore((s) => s.openZone);
  const [amount, setAmount] = useState(1);
  const [noRegeneration, setNoRegeneration] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unresolvedFinish, setUnresolvedFinish] = useState<ManualResolutionRequest | null>(null);

  const objects = gameState?.objects ?? {};
  const pickedObjects = picked.map((id) => objects[id]).filter((object): object is GameObject => Boolean(object));
  const zones = new Set(pickedObjects.map((object) => object.zone as CardZone));
  const pickedZone = zones.size === 1 ? [...zones][0] : null;
  const pickedPlayerState = pickedPlayer === null ? undefined : gameState?.players.find((p) => p.id === pickedPlayer);

  const zoneIds = (playerId: PlayerId, zone: ManualBoardZone): ObjectId[] => {
    const player = gameState?.players.find((p) => p.id === playerId);
    if (!player || !gameState) return [];
    switch (zone) {
      case "hand": return player.hand;
      case "graveyard": return player.graveyard;
      case "library": return player.library;
      case "exile": return gameState.exile.filter((id) => objects[id]?.owner === playerId);
    }
  };
  const stripIds = openZone ? zoneIds(openZone.playerId, openZone.zone) : [];
  // The engine's display-identity flag is the single authority for what this viewer sees.
  const shown = stripIds.filter((id) => objects[id]?.display_visible_to_viewer === true);
  const hiddenCount = stripIds.length - shown.length;

  const submit = async (actions: DebugAction[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const action of actions) await dispatchAction({ type: "Debug", data: action });
      useManualPickStore.getState().clearSelection();
    } catch (submitError) {
      setError(t("manualResolution.panel.failed", { reason: submitError instanceof Error ? submitError.message : String(submitError) }));
    } finally {
      setBusy(false);
    }
  };

  const finishResolution = async () => {
    if (!finish) return;
    const request: ManualResolutionRequest = unresolvedFinish ?? {
      binding: { interactionId: finish.interactionId, adapterGeneration: finish.adapterGeneration },
      command: { type: "finish", stackEntryId: source.stackEntryId, sourceObjectId: source.sourceObjectId },
    };
    setBusy(true);
    setError(null);
    try {
      if (unresolvedFinish) {
        const reconciled = await finish.port.reconcileManualResolution(request);
        if (reconciled.status === "completed") setUnresolvedFinish(null);
        else if (reconciled.status === "not-applied") {
          setUnresolvedFinish(null);
          setError(reconciled.reason ?? t("manualResolution.notAppliedRetry"));
        } else setError(t("manualResolution.panel.finishUnknown"));
        return;
      }
      const result = await finish.port.submitManualResolutionCommand(request);
      if (result.status === "rejected") setError(result.reason);
      else if (result.status === "indeterminate") {
        setUnresolvedFinish(request);
        setError(t("manualResolution.panel.finishUnknown"));
      }
    } catch (finishError) {
      setUnresolvedFinish(request);
      setError(finishError instanceof Error ? finishError.message : t("manualResolution.panel.finishUnknown"));
    } finally {
      setBusy(false);
    }
  };

  const button = "rounded-md border border-white/15 bg-slate-900 px-2.5 py-1 text-xs text-slate-100 hover:bg-slate-800 disabled:opacity-40";
  const stepper = (
    <span className="flex items-center gap-1 text-xs">
      <button type="button" className={button} aria-label="−" onClick={() => setAmount((n) => Math.max(1, n - 1))}>−</button>
      <input aria-label={t("manualResolution.amount")} type="number" min={1} value={amount}
        onChange={(event) => setAmount(Math.max(1, Number(event.target.value) || 1))}
        className="w-12 rounded border border-white/15 bg-slate-900 px-1 py-0.5 text-center" />
      <button type="button" className={button} aria-label="+" onClick={() => setAmount((n) => n + 1)}>+</button>
    </span>
  );

  return (
    <section aria-label={t("manualResolution.title")} data-testid="manual-resolution-panel"
      className="flex gap-3 rounded-xl border border-fuchsia-200/30 bg-slate-950/95 p-3 text-slate-100 shadow-2xl">
      <div className="w-[9.5rem] shrink-0" data-testid="manual-source-card">
        <CardImage cardName={source.name} size="normal" className="w-full rounded-lg" />
      </div>

      {!operable ? (
        <div className="flex min-w-0 flex-1 flex-col justify-end gap-2">{undoControl}</div>
      ) : (
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {openZone ? (
          <div data-testid="manual-zone-strip" className="rounded-lg border border-white/10 p-2">
            <div className="flex items-center justify-between gap-2 text-xs text-slate-300">
              <span>{t("manualResolution.panel.zoneTitle", {
                player: playerName(openZone.playerId),
                zone: t(`manualResolution.panel.zones.${openZone.zone}`),
              })}</span>
              <span className="flex gap-1">
                {ZONES.filter((zone) => zone !== openZone.zone).map((zone) => (
                  <button key={zone} type="button" className={button}
                    onClick={() => useManualPickStore.getState().showZone(openZone.playerId, zone)}>
                    {t(`manualResolution.panel.zones.${zone}`)}
                  </button>
                ))}
              </span>
            </div>
            <ul className="mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-auto">
              {shown.map((id) => (
                <li key={id}>
                  <button type="button" aria-pressed={picked.includes(id)} aria-label={objects[id]?.name}
                    onClick={() => useManualPickStore.getState().pickObject(id)}
                    className={`block w-14 overflow-hidden rounded-md ring-2 ${picked.includes(id) ? "ring-fuchsia-300" : "ring-transparent hover:ring-white/40"}`}>
                    <CardImage cardName={objects[id]?.name ?? ""} size="small" className="w-full" />
                  </button>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                <span>{t("manualResolution.panel.hidden", { count: hiddenCount })}</span>
                {openZone.zone === "hand" && openZone.playerId !== viewerId && (
                  <button type="button" disabled={busy} className={button}
                    onClick={() => void submit([{ type: "RevealHand", data: { player_id: openZone.playerId } }])}>
                    {t("manualResolution.panel.revealHand")}
                  </button>
                )}
                {openZone.zone === "library" && stepper}
                {openZone.zone === "library" && (
                  <button type="button" disabled={busy} className={button}
                    onClick={() => void submit([{ type: "Reveal", data: { player_id: openZone.playerId, count: amount } }])}>
                    {t("manualResolution.panel.revealTop", { count: amount })}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : null}

        <div data-testid="manual-instructions" className="flex flex-col gap-1.5">
          {pickedPlayerState ? (
            <>
              <p className="text-sm font-semibold">{playerName(pickedPlayerState.id)} <span className="text-slate-400">♥ {pickedPlayerState.life}</span></p>
              <div className="flex flex-wrap items-center gap-1.5">
                {stepper}
                <button type="button" disabled={busy} className={button}
                  onClick={() => void submit([{ type: "LoseLife", data: { player_id: pickedPlayerState.id, amount } }])}>
                  {t("manualResolution.panel.loseLife")}
                </button>
                <button type="button" disabled={busy} className={button}
                  onClick={() => void submit([{ type: "DrawCards", data: { player_id: pickedPlayerState.id, count: amount } }])}>
                  {t("manualResolution.panel.draw")}
                </button>
                <button type="button" disabled={busy} className={button}
                  onClick={() => void submit([{ type: "Mill", data: { player_id: pickedPlayerState.id, count: amount } }])}>
                  {t("manualResolution.panel.mill")}
                </button>
              </div>
            </>
          ) : pickedObjects.length > 0 ? (
            pickedZone ? (
              <>
                <p className="truncate text-sm font-semibold">{pickedObjects.map((object) => object.name).join(" / ")}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {verbsFor(pickedZone, pickedObjects.some((object) => object.owner !== viewerId)).map((verb) => (
                    <button key={verb} type="button" disabled={busy} className={button}
                      onClick={() => void submit(instructionsFor(verb, pickedObjects, noRegeneration))}>
                      {t(`manualResolution.panel.${verb}`)}
                    </button>
                  ))}
                  {pickedZone === "Battlefield" && (
                    <label className="flex items-center gap-1 text-xs text-slate-300">
                      <input type="checkbox" checked={noRegeneration} onChange={(event) => setNoRegeneration(event.target.checked)} />
                      {t("manualResolution.panel.noRegeneration")}
                    </label>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-amber-200">{t("manualResolution.panel.mixedZones")}</p>
            )
          ) : (
            <p className="text-xs text-slate-400">{t("manualResolution.panel.pickHint")}</p>
          )}
        </div>

        {error ? <p role="alert" className="text-xs text-rose-300">{error}</p> : null}

        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
          <button type="button" disabled={busy || !finish} onClick={() => void finishResolution()}
            className="rounded-md bg-fuchsia-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-fuchsia-600 disabled:opacity-40">
            {unresolvedFinish ? t("manualResolution.checkStatus") : t("manualResolution.finish")}
          </button>
          {undoControl}
        </div>
      </div>
      )}
    </section>
  );
}
