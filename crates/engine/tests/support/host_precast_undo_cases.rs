use super::engine_under_test as engine;
use engine::game::host_precast_undo::{HostPrecastUndo, HostUndoBinding, HostUndoPhase};
use engine::game::scenario::{GameScenario, P0, P1};
use engine::types::ability::Effect;
use engine::types::actions::GameAction;
use engine::types::events::GameEvent;
use engine::types::game_state::{
    ActionResult, GameState, PriorityPassingMode, StackEntryKind, TrustedGameStateEnvelope,
    WaitingFor,
};
use engine::types::game_state::{CastPaymentMode, PersistedGameState};
use engine::types::identifiers::{CardId, ObjectId};
use engine::types::mana::{ManaColor, ManaCost, ManaCostShard, ManaType};
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;
use rand::RngCore;

pub(super) const BINDING: HostUndoBinding = HostUndoBinding {
    incarnation: 1,
    database: 1,
    claim: 1,
};

pub(super) struct Fixture {
    pub(super) state: GameState,
    pub(super) undo: HostPrecastUndo,
    pub(super) forest_a: ObjectId,
    pub(super) forest_b: ObjectId,
    pub(super) bears: ObjectId,
    other: ObjectId,
}

impl Fixture {
    pub(super) fn new() -> Self {
        Self::with_payment_land(None)
    }

    pub(super) fn with_payment_land(oracle: Option<&str>) -> Self {
        Self::with_payment_setup(oracle, P0)
    }

    pub(super) fn with_payment_setup(oracle: Option<&str>, payment_land_owner: PlayerId) -> Self {
        let mut scenario = GameScenario::new_n_player(2, 0xF_32_00_01);
        scenario.at_phase(Phase::PreCombatMain);
        let forest_a = scenario.add_basic_land(P0, ManaColor::Green);
        let forest_b = match oracle {
            Some(oracle) => scenario
                .add_land_from_oracle(P0, "Payment witness land", oracle)
                .id(),
            None => scenario.add_basic_land(payment_land_owner, ManaColor::Green),
        };
        let bears = scenario
            .add_creature_to_hand(P0, "Grizzly Bears", 2, 2)
            .with_mana_cost(ManaCost::Cost {
                generic: 1,
                shards: vec![ManaCostShard::Green],
            })
            .id();
        let other = scenario
            .add_creature_to_hand(P0, "Other ordinary creature", 2, 2)
            .with_mana_cost(ManaCost::Cost {
                generic: 1,
                shards: vec![ManaCostShard::Green],
            })
            .id();
        scenario.with_library_top(
            P1,
            &[
                "private one",
                "private two",
                "private three",
                "private four",
            ],
        );
        let mut state = scenario.build().state().clone();
        for actor in [P0, P1] {
            engine::game::engine::apply(
                &mut state,
                actor,
                GameAction::SetPriorityPassingMode {
                    mode: PriorityPassingMode::FullControl,
                },
            )
            .unwrap();
        }
        let mut events = vec![];
        engine::game::library::resolve_and_apply_library_shuffle(&mut state, P1, &mut events)
            .unwrap();
        assert!(!events.is_empty());
        assert!(state.rng.get_word_pos() > 0);
        let tap = land_action(&state, forest_a);
        engine::game::engine::apply(&mut state, P0, tap).unwrap();
        assert!(state.objects[&forest_a].tapped);
        assert!(!state.objects[&forest_b].tapped);
        assert_eq!(state.players[0].mana_pool.count_color(ManaType::Green), 1);
        assert!(state.stack.is_empty());
        assert_eq!(state.waiting_for, WaitingFor::Priority { player: P0 });
        Self {
            state,
            undo: HostPrecastUndo::default(),
            forest_a,
            forest_b,
            bears,
            other,
        }
    }

    pub(super) fn cast(&mut self, payment_mode: CastPaymentMode) -> ActionResult {
        let card_id = self.state.objects[&self.bears].card_id;
        self.undo
            .submit_action(
                &mut self.state,
                BINDING,
                P0,
                GameAction::CastSpell {
                    object_id: self.bears,
                    card_id,
                    targets: vec![],
                    payment_mode,
                },
            )
            .unwrap()
    }

