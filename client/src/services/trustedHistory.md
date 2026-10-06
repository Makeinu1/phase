# Isolated trusted history prototype

This module is deliberately not imported by dispatch, stores, UI or P2P. It
bookkeeps operation roots supplied by a caller and does not classify game actions.
There are no engine, protocol, permission or durable-storage changes.

`captureTrustedCheckpointString` alone creates opaque checkpoint tokens from
`EngineAdapter.exportPersistenceState`. A private WeakMap holds the original
string. State objects, projections and parse/stringify output cannot be promoted
to tokens. `WasmAdapter.restoreTrustedState` forwards those bytes through the
existing worker/fallback restore and card-DB gate. Rust remains the decoder and
restore authority, including its existing multiplayer rejection.

## Transaction contract

- `perform` locks before capture. It copies the operation root/actor and binds
  game ID, session generation, branch, operation generation and committed seq.
- Capture, UTF-8 byte accounting, candidate entry and replacement/future arrays,
  and the optional allocation-injection hook complete before `submit` starts.
- `submit` represents an entire root (for example declaration, payment and
  required choices). It must not publish a competing client commit itself.
  Only a terminal, non-mutating rejection may return `rejected`. A throw or
  timeout is uncertain even if transport work continues.
- An accepted receipt matching root and the entire committed parent is validated
  before the required synchronous `commitAccepted` adopts its corresponding
  paired snapshot. Only a `true` result then changes the cursor/history, with
  no await between adoption and ledger swap. False/throw (including partial
  adoption) retains the old ledger/future and pending PRE under recovery lock.
  Synchronous store subscribers may invalidate ownership or cancel: the manager
  checks the adopted binding and session again before swapping its ledger.
  New acceptance drops future checkpoints. Rejection
  or cancellation before submit drops only the pending PRE.
- Once submit starts, cancellation waits for its terminal result. A canceled or
  stale acceptance, invalid receipt or exception keeps history unchanged and
  enters recovery lock; it does not allow another operation.
- `undo` locks first. Its optional preflight is non-mutating. After preflight,
  any failure conservatively retains the lock and known restore target.
- Every restore, including recovery, awaits `fenceMutations`. This port must
  drain or fence every older mutation. Ignoring a late receipt is insufficient:
  no older submit may mutate the engine after the fence resolves.
- Restore uses the same opaque PRE, then `getSnapshot` for a paired engine
  state/legal result. The synchronous `commitRestore` must commit that pair,
  invalidate old action/capability authority, and return a fresh branch,
  generation and snapshot seq. Only then does the manager move the cursor.
- Engine/commit failure retains the recovery target. Explicit `recover` repeats
  fence, restore, paired snapshot and fresh-authority commit. The commit port
  must handle a prior partial commit idempotently without reviving old authority.
  The restore port receives a per-call ownership guard, checked by the adapter
  at entry, after DB loading and after restore completion. It cannot cancel a
  posted RPC: same-engine session handoff must first drain all owned RPCs.
  A departed session cannot commit a stale result. Teardown can dispose retained
  checkpoint references after the owning engine session is terminated.

The lock is internal here. Future integration must extend it to every engine
mutation and submission route, not merely calls to this class. `isCurrent` must
check all binding fields; `isSessionCurrent` must check adapter ownership and
session identity even during partial-commit recovery. The snapshot seq is the
existing client ordering stamp, not a new network commit identifier.

## Memory and remaining evidence

`retainedBytes` counts UTF-8 serialized PRE bytes, including pending PRE and
retained future. This is not live heap. Dropping a future, pending PRE or disposed
history removes the WeakMap's raw-string references; metadata contains no raw
JSON. Actual garbage collection timing is not guaranteed or measured.

The optional byte budget and allocation hook are fault-injection inputs. There
is no default product budget, entry-count eviction, compression or durable spill.
Live retained heap and device measurements are required before choosing a budget.

Before real integration, prove operation-root grouping and accepted engine
commit mapping, serialization with every mutation route, terminal submit/fence
behavior, stale-session rejection and partial-commit recovery on the actual
  adapter. Then prove two-seat agreement, ACK/lock/unlock, privacy, old-capability
rejection and fresh continuation. Initial/non-Priority restore eligibility and
active offers remain separate engine evidence requirements. None of those are
claimed by the injected unit tests.

The separate `undo-history-adapter.yml` QA campaign uses the normal WasmAdapter
and module Worker with retained exact e109 WASM. It holds only response delivery,
including a real 65-second delay past the existing 60-second notification. Its
fence drains every owned RPC before pinging the captured Worker; ping alone is
not a fence because the Worker handles asynchronous setup requests concurrently.
Casting/payment has one actor; resolving/searching/shuffling and advancing past
required empty combat prompts explicitly group the engine's multiple actor
continuations. The first submitted actor is checked against the root actor.

Memory observations compare six ordinary roots with identical seed/action trace,
with and without retained checkpoints, after branch discard and after session
teardown. Three forced CDP GC rounds separate main/Worker JS heap from the WASM
allocated region and process RSS peak. CDP enumerates live WebAssembly.Memory objects and reads numeric buffer
lengths only; generated bindings remain byte-identical and their public exports
are inspected before the normal Worker starts. The
store retains the same display histories in the paired runs. These conditional
measurements do not establish a device budget or a reclamation guarantee. No
product dispatch, P2P, two-seat agreement or durable format is connected.
