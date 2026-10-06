# Bounded Undo WASM memory measurement

Finite stage completed on 2026-10-06. Public driver head before this report: `34cce758210fb5d87bca80ef0fe5f9f53a13f9e8`, branch `experiment/undo-memory-e10955dc`. Results below were read through the parent thread's normal authorized connector; the execution environment's GitHub API access was denied. Draft PR creation remains unresolved. No API retry or alternate credential was used.

## Fixed inputs and scope

Engine source: `e10955dc5977f1ba7c65cb1518cb8f4b1679fe92`. Verified CI control: `0d74cf0314bec06949cd03231cd7979091d03f95`. Original artifact producer: `387b7542a901d711cbef2868e686b29726c905f0`, run `37387607807`, artifact `11380069733`. The unchanged artifact verifier pins the original ZIP and the manifest verifier checks individual file hashes; no retained-copy input was substituted.

This is the producer's opt0, LTO-off, 16 MiB stack build with a two-card fixture database. Both seats have the stated deck size; the player deck has eight required cast cards and the rest basic lands, the opponent deck basic lands. Seed remains `0xF32002`. Legal engine actions prepare the game without state injection. Results do not establish a budget for optimized distributions, a full database, or mobile devices.

## Observed linear-memory boundary values

All values below are bytes. OFF is one cast only; ON is cast/restore at the same PRE for 32 cycles. OFF is not a repeated-cast control.

