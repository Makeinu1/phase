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
