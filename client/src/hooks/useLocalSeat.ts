import { useCallback, useMemo } from "react";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useUiStore } from "../stores/uiStore";
import type { GameAction } from "../adapter/types";
import type { InteractionSubmission, InteractionPreviewRequest } from "../adapter/generated/interaction";
import { dispatchInteraction, previewInteractionResponse } from "../game/dispatch";
import { captureLocalSeat, isLocalSeatCurrent } from "../game/localHistorySession";
import { useGameStore } from "../stores/gameStore";

/** Capture at render, never retarget an old callback to a newly selected seat. */
export function useLocalSeatBinding() {
  const session = useGameStore(s => s.localHistory?.session);
  const generation = useGameStore(s => s.localHistory?.seatGeneration);
  return useMemo(() => {
    const binding = captureLocalSeat();
    return session !== undefined && binding?.generation === generation ? binding : null;
  }, [session, generation]);
}
/** Preserve the store dispatch contract for existing consumers. */
export function useGameStoreDispatch() {
  const binding = useLocalSeatBinding();
  const dispatch = useGameStore(s => s.dispatch);
  return useCallback((action: GameAction) => binding ? dispatch(action, binding) : dispatch(action), [dispatch, binding]);
}
export function useGameInteraction() {
  const binding = useLocalSeatBinding();
  return useCallback((submission: InteractionSubmission) =>
    binding ? dispatchInteraction(submission, binding.seat, binding) : dispatchInteraction(submission), [binding]);
}
export function useInteractionPreview() {
  const binding = useLocalSeatBinding();
  return useCallback((request: InteractionPreviewRequest) =>
    binding ? previewInteractionResponse(request, binding.seat, binding) : previewInteractionResponse(request), [binding]);
}

/** Old seat callbacks cannot reopen pending choices, card details or tooltips. */
export function useLocalUiAction<F extends (...args: never[]) => unknown>(selector: (state: ReturnType<typeof useUiStore.getState>) => F): F {
  const action = useUiStore(selector);
  return useBoundLocalAction(action);
}
export function useLocalPreferenceAction<F extends (...args: never[]) => unknown>(selector: (state: ReturnType<typeof usePreferencesStore.getState>) => F): F {
  return useBoundLocalAction(usePreferencesStore(selector));
}
function useBoundLocalAction<F extends (...args: never[]) => unknown>(action: F): F {
  const binding = useLocalSeatBinding();
  return useCallback((...args: Parameters<F>) => {
    if (isLocalSeatCurrent(binding)) return action(...args);
  }, [action, binding]) as F;
}
