// Public behavioral cases run in both this unit venue and the bounded native
// integration target. Keep private carrier/counter/POST inspections here.
use super::*;
use crate as engine_under_test;
use crate::game::scenario::P0;
use crate::types::game_state::CastPaymentMode;

#[path = "../../tests/support/host_precast_undo_cases.rs"]
mod cases;

use cases::{witness, Fixture, BINDING};

#[test]
fn synthetic_activation_metadata_is_not_ordinary_payment() {
    let mut f = Fixture::new();
    f.cast(CastPaymentMode::Manual);
    // Carrier discrimination unit: this is synthetic activation metadata,
    // not a claim to have executed a real activated-ability payment flow.
    f.state
        .pending_cast
        .as_mut()
        .unwrap()
        .activation_ability_index = Some(0);
    assert!(!ordinary_payment(&f.state, f.undo.case.as_ref().unwrap()));
}

#[test]
fn rejected_correct_cast_captures_private_pre_counter() {
    let mut f = Fixture::with_payment_setup(None, crate::game::scenario::P1);
    let card_id = f.state.objects[&f.bears].card_id;
    assert!(eligible_pre(&f.state, P0, f.bears, card_id));
    assert!(
        f.undo
            .submit_action(
                &mut f.state,
                BINDING,
                P0,
                GameAction::CastSpell {
                    object_id: f.bears,
                    card_id,
                    targets: vec![],
                    payment_mode: CastPaymentMode::Auto,
                }
            )
            .is_err(),
        "ordinary cast really refused for insufficient payment"
    );
    assert_eq!(
        f.undo.next_receipt, 1,
        "PRE was captured before reducer refusal"
    );
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    assert!(f.undo.receipt().is_none());
}

#[test]
fn installed_delayed_watcher_is_ineligible_pre() {
    let mut f = Fixture::new();
    f.install_delayed_mana_watcher();
    assert!(!eligible_pre(
        &f.state,
        P0,
        f.bears,
        f.state.objects[&f.bears].card_id,
    ));
}

#[test]
fn synthetic_private_post_overflow_refuses_before_decoder() {
    let mut f = Fixture::new();
    let receipt = f.arm();
    // Synthetic exhaustion fixture; neither the live nor receipt revision is
    // serialized. The operation must refuse before invoking its decoder.
    f.state.state_revision = u64::MAX;
    f.undo
        .case
        .as_mut()
        .unwrap()
        .post
        .as_mut()
        .unwrap()
        .revision = u64::MAX;
    let overflow = witness(&f.state);
    assert!(f
        .undo
        .compare_restore(&mut f.state, BINDING, receipt, |_| panic!(
            "decoder must not run"
        ))
        .is_err());
    assert_eq!(witness(&f.state), overflow);
}

fn cast_action(f: &Fixture) -> GameAction {
    GameAction::CastSpell {
        object_id: f.bears,
        card_id: f.state.objects[&f.bears].card_id,
        targets: vec![],
        payment_mode: CastPaymentMode::Auto,
    }
}

#[test]
fn capacity_checked_sum_overflow_fails_closed() {
    assert_eq!(checked_item_sum([usize::MAX, 1]), None);
    assert_eq!(checked_item_sum([usize::MAX - 1, 1]), Some(usize::MAX));
}

#[test]
fn capacity_each_structural_category_has_inclusive_boundary() {
    use crate::game::deck_loading::DeckEntry;
    use crate::types::game_state::PlayerDeckPool;
    let mut f = Fixture::new();
    f.arm();
    f.state.lki_cache.clear();
    f.state.lki_copiable_values.clear();
    f.state.lki_by_incarnation.clear();
    f.state.departed_stack_spells.clear();
    f.state.linked_exile_lki.clear();
    f.state.deck_pools.push(PlayerDeckPool {
        registered_main: std::sync::Arc::new(vec![DeckEntry {
            card: Default::default(),
            count: u32::MAX,
        }]),
        ..Default::default()
    });
    let state = &f.state;
    let zone_count = state.battlefield.len()
        + state.stack.len()
        + state.exile.len()
        + state.command_zone.len()
        + state
            .players
            .iter()
            .map(|p| p.hand.len() + p.library.len() + p.graveyard.len())
            .sum::<usize>();
    let journal = &state.resolved_rules_journal;
    let journal_count = journal.entries().len()
        + journal.nodes().len()
        + journal.produced_mana().len()
        + journal.spent_mana().len();
    assert!(journal_count > 0, "real fixture tap records journal structure");
    let history_count = state.zone_changes_this_turn.len()
        + state.player_actions_this_turn.len()
        + state
            .spells_cast_this_game_by_player
            .values()
            .map(|v| v.len())
            .sum::<usize>()
        + state
            .spells_cast_this_turn_by_player
            .values()
            .map(|v| v.len())
            .sum::<usize>();
    assert!(history_count > 0, "real fixture records actions/zone history");
    for (category, count) in [
        state.objects.len(),
        zone_count,
        1,
        history_count,
        journal_count,
    ]
    .into_iter()
    .enumerate()
    {
        for limit in [count - 1, count, count + 1] {
            let mut limits = UNDO_CAPACITY_LIMITS;
            match category {
                0 => limits.objects = limit,
                1 => limits.zone_items = limit,
                2 => limits.deck_pool_items = limit,
                3 => limits.history_lki_items = limit,
                4 => limits.journal_items = limit,
                _ => unreachable!(),
            }
            assert_eq!(limits.admits_structure(state), count <= limit);
        }
    }
}

