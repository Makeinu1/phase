//! One experimental host-RAM checkpoint for a completed ordinary cast.
//!
//! This is a table-agreed prototype contract, not a casting-rule override.
//! All actions still enter the existing authenticated reducer. No checkpoint,
//! receipt, or lifecycle state is part of GameState or its persistence format.

use crate::types::ability::{AbilityCost, Effect, ManaContribution, ManaProduction};
use crate::types::actions::GameAction;
use crate::types::card_type::{CoreType, Supertype};
use crate::types::events::GameEvent;
use crate::types::game_state::{
    ActionResult, CastOccurrence, CastingVariant, GameState, PriorityPassingMode, StackPaidSnapshot,
    TrustedGameStateEnvelope, WaitingFor,
};
use crate::types::identifiers::{CardId, ObjectId};
use crate::types::interaction::InteractionSubmission;
use crate::types::mana::ManaSourcePenalty;
use crate::types::player::PlayerId;
use crate::types::zones::Zone;
use crate::types::ActionRejection;

// Initial operational limits, not measured heap or target-device safety budgets.
// Entries count retained structure; arbitrary strings/ability payloads remain uncounted.
#[derive(Clone, Copy)]
struct UndoCapacityLimits {
    objects: usize,
    zone_items: usize,
    deck_pool_items: usize,
    history_lki_items: usize,
    journal_items: usize,
    checkpoint_bytes: usize,
}

const UNDO_CAPACITY_LIMITS: UndoCapacityLimits = UndoCapacityLimits {
    objects: 512,
    zone_items: 2048,
    deck_pool_items: 2048,
    history_lki_items: 4096,
    journal_items: 4096,
    checkpoint_bytes: 1024 * 1024,
};

fn checked_item_sum(items: impl IntoIterator<Item = usize>) -> Option<usize> {
    items.into_iter().try_fold(0usize, usize::checked_add)
}

impl UndoCapacityLimits {
    fn admits_structure(self, state: &GameState) -> bool {
        let zones = checked_item_sum(
            [
                state.battlefield.len(),
                state.stack.len(),
                state.exile.len(),
                state.command_zone.len(),
            ]
            .into_iter()
            .chain(state.players.iter().flat_map(|player| {
                [player.hand.len(), player.library.len(), player.graveyard.len()]
            })),
        );
        // All thirteen registered/current vectors count entries, not card quantities.
        let pools = checked_item_sum(state.deck_pools.iter().flat_map(|pool| {
            [
                pool.registered_main.len(),
                pool.registered_sideboard.len(),
                pool.current_main.len(),
                pool.current_sideboard.len(),
                pool.registered_companion.len(),
                pool.current_companion.len(),
                pool.registered_commander.len(),
                pool.current_commander.len(),
                pool.registered_signature_spell.len(),
                pool.current_signature_spell.len(),
                pool.registered_planar_deck.len(),
                pool.registered_scheme_deck.len(),
                pool.current_scheme_deck.len(),
            ]
        }));
        let history = checked_item_sum(
            [
                state.zone_changes_this_turn.len(),
                state.player_actions_this_turn.len(),
                state.lki_cache.len(),
                state.lki_copiable_values.len(),
            ]
            .into_iter()
            .chain(
                state
                    .spells_cast_this_game_by_player
                    .values()
                    .map(|items| items.len()),
            )
            .chain(
                state
                    .spells_cast_this_turn_by_player
                    .values()
                    .map(|items| items.len()),
            )
            .chain(state.lki_by_incarnation.values().map(|items| items.len()))
            .chain(state.departed_stack_spells.values().map(|items| items.len()))
            .chain(state.linked_exile_lki.values().map(|items| items.len())),
        );
        let journal = &state.resolved_rules_journal;
        let journal = checked_item_sum([
            journal.entries().len(),
            journal.nodes().len(),
            journal.produced_mana().len(),
            journal.spent_mana().len(),
        ]);
        state.objects.len() <= self.objects
            && zones.is_some_and(|count| count <= self.zone_items)
            && pools.is_some_and(|count| count <= self.deck_pool_items)
            && history.is_some_and(|count| count <= self.history_lki_items)
            && journal.is_some_and(|count| count <= self.journal_items)
    }

    fn admits_json(self, json: &str) -> bool {
        json.len() <= self.checkpoint_bytes
    }
}

fn capture_pre(state: &GameState) -> Result<String, serde_json::Error> {
    let mut pre = state.clone();
    pre.capture_rng_word_pos();
    serde_json::to_string(&TrustedGameStateEnvelope::capture(pre))
}

