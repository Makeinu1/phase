import { useEffect } from "react";

import type {
  EngineAdapter,
  GameState,
  PhaseStop,
  PriorityPassingMode,
} from "../adapter/types";
import { dispatchActionForGameSession } from "../game/dispatch";
import { useGameStore } from "../stores/gameStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useUiStore } from "../stores/uiStore";
import { currentLocalHistory } from "../game/localHistorySession";
import { getPlayerId } from "./usePlayerId";

/**
 * The mode the engine must hold for this player.
 *
 * CR 117.1: Full Control is a standing refusal to give up any priority window,
 * so it has to be engine state, not a frontend flag. An auto-pass session
 * another player installed (Resolve All) is driven inside the engine's own
 * priority loop and never consults a client, so a purely local toggle could not
 * stop it. It stays a per-session `uiStore` toggle in the UI — this only
 * projects it onto the synced preference while it is on.
 */
function effectivePriorityPassingMode(): PriorityPassingMode {
  return useUiStore.getState().fullControl
    ? "FullControl"
    : usePreferencesStore.getState().priorityPassingMode;
}

type LastSent = {
  adapter: EngineAdapter;
  generation: number;
  stops?: readonly PhaseStop[];
  mode?: PriorityPassingMode;
  presentation?: LocalGameplayPresentation;
};
export interface LocalGameplayPresentation { priorityPassingMode: PriorityPassingMode; fullControl: boolean }
const gameplayPresentation = (): LocalGameplayPresentation => ({
  priorityPassingMode: usePreferencesStore.getState().priorityPassingMode,
  fullControl: useUiStore.getState().fullControl,
});

// Module-scoped so React StrictMode remounts cannot resend preferences for the
// same live engine lifecycle. `gameSessionGeneration` is monotonically unique,
// so a genuine init/resume/reset always invalidates this cache even when both
// the adapter object and game id are reused.
let lastSent: LastSent | null = null;
let syncRequested = false;
let syncInFlight = false;

/** New experimental setup only: configure before the initial pair is exposed. */
export async function prepareLocalGameplayPreferences(adapter: EngineAdapter, generation: number, checkCurrent: () => void): Promise<void> {
  const stops = usePreferencesStore.getState().phaseStops.slice();
  const mode = effectivePriorityPassingMode();
  const presentation = gameplayPresentation();
  await adapter.submitAction({ type: "SetPhaseStops", data: { stops } }, getPlayerId());
  checkCurrent();
  await adapter.submitAction({ type: "SetPriorityPassingMode", data: { mode } }, getPlayerId());
  checkCurrent();
  lastSent = { adapter, generation, stops, mode, presentation };
}

/** Pending controls can already show POST; retain the last committed PRE display. */
export function localGameplayPresentation(adapter: EngineAdapter, generation: number, state: GameState): LocalGameplayPresentation {
  const mode = state.priority_passing_modes?.[getPlayerId()] ?? "Standard";
  if (effectivePriorityPassingMode() === mode) return gameplayPresentation();
  if (lastSent?.adapter === adapter && lastSent.generation === generation && lastSent.mode === mode && lastSent.presentation) return { ...lastSent.presentation };
  return { priorityPassingMode: mode, fullControl: false };
}

/** Restore projects the engine's PRE settings; it must not resend POST settings. */
export function adoptLocalGameplayPreferences(adapter: EngineAdapter, generation: number, state: GameState, presentation: LocalGameplayPresentation): void {
  const actor = getPlayerId();
  const stops = state.phase_stops?.[actor] ?? [];
  const mode = state.priority_passing_modes?.[actor] ?? "Standard";
  lastSent = { adapter, generation, stops: stops.slice(), mode, presentation };
  usePreferencesStore.setState({
    phaseStops: stops.slice(),
    priorityPassingMode: presentation.priorityPassingMode,
  });
  useUiStore.setState({ fullControl: presentation.fullControl });
}

function phaseStopsEqual(a: readonly PhaseStop[], b: readonly PhaseStop[]): boolean {
  return a.length === b.length
    && a.every((value, index) =>
      value.phase === b[index]?.phase && value.scope === b[index]?.scope,
    );
}

function isCurrentSession(adapter: EngineAdapter, generation: number): boolean {
  const game = useGameStore.getState();
  return (
    game.adapter === adapter
    && game.gameSessionGeneration === generation
    && game.gameState !== null
  );
}

