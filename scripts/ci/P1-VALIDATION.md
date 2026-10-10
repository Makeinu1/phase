# P1 validation handoff

This branch changes validation only. Product Rust and client logic remain owned
by the integration writer. No P1 product build or UI PASS is implied by the
preparation preflight. R0 is `3dae2913f0ccc40e5ea392648e7ff18c6c4bd27a`, C′ is
`ca0055c7c7136fe312db3a9dd8bef934fc88b7c7`, and V0 is
`02932352ed7e792b2482c7495b9612d7d9ce79c3`.

## Execution

Use separate clean product and validation checkouts, and an evidence directory
outside both. Activate the existing toolchain, then add the local bindgen:

```bash
source /workspace/.phase-tools/activate.sh
export PATH=/workspace/p1-tools/bin:$PATH
python3 /workspace/p1-validation/scripts/ci/p1-wasm-validation.py preflight \
  --source /workspace/p1-preflight-source \
  --candidate-sha ca0055c7c7136fe312db3a9dd8bef934fc88b7c7 \
  --evidence /workspace/p1-validation-evidence/committed-preflight
```

After receiving the final reviewed product SHA, create its detached checkout.
Run `build` once with that SHA and a **fresh** evidence directory. It performs
the source/resource preflight, one enabled WASM build, and bindgen. There is no
old artifact fallback. Preserve `target` until the run is finished; never delete
another environment or target. A recorded command may not be retried in place.
The unmodified V0 guard still requires its exact lock/toolchain pins, 13GiB
memory capacity, and 4GiB free in workspace and temp. Changed pins are a blocker
to review, not an invitation to silently bypass admission.

Then run `install-runtime` with the same arguments. This verifies the producer
manifest, all WASM/glue/snippet hashes, and the consumer SHA before installing
only ignored generated artifacts. Consumer replay does not rebuild Rust.

The fork workflow's push mode currently replays the same pinned product from
one completed, verified producer artifact through the normal Actions API.
Its `P1_PUSH_CANDIDATE_SHA` and `P1_PUSH_MODE` literals can be changed to the final
reviewed SHA and `build` for a single CI build. This push path works for a newly
added workflow without putting it on the default branch. Dispatch is an optional
path when GitHub exposes that workflow; do not assume it does. Existing V0 jobs
and permissions are unchanged.

## Minimal fixture I/O still required

The parent and product writer supply:

1. The reviewed product SHA and the existing canonical fixture entrance that
   reaches `/game/:id`, including fixture id/query and any prerequisite input.
   The writer's received direction is: start a normal Local game, checked-restore
   a trusted checkpoint produced by the existing GameScenario, then drive the
   real game through authenticated Local continuation using the existing
   `submit_interaction_js`. Concrete envelope I/O and family/variant names await
   the D1 boundary review. This is a direction, not a fixed API schema. The
   browser wrapper takes the existing application entrance; the finite scenario
   performs those real setup steps once their contract is available. Do not
   invent a seeding API or use the Stage1 HTML page.
2. Existing user-visible controls/selectors and the real action sequence for
   prepayment, same source, life 20→19→18, Finish/child, and the next paid play to
   21. Validation authors the finite scenario only after that contract arrives.
3. The existing read-only way to observe the fixture's public state. The capture
   helper takes a reviewed read-only JS script; it defines no product API.
   Keep source/occurrence, life, waiting/child/closed state and original-request
   outcomes needed by the fixed acceptance cases. Never emit actor capabilities,
   session IDs, tokens, hidden player data, or private authorization wire fields.
4. Real restore inputs at K0–K3 (K4 auxiliary) and the existing ACK fault controls
   for life and Finish: applied/rejected/unknown/inflight. A mock result is not a
   substitute for authenticated product execution.

The fixed contract lives in the P1 plan and test Pages; these input requirements
do not change its assertions or adopt a speculative schema.

## Browser evidence

After runtime installation, install the consumer's frozen pnpm dependencies
using the same V0 guard and retain its original log/receipt. Supply a reviewed
fixture-specific Python scenario under this validation checkout's `scripts`.
Then use the local tools (no system package or security setting was changed):