/// Live bindings are owned by the host runtime and never rewound with PRE.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostUndoBinding {
    pub incarnation: u64,
    pub database: u64,
    pub claim: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HostUndoPhase {
    #[default]
    Empty,
    Pending,
    Armed,
    Invalidated,
    Consumed,
}

struct Case {
    receipt: u64,
    binding: HostUndoBinding,
    caster: PlayerId,
    object: ObjectId,
    card: CardId,
    pre: String,
    pre_revision: u64,
    post: Option<Post>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Post {
    revision: u64,
    occurrence: CastOccurrence,
    paid: StackPaidSnapshot,
}

/// A single case, with nonreused allocation outside the restorable state.
#[derive(Default)]
pub struct HostPrecastUndo {
    next_receipt: u64,
    case: Option<Case>,
    phase: HostUndoPhase,
}

impl HostPrecastUndo {
    pub fn phase(&self) -> HostUndoPhase {
        self.phase
    }

    pub fn receipt(&self) -> Option<u64> {
        self.case.as_ref().map(|case| case.receipt)
    }

    /// Call before every independent mutation attempt, including early errors.
    /// Read-only cache probes and trusted exports must not call this method.
    pub fn invalidate(&mut self) {
        self.case = None;
        self.phase = HostUndoPhase::Invalidated;
    }

    pub fn submit_action(
        &mut self,
        state: &mut GameState,
        binding: HostUndoBinding,
        actor: PlayerId,
        action: GameAction,
    ) -> Result<ActionResult, ActionRejection> {
        self.submit_action_with_capture(state, binding, actor, action, capture_pre)
    }

    fn submit_action_with_capture(
        &mut self,
        state: &mut GameState,
        binding: HostUndoBinding,
        actor: PlayerId,
        action: GameAction,
        capture: impl FnOnce(&GameState) -> Result<String, serde_json::Error>,
    ) -> Result<ActionResult, ActionRejection> {
        self.before_action_with_capture(state, binding, actor, actor, &action, capture);
        let result = super::engine::apply_with_rejection(state, actor, action);
        self.after_action(state, &result);
        result
    }

    pub fn submit_interaction(
        &mut self,
        state: &mut GameState,
        binding: HostUndoBinding,
        actor: PlayerId,
        submission: InteractionSubmission,
    ) -> Result<super::interaction::AppliedInteraction, ActionRejection> {
        let result = super::interaction::submit_interaction_with_rejection_observed(
            state,
            actor,
            submission,
            |state, resolved| match resolved {
                Some((owner, action)) => {
                    self.before_action(state, binding, actor, owner, action);
                }
                None => self.invalidate(),
            },
        );
        match &result {
            Ok(applied) => self.after_action(state, &Ok(applied.result.clone())),
            Err(_) => self.invalidate(),
        }
        result
    }

    fn before_action(
        &mut self,
        state: &GameState,
        binding: HostUndoBinding,
        actor: PlayerId,
        owner: PlayerId,
        action: &GameAction,
    ) {
        self.before_action_with_capture(state, binding, actor, owner, action, capture_pre);
    }

    fn before_action_with_capture(
        &mut self,
        state: &GameState,
        binding: HostUndoBinding,
        actor: PlayerId,
        owner: PlayerId,
        action: &GameAction,
        capture: impl FnOnce(&GameState) -> Result<String, serde_json::Error>,
    ) {
        if self.phase == HostUndoPhase::Pending
            && self.case.as_ref().is_some_and(|case| {
                case.binding == binding
                    && actor == case.caster
                    && owner == case.caster
                    && ordinary_payment(state, case)
                    && match action {
                        GameAction::PassPriority => true,
                        GameAction::TapLandForMana { selection } => {
                            // Validate the semantic selection through the same
                            // engine authority the reducer uses; no card-name test.
                            super::mana_sources::preflight_tap_land_action(state, actor, action)
                                .is_ok()
                                && ordinary_mana_board(state, actor)
                                && super::mana_sources::live_land_mana_option_for_selection(
                                    state, owner, selection,
                                )
                                .is_ok_and(|option| ordinary_mana_option(&option))
                        }
                        _ => false,
                    }
            })
        {
            return;
        }
        self.invalidate();
        let GameAction::CastSpell {
            object_id,
            card_id,
            targets,
            ..
        } = action
        else {
            return;
        };
        if actor != owner
            || !targets.is_empty()
            || !UNDO_CAPACITY_LIMITS.admits_structure(state)
            || !eligible_pre(state, actor, *object_id, *card_id)
        {
            return;
        }
        let Some(receipt) = self.next_receipt.checked_add(1) else {
            return;
        };
        let Ok(pre_json) = capture(state) else {
            return;
        };
        // This bounds retained JSON only, not serializer clone/Value/sort scratch peaks.
        if !UNDO_CAPACITY_LIMITS.admits_json(&pre_json) {
            return;
        }
        self.next_receipt = receipt;
        self.case = Some(Case {
            receipt,
            binding,
            caster: actor,
            object: *object_id,
            card: *card_id,
            pre: pre_json,
            pre_revision: state.state_revision,
            post: None,
        });
        self.phase = HostUndoPhase::Pending;
    }