function successfulSendFor(adapter: EngineAdapter, generation: number): LastSent {
  if (lastSent?.adapter === adapter && lastSent.generation === generation) {
    return lastSent;
  }
  return { adapter, generation };
}

async function drainGameplayPreferenceSync(): Promise<void> {
  if (syncInFlight) return;
  syncInFlight = true;

  try {
    while (syncRequested) {
      syncRequested = false;

      const {
        adapter,
        gameSessionGeneration: generation,
        gameState,
      } = useGameStore.getState();
      if (!adapter || !gameState) continue;
      // A blocked send is not a success. The idle transition below re-arms
      // pending user settings after the current root/restore is terminal.
      if (currentLocalHistory() && useGameStore.getState().localHistory?.phase !== "idle") continue;

      const stops = usePreferencesStore.getState().phaseStops;
      const mode = effectivePriorityPassingMode();
      const presentation = gameplayPresentation();
      const sent = successfulSendFor(adapter, generation);

      if (!sent.stops || !phaseStopsEqual(sent.stops, stops)) {
        try {
          await dispatchActionForGameSession(
            { type: "SetPhaseStops", data: { stops: [...stops] } },
            adapter,
            generation,
          );
        } catch {
          // dispatchAction reports engine failures. Leave this value unsent so
          // the next store notification can retry it.
          continue;
        }

        const currentStops = usePreferencesStore.getState().phaseStops;
        if (isCurrentSession(adapter, generation) && phaseStopsEqual(currentStops, stops)) {
          lastSent = {
            ...successfulSendFor(adapter, generation),
            stops: stops.slice(),
          };
        } else {
          syncRequested = true;
          continue;
        }
      }

      if (!isCurrentSession(adapter, generation)) {
        syncRequested = true;
        continue;
      }

      const currentMode = effectivePriorityPassingMode();
      if (currentMode !== mode) {
        syncRequested = true;
        continue;
      }

      const modeSent = successfulSendFor(adapter, generation);
      if (modeSent.mode !== mode) {
        try {
          await dispatchActionForGameSession(
            { type: "SetPriorityPassingMode", data: { mode } },
            adapter,
            generation,
          );
        } catch {
          // As above, a rejected dispatch must remain retryable.
          continue;
        }

        if (
          isCurrentSession(adapter, generation)
          && effectivePriorityPassingMode() === mode
        ) {
          lastSent = { ...successfulSendFor(adapter, generation), mode, presentation };
        } else {
          syncRequested = true;
        }
      }
    }
  } finally {
    syncInFlight = false;
    // A notification can land after the loop condition but before the flag is
    // cleared. Make sure that request is not stranded.
    if (syncRequested) void drainGameplayPreferenceSync();
  }
}

function sendGameplayPreferences(): void {
  syncRequested = true;
  void drainGameplayPreferenceSync();
}

/** Push engine-owned gameplay preferences once per game lifecycle and whenever
 * either preference changes. Mount exactly once in `GameProvider`. */
export function useGameplayPreferencesSync(): void {
  useEffect(() => {
    const unsubGame = useGameStore.subscribe(
      (state) => [
        state.adapter,
        state.gameSessionGeneration,
        state.gameState !== null,
        state.engineCommitEpoch,
        state.localHistory?.phase,
      ] as const,
      (next, previous) => {
        // A failed preference's own capture/recovery/idle notifications are
        // not a new request. Independent setting changes still queue below;
        // a different lifecycle must also be inspected after this attempt.
        if (currentLocalHistory() && syncInFlight
          && next[0] === previous[0] && next[1] === previous[1]) return;
        sendGameplayPreferences();
      },
      { fireImmediately: true },
    );
    const unsubPreferences = usePreferencesStore.subscribe(sendGameplayPreferences);
    // Full Control lives in `uiStore` (a per-session toggle, not a persisted
    // preference), so it needs its own subscription to reach the engine.
    // `uiStore` is a plain zustand store with no `subscribeWithSelector`
    // middleware, so the selector overload is unavailable — hence the explicit
    // previous-value guard, which also keeps unrelated UI state changes from
    // re-dispatching the preference.
    let lastFullControl = useUiStore.getState().fullControl;
    const unsubFullControl = useUiStore.subscribe((state) => {
      if (state.fullControl === lastFullControl) return;
      lastFullControl = state.fullControl;
      sendGameplayPreferences();
    });

    return () => {
      unsubGame();
      unsubPreferences();
      unsubFullControl();
    };
  }, []);
}