```bash
export BOOTSTRAP_CHROMEDRIVER=/workspace/p1-tools/chromium154/usr/bin/chromedriver
export P1_CHROME_BINARY=/workspace/p1-tools/chromium154/usr/lib/chromium/chromium
```

Run `p1-product-browser.py --source PRODUCT --evidence EVIDENCE
--entry-route ACTUAL_APPLICATION_ENTRANCE --scenario ACTUAL_VALIDATION_SCENARIO`.
It starts Vite on 127.0.0.1:5173 and ChromeDriver on 9515, creates a new isolated
browser session after installation, navigates the application entrance, and invokes
that finite scenario. The session ID stays in the child environment, never in
saved logs. A boot receipt binds source, manifest, Vite process and session hash;
the original scenario log and exit are saved even on failure. This is a local
consumer path. The workflow connects the bounded smoke described below; the
full acceptance scenario still requires its fixture contract and reviewed runner.

At each expected state, the scenario calls `p1-product-capture.py --evidence
EVIDENCE --step NAME --state-script READ_ONLY_SCRIPT`. Allowed steps are
`prepayment`, `same-source`, `life19`, `life18`, `finish`, `child`, `paidplay21`,
`restore-k0`–`restore-k4`, and `ack-life-*` / `ack-finish-*` with the four variants
above. It verifies source/installed runtime before and after capture, verifies
fresh-session/Vite provenance and served WASM identity, records served transformed
glue separately (as V0 does), and saves PNG + state JSON hashes in `step-index.json`.
Failure class and exit are saved separately; raw W3C transport stays unrecorded,
following V0's privacy boundary.

Snapshots are observations, not acceptance assertions. The reviewed finite
scenario must compare the actual states with the fixed contract and return a
nonzero exit on failure. The browser tools' synthetic navigation preflight is
also not a P1 UI test. No scenario exists yet because its actual fixture input
has not been received.

## Same-job bounded UI smoke

The build workflow now invokes `p1-ci-ui-smoke.py` after a successful producer
build, using the same product checkout and runner-temp evidence directory.
It generates the existing 145 native trusted fixtures through the focused
`manual_resolution_prototype` test target, checks `1c.K1`, installs the verified
runtime, installs frozen client dependencies, and obtains the exact matching
Chrome for Testing / ChromeDriver 154.0.8037.92 from official vendor metadata.
All expensive stages retain the unchanged source/resource/process guard.

The producer also builds real `draft-wasm` from the same pinned source. GamePage
reaches draft-adapter in its module graph; Vite resolves its literal dynamic
import even when a Local game does not invoke a draft action. Engine build flags
remain unchanged. The separate draft build enables the already-built
`phase-ai/manual_resolution_prototype` dependency feature, shares the guarded
target directory, and records its command, raw binary and bindgen hashes.

The installer verifies every generated artifact against the producer manifest,
but copies only executable JS/WASM (including generated snippets) into the
consumer. Generated `.d.ts` declarations stay in producer evidence, preserving
the product's tracked declarations byte for byte. `consumer-install.json` records
the exact executable subset; browser boot and each capture require that complete
subset and its hashes. Source cleanliness and SHA/tree checks remain mandatory.

`p1-ui-smoke.py` uses the existing product entrance
`/game/p1-ci-smoke?mode=local&manual=1&p1Fixture=1c.K1`. It reads only public store
fields, clicks the real player-area selection, Apply and Finish controls, and
asserts Manual Open at life 20, same-source life 19, and release of the exact
resolving entry at Finish with life still 19 and Priority restored. Begin already
popped that occurrence: `1c.K1` has zero ordinary stack entries and holds it in
`resolving_stack_entry`. Finish keeps the ordinary stack count unchanged. Both
the live predicate and saved-image verifier check its public ID, closed phase,
cleared resolving entry and retained source. Empty/nonempty ordinary stacks and
unfinished states have offline RED/GREEN regressions in `test_p1_finish_evidence.py`.
The existing capture helper saves the three
PNG/public-state pairs and their source/runtime/time/hash provenance.