| Profile/runtime | OFF boundary value | ON PRE | ON first capture | ON first restore | ON cycle 32 / clear | Evidence |
|---|---:|---:|---:|---:|---:|---|
| 40 short, Node | 33,095,680 | 33,095,680 | 33,161,216 | 36,831,232 | 37,748,736 | [run 37400630011](https://github.com/Makeinu1/phase/actions/runs/37400630011) |
| 40 short, Chrome Worker | 33,095,680 | 33,095,680 | 33,161,216 | 36,831,232 | 37,486,592 | [run 37400630011](https://github.com/Makeinu1/phase/actions/runs/37400630011) |
| 80 short, Node | 34,537,472 | 34,537,472 | 34,865,152 | 38,862,848 | 41,222,144 | [run 37401125680](https://github.com/Makeinu1/phase/actions/runs/37401125680) |
| 40 long, Node | 33,095,680 | 33,095,680 | 33,161,216 | 36,831,232 | 38,010,880 | [OFF run 37402335241](https://github.com/Makeinu1/phase/actions/runs/37402335241), [ON run 37402889215](https://github.com/Makeinu1/phase/actions/runs/37402889215) |

40-long reaches turn 21 with 306 preparation actions. ON census verifies PRE equality for all 32 cycles; cycle 16 and 32 have the same observed linear size, and clearing the game leaves that size unchanged. The ON child completed in 39.6 seconds without a resource-guard stop. 80-short reaches turn 3 with 38 preparation actions and 160 objects; its census also validates all 32 restores. Deck size and preparation history can change together, so these observations are not a pure size-only causal estimate.

## Recorded PRE census

These are exact successful result fields read from each run's `undo-memory-boundary-evidence` artifact. Counts and bytes are the same in the OFF and ON pair for each profile.

| Node profile | cards per seat | minTurn / reachedTurn | traceLength | objectCount | battlefieldCount | stackCount | preUtf8Bytes | OFF / ON repetitions | ON census equality |
|---|---:|---|---:|---:|---:|---:|---:|---|---|
| 40 short | 40 | 1 / 3 | 38 | 80 | 2 | 0 | 259,624 | 1 / 32 | 32 cycles PASS |
| 80 short | 80 | 1 / 3 | 38 | 160 | 2 | 0 | 391,915 | 1 / 32 | 32 cycles PASS |
| 40 long | 40 | 20 / 21 | 306 | 80 | 2 | 0 | 256,526 | 1 / 32 | 32 cycles PASS |

OFF has `censusCycles: 0`, `samePreValidated: false`, `replay: []`; it does not claim restore validation. ON has `censusCycles: 32` and `samePreValidated: true`. In every ON case replay recording is true before cycle 1 and false afterward; before/after cycles 2, 4, 8, 16 and 32 it is false. These are recording-enabled booleans, not replay entry counts.

Both 40-long cases record preparation policy `legal-candidate-discard-required-cast-card-last-v2`, `neededCardsDiscarded: 0`, and action counts `{SetPriorityPassingMode: 2, MulliganDecision: 2, PassPriority: 282, PlayLand: 2, SelectCards: 17, TapLandForMana: 1}`. The short runs predate these fields; they are not retrospectively inferred. Long PRE JSON is smaller than short PRE JSON despite the longer preparation trace, so trace length alone does not describe serialized payload size.

`preUtf8Bytes` is the exported JSON string's UTF-8 byte length, not RAM consumption or retained snapshot bytes. Zone breakdown per seat (hand/library/graveyard), exile counts, journal counts, and replay entry count/bytes were not recorded. `traceLength` is the number of preparation actions and must not substitute for journal/history size.

The run evidence artifact `undo-memory-boundary-evidence` contains `census.reachedTurn`, `traceLength`, `objectCount`, `battlefieldCount`, `stackCount`, `preUtf8Bytes`, action counts, preparation policy, and replay-recording booleans. Recorded PRE bytes and structural counts are transcribed above; unrecorded zone and journal dimensions remain unmeasured. Census validates players, objects, battlefield, stack, waiting state, priority, phase, turn and RNG position. It does not assert equality of renewed interaction authority.

The first restore clears replay recording, so cycle 1 and subsequent cycles are labeled separately. Do not interpret their allocation behavior as identical.

## 160-card preparation boundary

The original [diagnostic run 37401762273](https://github.com/Makeinu1/phase/actions/runs/37401762273) timed out during legal PRE preparation after 120,082 ms (`ETIMEDOUT`, null status, `SIGTERM`), before Undo measurement. A legal discard policy that preserves required cast cards was then recorded as a comparison-condition change, with the deck, seed and budgets unchanged.

[Run 37402335241](https://github.com/Makeinu1/phase/actions/runs/37402335241) again timed out at 120,138 ms: last observation step 350, turn 24, BeginCombat; required-card hand count 0, library count 8, discard count 0. The discard policy did not explain the missing PRE. This profile is **fixed-input PRE preparation unavailable within 120 seconds; Undo memory unmeasured**, not a memory failure. No further retry or seed selection was performed.

## Measurement limits and capacity-gate handoff

Each Node case uses a fresh process; each Chrome case a fresh module Worker. Census uses a separate WASM instance and observation/export/JSON parsing stays outside the hot measurement interval. Node RSS and heap observations still include that case's census instance and are not incremental Undo-only costs. Chrome's Worker memory capability is recorded separately and unavailable measurements remain unmeasured.

`memory.buffer.byteLength` is allocated linear-memory size. Saved/restored samples record its observed high-water mark. Live heap, synchronous internal allocation peak, and bytes actually freed are unmeasured. Non-shrink after clear does not prove a leak; a plateau does not prove zero allocations or future safety. Only 32 finite repetitions were tested.

Candidate gate inputs are total state/object and zone counts, retained snapshot count, serialized PRE byte size, and variable payload sizes. To stay within a measured region, a gate would need to bound the recorded structure and payload dimensions together, with the same build/database/runtime assumptions. Forty or eighty deck cards alone are insufficient. The host stores one Option snapshot without a byte cap, while serialization can clone state, create a Value, and allocate sorting scratch; a String-length cap cannot bound the peak.

Unmeasured dimensions include larger or richer card/object payloads, counters/abilities, stack and pending-interaction payloads, longer histories/replay content, a full card database, and different builds or devices. Before selecting a fixed device budget, measure these dimensions and the relevant live/peak memory on the intended distribution and device. No safe MiB limit is established by this report.

The dedicated workflow now filters push changes to `scripts/ci/undo-memory-*.mjs` and `.github/workflows/undo-memory-measure.yml`. Docs-only changes do not request measurement; driver and workflow changes remain triggers. Introducing the filter itself is a workflow change and therefore matches once.