    fn after_action(&mut self, state: &GameState, result: &Result<ActionResult, ActionRejection>) {
        let (Some(case), Ok(result)) = (&mut self.case, result) else {
            self.invalidate();
            return;
        };
        if !result.disposition.is_applied()
            || result
                .events
                .iter()
                .any(|event| matches!(event, GameEvent::PriorityPassed { .. }))
        {
            self.invalidate();
            return;
        }
        let cast_count = result
            .events
            .iter()
            .filter(|event| {
                matches!(event, GameEvent::SpellCast { object_id, card_id, controller, .. }
                if *object_id == case.object && *card_id == case.card && *controller == case.caster)
            })
            .count();
        if cast_count == 1 {
            if let Some(post) = finalized_post(state, case) {
                case.post = Some(post);
                self.phase = HostUndoPhase::Armed;
                return;
            }
        } else if cast_count == 0 && ordinary_payment(state, case) {
            return;
        }
        self.invalidate();
    }

    /// Compare and install synchronously while the caller owns live state.
    /// `decode` is the runtime's existing checked trusted decode/rehydrate path.
    /// It prepares a candidate; it must not install or resume that candidate.
    pub fn compare_restore(
        &mut self,
        state: &mut GameState,
        binding: HostUndoBinding,
        receipt: u64,
        decode: impl FnOnce(&str) -> Result<GameState, String>,
    ) -> Result<u64, String> {
        let case = self.case.as_ref().ok_or("checkpoint is unavailable")?;
        if self.phase != HostUndoPhase::Armed
            || case.receipt != receipt
            || case.binding != binding
            || case.post.as_ref() != finalized_post(state, case).as_ref()
        {
            return Err("checkpoint does not match the live completed cast".into());
        }
        let revision = state
            .state_revision
            .checked_add(1)
            .ok_or("live revision exhausted")?;
        let mut restored = decode(&case.pre)?;
        if !eligible_pre(&restored, case.caster, case.object, case.card) {
            return Err("decoded checkpoint is outside the admitted PRE boundary".into());
        }
        // Permissions are live capabilities, never grants taken from PRE.
        restored.debug_mode = state.debug_mode;
        restored.debug_permitted = state.debug_permitted.clone();
        restored.state_revision = revision;
        *state = restored;
        self.case = None;
        self.phase = HostUndoPhase::Consumed;
        Ok(revision)
    }
}

fn controls_held(state: &GameState) -> bool {
    state.viewer_projection.is_none()
        && state.players.len() == 2
        && state.auto_pass.is_empty()
        && state.players.iter().all(|player| {
            state.priority_passing_mode(player.id) == PriorityPassingMode::FullControl
        })
}

fn settled(state: &GameState, caster: PlayerId) -> bool {
    controls_held(state)
        && state.waiting_for == (WaitingFor::Priority { player: caster })
        && state.priority_player == caster
        && !state.withholds_priority()
        && state.resolution_stack.is_empty()
        && state.resolving_stack_entry.is_none()
        && state.stack_resolution_session.is_none()
        && state.pending_resolution_completion.is_none()
        && state.pending_replacement.is_none()
        && state.pending_trigger.is_none()
        && state.pending_trigger_entry.is_none()
        && state.pending_trigger_order.is_none()
        && state.pending_trigger_event_batch.is_empty()
        && state.deferred_triggers.is_empty()
        && state.pending_activations.is_empty()
}

fn eligible_pre(state: &GameState, caster: PlayerId, object: ObjectId, card: CardId) -> bool {
    settled(state, caster)
        && state.stack.is_empty()
        && state.delayed_triggers.is_empty()
        && state.pending_spell_cost_reductions.is_empty()
        && state.pending_next_spell_modifiers.is_empty()
        && ordinary_mana_board(state, caster)
        && state.objects.get(&object).is_some_and(|object| {
            object.card_id == card
                && object.owner == caster
                && object.controller == caster
                && object.zone == Zone::Hand
                && object.card_types.core_types.contains(&CoreType::Creature)
                && object.abilities.is_empty()
                && object.keywords.is_empty()
                && object.trigger_definitions.is_empty()
                && object.static_definitions.is_empty()
                && object.replacement_definitions.is_empty()
                && !object.mana_cost.has_x()
                && !object.face_down
        })
}

fn ordinary_mana_option(option: &super::mana_sources::ManaSourceOption) -> bool {
    option.penalty == ManaSourcePenalty::None
        && option.atomic_combination.is_none()
        && option.restrictions.is_empty()
        && option.taps_for_mana_overrides.is_empty()
}

/// The first F contract admits an otherwise empty board of ordinary basic
/// lands. Check both source shape and engine-owned live mana classification;
/// legal mana alone does not prove that a payment has no extra effect.
fn ordinary_mana_board(state: &GameState, caster: PlayerId) -> bool {
    state.transient_continuous_effects.is_empty()
        && state.battlefield.iter().all(|id| {
            let Some(object) = state.objects.get(id) else { return false };
            object.card_types.core_types == [CoreType::Land]
                && object.card_types.supertypes == [Supertype::Basic]
                && object.keywords.is_empty()
                && object.trigger_definitions.is_empty()
                && object.static_definitions.is_empty()
                && object.replacement_definitions.is_empty()
                && object.abilities.iter().all(|ability| {
                    ability.cost == Some(AbilityCost::Tap)
                        && matches!(ability.effect.as_ref(), Effect::Mana {
                            produced: ManaProduction::Fixed { colors, contribution: ManaContribution::Base },
                            restrictions, grants, expiry: None, target: None,
                        } if colors.len() == 1 && restrictions.is_empty() && grants.is_empty())
                })
                && super::mana_sources::activatable_mana_options(state, *id, caster)
                    .iter().all(ordinary_mana_option)
        })
}

fn ordinary_payment(state: &GameState, case: &Case) -> bool {
    controls_held(state)
        && matches!(state.waiting_for, WaitingFor::ManaPayment { player, .. } if player == case.caster)
        && state.pending_cast.as_ref().is_some_and(|pending| {
            pending.object_id == case.object
                && pending.card_id == case.card
                && pending.ability.controller == case.caster
                && pending.origin_zone == Zone::Hand
                && pending.casting_variant == CastingVariant::Normal
                && pending.activation_cost_snapshot.is_none()
                && pending.activation_cost.is_none()
                && pending.activation_ability_index.is_none()
                && pending.pending_loyalty_activation_player.is_none()
                && pending.deferred_random_discard_cost.is_none()
                && pending.additional_cost_flow.is_none()
                && pending.deferred_required_additional_cost.is_none()
                && pending.additional_cost_queue.is_empty()
                && pending.deferred_modal_choice.is_none()
                && !pending.deferred_target_selection
                && pending.target_constraints.is_empty()
        })
        && state.resolution_stack.is_empty()
        && state.resolving_stack_entry.is_none()
        && state.pending_replacement.is_none()
        && state.pending_trigger.is_none()
}

fn finalized_post(state: &GameState, case: &Case) -> Option<Post> {
    if !settled(state, case.caster)
        || state.state_revision <= case.pre_revision
        || state.stack.len() != 1
    {
        return None;
    }
    let entry = state.stack.front()?;
    let crate::types::game_state::StackEntryKind::Spell {
        card_id,
        casting_variant: CastingVariant::Normal,
        actual_mana_spent,
        ..
    } = &entry.kind
    else {
        return None;
    };
    let object = state.objects.get(&case.object)?;
    let paid = state.stack_paid_facts.get(&case.object)?;
    let occurrence = object.cast_occurrence?;
    let record = state
        .spells_cast_this_turn_by_player
        .get(&case.caster)?
        .get(occurrence.turn_journal_index as usize)?;
    if entry.id != case.object
        || entry.source_id != case.object
        || entry.controller != case.caster
        || *card_id != case.card
        || object.card_id != case.card
        || object.zone != Zone::Stack
        || occurrence.caster != case.caster
        || record.spell_object_id != Some(case.object)
        || record.from_zone != Zone::Hand
        || record.cast_variant != CastingVariant::Normal
        || paid.casting_variant != CastingVariant::Normal
        || paid.actual_mana_spent != *actual_mana_spent
        || object.mana_spent_to_cast_amount != *actual_mana_spent
        || paid.x_value.is_some()
        || paid.kickers_paid != 0
        || paid.additional_cost_payment_count != 0
        || !paid.additional_cost_payments.is_empty()
        || paid.additional_cost_paid
    {
        return None;
    }
    Some(Post {
        revision: state.state_revision,
        occurrence,
        paid: paid.clone(),
    })
}

#[cfg(test)]
#[path = "host_precast_undo_tests.rs"]
mod tests;