This independently specified smoke does not replace the unavailable migrated
full scenario and does not accept Undo, next paid play, ACK faults or S1-S12.
Fixtures/checkpoints, actor capabilities, private receipt wires, session IDs,
browser profiles and raw browser transport are excluded from upload paths.
The artifact contains safe smoke reports and observation PNG/JSON. Its GitHub
download page is a user retrieval path; actual delivery into chat must be
verified separately, and artifact creation alone is not delivery completion.

On browser/scenario failure, `browser-failure.json` records the fresh browser's
visible DOM text, public observer state, selected resource path/status metadata,
console error categories and diagnostic PNG hash before session cleanup. Console
messages and request bodies are not persisted. `diagnostic-failure.png` is a
labelled failure observation, never an acceptance snapshot or step-index entry.
The diagnostic retains source/runtime verification and does not extend timeouts.

### Producer reuse and native-click diagnosis

The next push uses the exact completed producer run 37956261306 / artifact
11630543757 for unchanged product `6f707b2b0e90cf69d05e57e4fd286a0fb73cecc0`
through the normal GitHub Actions REST download endpoint and the
existing contents-read GITHUB_TOKEN. No permissions are added. A single denied
download stops the run without compiling a replacement. ZIP digest/size,
producer run/head, manifest source/tree, toolchain, input hashes, unchanged
producer script/guard, both build configurations and every runtime byte are
checked before installing the runtime in a fresh immutable consumer. Only
manifest/runtime files are imported; earlier screenshots and consumer receipts
are not carried into the new consumer evidence.

The real player-area click remains a native WebDriver click. The safe smoke
report now retains its public hit-test geometry and selected W3C HTTP error
code and fixed message classification, omitting raw messages, response bodies,
stack traces and session identifiers.
An intercepted click is not replaced with JavaScript or store mutation.
# Bounded next ordinary paid play (2026-10-09)

The current validation retains the independently checked `1c.K1` life20 →
life19 → Finish closed/Priority smoke, then continues using the own-hand
`Next Ordinary Play` through its existing native card **double-click** (the
same `playCard` handler used by **Cast normally**), an actual **Pay** control when
offered, and actual own-priority **Resolve** controls. It requires remaining
mana1 → 0, a paid ordinary stack entry before resolution, life19 + 3 = 22,
the next card in graveyard, an empty stack and no open manual carrier. Four
screenshots/public-state receipts including `paidplay22` are mandatory and
checked against the current consumer execution. In the pre-driver validation
through run37976165163, opponent priority was observed
without submitting an action on its behalf; completion remains observable
while waiting for a visible own control. A blocked opponent turn is retained
as a failed diagnostic, not bypassed with store edits or forced clicks.

That pre-driver continuation did **not** establish S1's life18 → paidplay21,
before-payment manual designation, checked save/restore, Undo, or full S1–S12
acceptance. The existing pinned same-product producer37956261306 runtime is
reused through the ordinary Actions API; no product or build-input changes.

Run37969255038 confirmed that the inline Resolution options button is covered
by the own life19 HUD at the native click point (559, 640). That options/manual
entry obstruction remains an unresolved UI issue. The ordinary double-click
checks its exact native pointer origin before dispatch and does not bypass an
obstructed target. This desktop route does not establish iOS or whole-UI quality.

### Native input diagnosis after run37974221677
The next validation keeps the exact same input path, timings, product and
runtime. Passive capture listeners retain at most40 real pointerdown/up,
click/dblclick and capture-change events: trusted flag, detail, native point,
local DOM identity, own requested card ID and public state before handlers.
Listeners are removed after the command; no event is dispatched or prevented,
no product handler is invoked, and no store or engine state is changed. The
immediate after-command public state records own next-card legal action types
and source object IDs, existing ordinary-choice result, local authorization
and debug mode. A missing trusted dblclick fails immediately in the normal
input stage; payment waits are unchanged. A DOM dblclick alone is not proof of
React handler entry or engine dispatch. If the event is delivered but the
public guards do not explain the non-transition, actual handler/dispatch
observation is still required; no success is inferred from static source.

