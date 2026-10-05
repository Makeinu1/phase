use super::*;
use engine::game::scenario::{GameScenario, P0, P1};
use engine::types::game_state::{CastPaymentMode, PriorityPassingMode, WaitingFor};
use engine::types::mana::{ManaColor, ManaCost, ManaCostShard};
use engine::types::phase::Phase;
use engine::types::zones::Zone;
use rand::RngCore;

// Exact entries from admitted official card-data-16631934f8dd6350.json.
// Full data SHA: 16631934f8dd63509a228cc7bccb8fa4b021d596d772c5f5697e55fe7e43dfe8.
const DATA: &str = include_str!("fixtures/host-precast-card-data.json");

struct Fixture {
    bears: engine::types::identifiers::ObjectId,
}

fn setup() -> Fixture {
    // A fresh test registry retains the external incarnation serial.
    RUNTIME.with(|cell| {
        cell.take();
    });
    clear_game_state();
    set_multiplayer_mode(false);
    load_card_database_inner(DATA).unwrap();
    let mut scenario = GameScenario::new_n_player(2, 0xF32002);
    scenario.at_phase(Phase::PreCombatMain);
    scenario.add_basic_land(P0, ManaColor::Green);
    scenario.add_basic_land(P0, ManaColor::Green);
    let bears = scenario
        .add_creature_to_hand(P0, "Grizzly Bears", 2, 2)
        .with_mana_cost(ManaCost::Cost {
            generic: 1,
            shards: vec![ManaCostShard::Green],
        })
        .id();
    scenario.with_library_top(P1, &["Forest", "Forest", "Forest"]);
    let mut state = scenario.build().state().clone();
    rehydrate_restored_state_from_card_db(&mut state).unwrap();
    for actor in [P0, P1] {
        apply_with_rejection(
            &mut state,
            actor,
            GameAction::SetPriorityPassingMode {
                mode: PriorityPassingMode::FullControl,
            },
        )
        .unwrap();
    }
    bind_interaction_session(&mut state);
    GAME_STATE.with(|cell| cell.set(Some(state)));
    set_multiplayer_mode(true);
    Fixture { bears }
}

fn cast(f: &Fixture, mode: CastPaymentMode) -> engine::types::game_state::ActionResult {
    with_state_mut(|state| {
        let card_id = state.objects[&f.bears].card_id;
        submit_action(
            state,
            P0,
            GameAction::CastSpell {
                object_id: f.bears,
                card_id,
                targets: vec![],
                payment_mode: mode,
            },
        )
    })
    .unwrap()
    .unwrap()
}

fn live() -> GameState {
    with_state(Clone::clone).unwrap()
}

fn arm(f: &Fixture) -> Status {
    enable(&status().unwrap().binding).unwrap();
    let result = cast(f, CastPaymentMode::Auto);
    assert!(result.events.iter().any(|event| matches!(event, engine::types::events::GameEvent::SpellCast { object_id, .. } if *object_id == f.bears)));
    let armed = status().unwrap();
    assert_eq!(armed.phase, "Armed");
    assert!(armed.receipt.is_some());
    assert_eq!(live().objects[&f.bears].zone, Zone::Stack);
    assert_eq!(live().stack_paid_facts[&f.bears].actual_mana_spent, 2);
    armed
}

#[test]
fn disabled_default_keeps_normal_cast_without_checkpoint() {
    let f = setup();
    cast(&f, CastPaymentMode::Auto);
    assert_eq!(live().objects[&f.bears].zone, Zone::Stack);
    assert!(!status().unwrap().enabled);
    assert!(status().unwrap().receipt.is_none());
}

#[test]
fn host_restore_rehydrates_pre_once_and_rebinds_authority() {
    let f = setup();
    let pre = live();
    let armed = arm(&f);
    let post = live();
    let restored = restore(&armed.binding, armed.receipt.as_deref().unwrap()).unwrap();
    let state = live();
    assert_eq!(restored.phase, "Consumed");
    assert_eq!(state.state_revision, post.state_revision + 1);
    assert_eq!(state.players[0].hand, pre.players[0].hand);
    assert_eq!(state.players[1].library, pre.players[1].library);
    assert_eq!(state.objects[&f.bears].zone, Zone::Hand);
    assert_eq!(state.stack.len(), pre.stack.len());
    assert_eq!(state.waiting_for, pre.waiting_for);
    assert_eq!(state.priority_player, pre.priority_player);
    assert_eq!(state.players[0].mana_pool, pre.players[0].mana_pool);
    for id in &pre.battlefield {
        assert_eq!(state.objects[id].tapped, pre.objects[id].tapped);
    }
    assert_eq!(state.debug_mode, post.debug_mode);
    assert_eq!(state.debug_permitted, post.debug_permitted);
    assert_ne!(state.interaction_session_id, post.interaction_session_id);
    let mut expected = pre.rng.clone();
    let mut actual = state.rng.clone();
    assert_eq!(actual.next_u64(), expected.next_u64());
    assert!(restore(&armed.binding, armed.receipt.as_deref().unwrap()).is_err());
    assert!(REPLAY_LOG.with(|cell| cell.take()).is_none());
}