#[test]
fn capacity_nested_history_counts_inner_entries() {
    use crate::types::game_state::{DepartedStackSpell, LinkedExileSnapshot};
    let mut f = Fixture::new();
    f.arm();
    f.state.lki_cache.clear();
    f.state.lki_copiable_values.clear();
    f.state.lki_by_incarnation.clear();
    f.state.departed_stack_spells.clear();
    f.state.linked_exile_lki.clear();
    let baseline = checked_item_sum([
        f.state.zone_changes_this_turn.len(),
        f.state.player_actions_this_turn.len(),
        f.state
            .spells_cast_this_game_by_player
            .values()
            .map(|v| v.len())
            .sum(),
        f.state
            .spells_cast_this_turn_by_player
            .values()
            .map(|v| v.len())
            .sum(),
    ])
    .unwrap();
    let lki = f.state.objects[&f.bears].snapshot_public_characteristics();
    let departed = DepartedStackSpell {
        entry: f.state.stack.front().unwrap().clone(),
        object: Box::new(f.state.objects[&f.bears].clone()),
    };
    f.state
        .lki_by_incarnation
        .insert(f.bears, [(1, lki.clone()), (2, lki)].into_iter().collect());
    f.state.departed_stack_spells.insert(
        f.bears,
        [(1, departed.clone()), (2, departed)].into_iter().collect(),
    );
    f.state.linked_exile_lki.insert(
        f.bears,
        vec![
            LinkedExileSnapshot {
                exiled_id: f.bears,
                owner: P0,
                mana_value: 2,
            };
            2
        ],
    );
    f.state.linked_exile_lki.insert(
        f.forest_a,
        vec![LinkedExileSnapshot {
            exiled_id: f.forest_a,
            owner: P0,
            mana_value: 0,
        }],
    );
    let mut limits = UNDO_CAPACITY_LIMITS;
    limits.history_lki_items = baseline + 6;
    assert!(!limits.admits_structure(&f.state));
    limits.history_lki_items += 1;
    assert!(limits.admits_structure(&f.state));
}

#[test]
fn capacity_json_counts_utf8_bytes_inclusive() {
    let mut limits = UNDO_CAPACITY_LIMITS;
    limits.checkpoint_bytes = 6;
    assert!(limits.admits_json("éabc"));
    assert!(limits.admits_json("éabcd"));
    assert!(!limits.admits_json("éabcde"));
}

#[test]
fn capacity_structure_refusal_skips_capture_and_casts_once() {
    let mut f = Fixture::new();
    let old = f.arm();
    f.restore(old).unwrap();
    // Keep a stale case to prove refusal invalidates it before any capture.
    f.arm();
    f.state = Fixture::new().state;
    while f.state.players[1].library.len() <= UNDO_CAPACITY_LIMITS.zone_items {
        f.state.players[1].library.push_back(f.bears);
    }
    let action = cast_action(&f);
    let result = f
        .undo
        .submit_action_with_capture(&mut f.state, BINDING, P0, action, |_| {
            panic!("structure refusal must precede clone/serialization")
        })
        .unwrap();
    assert_eq!(
        result
            .events
            .iter()
            .filter(|e| matches!(e, GameEvent::SpellCast { .. }))
            .count(),
        1
    );
    assert_eq!(f.state.stack.len(), 1);
    assert!(f.undo.receipt().is_none());
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
}

#[test]
fn capacity_serializer_error_or_json_refusal_casts_once() {
    for error in [false, true] {
        let mut f = Fixture::new();
        let action = cast_action(&f);
        let result = f
            .undo
            .submit_action_with_capture(&mut f.state, BINDING, P0, action, |_| {
                if error {
                    Err(serde_json::from_str::<serde_json::Value>("{").unwrap_err())
                } else {
                    Ok("é".repeat(UNDO_CAPACITY_LIMITS.checkpoint_bytes / 2 + 1))
                }
            })
            .unwrap();
        assert_eq!(
        result
            .events
            .iter()
            .filter(|e| matches!(e, GameEvent::SpellCast { .. }))
            .count(),
        1
    );
        assert_eq!(f.state.stack.len(), 1);
        assert_eq!(f.undo.next_receipt, 0);
        assert!(f.undo.receipt().is_none());
    }
}

#[test]
fn capacity_restore_decode_failure_preserves_case() {
    let mut f = Fixture::new();
    let receipt = f.arm();
    let before = witness(&f.state);
    assert!(f
        .undo
        .compare_restore(&mut f.state, BINDING, receipt, |_| Err("refused".into()))
        .is_err());
    assert_eq!(witness(&f.state), before);
    assert_eq!(f.undo.receipt(), Some(receipt));
    assert_eq!(f.undo.phase(), HostUndoPhase::Armed);
}