    pub(super) fn arm(&mut self) -> u64 {
        let result = self.cast(CastPaymentMode::Auto);
        assert_eq!(self.undo.phase(), HostUndoPhase::Armed);
        assert_eq!(self.state.stack.len(), 1);
        assert_eq!(self.state.objects[&self.bears].zone, Zone::Stack);
        assert!(result.events.iter().any(|event| matches!(event, GameEvent::SpellCast { object_id, .. } if *object_id == self.bears)));
        assert!(!result
            .events
            .iter()
            .any(|event| matches!(event, GameEvent::PriorityPassed { .. })));
        assert_eq!(self.state.waiting_for, WaitingFor::Priority { player: P0 });
        self.undo.receipt().unwrap()
    }

    pub(super) fn restore(&mut self, receipt: u64) -> Result<u64, String> {
        self.undo
            .compare_restore(&mut self.state, BINDING, receipt, decode)
    }

    pub(super) fn install_delayed_mana_watcher(&mut self) {
        use engine::types::ability::{
            AbilityCondition, CommanderOwnership, DelayedTriggerCondition, DelayedTriggerLifetime,
            ResolvedAbility, TargetFilter, TriggerDefinition,
        };
        use engine::types::game_state::DelayedTrigger;
        use engine::types::triggers::TriggerMode;

        let mut definition = TriggerDefinition::new(TriggerMode::AbilityActivated);
        definition.valid_target = Some(TargetFilter::Controller);
        let mut ability = ResolvedAbility::new(
            Effect::BecomeMonarch {
                target: TargetFilter::Controller,
            },
            vec![],
            self.forest_a,
            P0,
        );
        ability.condition = Some(AbilityCondition::ControlsCommander {
            ownership: CommanderOwnership::Own,
        });
        ability.trigger_source = Some(engine::game::triggers::trigger_source_context_for_latch(
            &self.state,
            &self.state.objects[&self.forest_a],
        ));
        // Fixture preparation installs a false-gated one-shot watcher through the
        // production installation authority. Its consumption is tested by a real
        // mana activation, not by injecting an AbilityActivated event.
        let mut installation_events = vec![];
        engine::game::triggers::install_delayed_trigger(
            &mut self.state,
            DelayedTrigger::new(
                DelayedTriggerCondition::WhenNextEvent {
                    trigger: Box::new(definition),
                    or_trigger: None,
                    lifetime: DelayedTriggerLifetime::ThisTurn,
                },
                Box::new(ability),
                P0,
                self.forest_a,
                true,
            ),
            &mut installation_events,
        );
        assert_eq!(self.state.delayed_triggers.len(), 1);
    }
}

fn land_action(state: &GameState, id: ObjectId) -> GameAction {
    engine::game::mana_sources::activatable_mana_actions_for_player(state, P0).into_iter()
        .find(|action| matches!(action, GameAction::TapLandForMana { selection } if selection.source.object_id == id)).unwrap()
}

fn decode(json: &str) -> Result<GameState, String> {
    let mut state = serde_json::from_str::<PersistedGameState>(json)
        .map_err(|e| e.to_string())?
        .into_game_state()
        .map_err(|e| e.to_string())?;
    state.rehydrate_rng();
    Ok(state)
}

pub(super) fn witness(state: &GameState) -> (String, u64, u128) {
    (
        serde_json::to_string(&TrustedGameStateEnvelope::capture(state.clone())).unwrap(),
        state.state_revision,
        state.rng.get_word_pos(),
    )
}

