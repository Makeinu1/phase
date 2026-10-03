import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { EngineAdapter, GameEvent, GameState, PlayerId } from "../../adapter/types.ts";
import { getPlayerId, usePlayerId } from "../../hooks/usePlayerId.ts";
import { useGameDispatch } from "../../hooks/useGameDispatch.ts";
import { useGameStore } from "../../stores/gameStore.ts";
import { LifeTotal } from "../controls/LifeTotal.tsx";

interface LifeCorrectionDraft {
  targetPlayerId: PlayerId;
  value: string;
  initialLife: number;
  gameId: string | null;
  adapter: EngineAdapter;
  gameSessionGeneration: number;
  engineCommitEpoch: number;
  gameState: GameState;
}

type StoreSnapshot = ReturnType<typeof useGameStore.getState>;

function sandboxFlagEnabled(): boolean {
  return import.meta.env.DEV && Reflect.get(import.meta.env, "VITE_PHASE_SANDBOX") === "1";
}

function captureDraft(targetPlayerId: PlayerId, store: StoreSnapshot): LifeCorrectionDraft | null {
  const gameState = store.gameState;
  const adapter = store.adapter;
  const player = gameState?.players.find((entry) => entry.id === targetPlayerId);
  if (!gameState || !adapter || !player) return null;

  return {
    targetPlayerId,
    value: String(player.life),
    initialLife: player.life,
    gameId: store.gameId,
    adapter,
    gameSessionGeneration: store.gameSessionGeneration,
    engineCommitEpoch: store.engineCommitEpoch,
    gameState,
  };
}

function draftStillMatches(draft: LifeCorrectionDraft, store: StoreSnapshot): boolean {
  return store.adapter === draft.adapter
    && store.gameId === draft.gameId
    && store.gameSessionGeneration === draft.gameSessionGeneration
    && store.engineCommitEpoch === draft.engineCommitEpoch
    && store.gameState === draft.gameState
    && store.gameState?.players.find((player) => player.id === draft.targetPlayerId)?.life === draft.initialLife;
}

function confirmsCorrection(
  events: GameEvent[],
  actor: PlayerId,
  targetPlayerId: PlayerId,
  expectedLife: number,
): boolean {
  const used = events.some((event) =>
    event.type === "DebugActionUsed"
    && event.data.player_id === actor
    && event.data.description.startsWith("SetLife (")
    && event.data.description.endsWith(` → ${expectedLife})`),
  );
  const changed = events.some((event) =>
    event.type === "LifeChanged"
    && event.data.player_id === targetPlayerId
    && event.data.new_total === expectedLife,
  );
  return used && changed;
}

/** Local development affordance for the sandbox walkthrough. It uses the same
 * adapter dispatch as the rest of the game and only reads committed life. */