#[test]
fn manual_semantic_payment_keeps_the_same_pre_receipt() {
    let f = setup();
    let binding = status().unwrap().binding;
    enable(&binding).unwrap();
    cast(&f, CastPaymentMode::Manual);
    let pending = status().unwrap();
    assert_eq!(pending.phase, "Pending");
    for _ in 0..2 {
        with_state_mut(|state| {
            let action = engine::game::mana_sources::activatable_mana_actions_for_player(state, P0)
                .into_iter()
                .find(|action| matches!(action, GameAction::TapLandForMana { .. }))
                .unwrap();
            submit_action(state, P0, action).unwrap();
        })
        .unwrap();
    }
    with_state_mut(|state| submit_action(state, P0, GameAction::PassPriority))
        .unwrap()
        .unwrap();
    let armed = status().unwrap();
    assert_eq!(armed.phase, "Armed");
    assert_eq!(armed.receipt, pending.receipt);
    restore(&binding, armed.receipt.as_deref().unwrap()).unwrap();
    assert_eq!(live().waiting_for, WaitingFor::Priority { player: P0 });
    assert_eq!(live().objects[&f.bears].zone, Zone::Hand);
}

#[test]
fn refused_init_and_db_load_revoke_undo_without_erasing_host() {
    for refusal in [0, 1] {
        let f = setup();
        let armed = arm(&f);
        let before = live();
        if refusal == 0 {
            assert!(init_guard(InitSessionKind::Local).is_err());
        } else {
            assert!(load_card_database_inner("not JSON").is_err());
        }
        assert!(!status().unwrap().enabled);
        assert!(restore(&armed.binding, armed.receipt.as_deref().unwrap()).is_err());
        assert_eq!(live().state_revision, before.state_revision);
        assert_eq!(live().objects[&f.bears].zone, Zone::Stack);
        assert!(is_multiplayer_mode());
    }
}

#[test]
fn legacy_multiplayer_restore_still_refuses_and_preserves_state() {
    let f = setup();
    let armed = arm(&f);
    let before = live();
    assert!(restore_game_state_inner("invalid")
        .unwrap_err()
        .contains("multiplayer"));
    assert_eq!(live().state_revision, before.state_revision);
    assert!(restore(&armed.binding, armed.receipt.as_deref().unwrap()).is_err());
}

#[test]
fn scoring_mutates_entropy_and_invalidates_before_restore() {
    let f = setup();
    let armed = arm(&f);
    let before = live();
    with_state_mut(|state| {
        scored_candidates_inner(state, AiDifficulty::Easy, P0, before.rng_seed + 1)
    })
    .unwrap();
    let scored = live();
    assert_ne!(scored.rng_seed, before.rng_seed);
    assert_eq!(status().unwrap().phase, "Invalidated");
    assert!(restore(&armed.binding, armed.receipt.as_deref().unwrap()).is_err());
    assert_eq!(live().rng_seed, scored.rng_seed);
}

#[test]
fn lost_registry_gets_a_fresh_incarnation_and_no_old_receipt() {
    let f = setup();
    let armed = arm(&f);
    // Synthetic panic-loss fixture; no engine crash is claimed.
    RUNTIME.with(|cell| {
        cell.take();
    });
    let current = status().unwrap();
    assert_ne!(current.binding, armed.binding);
    assert!(!current.enabled);
    assert!(restore(&armed.binding, armed.receipt.as_deref().unwrap()).is_err());
}

#[test]
fn wrong_binding_and_receipt_refuse_without_consuming() {
    let f = setup();
    let armed = arm(&f);
    let before = live().state_revision;
    assert!(restore("old.binding", armed.receipt.as_deref().unwrap()).is_err());
    assert!(restore(&armed.binding, "18446744073709551616").is_err());
    assert!(restore(&armed.binding, "01").is_err());
    assert_eq!(live().state_revision, before);
    assert_eq!(status().unwrap().phase, "Armed");
}

#[test]
fn foreign_database_and_nonhost_cannot_enable() {
    setup();
    set_multiplayer_mode(false);
    assert!(status().is_err());
    set_multiplayer_mode(true);
    load_card_database_inner(DATA).unwrap();
    assert!(status().is_err(), "new DB Arc is not the installed game DB");
}

#[test]
fn checked_identity_exhaustion_disables_experiment() {
    setup();
    // Synthetic private exhaustion; production identities never reset/wrap.
    with_runtime(|runtime| {
        runtime.binding.database = u64::MAX;
        Ok(())
    })
    .unwrap();
    boundary(Boundary::Database);
    assert!(status().is_err());
}