fn assert_pre(f: &Fixture, pre: &GameState, post_revision: u64) {
    assert!(f.state.objects[&f.forest_a].tapped);
    assert!(!f.state.objects[&f.forest_b].tapped);
    assert_eq!(f.state.objects[&f.bears].zone, Zone::Hand);
    assert!(f.state.stack.is_empty());
    assert_eq!(f.state.players[0].mana_pool, pre.players[0].mana_pool);
    assert_eq!(f.state.players[0].mana_pool.count_color(ManaType::Green), 1);
    for seat in [0, 1] {
        assert_eq!(f.state.players[seat].hand, pre.players[seat].hand);
        assert_eq!(f.state.players[seat].library, pre.players[seat].library);
        assert_eq!(f.state.players[seat].graveyard, pre.players[seat].graveyard);
    }
    assert_eq!(f.state.waiting_for, pre.waiting_for);
    assert_eq!(f.state.priority_player, pre.priority_player);
    assert_eq!(f.state.priority_passes, pre.priority_passes);
    assert_eq!(f.state.battlefield, pre.battlefield);
    assert_eq!(
        f.state.spells_cast_this_turn_by_player,
        pre.spells_cast_this_turn_by_player
    );
    assert!(f.state.pending_cast.is_none());
    assert!(f.state.pending_discard_for_cost.is_none());
    assert!(f.state.resolution_stack.is_empty());
    assert!(f.state.resolving_stack_entry.is_none());
    assert!(f.state.stack_resolution_session.is_none());
    assert_eq!(f.state.state_revision, post_revision + 1);
    assert_eq!(f.state.rng.get_word_pos(), pre.rng.get_word_pos());
    let mut expected = pre.rng.clone();
    let mut actual = f.state.rng.clone();
    assert_eq!(actual.next_u32(), expected.next_u32());
}

fn assert_uncommitted_manual_cast(f: &Fixture) {
    assert!(matches!(
        f.state.waiting_for,
        WaitingFor::ManaPayment { player: P0, .. }
    ));
    let pending = f.state.pending_cast.as_ref().unwrap();
    assert_eq!(pending.object_id, f.bears);
    assert_eq!(pending.card_id, f.state.objects[&f.bears].card_id);
    assert!(pending.activation_ability_index.is_none());
    assert_eq!(f.state.objects[&f.bears].zone, Zone::Hand);
    assert!(f.state.players[0].hand.contains(&f.bears));
    assert!(f.state.objects[&f.bears].cast_occurrence.is_none());
    assert!(!f.state.stack_paid_facts.contains_key(&f.bears));
    assert!(f.state.resolution_stack.is_empty());
    assert!(f.state.resolving_stack_entry.is_none());
    assert!(f.state.stack_resolution_session.is_none());
    // Announcement owns one spell placeholder before payment is committed.
    // Exactly this entry also excludes an additional watcher trigger.
    assert_eq!(f.state.stack.len(), 1);
    let entry = f.state.stack.front().unwrap();
    assert_eq!(entry.id, f.bears);
    assert_eq!(entry.source_id, f.bears);
    assert_eq!(entry.controller, P0);
    assert!(matches!(
        &entry.kind,
        StackEntryKind::Spell {
            card_id,
            ability: None,
            actual_mana_spent: 0,
            ..
        } if *card_id == pending.card_id
    ));
}

#[test]
fn automatic_cast_post_restores_exact_pre_without_resolution() {
    let mut f = Fixture::new();
    let pre = f.state.clone();
    let receipt = f.arm();
    let post_revision = f.state.state_revision;
    assert!(f.state.objects[&f.forest_b].tapped);
    assert_eq!(f.state.players[0].mana_pool.total(), 0);
    f.restore(receipt).unwrap();
    assert_pre(&f, &pre, post_revision);
    assert_eq!(f.undo.phase(), HostUndoPhase::Consumed);
    let restored = witness(&f.state);
    assert!(f.restore(receipt).is_err());
    assert_eq!(witness(&f.state), restored);
}

#[test]
fn recast_on_stack_rejects_consumed_receipt() {
    let mut f = Fixture::new();
    let old = f.arm();
    let occurrence = f.state.objects[&f.bears].cast_occurrence;
    f.restore(old).unwrap();
    let new = f.arm();
    assert_ne!(new, old);
    assert_eq!(
        f.state.objects[&f.bears].cast_occurrence, occurrence,
        "journal position alone is reused after rollback"
    );
    let recast = witness(&f.state);
    assert!(f.restore(old).is_err());
    assert_eq!(witness(&f.state), recast);
    assert_eq!(f.state.objects[&f.bears].zone, Zone::Stack);
}