### Bounded live K1 restore and explicit fixture opponent participant
The current bounded validation exports the live K1 trusted persistence through
`exportPersistenceState` and restores that same in-memory checkpoint through
`localContinuation().restore`. No raw checkpoint/context is written to evidence.
It requires preserved public source/carrier/Begin/wait/life and changed opaque
session plus epoch/generation increments, then performs real Apply and Finish
with current UI. This is live K1 checked restore evidence; old-generation
rejection, K0/K2/K3, legacy input, and full S8 remain outside this bounded run.
The existing local fixture has no opponent-seat UI. For one actual pending
Priority1/stack1/mana0/life19 state only, a clearly recorded fixture opponent
driver submits one ordinary `dispatchAction({type: 'PassPriority'}, 1)`. It uses
the existing adapter/Worker/native/snapshot pipeline. It does not directly
change state, invoke playCard, use Resolve All, emulate an ACK, or claim an
opponent UI click or two-client/S9 acceptance. Any remaining own pass is a
native UI click. The final four captures require genuine life22/graveyard/stack0
and no manual carrier; driver assistance must remain visible in evidence.

Run37978983564 passed this bounded case. An independent formal reader verified
ZIP/internal source hashes, all four PNG/state/index hashes and personally
viewed all images. All four context checks passed; one fixture opponent
PassPriority produced life22/mana0/graveyardtrue/stack0. K1-only checked restore
and this driver-assisted continuation are accepted; full S8 remains unaccepted.
Both generated reports share `BOUNDED_K1_SCOPE`; the operation validator rejects
a missing or inconsistent scope. Earlier artifact bytes and historical results
are retained unchanged. This wording-only follow-up requires lightweight
validation, not another WASM/UI CI run.


### Current finite prepayment UI slice

The reviewed current CI entry is initial fixture `1a.B` on the normal Local
`/game/:id` route. The fixture supplies the starting board only. Real native
browser inputs select S, open resolution options, choose Manual before payment,
pay through ordinary payment, and issue A's priority response. Each B response
uses the existing, explicit single-command fixture participant driver. This is
assistance, not opponent UI or two-client/D acceptance.

Five mandatory captures show the prepayment options disclosure, Begin at life20,
Apply2 at life18, Finish at life18 with S in graveyard/carrier released, and N's
paid ordinary resolution at life21. Initial mana2, S paid mana1, N paid mana0;
public source/occurrence, bounded engine events, and completed Local receipt
delivery are cross-checked. Missing captures fail acceptance. No forced clicks,
DOM changes, seat switch, or unannounced pass is used.

This finite positive S1-1a/S12c path does not accept all S1–S12. Auto/N controls,
wrong actor/stale refusal, the mandatory 1c two-Apply receipt-relookup path,
Undo/Recovery, D/two-client, and the other finite groups remain separate gates.
Historical K1 checked-restore validation and its artifacts remain available.
The changed product SHA requires a fresh guarded runtime build; an old runtime
must never be relabelled as this candidate.


The fresh afe3 producer run37997514707 built its guarded runtime successfully,
but the UI consumer failed at N payment: two trusted detail1 clicks were
observed, with no dblclick. Manual Begin20/Apply2/Finish18 passed; this run does
not prove the final paidplay21 capture. The next validation uses that exact
producer runtime through the existing normal Actions reuse verifier; all hash,
source and provenance guards remain unchanged. No rebuild fallback is allowed.

The native ordinary-card double-click is one WebDriver actions request without
an explicit inter-click pause. Command completion requires the passive browser
witness of trusted click detail1, click detail2 and dblclick detail2 in order on
the requested card, with no dropped events. Missing witness fails with
`native-double-click-not-observed`; observed timing is diagnostic only and has
no guessed success threshold. No JS event dispatch or automatic retry is used.


Run38001962170 completed the real20→18→21 scenario with all five PNG/state/index
pairs and a trusted card2 dblclick (reader-observed422.8ms). Overall CI correctly
failed `s1-1a-native-clicks-missing`: actual completed operations were only
manual-card-select, manual-options, manual-cast, player-area-select, life18,
finish, paidplay-normal-direct. Both required own priority response clicks were
absent; automatic own passing is not evidence of native own response.

