# Phase boundary audit reconciliation

Reconciliation v1.1 — 2026-09-30 23:42 UTC

## Purpose and limits

This is a compact index for the retained findings from the older broad audit, reconciled against the Phase Issues below. The audit reference tree is `phase-rs/phase` main snapshot `527ffc8c2e3dd87c87bbabe4459c3a147d7f5b6b`; live Issue/PR state and exact candidate evidence take precedence over this dated snapshot.

[Makeinu1/MTG_OneDeck#101](https://github.com/Makeinu1/MTG_OneDeck/issues/101) retires the independent Boundary project while preserving concrete findings, reproductions, tests, investigation SHAs, product requirements, and seven review questions. This document is an index and triage aid, not a renewed framework or a claim that all findings reproduce today. Do not start another broad audit from it.

Classify evidence separately:

- **Requirements gap:** the product behavior or failure policy is missing or ambiguous.
- **Implementation violation:** source or a discriminating reproduction shows behavior contrary to an existing requirement.
- **Unproven:** historical evidence or a source hypothesis lacks a fresh production-path witness, failure injection, or current-head confirmation.

The seven reusable review questions are: **Authority** (who owns/permits the action?), **Identity** (which object/session generation?), **Commit** (when is the outcome authoritative?), **Invalidation** (what becomes stale?), **Persistence** (what survives restart?), **Publication** (what is exposed, to whom?), and **Receipt/Reconciliation** (how do uncertain outcomes converge and cleanup finish?). Use only where relevant; these questions do not require a Boundary framework.

## Provisional finding groups

These four groups are navigation aids, not permanent lanes. The F-numbers preserve the earlier audit mapping; the linked Phase Issue is the working record.

| Group | Findings and evidence classification |
|---|---|
| Participant departure | **Issue18 / F002** [#9303](https://github.com/phase-rs/phase/issues/9303) and **F003** [#9304](https://github.com/phase-rs/phase/issues/9304) are `PARKED_OWNER_LED / NO_CONTRIBUTOR_IMPLEMENTATION`. The bounded #9303 handoff [records](https://github.com/phase-rs/phase/issues/9303#issuecomment-5921631936) a focused production resolver + real `Concede(P1)` witness on pinned main `527ffc8`: two no-departure controls passed and one departure case failed, reaching `Priority(P2)` without exposing the pending choice. Later actor/subject/queue assertions were unreached. This was not a full spell-cast test; no production fix was made and the test remains frozen/unpublished. The note cites CR 800.4g/h and identifies actor-versus-choice-subject representation as an owner question; it does not settle broader rules semantics. #9304 remains in the parked owner-led lane; its voter behavior was not tested by this witness. A shared elimination seam remains a hypothesis, not a proven common fix. [#4823](https://github.com/phase-rs/phase/issues/4823) remains a separate historical source-backed report, not freshly reproduced. **F004** [#9306](https://github.com/phase-rs/phase/issues/9306) remains separately tracked; no implementation status is inferred here. |
| Suspension and result ownership | **F001** [#8910](https://github.com/phase-rs/phase/issues/8910) — forwarded zone-choice result across re-pause; Issue records a concrete Clone repro and probe on PR #8899, but this reconciliation did not rerun it. **F006** [#8766](https://github.com/phase-rs/phase/issues/8766) — user-reported panic clearing a buried ability continuation; not freshly reproduced. **F007** [#9309](https://github.com/phase-rs/phase/issues/9309) — swallowed `EffectError`; current-source claim, no new runtime witness. **F008** [#9310](https://github.com/phase-rs/phase/issues/9310) — restore may admit ownerless `Dispatching` state; distinguish this persistence-boundary claim from the historical runtime producer fixed by #7485. |
| Stale identity and invalidation | **F005** [#9307](https://github.com/phase-rs/phase/issues/9307) — ChooseFromZone candidate incarnation/provenance after owner departure; source-backed Issue report, not freshly reproduced. **F009** [#8660](https://github.com/phase-rs/phase/issues/8660) — reaper delist/session-removal authority and missing test at the reaper call site. The current call-site coverage claim is distinct from the older same-code race, which this report does not establish. |
| Commit and persistence agreement | **F010** [#9311](https://github.com/phase-rs/phase/issues/9311) — definite non-commit slice landed in [#9357](https://github.com/phase-rs/phase/pull/9357); unknown-after-send reconciliation remains on open [#9409](https://github.com/phase-rs/phase/pull/9409). Rechecked at 23:42 UTC: #9409 remained open at `b3ab5efc03537552facdf7964db97dd115071d04`; hosted CI run `36751038461` attempt 2 passed, including the retried 9,055-test Rust partition. Latest maintainer review reports the merge queue removed the candidate for a protocol conflict after #9438, and assigns the port/integration to maintainers. Do not describe this as CI-pending or author code failure; the next gate is maintainer integration and resulting-head verification. Issue #9311 is closed, but that does not mean open PR #9409 has merged. **F011** [#9312](https://github.com/phase-rs/phase/issues/9312) — ranking can persist before the durable terminal artifact; the reported ordering remains, but crash injection was not run. |

## Reconciliation notes

- Earlier composite-payment finding F01 is addressed by [#9263](https://github.com/phase-rs/phase/pull/9263). Keep its bounded transaction scope; do not reopen it through this index without new evidence.
- [#9388](https://github.com/phase-rs/phase/pull/9388) merged only its draw-continuation/result-ownership scope. Its merge does not close or validate unrelated findings above.
- At the check time, all listed Phase Issues were open except #9311. #9357 and #9263 are merged; #9409 remains an open PR. Verify live status before relying on this snapshot.
- The old reports for the other findings were not freshly reproduced here. “Source-supported” is not a substitute for a discriminating runtime test, and an open Issue is not proof that its original condition still exists on current main.

## Next step

The bounded discovery handoff is recorded in [upstream #9303](https://github.com/phase-rs/phase/issues/9303#issuecomment-5921631936) and [Fork Issue #18](https://github.com/Makeinu1/phase/issues/18). Keep Issue18/#9303/#9304 `PARKED_OWNER_LED / NO_CONTRIBUTOR_IMPLEMENTATION` until the owner settles the relevant scope; do not assign a contributor implementation from this witness. Keep #9312's crash/persistence question separate. #9409 remains its independent approved recovery/integration lane and is not cancelled by this parked choice-departure work.
