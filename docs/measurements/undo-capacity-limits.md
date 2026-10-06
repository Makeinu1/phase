# Experimental Undo operational capacity guard

Base engine: `e10955dc5977f1ba7c65cb1518cb8f4b1679fe92`. This separate candidate retains the existing experimental DEV/consent gates and single Case lifecycle. It does not modify the measurement branch or its evidence.

These are initial product operational limits, chosen to curb unlimited growth without narrowly restricting ordinary two-seat decks. They are **not experimentally proven heap safety values**, full-database budgets, or target-device budgets.

| Category | Inclusive maximum | Counted structure |
| --- | ---: | --- |
| Objects | 512 | `objects.len()` |
| Zone items | 2048 | Every player's hand/library/graveyard plus battlefield/stack/exile/command |
| Deck pool items | 2048 | All thirteen registered/current vectors, summed across pools; entry count, not DeckEntry card quantities |
| History/LKI items | 4096 | Both per-player spell histories, zone changes, player actions, LKI cache/copiable values; inner entries of incarnation/departed-spell maps and linked-exile vectors |
| Rules journal items | 4096 | entries/nodes/produced_mana/spent_mana combined |
| Retained checkpoint JSON | 1,048,576 UTF-8 bytes | Serialized trusted envelope String byte length |

All structural sums use checked addition and reject overflow. Before a new eligible cast, an old Case is invalidated. Structural refusal happens before clone/capture; the normal authenticated reducer still runs once. After serialization, oversized JSON is dropped before receipt allocation or Case retention. This post-serialization limit does not prevent temporary allocation by clone, serde Value construction, sorting scratch, or the output String. Pending ordinary manual-payment continuation and restore-failure retention follow existing semantics.

This is not a comprehensive bound: arbitrary strings, ability payloads, other containers, outer empty nested-map buckets, and per-item allocation sizes are uncounted. Count bounds do not establish a heap maximum. JSON bytes are retained representation size, not RAM or allocator peak. No card-name, 80-card, or two-land restriction is added.

## Validation

Private unit tests reuse the existing legal cast Fixture and shared host Undo regressions. They cover inclusive structural boundaries, nested inner sums, arithmetic overflow, multibyte JSON, capture avoidance, serializer refusal/error with exactly one SpellCast, old receipt invalidation, and failed decode retaining the armed Case. Dedicated fork-only native Actions uses fixed nightly-2026-04-19, cranelift, opt0, debug0, jobs1, incremental disabled, existing nextest CI profile, relevant rustfmt check and parser Gate A. Each native build/test command has the reused 13 GiB working-set, 4 GiB disk-free, and 1500-second process-group guard. No WASM rebuild or new credentials are used. Local runtime validation is unavailable; committed-candidate CI and independent review remain required.


### Workflow context preflight

Before publishing workflow edits, parse the YAML and check expression roots against GitHub's [context availability table](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability). Top-level `env` permits `github`, `secrets`, `inputs`, and `vars`; job-level `env` additionally permits `needs`, `strategy`, and `matrix`, but neither permits `runner`. Runner-local paths are initialized in a step using quoted `$RUNNER_TEMP` and `$GITHUB_ENV`; `runner.temp` remains valid in artifact step `with`. Verify the context check rejects the previous top-level `runner.temp` definitions, verify the initialization shell with `bash -n`, and recheck branch/path triggers and read-only permissions. This preflight does not replace GitHub workflow admission or Rust test results.