The next journey turns the existing Full Control UI ON with a native click and
confirms its pressed state before designation/payment. Each own priority0 is
mandatory before native Resolve; only after priority1 may the explicit one-shot
B fixture driver run. The validator retains both native response requirements
and additionally requires the Full Control click and confirmed state. Product
and guarded runtime remain afe3 unchanged. Historical failed reports remain
failed; no auto-pass is relabelled as native input.


Run38003286935 stopped at prepayment-full-control before any click_commands;
Manual and subsequent stages were not run. Source and the offline reproduction show the unscoped Full Control locator
selects a hidden mobile-left instance before the visible right rail at the
fixed1440×1000 viewport. The two-control offline reproduction is RED on1e5.
Both native OFF click and passive ON confirmation are now scoped to the
existing data-mobile-action-right container. No timeout is increased.

Acquisition failure reports the specific operation, acquisition phase, locator,
first-match-visible-and-enabled condition, last match count/first visibility,
and passive public state. Native click failure retains its original error;
performed ON confirmation records its result separately. Fixed failure reasons
survive browser aggregation. Missing responses/Full Control remain failures.


## Finite 1c continuation on unchanged afe3

Run38004364808 succeeded on b4 with exact guarded producer37997514707 runtime.
Parent independently verified the exact artifact and visually checked all five
PNGs and accepted finite S1-1a plus S12c only. Full P1 remains unaccepted.

The next consumer uses 1c.B before designation/payment on the same afe3 and
same guarded runtime. Two separate native UI Apply1 operations produce
20→19→18 on the same source/occurrence. A subscriber privately retains the
actual completed first original. One native read-only lookup (actor0) must
return that exact completed original/result (old LifeChanged19, no rejection),
with appliedResult null and resident current18/open/same source. Then a public
port reconciles the exact original command binding through its terminal cache.
UI before/after remains18, and publication/completed/applied counts cannot grow.
The native lookup and client cache reconciliation are separate evidence;
this does not exercise publishing an old native reply through the adapter.
No submission is repeated, no adapter-private maps are altered, no control
state is seeded after the initial fixture. Finally removes the subscription
and private original data on success or failure. Cleanup failure propagates.

Normal Finish and next paid play continue to21 through real own Resolve clicks
and two explicitly labelled B fixture passes. Seven exact PNG/state/index
receipts are required: prepayment, same-source20, life19, life18,
historical-lookup18, Finish18, paidplay21. Wrong actor/stale controls, Auto S,
standalone N and remaining S1–S12 groups are still separate outstanding work.


## Ordinary Auto S and standalone N controls on unchanged afe3

Two new browser sessions each use initial1a.B before designation/payment.
The existing trusted native double-click plays S or N normally. FullControl
right toggle is confirmed before cast; cost1 gives mana1/life20/stack1,
mandatory ownnativeResolve precedes one explicitfixtureBpass. Auto S gives
life18/Sgraveyard/Nhand. Standalone N gives23/Ngraveyard/Shand. Both have
stack0/mana1/no Manual view/carrier and exactly one ordinary life event.
Each requires initial+completed exactPNG/state/index provenance and hashes.
Case outputs live separately under controls/auto-s and controls/auto-n;
no first-case report or screenshots are overwritten by the second case.
Productafe3 and strict guarded producer379975 reuse stay unchanged.

Correction of prior1c scope: 11 operations refers to browser input count.
The evidence is limited to completed qL1 read plus clientterminalcache
comparison; full1c is PARTIAL. Same qL1/qL2 redelivery, lookup before/after
qL2 completion, qL2 pending/notApplied, oldbinding-newattempt atomicrefusal,
and old19 result projection notoverwriting18 remain separate unproved gates.
No read-only lookup is relabelled as redelivery or adapterhistoricalpublish.

## Same-original terminal queries and atomic refusals on afe3

A fresh manual-originals browser case reuses the actual prepayment1c UI journey
and the same reviewed product/runtime. At actual life19, the first completed
Apply1 original is registered, applied and looked up once each. At actual18,
both completed Apply1 originals receive those same three queries. Each must
return its historical result (19 or18), appliedResult null and one LoseLife
EffectResolved, while the current UI, full native GameState and replay stay
unchanged. These are native terminal queries; they do not publish an old reply
through the adapter. No missing pending interval is inferred from transport.