#[test]
fn legal_caster_pass_invalidates_before_guest_response() {
    let mut f = Fixture::new();
    let receipt = f.arm();
    let result = f
        .undo
        .submit_action(&mut f.state, BINDING, P0, GameAction::PassPriority)
        .unwrap();
    assert!(result.disposition.is_applied());
    // The submitting/pass seat is P0; the existing event carries recipient P1.
    assert_eq!(f.state.priority_passes.len(), 1);
    assert!(f.state.priority_passes.contains(&P0));
    assert!(!f.state.priority_passes.contains(&P1));
    assert!(result
        .events
        .iter()
        .any(|event| matches!(event, GameEvent::PriorityPassed { player_id } if *player_id == P1)));
    assert_eq!(f.state.waiting_for, WaitingFor::Priority { player: P1 });
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    let after_pass = witness(&f.state);
    assert!(f.restore(receipt).is_err());
    assert_eq!(witness(&f.state), after_pass);
    // B is now legally able to act. Stop before B passes (which could resolve).
}

#[test]
fn manual_payment_continuation_keeps_original_pre() {
    let mut f = Fixture::new();
    let pre = f.state.clone();
    let result = f.cast(CastPaymentMode::Manual);
    assert!(matches!(
        f.state.waiting_for,
        WaitingFor::ManaPayment { player: P0, .. }
    ));
    assert!(f.state.pending_cast.is_some());
    assert!(!result
        .events
        .iter()
        .any(|event| matches!(event, GameEvent::SpellCast { .. })));
    assert_eq!(f.undo.phase(), HostUndoPhase::Pending);
    let receipt = f.undo.receipt().unwrap();
    let pending = witness(&f.state);
    assert!(f.restore(receipt).is_err());
    assert_eq!(witness(&f.state), pending);
    let tap = land_action(&f.state, f.forest_b);
    f.undo
        .submit_action(&mut f.state, BINDING, P0, tap)
        .unwrap();
    assert_eq!(f.undo.receipt(), Some(receipt));
    assert_eq!(f.undo.phase(), HostUndoPhase::Pending);
    let result = f
        .undo
        .submit_action(&mut f.state, BINDING, P0, GameAction::PassPriority)
        .unwrap();
    assert!(result
        .events
        .iter()
        .any(|event| matches!(event, GameEvent::SpellCast { .. })));
    assert_eq!(f.undo.phase(), HostUndoPhase::Armed);
    let post_revision = f.state.state_revision;
    f.restore(receipt).unwrap();
    assert_pre(&f, &pre, post_revision);
}

#[test]
fn different_cast_activation_cancel_and_rejection_invalidate() {
    let mut f = Fixture::new();
    f.cast(CastPaymentMode::Manual);
    let receipt = f.undo.receipt().unwrap();
    f.undo
        .submit_action(&mut f.state, BINDING, P0, GameAction::CancelCast)
        .unwrap();
    assert_eq!(f.state.objects[&f.bears].zone, Zone::Hand);
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    assert!(f.restore(receipt).is_err());

    let mut f = Fixture::new();
    f.cast(CastPaymentMode::Manual);
    let receipt = f.undo.receipt().unwrap();
    let tap = land_action(&f.state, f.forest_b);
    assert!(f
        .undo
        .submit_action(&mut f.state, BINDING, P1, tap)
        .is_err());
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    assert!(f.restore(receipt).is_err());

    let mut f = Fixture::new();
    f.cast(CastPaymentMode::Manual);
    let receipt = f.undo.receipt().unwrap();
    let other = f.other;
    assert_ne!(other, f.bears);
    assert!(f.state.players[0].hand.contains(&other));
    let card_id = f.state.objects[&other].card_id;
    let before = witness(&f.state);
    assert!(f
        .undo
        .submit_action(
            &mut f.state,
            BINDING,
            P0,
            GameAction::CastSpell {
                object_id: other,
                card_id,
                targets: vec![],
                payment_mode: CastPaymentMode::Manual,
            }
        )
        .is_err());
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    assert!(f.restore(receipt).is_err());
    assert_eq!(witness(&f.state), before);

    let mut f = Fixture::new();
    let wrong_card = CardId(u64::MAX);
    assert!(f
        .undo
        .submit_action(
            &mut f.state,
            BINDING,
            P0,
            GameAction::CastSpell {
                object_id: f.bears,
                card_id: wrong_card,
                targets: vec![],
                payment_mode: CastPaymentMode::Auto,
            }
        )
        .is_err());
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    assert!(f.undo.receipt().is_none());

    let mut f = Fixture::with_payment_setup(None, P1);
    let card_id = f.state.objects[&f.bears].card_id;
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
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    assert!(f.undo.receipt().is_none());
    // A subsequent real Manual cast must allocate the next receipt, proving
    // the rejected Auto cast captured PRE before entering the reducer.
    f.cast(CastPaymentMode::Manual);
    assert_eq!(f.undo.phase(), HostUndoPhase::Pending);
    assert_eq!(f.undo.receipt(), Some(2));

    let mut f = Fixture::new();
    f.cast(CastPaymentMode::Manual);
    let receipt = f.undo.receipt().unwrap();
    f.undo
        .submit_action(
            &mut f.state,
            BINDING,
            P0,
            GameAction::ActivateAbility {
                source_id: f.forest_b,
                ability_index: 0,
            },
        )
        .unwrap();
    assert!(
        f.state.objects[&f.forest_b].tapped,
        "legacy mana activation really applied"
    );
    assert_eq!(f.state.players[0].mana_pool.total(), 2);
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    assert!(f.restore(receipt).is_err());

    let mut f = Fixture::new();
    let receipt = f.arm();
    let result = f
        .undo
        .submit_action(
            &mut f.state,
            BINDING,
            P1,
            GameAction::SetPriorityPassingMode {
                mode: PriorityPassingMode::FullControl,
            },
        )
        .unwrap();
    assert!(result.disposition.is_applied());
    assert_eq!(f.state.waiting_for, WaitingFor::Priority { player: P0 });
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    let after = witness(&f.state);
    assert!(f.restore(receipt).is_err());
    assert_eq!(witness(&f.state), after);
}

