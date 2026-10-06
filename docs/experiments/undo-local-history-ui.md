# New Local session history experiment

This extends the `f802693d` adapter experiment through existing product dispatch
and Undo controls. It is opt-in, development-only, in-memory, and single-session.

Run the client with `VITE_PHASE_LOCAL_HISTORY=1` and start a **new** normal Local
game with `?mode=local&history=1`. `GameProvider` chooses a new dedicated normal
WASM module Worker. Saved-game, draft, multiplayer and main-thread fallback
setup are refused for this experiment. The query option is captured when a new
session starts; changing it in the current game does not switch Undo implementations.

| Existing entrance | Experimental path |
|---|---|
| PlayerHand / other `dispatchAction` UI | One submission through the shared Local coordinator |
| `dispatchInteraction` | One issued interaction submission through the same coordinator |
| `gameStore.dispatch` / keyboard actions | Same coordinator and lock |
| Existing UndoButton / keyboard Z / `gameStore.undo` | TrustedHistory Undo through the same lock |
| Direct adapter mutation, raw-client access, external pair adoption or legacy restore | Fail closed; terminate owned executor and require a new session |

Each submitted action is a separate root. Cast, manual payment, a later choice,
and a pass are separate roots when they require separate submissions. Resolution
within one accepted engine submission is part of that submission. The QA harness
does not group both actors' passes, cast/payment or search into product roots.
Initial standing preferences are configured before the initial pair is displayed;
subsequent preference changes use recorded submissions.

Capture failure sends nothing. Unknown submit, snapshot or store-adoption failure
keeps the lock until the known engine PRE has been fenced, restored and adopted.
Recovery failure stops and disposes the owned executor. Undo restores the engine
pair, display log/event history and standing-preference display/cache, clears
pending UI choices and creates fresh restore authority. UI state is never a
restore source. The old five-entry ring is unused. Future PREs are released only
after an accepted replacement action; rejected attempts keep them.

This experiment uses immediate pair adoption rather than the normal animation
pipeline. Automatic client passes, stale-screen rehydration and AI proposals are
disabled/closed while it owns the session. Leaving ends its dedicated Worker.
There is no agreement model, pre-agreed Undo, P2P synchronization, shared-seat
privacy, new engine/protocol/persistence format, deployment or production enablement.

`localHistorySession.test.tsx` exercises the real dispatcher/store/Undo component
with an explicitly labelled boundary fixture. It does not prove engine rules.
`undo-history-local-ui.mjs` renders existing PlayerHand, GameBoard and UndoButton,
starts via `gameStore.initGame`, and uses trusted CDP mouse input. It checks land
and creature-cast UI → Undo → reexecution, full engine-envelope equality except
documented authority rotation, legal-action display and log/pending consistency.
Natural setup submissions are separately labelled harness roots. It uses the
fixed nine-card test database and verified existing e109 WASM; no engine build.
This campaign does not exercise the full GameProvider/GamePage route, two-seat
UI, P2P or Safari. Its workflow artifact is the evidence of whether it ran.
