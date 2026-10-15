import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { DebugAction, GameObject, ObjectId, PlayerId } from "../../adapter/types";
import type { InteractionId } from "../../adapter/generated/interaction";
import { dispatchAction } from "../../game/dispatch";
import { useGameStore } from "../../stores/gameStore";
import { useManualPickStore, type ManualBoardZone } from "../../stores/manualPickStore";
import { CardImage } from "../card/CardImage";
import { ManualTokenShelf } from "./ManualTokenShelf";
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
  | "destroy" | "sacrifice" | "damage" | "tap" | "untap" | "addCounter" | "removeCounter"
  | "exile" | "toHand" | "toGraveyard" | "discard" | "toBattlefield" | "toBattlefieldMine"
  | "toLibraryTop" | "toLibraryBottom" | "copyToken" | "arrangeTop" | "arrangeBottom";

type CardZone = "Battlefield" | "Hand" | "Graveyard" | "Exile" | "Library";

/** The instructions picked cards offer from the zone they are in. */
function verbsFor(zone: CardZone, objects: readonly GameObject[], viewerId: PlayerId): Verb[] {
  const mine: Verb[] = objects.some((object) => object.owner !== viewerId) ? ["toBattlefieldMine"] : [];
  const library: Verb[] = ["toLibraryTop", "toLibraryBottom"];
  switch (zone) {
    case "Battlefield":
      return [
        "destroy", "sacrifice", "damage", objects.every((object) => object.tapped) ? "untap" : "tap",
        "addCounter", "removeCounter", "copyToken", "exile", "toHand", "toGraveyard", ...library,
      ];
    case "Hand": return ["discard", "exile", "toBattlefield", ...mine, ...library];
    case "Graveyard": return ["toBattlefield", ...mine, "toHand", "exile", ...library];
    case "Exile": return ["toBattlefield", ...mine, "toHand", "toGraveyard", ...library];
    case "Library": return ["toHand", "toGraveyard", "exile", "toBattlefield", ...mine, "arrangeTop", "arrangeBottom"];
  }
}

/** Verbs that use the amount stepper. */
const AMOUNT_VERBS: ReadonlySet<Verb> = new Set(["damage", "addCounter", "removeCounter", "copyToken"]);

function instructionsFor(verb: Verb, objects: readonly GameObject[], noRegeneration: boolean, amount: number, viewerId: PlayerId, counterType: string): DebugAction[] {
  const ids = objects.map((object) => object.id);
  const put = (destination: Extract<DebugAction, { type: "PutCards" }>["data"]["destination"]): DebugAction[] =>
    [{ type: "PutCards", data: { object_ids: ids, destination } }];
  const each = (make: (object_id: ObjectId) => DebugAction) => ids.map(make);
  switch (verb) {
    case "destroy":
      return [{ type: "Destroy", data: { object_ids: ids, regeneration: noRegeneration ? "Forbidden" : "Allowed" } }];
    case "sacrifice": return each((object_id) => ({ type: "Sacrifice", data: { object_id } }));
    case "damage": return [{ type: "DealDamage", data: { object_ids: ids, player_ids: [], amount } }];
    case "tap": return each((object_id) => ({ type: "SetTapped", data: { object_id, tapped: true } }));
    case "untap": return each((object_id) => ({ type: "SetTapped", data: { object_id, tapped: false } }));
    case "addCounter":
      return each((object_id) => ({ type: "ModifyCounters", data: { object_id, counter_type: counterType, delta: amount } }));
    case "removeCounter":
      return each((object_id) => ({ type: "ModifyCounters", data: { object_id, counter_type: counterType, delta: -amount } }));
    case "discard": return each((object_id) => ({ type: "Discard", data: { object_id } }));
    case "exile": return put({ type: "Exile" });
    case "toHand": return put({ type: "Hand" });
    case "toGraveyard": return put({ type: "Graveyard" });
    case "toBattlefield": return put({ type: "Battlefield", data: { control: "Owner" } });
    case "toBattlefieldMine": return put({ type: "Battlefield", data: { control: "Actor" } });
    case "toLibraryTop": return put({ type: "Library", data: { end: "Top" } });
    case "toLibraryBottom": return put({ type: "Library", data: { end: "Bottom" } });
    // CR 401.4: cards that stay in the library are rearranged in picked order.
    case "arrangeTop":
      return [{ type: "ArrangeLibrary", data: { player_id: objects[0].owner, top: ids, bottom: [] } }];
    case "arrangeBottom":
      return [{ type: "ArrangeLibrary", data: { player_id: objects[0].owner, top: [], bottom: ids } }];
    case "copyToken":
      return each((source_id) => ({ type: "CreateTokenCopy", data: { source_id, owner: viewerId, nonlegendary: false, count: amount } }));
  }
}