export function SandboxLifeCorrection() {
  const { t } = useTranslation("game");
  const dispatch = useGameDispatch();
  const localPlayerId = usePlayerId();
  const gameMode = useGameStore((store) => store.gameMode);
  const gameId = useGameStore((store) => store.gameId);
  const gameSessionGeneration = useGameStore((store) => store.gameSessionGeneration);
  const engineCommitEpoch = useGameStore((store) => store.engineCommitEpoch);
  const gameState = useGameStore((store) => store.gameState);
  const adapter = useGameStore((store) => store.adapter);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LifeCorrectionDraft | null>(null);
  const [status, setStatus] = useState<"applied" | "notApplied" | "failed" | null>(null);
  const [statusTargetPlayerId, setStatusTargetPlayerId] = useState<PlayerId | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const requestIdRef = useRef(0);

  const currentStore = useGameStore.getState();
  const isSupportedMode = gameMode === "ai" || gameMode === "local";
  const debugPlayers = gameState?.debug_permitted;
  const hasDebugPermission = !debugPlayers || debugPlayers.length === 0 || debugPlayers.includes(localPlayerId);
  const isSandboxGame = gameState?.format_config?.allow_debug_actions === true;

  if (
    !sandboxFlagEnabled()
    || !isSupportedMode
    || !gameState
    || !adapter
    || !isSandboxGame
    || !hasDebugPermission
  ) {
    return null;
  }

  const currentDraftIsValid = draft !== null
    && gameId === currentStore.gameId
    && gameSessionGeneration === currentStore.gameSessionGeneration
    && engineCommitEpoch === currentStore.engineCommitEpoch
    && draftStillMatches(draft, currentStore);
  const draftIsStale = draft !== null && !currentDraftIsValid && !submitting;
  const nextLife = draft ? Number(draft.value) : Number.NaN;
  const validNewLife = draft !== null
    && draft.value.trim().length > 0
    && Number.isSafeInteger(nextLife)
    && nextLife >= -2_147_483_648
    && nextLife <= 2_147_483_647
    && nextLife !== draft.initialLife;

  const closePanel = () => {
    requestIdRef.current += 1;
    setOpen(false);
    setDraft(null);
    setStatus(null);
    setStatusTargetPlayerId(null);
  };

  const openPanel = () => {
    const store = useGameStore.getState();
    const targetPlayerId = store.gameState?.players.some((player) => player.id === localPlayerId)
      ? localPlayerId
      : store.gameState?.players[0]?.id;
    if (targetPlayerId === undefined) return;
    const nextDraft = captureDraft(targetPlayerId, store);
    if (!nextDraft) return;

    requestIdRef.current += 1;
    setDraft(nextDraft);
    setStatus(null);
    setStatusTargetPlayerId(null);
    setOpen(true);
  };

  const changeTarget = (value: string) => {
    const targetPlayerId = Number(value);
    const nextDraft = captureDraft(targetPlayerId, useGameStore.getState());
    if (!nextDraft) return;
    setDraft(nextDraft);
    setStatus(null);
    setStatusTargetPlayerId(null);
  };

  const submitCorrection = async () => {
    if (submittingRef.current || !draft || !validNewLife) return;

    const before = useGameStore.getState();
    if (!draftStillMatches(draft, before)) {
      setStatus("notApplied");
      return;
    }

    const submittedActor = getPlayerId();
    const requestId = requestIdRef.current;
    submittingRef.current = true;
    setSubmitting(true);
    setStatus(null);

    try {
      await dispatch({
        type: "Debug",
        data: {
          type: "SetLife",
          data: { player_id: draft.targetPlayerId, life: nextLife },
        },
      });

      const after = useGameStore.getState();
      const sameSession = after.adapter === draft.adapter
        && after.gameId === draft.gameId
        && after.gameSessionGeneration === draft.gameSessionGeneration;
      const committedLife = after.gameState?.players.find((player) => player.id === draft.targetPlayerId)?.life;
      const applied = sameSession
        && after.engineCommitEpoch > before.engineCommitEpoch
        && committedLife === nextLife
        && after.events !== before.events
        && confirmsCorrection(
          after.events,
          submittedActor,
          draft.targetPlayerId,
          nextLife,
        );

      if (requestIdRef.current === requestId) {
        setDraft(null);
        setStatus(applied ? "applied" : "notApplied");
        setStatusTargetPlayerId(draft.targetPlayerId);
      }
    } catch {
      if (requestIdRef.current === requestId) {
        setDraft(null);
        setStatus("failed");
        setStatusTargetPlayerId(draft.targetPlayerId);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={open ? closePanel : openPanel}
        className="rounded-full bg-gray-800/80 px-2 py-0.5 text-[10px] font-medium text-amber-200 transition-colors hover:bg-gray-700/80"
      >
        {t("sandboxLifeCorrection.open")}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("sandboxLifeCorrection.title")}
          className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-lg border border-amber-700/50 bg-gray-950 p-3 text-xs text-gray-200 shadow-xl"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <h2 className="font-semibold text-amber-100">{t("sandboxLifeCorrection.title")}</h2>
            <button
              type="button"
              onClick={closePanel}
              aria-label={submitting ? t("actions.close", { ns: "common" }) : t("actions.cancel", { ns: "common" })}
              className="-mr-1 -mt-1 rounded px-1.5 py-0.5 text-gray-400 hover:bg-gray-800 hover:text-white"
            >
              {submitting ? t("actions.close", { ns: "common" }) : t("actions.cancel", { ns: "common" })}
            </button>
          </div>
          <p className="mb-2 text-gray-400">{t("sandboxLifeCorrection.description")}</p>
          <p className="mb-3 text-[11px] text-amber-200/80">{t("sandboxLifeCorrection.scopeNote")}</p>

          {statusTargetPlayerId !== null && gameState.players.some((player) => player.id === statusTargetPlayerId) ? (
            <div className="mb-2 flex items-center justify-between rounded bg-gray-900 px-2 py-1.5">
              <span className="text-gray-400">{t("sandboxLifeCorrection.currentLife")}</span>
              <LifeTotal playerId={statusTargetPlayerId} size="sm" hideLabel />
            </div>
          ) : null}
          {submitting ? (
            <p role="status" className="mb-2 text-amber-200">{t("sandboxLifeCorrection.submitting")}</p>
          ) : null}
          {draft && currentDraftIsValid ? (
            <form
              aria-label={t("sandboxLifeCorrection.title")}
              onSubmit={(event) => {
                event.preventDefault();
                void submitCorrection();
              }}
              className="space-y-2"
            >
              <label className="block space-y-1">
                <span className="text-gray-300">{t("sandboxLifeCorrection.target")}</span>
                <select
                  aria-label={t("sandboxLifeCorrection.target")}
                  value={draft.targetPlayerId}
                  disabled={submitting}
                  onChange={(event) => changeTarget(event.currentTarget.value)}
                  className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-white"
                >
                  {gameState.players.map((player) => (
                    <option key={player.id} value={player.id}>
                      {t("sandboxLifeCorrection.player", { seat: player.id + 1 })}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center justify-between rounded bg-gray-900 px-2 py-1.5">
                <span className="text-gray-400">{t("sandboxLifeCorrection.currentLife")}</span>
                <LifeTotal playerId={draft.targetPlayerId} size="sm" hideLabel />
              </div>
              <label className="block space-y-1">
                <span className="text-gray-300">{t("sandboxLifeCorrection.newLife")}</span>
                <input
                  type="number"
                  step="1"
                  min="-2147483648"
                  max="2147483647"
                  value={draft.value}
                  disabled={submitting}
                  onChange={(event) => setDraft({ ...draft, value: event.currentTarget.value })}
                  className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-white"
                />
              </label>
              {status ? (
                <p role="status" className={status === "applied" ? "text-emerald-300" : "text-amber-200"}>
                  {t(`sandboxLifeCorrection.${status}`)}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={submitting || !validNewLife}
                className="w-full rounded bg-amber-700 px-2 py-1.5 font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("sandboxLifeCorrection.submit")}
              </button>
            </form>
          ) : draftIsStale ? (
            <p role="alert" className="text-amber-200">{t("sandboxLifeCorrection.stale")}</p>
          ) : null}
          {status && !draft ? (
            <p role="status" className={status === "applied" ? "text-emerald-300" : "text-amber-200"}>
              {t(`sandboxLifeCorrection.${status}`)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