#[test]
fn unsupported_payment_source_executes_normally_without_arming() {
    for payment_mode in [CastPaymentMode::Auto, CastPaymentMode::Manual] {
        let mut f = Fixture::with_payment_land(Some("{T}, Pay 1 life: Add {G}."));
        let result = f.cast(payment_mode);
        let result = if payment_mode == CastPaymentMode::Manual {
            assert!(matches!(
                f.state.waiting_for,
                WaitingFor::ManaPayment { player: P0, .. }
            ));
            let action = land_action(&f.state, f.forest_b);
            f.undo
                .submit_action(&mut f.state, BINDING, P0, action)
                .unwrap();
            f.undo
                .submit_action(&mut f.state, BINDING, P0, GameAction::PassPriority)
                .unwrap()
        } else {
            result
        };
        assert!(result.events.iter().any(
            |event| matches!(event, GameEvent::SpellCast { object_id, .. } if *object_id == f.bears)
        ));
        assert_eq!(f.state.objects[&f.bears].zone, Zone::Stack);
        assert_eq!(f.state.players[0].life, 19, "production life cost was paid");
        assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
        assert!(f.undo.receipt().is_none());
    }
}

#[test]
fn next_spell_effects_execute_normally_without_arming() {
    use engine::types::ability::{PlayerScope, ResolvedAbility};
    use engine::types::game_state::NextSpellModifier;
    for effect in [
        Effect::ReduceNextSpellCost {
            amount: 1,
            spell_filter: None,
        },
        Effect::GrantNextSpellAbility {
            modifier: NextSpellModifier::CantBeCountered,
            player: PlayerScope::Controller,
            spell_filter: None,
        },
    ] {
        let reduction = matches!(effect, Effect::ReduceNextSpellCost { .. });
        let mut f = Fixture::new();
        // Fixture preparation uses the production effect dispatch to create
        // the next-spell carrier; the tested Bears never resolves.
        let ability = ResolvedAbility::new(effect, vec![], f.forest_a, P0);
        let mut events = vec![];
        engine::game::effects::resolve_effect(&mut f.state, &ability, &mut events).unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, GameEvent::EffectResolved { .. })));
        assert!(
            !f.state.pending_spell_cost_reductions.is_empty()
                || !f.state.pending_next_spell_modifiers.is_empty()
        );
        f.cast(CastPaymentMode::Auto);
        assert_eq!(f.state.objects[&f.bears].zone, Zone::Stack);
        assert!(f.state.pending_spell_cost_reductions.is_empty());
        assert!(f.state.pending_next_spell_modifiers.is_empty());
        let paid = f.state.stack_paid_facts.get(&f.bears).unwrap();
        assert_eq!(paid.actual_mana_spent, if reduction { 1 } else { 2 });
        assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
        assert!(f.undo.receipt().is_none());
    }
}

