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

Private assertions reuse the existing legal cast Fixture and shared host Undo regressions. Unit discovery remains intact; the existing bounded acceptance target delegates eleven named tests to the same private assertions through feature-gated, hidden assertion entry points, alongside nine shared behavioral tests and two registration guards. The default product build does not compile these test-support entry points. They cover inclusive structural boundaries, nested inner sums, arithmetic overflow, multibyte JSON, capture avoidance, serializer refusal/error with exactly one SpellCast, old receipt invalidation, and failed decode retaining the armed Case. Dedicated fork-only native Actions uses fixed nightly-2026-04-19, cranelift, opt0, debug0, jobs1, incremental disabled, existing nextest CI profile, relevant rustfmt check and parser Gate A. Each native build/test command has the reused 13 GiB working-set, 4 GiB disk-free, and 1500-second process-group guard. No WASM rebuild or new credentials are used. Local runtime validation is unavailable; committed-candidate CI and independent review remain required.


### Workflow context preflight

Before publishing workflow edits, parse the YAML and check expression roots against GitHub's [context availability table](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability). Top-level `env` permits `github`, `secrets`, `inputs`, and `vars`; job-level `env` additionally permits `needs`, `strategy`, and `matrix`, but neither permits `runner`. Runner-local paths are initialized in a step using quoted `$RUNNER_TEMP` and `$GITHUB_ENV`; `runner.temp` remains valid in artifact step `with`. Verify the context check rejects the previous top-level `runner.temp` definitions, verify the initialization shell with `bash -n`, and recheck branch/path triggers and read-only permissions. This preflight does not replace GitHub workflow admission or Rust test results.


### Native compilation resource stop

Run `37406168240` at candidate `50f1055ae6e55133e60fe556d37d648b596e3e67` selected `phase-engine --lib` through `cargo nextest run --locked --build-jobs 1 --profile ci`, with test opt-level 0, debug 0, incremental false and cranelift. The guard observed working set **13,978,275,840 bytes**, above the unchanged 13 GiB limit, and terminated the command with exit **-15** before tests ran: runtime verdict **NOT RUN**. Actual concurrent rustc count and baseline preflight readings were not received and are not inferred from jobs=1.

The next venue selects existing `--test host_precast_undo_acceptance` for phase-engine, unfiltered, retaining all 22 assertions instead of compiling the full unit-test population. The previously successful control `0d74cf0314bec06949cd03231cd7979091d03f95` used this bounded target. Engine-wasm continues to select its existing filtered `--lib` tests. Verbose Cargo evidence records selected targets/features/profile. This venue change does not predict memory use or establish a successful runtime result; the resource limits and test assertions are unchanged.


### First exact-head native verification receipt

The parent verified [run 37407473256](https://github.com/Makeinu1/phase/actions/runs/37407473256) through authorized GitHub read access at candidate **`f48a0d6ee0b143e4ec15b482249a70c932f7bde5`**: **SUCCESS**.

| Check | Observed result |
| --- | --- |
| Bounded phase-engine acceptance | 22 passed, 0 skipped: 20 Undo assertions and 2 registration guards |
| Engine-wasm native boundary | 10 passed; 53 outside-scope tests excluded by the existing filter |
| Fixed-toolchain formatting and parser Gate A | Passed |
| Resource guard stop | None |
| Sampled phase-engine working-set maximum | 10,158,006,272 bytes, below 13 GiB |
| Sampled engine-wasm working-set maximum | 11,991,519,232 bytes, below 13 GiB |

This receipt supports native behavior at that exact candidate head. The engine-wasm results are native boundary tests, not execution of compiled WASM: compiled-WASM and real-browser validation of this capacity candidate were **NOT RUN at the time of this native receipt**; the later WASM receipt below records their result. The sampled CI working set is not live Undo heap, a guaranteed instantaneous peak, or a target-device safety budget. The earlier e10955dc measurement artifact does not validate this new code. The prior resource-stop record remains applicable to its different full-lib venue.


### Recorded next-stage plan: fixed-source real WASM boundary validation

The independent producer will build candidate source **`f48a0d6ee0b143e4ec15b482249a70c932f7bde5`** once with nightly-2026-04-19, locked dependencies, LLVM opt0, LTO off, codegen-units 16 and the existing 16 MiB stack setting. Standard free Ubuntu jobs retain the 13 GiB working-set, 4 GiB free-disk and finite command/job guards. This stage creates a new artifact; it does not reuse the earlier e10955dc artifact.

Consumers will verify the new same-run manifest digest, source/tree, lock/input hashes, producer/control/run identities, fixed build settings and individual artifact file sizes/hashes. Artifact ID and GitHub artifact digest are recorded alongside the manifest SHA-256. Node and one standard Chrome module Worker will execute the same functional assertions: baseline cast **Armed → restore Consumed**, then a legally prepared **520-object PRE** whose cast continues exactly once while Undo becomes Invalidated without retaining a receipt. No state injection or browser security-flag bypass is used.

Real-WASM results were **NOT RUN when this plan was recorded**; the completed run is documented below. Initialization or legal PRE preparation failure is a preparation failure, not a successful capacity refusal. App UI, two-seat synchronization, mobile browsers and live-heap/reclamation measurements remain unperformed; this stage does not prove a safe heap budget.


### Completed real WASM verification and retained artifact

The parent confirmed [run 37409235450](https://github.com/Makeinu1/phase/actions/runs/37409235450) through authorized GitHub read access: **SUCCESS**, control/producer **`57a5af0b7d943f31c0c5f5675ae860dacc592084`**, fixed product source **`f48a0d6ee0b143e4ec15b482249a70c932f7bde5`**. Both Node and standard Chrome module Worker passed normal restore and the legally prepared 520-object overflow case: one cast, Invalidated Undo and no retained receipt. The guarded commands reported `source_unchanged=true`, exit 0 and no guard stop.

| Artifact identity | Verified value |
| --- | --- |
| Artifact ID | `11388721891` |
| ZIP SHA-256 | `3f102d3003003f7066ff7dea0c37e2503e3b1af3a58a738c2fc2e26bb17ddde8` |
| Manifest SHA-256 | `8a07d47b593e05ff7d68a331159da2679aea4d4e68e83ce7bdc17aa1c84c10db` |

The artifact uses seven-day retention: an October 6 creation corresponds to October 13, but the exact `expires_at` timestamp has not been provided and is unconfirmed. Reuse must retrieve the fixed run/artifact through authorized GitHub Actions read access and verify ZIP digest, manifest digest, source/control/run identities, build settings and every file hash. Expiry or any mismatch must fail closed; another artifact must not be silently substituted or mixed with this producer's inputs.

The current verifier pins the consuming run and run attempt to the same producer run. It cannot be used unchanged for cross-run reuse; that would require a consumer with explicit producer identity pins. No workflow change is made by this receipt.

These results validate the specified real-WASM boundaries for this candidate and build. App UI, two-seat synchronization, mobile browsers and live-heap/reclamation remain unverified. A safe heap budget is still **NOT PROVEN**.