const ZONES: readonly ManualBoardZone[] = ["hand", "graveyard", "exile", "library"];

/** Counter kinds offered by name; the engine parses the name into its typed
 *  counter (an unknown single word becomes a named counter, CR 122.1). */
const COUNTER_KINDS = ["P1P1", "M1M1", "loyalty", "shield", "stun", "lore", "time", "oil"] as const;

export function ManualResolutionPanel({ viewerId, source, operable, finish, playerName, undoControl }: ManualResolutionPanelProps) {
  const { t } = useTranslation("game");
  const gameState = useGameStore((s) => s.gameState);
  const picked = useManualPickStore((s) => s.selectedObjectIds);
  const pickedPlayer = useManualPickStore((s) => s.selectedPlayerId);
  const openZone = useManualPickStore((s) => s.openZone);
  const [amount, setAmount] = useState(1);
  const [noRegeneration, setNoRegeneration] = useState(false);
  const [counterChoice, setCounterChoice] = useState<string>("P1P1");
  const [customCounter, setCustomCounter] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unresolvedFinish, setUnresolvedFinish] = useState<ManualResolutionRequest | null>(null);

  // Esc puts down whatever is picked, like lifting your hand off the table.
  useEffect(() => {
    if (!operable) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") useManualPickStore.getState().clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [operable]);

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
  const visible = stripIds.filter((id) => objects[id]?.display_visible_to_viewer === true);
  const hiddenCount = stripIds.length - visible.length;
  // A searched library can hold most of a deck; narrowing by name is a view
  // convenience over the engine's visible cards, not a game decision.
  const FILTER_THRESHOLD = 12;
  const needle = nameFilter.trim().toLowerCase();
  const shown = visible.length > FILTER_THRESHOLD && needle
    ? visible.filter((id) => objects[id]?.name.toLowerCase().includes(needle))
    : visible;

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

  const counterType = counterChoice === "custom" ? customCounter.trim().toLowerCase() : counterChoice;
  const counterLabel = counterChoice === "custom" ? customCounter.trim() : t(`manualResolution.panel.counterKinds.${counterChoice}`);
  // One amount stepper at a time: the shelf borrows it when nothing else shows it.
  const stepperShown = Boolean(pickedPlayerState) || pickedZone === "Battlefield"
    || (openZone?.zone === "library" && hiddenCount > 0);
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
                {openZone.zone === "library" && (
                  <button type="button" disabled={busy} className={button}
                    onClick={() => void submit([{ type: "ShuffleLibrary", data: { player_id: openZone.playerId } }])}>
                    {t("manualResolution.panel.shuffle")}
                  </button>
                )}
                {ZONES.filter((zone) => zone !== openZone.zone).map((zone) => (
                  <button key={zone} type="button" className={button}
                    onClick={() => useManualPickStore.getState().showZone(openZone.playerId, zone)}>
                    {t(`manualResolution.panel.zones.${zone}`)}
                  </button>
                ))}
              </span>
            </div>
            {visible.length > FILTER_THRESHOLD && (
              <input type="search" value={nameFilter} onChange={(event) => setNameFilter(event.target.value)}
                aria-label={t("manualResolution.panel.filter")} placeholder={t("manualResolution.panel.filter")}
                className="mt-2 w-full rounded border border-white/15 bg-slate-900 px-2 py-0.5 text-xs" />
            )}
            <ul className="mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-auto">
              {shown.map((id) => (
                <li key={id}>
                  <button type="button" aria-pressed={picked.includes(id)} aria-label={objects[id]?.name}
                    onClick={() => useManualPickStore.getState().pickObject(id)}
                    className={`block w-14 overflow-hidden rounded-md ring-2 ${picked.includes(id) ? "ring-fuchsia-300" : "ring-transparent hover:ring-white/40"}`}>
                    <span className="relative block">
                      <CardImage cardName={objects[id]?.name ?? ""} size="small" className="w-full" />
                      {picked.includes(id) && (
                        <span aria-hidden className="absolute left-0.5 top-0.5 rounded-full bg-fuchsia-600 px-1.5 text-[10px] font-bold text-white">
                          {picked.indexOf(id) + 1}
                        </span>
                      )}
                    </span>
                    <span className="block truncate bg-slate-900 px-0.5 text-[9px] leading-tight text-slate-200">{objects[id]?.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>{t("manualResolution.panel.hidden", { count: hiddenCount })}</span>
                {openZone.zone === "hand" && openZone.playerId !== viewerId && (
                  <>
                    <button type="button" disabled={busy} className={button}
                      onClick={() => void submit([{ type: "LookAtCards", data: { player_id: openZone.playerId, scope: { type: "Hand" } } }])}>
                      {t("manualResolution.panel.lookHand")}
                    </button>
                    <button type="button" disabled={busy} className={button}
                      onClick={() => void submit([{ type: "RevealHand", data: { player_id: openZone.playerId } }])}>
                      {t("manualResolution.panel.revealHand")}
                    </button>
                  </>
                )}
                {openZone.zone === "library" && (
                  <>
                    <button type="button" disabled={busy} className={button}
                      onClick={() => void submit([{ type: "LookAtCards", data: { player_id: openZone.playerId, scope: { type: "Library", data: { top: null } } } }])}>
                      {t("manualResolution.panel.searchLibrary")}
                    </button>
                    {stepper}
                    <button type="button" disabled={busy} className={button}
                      onClick={() => void submit([{ type: "LookAtCards", data: { player_id: openZone.playerId, scope: { type: "Library", data: { top: amount } } } }])}>
                      {t("manualResolution.panel.lookTop", { count: amount })}
                    </button>
                    <button type="button" disabled={busy} className={button}
                      onClick={() => void submit([{ type: "Reveal", data: { player_id: openZone.playerId, count: amount } }])}>
                      {t("manualResolution.panel.revealTop", { count: amount })}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ) : null}

        <div data-testid="manual-instructions" className="flex flex-col gap-1.5">
          {(pickedPlayerState || pickedObjects.length > 0) && (
            <button type="button" className="self-end text-[11px] text-slate-400 underline hover:text-slate-200"
              onClick={() => useManualPickStore.getState().clearSelection()}>
              {t("manualResolution.panel.clear")}
            </button>
          )}
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
                  onClick={() => void submit([{ type: "GainLife", data: { player_id: pickedPlayerState.id, amount } }])}>
                  {t("manualResolution.panel.gainLife")}
                </button>
                <button type="button" disabled={busy} className={button}
                  onClick={() => void submit([{ type: "DealDamage", data: { object_ids: [], player_ids: [pickedPlayerState.id], amount } }])}>
                  {t("manualResolution.panel.damage", { count: amount })}
                </button>
                <button type="button" disabled={busy} className={button}
                  onClick={() => void submit([{ type: "GivePlayerCounters", data: { player_id: pickedPlayerState.id, kind: "Poison", amount } }])}>
                  {t("manualResolution.panel.poison", { count: amount })}
                </button>
                <button type="button" disabled={busy} className={button}
                  onClick={() => void submit([{ type: "GivePlayerCounters", data: { player_id: pickedPlayerState.id, kind: "Experience", amount } }])}>
                  {t("manualResolution.panel.experience", { count: amount })}
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
                  {verbsFor(pickedZone, pickedObjects, viewerId).map((verb) => (
                    <button key={verb} type="button" disabled={busy} className={button}
                      onClick={() => void submit(instructionsFor(verb, pickedObjects, noRegeneration, amount, viewerId, counterType))}>
                      {AMOUNT_VERBS.has(verb) ? t(`manualResolution.panel.${verb}`, { count: amount, kind: counterLabel }) : t(`manualResolution.panel.${verb}`)}
                    </button>
                  ))}
                  {pickedZone === "Battlefield" && stepper}
                  {pickedZone === "Battlefield" && (
                    <span className="flex items-center gap-1 text-xs">
                      <select aria-label={t("manualResolution.panel.counterKind")} value={counterChoice}
                        onChange={(event) => setCounterChoice(event.target.value)}
                        className="rounded border border-white/15 bg-slate-900 px-1 py-0.5">
                        {[...COUNTER_KINDS, "custom"].map((kind) => (
                          <option key={kind} value={kind}>{t(`manualResolution.panel.counterKinds.${kind}`)}</option>
                        ))}
                      </select>
                      {counterChoice === "custom" && (
                        <input aria-label={t("manualResolution.panel.customCounter")} value={customCounter}
                          onChange={(event) => setCustomCounter(event.target.value)}
                          className="w-20 rounded border border-white/15 bg-slate-900 px-1 py-0.5" />
                      )}
                    </span>
                  )}
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

        <ManualTokenShelf owner={pickedPlayerState?.id ?? viewerId} count={amount} disabled={busy}
          amountControl={stepperShown ? null : stepper}
          relatedPresetIds={objects[source.sourceObjectId]?.source_related_token_ids ?? []}
          sourceName={source.name}
          onCreate={(action) => void submit([action])} />

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