#[test]
fn delayed_mana_watcher_executes_normally_without_arming() {
    use engine::types::events::{ActivationObservers, ActivationTriggerState};

    let mut f = Fixture::new();
    f.install_delayed_mana_watcher();
    let announcement = f.cast(CastPaymentMode::Manual);
    assert_uncommitted_manual_cast(&f);
    assert!(!announcement.events.iter().any(
        |event| matches!(event, GameEvent::SpellCast { object_id, .. } if *object_id == f.bears)
    ));
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    assert!(f.undo.receipt().is_none());

    let tap = land_action(&f.state, f.forest_b);
    let activation = f
        .undo
        .submit_action(&mut f.state, BINDING, P0, tap)
        .unwrap();
    assert!(activation.events.iter().any(|event| matches!(event,
        GameEvent::AbilityActivated {
            source_id,
            trigger_state: ActivationTriggerState::CollectedAtActivation {
                observers: ActivationObservers::Bound,
            },
            ..
        } if *source_id == f.forest_b
    )));
    assert!(f.state.objects[&f.forest_b].tapped);
    assert!(f.state.delayed_triggers.is_empty());
    assert!(f.state.deferred_triggers.is_empty());
    assert!(f.state.pending_trigger.is_none());
    assert_uncommitted_manual_cast(&f);
    assert!(!activation.events.iter().any(
        |event| matches!(event, GameEvent::SpellCast { object_id, .. } if *object_id == f.bears)
    ));

    let cast = f
        .undo
        .submit_action(&mut f.state, BINDING, P0, GameAction::PassPriority)
        .unwrap();
    assert!(cast.events.iter().any(|event| matches!(event,
        GameEvent::SpellCast { object_id, .. } if *object_id == f.bears
    )));
    assert_eq!(f.state.stack.len(), 1);
    assert_eq!(f.state.objects[&f.bears].zone, Zone::Stack);
    assert!(f.state.pending_cast.is_none());
    assert_eq!(
        f.state.objects[&f.bears].cast_occurrence.unwrap().caster,
        P0
    );
    assert_eq!(f.state.stack_paid_facts[&f.bears].actual_mana_spent, 2);
    assert_eq!(f.state.waiting_for, WaitingFor::Priority { player: P0 });
    assert_eq!(f.undo.phase(), HostUndoPhase::Invalidated);
    assert!(f.undo.receipt().is_none());
    let post = witness(&f.state);
    assert!(f.restore(1).is_err());
    assert_eq!(witness(&f.state), post);
}

#[test]
fn live_binding_post_revision_and_overflow_refuse_stale_restore() {
    let mut f = Fixture::new();
    let receipt = f.arm();
    let before = witness(&f.state);
    for binding in [
        HostUndoBinding {
            incarnation: 2,
            ..BINDING
        },
        HostUndoBinding {
            database: 2,
            ..BINDING
        },
        HostUndoBinding {
            claim: 2,
            ..BINDING
        },
    ] {
        assert!(f
            .undo
            .compare_restore(&mut f.state, binding, receipt, decode)
            .is_err());
        assert_eq!(witness(&f.state), before);
    }
    assert!(f
        .undo
        .compare_restore(&mut f.state, BINDING, receipt, |_| Err(
            "test decoder refusal".into()
        ))
        .is_err());
    assert_eq!(witness(&f.state), before);
    // Reach the overflow boundary through a real successful cast rather than
    // mutating the private receipt's POST. Fixture revision is deliberately
    // prepared before the production reducer performs its one live bump.
    let mut f = Fixture::new();
    f.state.state_revision = u64::MAX - 1;
    let receipt = f.arm();
    assert_eq!(f.state.state_revision, u64::MAX);
    let overflow = witness(&f.state);
    assert!(f
        .undo
        .compare_restore(&mut f.state, BINDING, receipt, |_| panic!(
            "decoder must not run"
        ))
        .is_err());
    assert_eq!(witness(&f.state), overflow);
}