At19, two register-only refusals use fresh attempt IDs: actor1 with a valid
current opportunity must fail admission, and actor0 with the first completed
Apply's old submission binding must return raw notApplied with
invalid_interaction_response. UI, native GameState, replay and publication
counts must stay unchanged. The ledger is not claimed unchanged. The next
real UI Apply1 must still succeed to18, followed by Finish and normal N21.
Final native replay must contain exactly two ApplyManualLifeLoss actions and
one FinishManualResolution. Seven strict PNG/state/index receipts remain
required. The new native phases retain their own primary failure stages.

This finite case does not accept full1c, qL2 precommit custody, historical
adapter publication, refusal UI, or whole P1. Current source gaps are the
adapter's register-pending reply going directly to apply without publication,
and terminal client reconciliation returning its cached result before an
adapter lookup. Those require independent product review and matching runtime
before their acceptance gates can be closed.

## Checkpoint replay gate and finite ordinary V control

run38011597200 stopped after the first actual Apply1/life19 at
native-original-checks. The checkpoint entry intentionally installs no replay
recording (native checkpoint initializer removes the ordinary shuffled header).
The new probe's initial exportReplayLog therefore cannot work on 1c.B, and its
callback erased the exception to null. Two independent source reviews confirmed
this API/entrance mismatch. Original queries/refusals/Finish were not reached;
no original or refusal acceptance is inferred. Replay hash and L2/F1 predicates
remain unchanged and unaccepted. Do not retry that case on the same entrance,
invent a recording/header, or use a different board as its replay.

The next independent case is auto-v, existing native fixture11c.V.B before
payment, on unchanged afe3 and reviewed runtime379975. It uses existing trusted
hand double-click, real own Resolve, and one labelled fixture B PassPriority.
Strict boundaries require life20, mana2-to1, one stack entry before response,
V cost1/2-2/empty abilities, exact V identity and own Battlefield membership,
one SpellCast and one Stack-to-Battlefield event, zero V EffectResolved,
no Manual source/entry/carrier. Two exact current PNG/state/index receipts and
case-specific guard output are required. Ordinary ETB zone1 is a real zone
change, not a triggered ability. Accepted S/N evidence need not be rerun.
V-only success does not close full11c/wholeP1 or the replay-gated1c remainder.

Native original diagnostic preparation now keeps the failing substep, qL1/qL2
query kind, completed-check sequence, exception name, and a known safe message.
Unknown messages are withheld so raw original/context data cannot be emitted.
The strict predicates and failure remain unchanged. This diagnostic addition
is not a same-entrance rerun or evidence that the old null had a specific runtime
exception. The new CI case remains V only.


### Local recorded-start preparation (finite, unpublished)

The recorded-prep case is separate from legacy checkpoint and S1 controls. Its input comes only from the successful native8 host run on product74fd4e195ab3a60223e74932c79ec0ab9ba6c913, with three write-once files emitted after all assertions. The actual four-card database is separate from the145-checkpoint database. No replay header, resident, receipt or context is injected. The emitter's null playerCount means native default2; provider uses explicit2, not literally identical initializer fields. Check Limited format, actor0 and firstPlayer0 against the emitted full initializer input.

Use a matching fresh guarded runtime/consumer and the recorded fixture1c.recorded.B. Run the existing product-browser with p1-ui-smoke.py and P1_UI_CASE=recorded-prep. Own Keep, ordinary own priority advance, native own Hand land double-click and Battlefield land single-click must produce life20/mana2, PreCombatMain/active0/priority0/stack0. Explicit B Keep/Pass is labelled a fixture participant driver, not opponent UI. Keep the three chosen own-hand IDs stable because each name has several copies. Stop unexpected waiting and at20 operations. Save3 exact images recorded-initial/main/ready with hash/state/provenance, actual hasReplayRecording true and replay SHA/action count only. Never publicly save replay/context/receipt/input blobs.

validate_recorded_prep plus validate_required_images(recorded_prep=True) must pass after the real browser exit0. Offline unit fixtures test rejection behavior only. This case is recorded-start preparation, not full1c, engine in-flight, two-client or S1–S12 acceptance. Full qL2 custody and adapter historical19/current18 remain separate required work.
