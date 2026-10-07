import { useCallback } from "react";
import type { GameAction } from "../adapter/types";
import { currentSnapshot, dispatchAction } from "../game/dispatch";
import { useLocalSeatBinding } from "./useLocalSeat";

export function useGameDispatch() {
  const binding = useLocalSeatBinding();
  return useCallback((action: GameAction, actor?: number) =>
    binding ? dispatchAction(action, actor ?? binding.seat, { localSeat: binding })
      : actor === undefined ? dispatchAction(action) : dispatchAction(action, actor), [binding]);
}
export { currentSnapshot };
