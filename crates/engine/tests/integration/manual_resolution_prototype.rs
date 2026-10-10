//! Action and interaction-boundary tests for the opt-in Manual continuation.
//! Uses synthetic definitions; no card generation or Oracle data is needed.

#[cfg(feature = "manual_resolution_prototype")]
mod enabled_tests {
    use engine::game::engine::apply;
    use engine::game::interaction::{
        bind_interaction_authority, derive_viewer_interaction, submit_interaction,
    };
    use engine::game::scenario::{GameRunner, GameScenario};
    use engine::game::visibility::filter_state_for_viewer;
    use engine::types::ability::{
        AbilityDefinition, AbilityKind, Effect, QuantityExpr, QuantityModification,
        ReplacementDefinition, ResolvedAbility, TargetFilter,
    };
    use engine::types::actions::GameAction;
    use engine::types::events::GameEvent;
    use engine::types::game_state::{
        GameState, PersistedGameState, PersistedRestoreError, PersistedRestoreFinalization,
        WaitingFor,
    };
    use engine::types::identifiers::ObjectId;
    use engine::types::interaction::{
        InteractionActionCode, InteractionAvailability, InteractionChoiceId, InteractionId,
        InteractionOpportunityResponse, InteractionReasonCode, InteractionResponse,
        InteractionSessionId, InteractionSubmission, ManualResolutionDecision,
    };
    use engine::types::mana::ManaCost;
    use engine::types::phase::Phase;
    use engine::types::player::PlayerId;
    use engine::types::replacements::ReplacementEvent;
    use engine::types::triggers::TriggerMode;

    fn designated_runner() -> (GameRunner, PlayerId, PlayerId, ObjectId, ObjectId) {
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let spell = scenario
            .add_spell_to_hand(p0, "Manual Prototype", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        runner.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .act(GameAction::DesignateManualResolution { stack_entry_id })
            .expect("controller can designate an ordinary hand-cast spell");
        (runner, p0, p1, spell, stack_entry_id)
    }

    fn enter_manual_wait(runner: &mut GameRunner, player: PlayerId, stack_entry_id: ObjectId) {
        runner
            .act(GameAction::PassPriority)
            .expect("first player passes");
        runner
            .act(GameAction::PassPriority)
            .expect("second player passes into manual wait");
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution {
                player: waiting_player,
                stack_entry_id: waiting_id,
            } if waiting_player == player && waiting_id == stack_entry_id
        ));
    }

    fn viewer_interaction(
        state: &GameState,
        viewer: PlayerId,
    ) -> engine::types::interaction::ViewerInteraction {
        let filtered = filter_state_for_viewer(state, viewer);
        derive_viewer_interaction(state, &filtered, viewer)
    }

    fn submit_loss(
        runner: &mut GameRunner,
        player: PlayerId,
        interaction_id: InteractionId,
        amount: u32,
    ) -> engine::game::interaction::AppliedInteraction {
        submit_interaction(
            runner.state_mut(),
            player,
            InteractionSubmission {
                interaction_id,
                response: InteractionResponse::ManualResolution {
                    decision: ManualResolutionDecision::LoseOwnLife { amount },
                },
            },
        )
        .expect("bounded life-loss choice is accepted through the interaction boundary")
    }

    fn finish_choice_id(state: &GameState, player: PlayerId) -> InteractionChoiceId {
        let view = viewer_interaction(state, player);
        let opportunity = view
            .opportunities
            .first()
            .expect("manual opportunity exists");
        let InteractionOpportunityResponse::Schema { spec, candidates } = &opportunity.response
        else {
            panic!("manual-resolution response uses its explicit schema");
        };
        assert!(matches!(
            spec,
            engine::types::interaction::InteractionResponseSpec::ManualResolution {
                min_life_loss: 1,
                max_life_loss,
                ..
            } if *max_life_loss == i32::MAX as u32
        ));
        assert_eq!(candidates.len(), 1, "Finish is the one exact candidate");
        assert!(candidates[0].surfaces.iter().any(|surface| matches!(
            surface,
            engine::types::interaction::InteractionPresentationSurface::Action {
                code: InteractionActionCode::FinishManualResolution,
                ..
            }
        )));
        candidates[0].id.clone()
    }

    fn stack_resolved_count(events: &[GameEvent], entry: ObjectId) -> usize {
        events
            .iter()
            .filter(|event| matches!(event, GameEvent::StackResolved { object_id } if *object_id == entry))
            .count()
    }

    fn manual_finish_preview(
        state: &GameState,
        player: PlayerId,
    ) -> engine::types::interaction::InteractionPreviewStatus {
        let view = viewer_interaction(state, player);
        let request = engine::types::interaction::InteractionPreviewRequest {
            request_id: engine::types::interaction::PreviewRequestId("stuck-diagnostic".into()),
            interaction_id: view.opportunities[0].interaction_id.clone(),
            response: InteractionResponse::ManualResolution {
                decision: ManualResolutionDecision::Finish {
                    choice_id: finish_choice_id(state, player),
                },
            },
        };
        engine::game::interaction::preview_interaction(state, player, &request).status
    }

    #[test]
    fn stuck_diagnostic_accepts_legal_manual_progress_without_mutating_state() {
        let (mut runner, player, _, _, entry) = designated_runner();
        enter_manual_wait(&mut runner, player, entry);
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("manual-stuck-diagnostic".into()),
        )
        .unwrap();
        let before = runner.state().clone();
        assert!(engine::ai_support::legal_actions_full(&before).0.is_empty());
        assert!(matches!(
            manual_finish_preview(&before, player),
            engine::types::interaction::InteractionPreviewStatus::Confirmable
        ));
        assert!(engine::ai_support::stuck_decision_diagnostic(runner.state()).is_none());
        assert_eq!(runner.state(), &before);
    }

    #[test]
    fn stuck_diagnostic_retains_manual_with_rejected_carrier_or_authority() {
        let (mut runner, player, other, _, entry) = designated_runner();
        enter_manual_wait(&mut runner, player, entry);
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("manual-stuck-diagnostic-invalid".into()),
        )
        .unwrap();
        let mut missing_carrier = runner.state().clone();
        missing_carrier.resolving_stack_entry = None;
        assert!(matches!(
            manual_finish_preview(&missing_carrier, player),
            engine::types::interaction::InteractionPreviewStatus::Rejected { .. }
        ));
        let mut unbound = runner.state().clone();
        unbound.interaction_session_id = None;
        unbound.active_interaction_slots.clear();
        assert!(viewer_interaction(&unbound, player)
            .opportunities
            .is_empty());
        let mut wrong_owner = runner.state().clone();
        wrong_owner.waiting_for = WaitingFor::ManualResolution {
            player: other,
            stack_entry_id: entry,
        };
        bind_interaction_authority(
            &mut wrong_owner,
            InteractionSessionId("manual-stuck-diagnostic-wrong-owner".into()),
        )
        .unwrap();
        assert!(matches!(
            manual_finish_preview(&wrong_owner, other),
            engine::types::interaction::InteractionPreviewStatus::Rejected { .. }
        ));
        for (state, actor) in [
            (missing_carrier, player),
            (unbound, player),
            (wrong_owner, other),
        ] {
            let before = state.clone();
            let diagnostic = engine::ai_support::stuck_decision_diagnostic(&state)
                .expect("Manual without a legal admitted response is still stuck");
            assert_eq!(diagnostic.waiting_for_kind, "ManualResolution");
            assert_eq!(diagnostic.stuck_players, vec![actor]);
            assert_eq!(state, before);
        }
    }

    #[test]
    fn stuck_diagnostic_retains_unsatisfiable_non_manual_decision() {
        let mut state = GameState::new_two_player(42);
        state.waiting_for = WaitingFor::NamedChoice {
            free_entry: None,
            player: PlayerId(0),
            choice_type: engine::types::ability::ChoiceType::Labeled { options: vec![] },
            options: vec![],
            source: None,
            persist_player: None,
        };
        let before = state.clone();
        assert!(engine::ai_support::legal_actions_full(&state).0.is_empty());
        let diagnostic = engine::ai_support::stuck_decision_diagnostic(&state).unwrap();
        assert_eq!(diagnostic.waiting_for_kind, "NamedChoice");
        assert_eq!(diagnostic.stuck_players, vec![PlayerId(0)]);
        assert_eq!(state, before);
    }

    #[test]
    fn unrelated_response_preserves_lower_designated_occurrence() {
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let designated = scenario
            .add_spell_to_hand(p0, "Manual Lower Spell", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let response = scenario
            .add_spell_to_hand_from_oracle(p1, "Response", true, "You gain 1 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        runner.cast(designated).commit();
        let designated_entry = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .act(GameAction::DesignateManualResolution {
                stack_entry_id: designated_entry,
            })
            .expect("designation is accepted before the responder acts");
        runner
            .act(GameAction::PassPriority)
            .expect("controller passes priority");
        runner.cast(response).commit();
        let response_entry = runner
            .state()
            .stack
            .back()
            .expect("response is on stack")
            .id;
        runner
            .act(GameAction::PassPriority)
            .expect("response controller passes");
        let resolved_response = runner
            .act(GameAction::PassPriority)
            .expect("unrelated response resolves normally");
        assert_eq!(
            stack_resolved_count(&resolved_response.events, response_entry),
            1
        );
        assert_eq!(
            stack_resolved_count(&resolved_response.events, designated_entry),
            0
        );
        assert_eq!(runner.state().players[p1.0 as usize].life, 21);
        assert!(runner
            .state()
            .stack
            .iter()
            .any(|entry| entry.id == designated_entry));
        enter_manual_wait(&mut runner, p0, designated_entry);
    }

    #[test]
    fn interaction_boundary_repeats_loss_rotates_ids_restores_v6_and_finishes_once() {
        let (mut runner, p0, _, spell, stack_entry_id) = designated_runner();
        enter_manual_wait(&mut runner, p0, stack_entry_id);
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("manual-prototype-session".to_string()),
        )
        .expect("manual wait binds authenticated interaction authority");

        let checkpoint = PersistedGameState::capture(runner.state().clone());
        let checkpoint_wire = serde_json::to_value(&checkpoint).expect("trusted save serializes");
        assert_eq!(checkpoint_wire["state"]["resolution_state_version"], 6);
        let checked_checkpoint =
            serde_json::from_value::<PersistedGameState>(checkpoint_wire.clone())
                .expect("trusted v6 save decodes")
                .prepare_for_restore(PersistedRestoreFinalization::Immediate)
                .expect("trusted v6 manual wait passes checked restore")
                .finalize_immediately()
                .expect("trusted restore finalizes");
        assert!(matches!(
            checked_checkpoint.waiting_for,
            WaitingFor::ManualResolution { .. }
        ));

        let before_view = viewer_interaction(runner.state(), p0);
        assert!(matches!(
            before_view.availability,
            InteractionAvailability::InputRequired
        ));
        let first_id = before_view.opportunities[0].interaction_id.clone();
        let source_id = runner
            .state()
            .resolving_stack_entry
            .as_ref()
            .expect("manual source remains in its sole carrier")
            .source_id;
        let first = submit_loss(&mut runner, p0, first_id.clone(), 1);
        assert!(matches!(
            first.action,
            GameAction::ApplyManualLifeLoss {
                stack_entry_id: action_id,
                amount: 1
            } if action_id == stack_entry_id
        ));
        assert_eq!(runner.state().players[p0.0 as usize].life, 19);
        assert!(first.result.events.iter().any(|event| matches!(
            event,
            GameEvent::LifeChanged { player_id, amount: -1, .. } if *player_id == p0
        )));
        assert!(
            first.result.events.iter().any(|event| matches!(
                event,
                GameEvent::EffectResolved {
                    kind: engine::types::ability::EffectKind::LoseLife,
                    source_id: event_source,
                    subject: None,
                } if *event_source == source_id
            )),
            "manual loss is attributed to the exact designated source"
        );
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution { .. }
        ));

        let second_id = viewer_interaction(runner.state(), p0).opportunities[0]
            .interaction_id
            .clone();
        assert_ne!(
            first_id, second_id,
            "a successful operation rotates the capability"
        );
        submit_loss(&mut runner, p0, second_id.clone(), 1);
        assert_eq!(runner.state().players[p0.0 as usize].life, 18);
        let before_stale_replay = runner.state().clone();
        let stale = submit_interaction(
            runner.state_mut(),
            p0,
            InteractionSubmission {
                interaction_id: first_id.clone(),
                response: InteractionResponse::ManualResolution {
                    decision: ManualResolutionDecision::LoseOwnLife { amount: 1 },
                },
            },
        )
        .expect_err("a replay with the old capability is rejected");
        assert_eq!(stale.code, InteractionReasonCode::StaleInteraction);
        assert_eq!(runner.state(), &before_stale_replay);

        // Simulate Undo by restoring the actual checked trusted checkpoint and binding a fresh
        // session namespace. A pre-Undo capability cannot be replayed against the restored wait.
        let mut restored = checked_checkpoint;
        bind_interaction_authority(
            &mut restored,
            InteractionSessionId("manual-prototype-after-undo".to_string()),
        )
        .expect("restored manual wait receives a fresh capability namespace");
        let restored_view = viewer_interaction(&restored, p0);
        let after_undo_id = restored_view.opportunities[0].interaction_id.clone();
        assert_ne!(first_id, after_undo_id);
        let stale_after_undo = submit_interaction(
            &mut restored,
            p0,
            InteractionSubmission {
                interaction_id: second_id,
                response: InteractionResponse::ManualResolution {
                    decision: ManualResolutionDecision::LoseOwnLife { amount: 1 },
                },
            },
        )
        .expect_err("pre-Undo interaction cannot address the restored decision");
        assert_eq!(
            stale_after_undo.code,
            InteractionReasonCode::StaleInteraction
        );
        assert_eq!(restored.players[p0.0 as usize].life, 20);

        let mut runner = GameRunner::from_state(restored);
        submit_loss(&mut runner, p0, after_undo_id, 1);
        assert_eq!(runner.state().players[p0.0 as usize].life, 19);
        let finish_id = viewer_interaction(runner.state(), p0).opportunities[0]
            .interaction_id
            .clone();
        let choice_id = finish_choice_id(runner.state(), p0);
        let finished = submit_interaction(
            runner.state_mut(),
            p0,
            InteractionSubmission {
                interaction_id: finish_id.clone(),
                response: InteractionResponse::ManualResolution {
                    decision: ManualResolutionDecision::Finish {
                        choice_id: choice_id.clone(),
                    },
                },
            },
        )
        .expect("Finish uses the authenticated common action boundary");
        assert!(
            matches!(finished.action, GameAction::FinishManualResolution { stack_entry_id: id } if id == stack_entry_id)
        );
        assert_eq!(
            stack_resolved_count(&finished.result.events, stack_entry_id),
            1
        );
        assert!(runner.state().players[p0.0 as usize]
            .graveyard
            .contains(&spell));

        let before_duplicate = runner.state().clone();
        assert!(apply(
            runner.state_mut(),
            p0,
            GameAction::FinishManualResolution { stack_entry_id }
        )
        .is_err());
        assert_eq!(runner.state(), &before_duplicate);
        assert!(submit_interaction(
            runner.state_mut(),
            p0,
            InteractionSubmission {
                interaction_id: finish_id,
                response: InteractionResponse::ManualResolution {
                    decision: ManualResolutionDecision::Finish { choice_id },
                },
            },
        )
        .is_err());
        assert_eq!(runner.state(), &before_duplicate);

        let after_finish = apply(runner.state_mut(), p0, GameAction::PassPriority)
            .expect("the next ordinary action proceeds after Finish");
        assert_eq!(
            stack_resolved_count(&after_finish.events, stack_entry_id),
            0
        );
    }

    #[test]
    fn actor_source_and_numeric_rejections_are_atomic() {
        let (mut runner, p0, p1, _, stack_entry_id) = designated_runner();
        enter_manual_wait(&mut runner, p0, stack_entry_id);
        for (actor, action) in [
            (
                p1,
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id,
                    amount: 1,
                },
            ),
            (
                p0,
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id: ObjectId(stack_entry_id.0.saturating_add(1)),
                    amount: 1,
                },
            ),
            (
                p0,
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id,
                    amount: 0,
                },
            ),
            (
                p0,
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id,
                    amount: i32::MAX as u32 + 1,
                },
            ),
        ] {
            let before = runner.state().clone();
            assert!(apply(runner.state_mut(), actor, action).is_err());
            assert_eq!(runner.state(), &before, "rejected operation is atomic");
        }
    }

    #[test]
    fn replacement_choice_after_manual_request_rejects_without_fallback() {
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let mut doubler = ReplacementDefinition::new(ReplacementEvent::LoseLife)
            .quantity_modification(QuantityModification::DOUBLE);
        doubler.valid_player = Some(engine::types::ability::ReplacementPlayerScope::AnyPlayer);
        scenario
            .add_creature(p0, "Manual Loss Doubler", 2, 2)
            .with_replacement_definition(doubler);
        let mut plus_one = ReplacementDefinition::new(ReplacementEvent::LoseLife)
            .quantity_modification(QuantityModification::Plus { value: 1 });
        plus_one.valid_player = Some(engine::types::ability::ReplacementPlayerScope::AnyPlayer);
        scenario
            .add_creature(p1, "Manual Loss Plus One", 2, 2)
            .with_replacement_definition(plus_one);
        let spell = scenario
            .add_spell_to_hand(p0, "Manual Loss Source", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        runner.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .act(GameAction::DesignateManualResolution { stack_entry_id })
            .expect("designation does not preflight a later life-loss choice");
        enter_manual_wait(&mut runner, p0, stack_entry_id);

        let before = runner.state().clone();
        assert!(apply(
            runner.state_mut(),
            p0,
            GameAction::ApplyManualLifeLoss {
                stack_entry_id,
                amount: 3,
            },
        )
        .is_err());
        assert_eq!(runner.state(), &before);
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution { .. }
        ));
        assert_eq!(runner.state().players[p0.0 as usize].life, 20);
    }

    #[test]
    fn manual_life_loss_collects_existing_life_loss_trigger_observers() {
        let p0 = PlayerId(0);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let observer = scenario
            .add_creature(p0, "Life Loss Observer", 1, 1)
            .with_trigger_definition(
                engine::types::ability::TriggerDefinition::new(TriggerMode::LifeLost).execute(
                    AbilityDefinition::new(
                        AbilityKind::Database,
                        Effect::GainLife {
                            amount: QuantityExpr::Fixed { value: 1 },
                            player: TargetFilter::Controller,
                        },
                    ),
                ),
            )
            .id();
        let spell = scenario
            .add_spell_to_hand(p0, "Manual Loss Observer Source", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        runner.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .act(GameAction::DesignateManualResolution { stack_entry_id })
            .expect("ordinary spell can be designated");
        enter_manual_wait(&mut runner, p0, stack_entry_id);
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("manual-trigger-observer".to_string()),
        )
        .expect("native manual interaction binds");
        let interaction_id = viewer_interaction(runner.state(), p0).opportunities[0]
            .interaction_id
            .clone();
        let result = submit_loss(&mut runner, p0, interaction_id, 1);
        assert!(result.result.events.iter().any(|event| matches!(
            event,
            GameEvent::LifeChanged { player_id, amount: -1, .. } if *player_id == p0
        )));
        assert_eq!(
            runner.state().deferred_triggers.len(),
            1,
            "the LifeLost observer is collected exactly once during the manual wait"
        );
        assert_eq!(
            runner.state().stack.len(),
            0,
            "observer has not reached the stack"
        );
        assert_eq!(runner.state().players[p0.0 as usize].life, 19);
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution { .. }
        ));
        let finished = apply(
            runner.state_mut(),
            p0,
            GameAction::FinishManualResolution { stack_entry_id },
        )
        .expect("Finish drains deferred observers through the ordinary post-resolution pipeline");
        assert_eq!(stack_resolved_count(&finished.events, stack_entry_id), 1);
        assert!(runner.state().deferred_triggers.is_empty());
        assert_eq!(
            runner.state().stack.len(),
            1,
            "exactly one observer trigger reaches the stack"
        );
        assert_eq!(
            runner
                .state()
                .stack
                .back()
                .expect("observer is on stack")
                .source_id,
            observer
        );
        assert_eq!(
            runner.state().players[p0.0 as usize].life,
            19,
            "observer does not resolve at Finish"
        );
        runner
            .act(GameAction::PassPriority)
            .expect("first pass for observer");
        runner
            .act(GameAction::PassPriority)
            .expect("second pass resolves observer");
        assert_eq!(runner.state().players[p0.0 as usize].life, 20);
        assert!(runner.state().stack.is_empty());
    }

    fn execute_quantity_runner(quantity: QuantityExpr) -> (GameRunner, PlayerId, ObjectId) {
        let p0 = PlayerId(0);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let replacement =
            ReplacementDefinition::new(ReplacementEvent::LoseLife).execute(AbilityDefinition::new(
                AbilityKind::Database,
                Effect::LoseLife {
                    amount: quantity,
                    target: Some(TargetFilter::Controller),
                },
            ));
        assert!(
            replacement.quantity_modification.is_none(),
            "exercise the parsed execute quantity path"
        );
        scenario
            .add_creature(p0, "Execute Quantity Replacement", 1, 1)
            .with_replacement_definition(replacement);
        let spell = scenario
            .add_spell_to_hand(p0, "Bounded Quantity Source", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        runner.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("spell on stack").id;
        runner
            .act(GameAction::DesignateManualResolution { stack_entry_id })
            .expect("designation accepted");
        enter_manual_wait(&mut runner, p0, stack_entry_id);
        (runner, p0, stack_entry_id)
    }

    #[test]
    fn parsed_execute_double_rejects_signed_overflow_atomically() {
        let (mut runner, p0, stack_entry_id) = execute_quantity_runner(QuantityExpr::Multiply {
            factor: 2,
            inner: Box::new(QuantityExpr::Ref {
                qty: engine::types::ability::QuantityRef::EventContextAmount,
            }),
        });
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("parsed-double-overflow".into()),
        )
        .expect("bind manual interaction");
        let before = runner.state().clone();
        let error = apply(
            runner.state_mut(),
            p0,
            GameAction::ApplyManualLifeLoss {
                stack_entry_id,
                amount: 1_073_741_824,
            },
        )
        .expect_err("parsed x2 must reject before overflowing signed arithmetic");
        assert!(matches!(
            error,
            engine::game::engine::EngineError::InvalidAction(_)
        ));
        assert_eq!(runner.state(), &before);
        let interaction_id = viewer_interaction(runner.state(), p0).opportunities[0]
            .interaction_id
            .clone();
        assert!(submit_interaction(
            runner.state_mut(),
            p0,
            InteractionSubmission {
                interaction_id: interaction_id.clone(),
                response: InteractionResponse::ManualResolution {
                    decision: ManualResolutionDecision::LoseOwnLife {
                        amount: 1_073_741_824
                    },
                },
            }
        )
        .is_err());
        assert_eq!(runner.state(), &before);
        submit_loss(&mut runner, p0, interaction_id, 3);
        assert_eq!(
            runner.state().players[p0.0 as usize].life,
            14,
            "representable parsed multiplication still executes"
        );
    }

    #[test]
    fn bounded_execute_quantities_reject_overflow_and_unsupported_without_fallback() {
        use engine::types::ability::QuantityRef;
        for quantity in [
            QuantityExpr::Offset {
                inner: Box::new(QuantityExpr::Fixed { value: i32::MAX }),
                offset: 1,
            },
            QuantityExpr::Sum {
                exprs: vec![
                    QuantityExpr::Fixed { value: i32::MAX },
                    QuantityExpr::Fixed { value: 1 },
                ],
            },
            QuantityExpr::Difference {
                left: Box::new(QuantityExpr::Fixed { value: i32::MIN }),
                right: Box::new(QuantityExpr::Fixed { value: 1 }),
            },
            QuantityExpr::Power {
                base: 2,
                exponent: Box::new(QuantityExpr::Fixed { value: 31 }),
            },
            QuantityExpr::Ref {
                qty: QuantityRef::LifeTotal {
                    player: engine::types::ability::PlayerScope::Controller,
                },
            },
            QuantityExpr::Ref {
                qty: QuantityRef::HandSize {
                    player: engine::types::ability::PlayerScope::Controller,
                },
            },
        ] {
            let (mut runner, p0, stack_entry_id) = execute_quantity_runner(quantity);
            let before = runner.state().clone();
            assert!(apply(
                runner.state_mut(),
                p0,
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id,
                    amount: 1
                }
            )
            .is_err());
            assert_eq!(runner.state(), &before);
        }
        // A rounding numerator can exceed i32 while the quotient fits.
        let (mut runner, p0, stack_entry_id) =
            execute_quantity_runner(QuantityExpr::DivideRounded {
                inner: Box::new(QuantityExpr::Fixed { value: i32::MAX }),
                divisor: 2,
                rounding: engine::types::ability::RoundingMode::Up,
            });
        runner.state_mut().players[p0.0 as usize].life = i32::MAX;
        apply(
            runner.state_mut(),
            p0,
            GameAction::ApplyManualLifeLoss {
                stack_entry_id,
                amount: 1,
            },
        )
        .expect("the large representable rounded result has no arbitrary cap");
        assert_eq!(runner.state().players[p0.0 as usize].life, 1_073_741_823);

        // Synthetic one-shot definitions isolate continuation allocation from
        // recurring replacements; these are typed fixtures, not card readings.
        for (label, quantity, modification, sentinel, captured, expected_loss, expected_changes) in [
            (
                "ordinary life total",
                QuantityExpr::Ref {
                    qty: QuantityRef::LifeTotal {
                        player: engine::types::ability::PlayerScope::Controller,
                    },
                },
                None,
                false,
                false,
                1,
                vec![(-1, 19), (-19, 0)],
            ),
            (
                "ordinary hand size",
                QuantityExpr::Ref {
                    qty: QuantityRef::HandSize {
                        player: engine::types::ability::PlayerScope::Controller,
                    },
                },
                None,
                false,
                false,
                1,
                vec![(-1, 19), (-3, 16)],
            ),
            (
                "folded scalar template",
                QuantityExpr::Fixed { value: 3 },
                None,
                false,
                false,
                3,
                vec![(-3, 17)],
            ),
            (
                "structured modifier with execute",
                QuantityExpr::Fixed { value: 3 },
                Some(QuantityModification::Times { factor: 2 }),
                false,
                false,
                2,
                vec![(-2, 18), (-3, 15)],
            ),
            (
                "sentinel scalar template",
                QuantityExpr::Fixed { value: 3 },
                None,
                true,
                false,
                1,
                vec![(-1, 19), (-3, 16)],
            ),
            (
                "captured continuation",
                QuantityExpr::Fixed { value: 3 },
                None,
                false,
                true,
                3,
                vec![(-3, 17), (1, 18)],
            ),
        ] {
            let p0 = PlayerId(0);
            let p1 = PlayerId(1);
            let mut scenario = GameScenario::new();
            scenario
                .at_phase(Phase::PreCombatMain)
                .with_life(p0, 20)
                .with_life(p1, 31)
                .with_cards_in_hand(p0, &["P0 Hand A", "P0 Hand B", "P0 Hand C"])
                .with_cards_in_hand(p1, &["P1 Hand A", "P1 Hand B"])
                .with_graveyard(
                    p0,
                    &["P0 Grave A", "P0 Grave B", "P0 Grave C", "P0 Grave D"],
                )
                .with_graveyard(p1, &["P1 Grave A"]);
            let mut replacement = ReplacementDefinition::new(ReplacementEvent::LoseLife).execute(
                AbilityDefinition::new(
                    AbilityKind::Database,
                    Effect::LoseLife {
                        amount: quantity,
                        target: Some(TargetFilter::Controller),
                    },
                ),
            );
            replacement.quantity_modification = modification;
            replacement.consume_on_apply = true;
            let selected = if sentinel {
                replacement.source_controller = Some(p0);
                ObjectId(0)
            } else {
                let mut source = scenario.add_creature(p1, "Selected Loss Replacement", 1, 1);
                source.controlled_by(p0);
                let source_id = source.id();
                if captured {
                    replacement = replacement.runtime_execute(ResolvedAbility::new(
                        Effect::GainLife {
                            amount: QuantityExpr::Fixed { value: 1 },
                            player: TargetFilter::Controller,
                        },
                        vec![],
                        source_id,
                        p0,
                    ));
                }
                source.with_replacement_definition(replacement.clone());
                source_id
            };
            let mut decoy_definition = ReplacementDefinition::new(ReplacementEvent::LoseLife)
                .execute(AbilityDefinition::new(
                    AbilityKind::Database,
                    Effect::LoseLife {
                        amount: QuantityExpr::Fixed { value: 11 },
                        target: Some(TargetFilter::Controller),
                    },
                ));
            decoy_definition.consume_on_apply = true;
            let decoy = scenario
                .add_creature(p1, "Other Controller Loss Decoy", 1, 1)
                .with_replacement_definition(decoy_definition)
                .id();
            let mut runner = scenario.build();
            let registry_index = runner.state().pending_damage_replacements.len();
            if sentinel {
                runner
                    .state_mut()
                    .pending_damage_replacements
                    .push(replacement);
                assert_eq!(
                    runner.state().pending_damage_replacements[registry_index].source_controller,
                    Some(p0),
                    "{label}"
                );
            } else {
                assert_eq!(runner.state().objects[&selected].owner, p1, "{label}");
                assert_eq!(runner.state().objects[&selected].controller, p0, "{label}");
                assert_eq!(
                    runner.state().objects[&selected].base_controller,
                    Some(p0),
                    "{label}"
                );
            }
            assert_eq!(runner.state().objects[&decoy].controller, p1, "{label}");
            assert_eq!(
                runner.state().players[p0.0 as usize].hand.len(),
                3,
                "{label}"
            );
            assert_eq!(
                runner.state().players[p0.0 as usize].graveyard.len(),
                4,
                "{label}"
            );
            assert_eq!(
                runner.state().players[p1.0 as usize].hand.len(),
                2,
                "{label}"
            );
            assert_eq!(
                runner.state().players[p1.0 as usize].graveyard.len(),
                1,
                "{label}"
            );
            let mut events = Vec::new();
            let lost = engine::game::effects::life::apply_life_loss(
                runner.state_mut(),
                p0,
                1,
                &mut events,
            )
            .expect("ordinary one-shot replacement and its continuation complete");
            let changes: Vec<_> = events
                .iter()
                .filter_map(|event| match event {
                    GameEvent::LifeChanged {
                        player_id,
                        amount,
                        new_total,
                    } => Some((*player_id, *amount, new_total.0)),
                    _ => None,
                })
                .collect();
            let expected: Vec<_> = expected_changes
                .iter()
                .map(|(amount, total)| (p0, *amount, Some(*total)))
                .collect();
            assert_eq!(changes, expected, "{label}");
            assert_eq!(lost, expected_loss, "{label}");
            assert_eq!(
                runner.state().players[p0.0 as usize].life,
                expected_changes.last().expect("case has life changes").1,
                "{label}"
            );
            assert_eq!(runner.state().players[p1.0 as usize].life, 31, "{label}");
            if sentinel {
                assert!(
                    runner.state().pending_damage_replacements[registry_index].is_consumed,
                    "{label}: exact selected registry entry was applied"
                );
            } else {
                assert!(
                    runner.state().objects[&selected].replacement_definitions[0].is_consumed,
                    "{label}: exact selected object definition was applied"
                );
            }
            assert!(
                !runner.state().objects[&decoy].replacement_definitions[0].is_consumed,
                "{label}: differently scoped decoy was not applied"
            );
            assert!(runner.state().pending_replacement.is_none(), "{label}");
            assert!(!runner.state().has_post_replacement_drain(), "{label}");
        }
    }

    fn install_control(state: &mut GameState, controller: PlayerId) {
        state.active_full_turn_control = Some(engine::types::game_state::ActivePlayerControl {
            controller,
            timestamp: 1,
        });
        state.turn_decision_controller = Some(controller);
        state.turn_decision_control_timestamp = Some(1);
        state.priority_player = controller;
    }

    #[test]
    fn controlled_player_designation_operation_and_checked_restore_are_rejected() {
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let spell = scenario
            .add_spell_to_hand(p0, "Controlled Designation Source", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        runner.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("spell on stack").id;
        install_control(runner.state_mut(), p1);
        for actor in [p0, p1] {
            let before = runner.state().clone();
            assert!(apply(
                runner.state_mut(),
                actor,
                GameAction::DesignateManualResolution { stack_entry_id }
            )
            .is_err());
            assert_eq!(
                runner.state(),
                &before,
                "controlled authority is rejected before takeover"
            );
        }
        // Validate an already active state too, including the authenticated
        // interaction projection that maps P0's decision authority to P1.
        let (mut runner, p0, p1, spell, stack_entry_id) = designated_runner();
        let valid_designation_wire =
            serde_json::to_value(PersistedGameState::capture(runner.state().clone()))
                .expect("valid designation serializes before control is installed");
        let mut controlled_designation = runner.state().clone();
        install_control(&mut controlled_designation, p1);
        enter_manual_wait(&mut runner, p0, stack_entry_id);
        let valid_manual_wait_wire =
            serde_json::to_value(PersistedGameState::capture(runner.state().clone()))
                .expect("valid manual wait serializes before control is installed");
        install_control(runner.state_mut(), p1);
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("controlled-manual".into()),
        )
        .expect("authority binds");
        for actor in [p0, p1] {
            for action in [
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id,
                    amount: 1,
                },
                GameAction::FinishManualResolution { stack_entry_id },
            ] {
                let before = runner.state().clone();
                let result = apply(runner.state_mut(), actor, action.clone());
                assert!(
                    result.is_err(),
                    "controlled actor {actor:?} must not apply {action:?}: {result:?}"
                );
                assert_eq!(runner.state(), &before, "actor {actor:?}, {action:?}");
            }
        }
        let interaction_id = viewer_interaction(runner.state(), p1).opportunities[0]
            .interaction_id
            .clone();
        let choice_id = finish_choice_id(runner.state(), p1);
        for actor in [p0, p1] {
            for decision in [
                ManualResolutionDecision::LoseOwnLife { amount: 1 },
                ManualResolutionDecision::Finish {
                    choice_id: choice_id.clone(),
                },
            ] {
                let before = runner.state().clone();
                let result = submit_interaction(
                    runner.state_mut(),
                    actor,
                    InteractionSubmission {
                        interaction_id: interaction_id.clone(),
                        response: InteractionResponse::ManualResolution {
                            decision: decision.clone(),
                        },
                    },
                );
                assert!(
                    result.is_err(),
                    "controlled actor {actor:?} must not submit {decision:?}: {result:?}"
                );
                assert_eq!(runner.state(), &before, "actor {actor:?}, {decision:?}");
            }
        }
        let source_scope_error =
            "manual-resolution designation is outside the supported source scope";
        for wire in [valid_designation_wire, valid_manual_wait_wire] {
            assert_eq!(wire["state"]["resolution_state_version"], 6);
            assert_eq!(
                wire["state"]["manual_resolution_state"]["data"]["binding"]["stack_entry_id"],
                stack_entry_id.0
            );
            let restored = serde_json::from_value::<PersistedGameState>(wire.clone())
                .expect("untouched trusted manual state decodes")
                .prepare_for_restore(PersistedRestoreFinalization::Immediate)
                .expect("untouched manual state passes checked restore")
                .finalize_immediately()
                .expect("untouched manual state finalizes successfully");
            let restored_entry = restored
                .resolving_stack_entry
                .as_ref()
                .or_else(|| restored.stack.back())
                .expect("designated spell retains its exact stack or resolving carrier");
            assert_eq!(restored_entry.id, stack_entry_id);
            assert_eq!(restored_entry.source_id, spell);
            assert_eq!(restored_entry.controller, p0);
            let restored_wire = serde_json::to_value(PersistedGameState::capture(restored))
                .expect("restored manual state remains serializable");
            for field in [
                "resolution_state_version",
                "manual_resolution_state",
                "stack",
                "resolving_stack_entry",
                "waiting_for",
            ] {
                assert_eq!(restored_wire["state"][field], wire["state"][field]);
            }

            // Preserve the valid envelope and manual source; install only the
            // same four control fields as the in-memory negative fixtures.
            let mut controlled_wire = wire.clone();
            controlled_wire["state"]["active_full_turn_control"] =
                serde_json::json!({ "controller": p1.0, "timestamp": 1 });
            controlled_wire["state"]["turn_decision_controller"] = serde_json::json!(p1.0);
            controlled_wire["state"]["turn_decision_control_timestamp"] = serde_json::json!(1);
            controlled_wire["state"]["priority_player"] = serde_json::json!(p1.0);
            let decoded = serde_json::from_value::<PersistedGameState>(controlled_wire)
                .expect("controlled trusted v6 fixture decodes before checked restore");
            assert!(
                matches!(
                    decoded.prepare_for_restore(PersistedRestoreFinalization::Immediate),
                    Err(PersistedRestoreError::UnsupportedFormat(reason))
                        if reason == source_scope_error
                ),
                "checked restore rejects controlled designation and active manual wait"
            );
        }
        for state in [controlled_designation, runner.state().clone()] {
            let error = serde_json::to_value(PersistedGameState::capture(state))
                .expect_err("already-controlled manual state is rejected during serialization");
            assert_eq!(error.to_string(), source_scope_error);
        }
    }
}

// Baseline native lifecycle and feature-off compatibility coverage.
#[cfg(feature = "manual_resolution_prototype")]
use engine::game::scenario::{GameRunner, GameScenario};
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::actions::{DebugAction, GameAction};
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::events::GameEvent;
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::game_state::{
    AutoPassMode, CastPaymentMode, GameState, PendingReplacement, PersistedGameState,
    PersistedRestoreFinalization, StackResolutionPolicy, WaitingFor,
};
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::identifiers::ObjectId;
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::keywords::{BuybackCost, Keyword};
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::mana::ManaCost;
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::phase::Phase;
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::player::PlayerId;
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::proposed_event::ProposedEvent;
#[cfg(feature = "manual_resolution_prototype")]
use engine::types::zones::Zone;

#[cfg(feature = "manual_resolution_prototype")]
mod enabled_baseline_tests {
    use super::*;
    use engine::game::engine::{apply, EngineError};
    use engine::types::ability::{
        AbilityDefinition, AbilityKind, ContinuousModification, ControllerRef, Duration, Effect,
        FilterProp, ReplacementDefinition, ReplacementMode, StaticDefinition, TargetFilter,
        TypedFilter,
    };
    use engine::types::game_state::{PersistedRestoreError, StackEntryKind};
    use engine::types::replacements::ReplacementEvent;
    use engine::types::zones::EtbTapState;

    // The shared integration harness remains the canonical test target per
    // AGENTS.md. This file is also checked and run only through the resource-safe
    // focused target configured in Cargo.toml when exercising these prototype
    // tests, avoiding a link of the full integration corpus.

    fn trusted_resolution_version(state: &GameState) -> u64 {
        serde_json::to_value(PersistedGameState::capture(state.clone()))
            .expect("trusted game state serializes")["state"]["resolution_state_version"]
            .as_u64()
            .expect("trusted wire declares its resolution version")
    }

    fn trusted_manual_designation(state: &GameState) -> Option<ObjectId> {
        state
            .manual_resolution_binding()
            .map(|binding| binding.stack_entry_id)
    }

    fn stack_resolved_count(events: &[GameEvent], stack_entry_id: ObjectId) -> usize {
        events
        .iter()
        .filter(|event| matches!(event, GameEvent::StackResolved { object_id } if *object_id == stack_entry_id))
        .count()
    }

    fn designated_runner() -> (GameRunner, PlayerId, ObjectId, ObjectId) {
        let p0 = PlayerId(0);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let spell = scenario
            .add_spell_to_hand_from_oracle(p0, "Manual Debug Guard", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        let stack_entry_id;
        {
            let mut cast = runner.cast(spell).commit();
            stack_entry_id = cast.state().stack.back().expect("cast is on stack").id;
            cast.act(GameAction::DesignateManualResolution { stack_entry_id })
                .expect("controller can designate the ordinary spell");
        }
        (runner, p0, spell, stack_entry_id)
    }

    fn enable_debug(runner: &mut GameRunner, actor: PlayerId) {
        let state = runner.state_mut();
        state.debug_mode = true;
        state.debug_permitted.insert(actor);
        state.format_config.allow_debug_actions = true;
    }

    fn assert_manual_state_checked_roundtrips(runner: &GameRunner, stack_entry_id: ObjectId) {
        let persisted = serde_json::to_value(PersistedGameState::capture(runner.state().clone()))
            .expect("manual state serializes with the trusted wire version");
        assert_eq!(persisted["state"]["resolution_state_version"], 6);
        assert_eq!(
            persisted["state"]["manual_resolution_state"]["data"]["binding"]["stack_entry_id"],
            stack_entry_id.0
        );
        let restored = serde_json::from_value::<PersistedGameState>(persisted)
            .expect("checked restore accepts the unchanged manual state")
            .prepare_for_restore(PersistedRestoreFinalization::Immediate)
            .expect("manual designation survives checked restore")
            .finalize_immediately()
            .expect("restore does not manufacture a priority pass");
        assert_eq!(restored.waiting_for, runner.state().waiting_for);
    }

    fn pending_destroy_replacement(source: ObjectId) -> PendingReplacement {
        PendingReplacement {
            proposed: ProposedEvent::Destroy {
                object_id: source,
                source: None,
                cant_regenerate: false,
                applied: Default::default(),
            },
            sacrifice_provenance: None,
            candidates: vec![engine::types::proposed_event::ReplacementId { source, index: 0 }],
            search_found_candidates: Vec::new(),
            depth: 0,
            is_optional: false,
            choice_player: None,
            library_placement: None,
            exile_controller: None,
            exile_duration: None,
            exile_tracking: engine::types::game_state::ZoneDeliveryExileTracking::None,
            excess_recipient: None,
            lifelink_bonus: 0,
            may_cost_paid: false,
            may_cost_remaining: None,
        }
    }

    fn optional_graveyard_exile_replacement() -> ReplacementDefinition {
        ReplacementDefinition::new(ReplacementEvent::Moved)
            .destination_zone(Zone::Graveyard)
            .mode(ReplacementMode::Optional { decline: None })
            .execute(AbilityDefinition::new(
                AbilityKind::Spell,
                Effect::ChangeZone {
                    destination: Zone::Exile,
                    origin: None,
                    target: TargetFilter::SelfRef,
                    owner_library: false,
                    enter_transformed: false,
                    enters_under: None,
                    enter_tapped: EtbTapState::Unspecified,
                    enters_attacking: false,
                    up_to: false,
                    enter_with_counters: vec![],
                    conditional_enter_with_counters: vec![],
                    face_down_profile: None,
                    enters_modified_if: None,
                },
            ))
    }

    #[test]
    fn designated_spell_waits_through_response_and_finishes_once_through_apply() {
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let designated = scenario
            .add_spell_to_hand_from_oracle(p0, "Manual Prototype", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let response = scenario
            .add_spell_to_hand_from_oracle(p1, "Response Prototype", true, "You gain 1 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let next_spell = scenario
            .add_spell_to_hand_from_oracle(p0, "Next Play", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();

        let mut builder = scenario.build();
        let mut runner = builder.cast(designated).commit();
        let designated_entry = runner.state().stack.back().expect("cast is on stack").id;
        assert_ne!(designated_entry, ObjectId(0));
        let initial_stack_len = runner.state().stack.len();
        runner.state_mut().auto_pass.insert(
            p0,
            AutoPassMode::UntilStackEmpty {
                initial_stack_len,
                policy: StackResolutionPolicy::Committed,
            },
        );
        runner
            .act(GameAction::DesignateManualResolution {
                stack_entry_id: designated_entry,
            })
            .expect("controller can designate their ordinary spell");
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::Priority { player } if player == p0
        ));
        runner.state_mut().auto_pass.remove(&p0);

        runner
            .act(GameAction::PassPriority)
            .expect("pass to response player");
        runner.cast(response).commit();
        let response_entry = runner
            .state()
            .stack
            .back()
            .expect("response is on stack")
            .id;
        runner
            .act(GameAction::PassPriority)
            .expect("response player passes");
        let response_resolution = runner
            .act(GameAction::PassPriority)
            .expect("resolve unrelated response");

        assert_eq!(
            stack_resolved_count(&response_resolution.events, response_entry),
            1
        );
        assert_eq!(runner.state().players[p1.0 as usize].life, 21);
        assert_eq!(runner.state().players[p0.0 as usize].life, 20);
        assert!(runner
            .state()
            .stack
            .iter()
            .any(|entry| entry.id == designated_entry));

        runner
            .act(GameAction::PassPriority)
            .expect("pass after response");
        runner
            .act(GameAction::PassPriority)
            .expect("enter manual-resolution wait");
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution {
                player,
                stack_entry_id
            } if player == p0 && stack_entry_id == designated_entry
        ));

        let persisted = serde_json::to_value(PersistedGameState::capture(runner.state().clone()))
            .expect("trusted snapshot serializes through the resolution wire");
        assert_eq!(persisted["state"]["resolution_state_version"], 6);
        assert!(serde_json::from_value::<GameState>(persisted["state"].clone()).is_err());
        let mut mislabeled_legacy = persisted.clone();
        mislabeled_legacy["state"]["resolution_state_version"] = 4.into();
        assert!(serde_json::from_value::<PersistedGameState>(mislabeled_legacy).is_err());
        let mut malformed_legacy_designation = persisted.clone();
        malformed_legacy_designation["state"]["resolution_state_version"] = 4.into();
        malformed_legacy_designation["state"]["manual_resolution_designation"] =
            "malformed-manual-marker".into();
        assert!(
            serde_json::from_value::<PersistedGameState>(malformed_legacy_designation).is_err()
        );
        let mut missing_v5_designation = persisted.clone();
        missing_v5_designation["state"]["manual_resolution_state"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<PersistedGameState>(missing_v5_designation).is_err());
        let restored = serde_json::from_value::<PersistedGameState>(persisted)
            .expect("manual state is recognized by the checked reader")
            .prepare_for_restore(PersistedRestoreFinalization::Immediate)
            .expect("active manual state passes checked restore")
            .finalize_immediately()
            .expect("active manual state finalizes without manufacturing a pass");
        assert_eq!(restored.waiting_for, runner.state().waiting_for);
        let restored_wire = serde_json::to_value(PersistedGameState::capture(restored.clone()))
            .expect("restored trusted state serializes");
        assert_eq!(
            restored_wire["state"]["manual_resolution_state"]["data"]["binding"]["stack_entry_id"],
            designated_entry.0
        );

        let finish = runner
            .act(GameAction::FinishManualResolution {
                stack_entry_id: designated_entry,
            })
            .expect("authenticated Finish takes the terminal path");
        assert_eq!(runner.state().players[p0.0 as usize].life, 20);
        assert_eq!(runner.state().objects[&designated].zone, Zone::Graveyard);
        assert_eq!(stack_resolved_count(&finish.events, designated_entry), 1);
        assert_eq!(stack_resolved_count(&finish.events, response_entry), 0);
        assert!(
            runner
                .act(GameAction::FinishManualResolution {
                    stack_entry_id: designated_entry,
                })
                .is_err(),
            "a completed designation cannot be finished twice"
        );
        assert_eq!(runner.state().players[p0.0 as usize].life, 20);

        runner.cast(next_spell).commit();
        let next_entry = runner
            .state()
            .stack
            .back()
            .expect("next play is on stack")
            .id;
        runner
            .act(GameAction::PassPriority)
            .expect("next player passes");
        let next_resolution = runner
            .act(GameAction::PassPriority)
            .expect("next play resolves normally after Finish");
        assert_eq!(runner.state().players[p0.0 as usize].life, 23);
        assert_eq!(stack_resolved_count(&next_resolution.events, next_entry), 1);
    }

    #[test]
    fn terminal_finish_holds_exact_spell_through_interactive_zone_replacement() {
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        scenario
            .add_creature(p1, "Optional Graveyard Exile", 1, 1)
            .with_replacement_definition(optional_graveyard_exile_replacement());
        let spell = scenario
            .add_spell_to_hand_from_oracle(p0, "Manual Replacement Probe", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let next_spell = scenario
            .add_spell_to_hand_from_oracle(p0, "Next Ordinary Play", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();

        let card_id = runner.state().objects[&spell].card_id;
        apply(
            runner.state_mut(),
            p0,
            GameAction::CastSpell {
                object_id: spell,
                card_id,
                targets: vec![],
                payment_mode: CastPaymentMode::Auto,
            },
        )
        .expect("the synthetic spell casts through the public engine boundary");
        let stack_entry_id = runner.state().stack.back().expect("spell is on stack").id;
        apply(
            runner.state_mut(),
            p0,
            GameAction::DesignateManualResolution { stack_entry_id },
        )
        .expect("the authenticated controller designates the exact source");
        apply(runner.state_mut(), p0, GameAction::PassPriority)
            .expect("the source controller passes priority");
        let paused = apply(runner.state_mut(), p1, GameAction::PassPriority)
            .expect("the response seat passes and the designated source pauses");
        assert!(matches!(
            paused.waiting_for,
            WaitingFor::ManualResolution {
                player,
                stack_entry_id: waiting_id,
            } if player == p0 && waiting_id == stack_entry_id
        ));

        let finish = apply(
            runner.state_mut(),
            p0,
            GameAction::FinishManualResolution { stack_entry_id },
        )
        .expect("Finish enters the replacement-aware terminal path");
        let chooser = match &runner.state().waiting_for {
            WaitingFor::ReplacementChoice {
                player, candidates, ..
            } => {
                assert!(
                    candidates
                        .iter()
                        .any(|candidate| candidate.description == "Accept"),
                    "the optional exile branch must be represented in the choice"
                );
                *player
            }
            other => panic!("Finish should pause on the optional zone replacement, got {other:?}"),
        };
        assert_eq!(
            runner.state().resolving_stack_entry.as_ref().map(|entry| entry.id),
            Some(stack_entry_id),
            "the exact source occurrence remains the resolving carrier while the zone move is parked"
        );
        assert!(matches!(
            runner
                .state()
                .pending_replacement
                .as_ref()
                .map(|pending| &pending.proposed),
            Some(ProposedEvent::ZoneChange { object_id, .. }) if *object_id == stack_entry_id
        ));
        assert_eq!(stack_resolved_count(&finish.events, stack_entry_id), 1);

        let before_duplicate =
            serde_json::to_value(runner.state()).expect("pending replacement state serializes");
        assert!(
            apply(
                runner.state_mut(),
                chooser,
                GameAction::FinishManualResolution { stack_entry_id },
            )
            .is_err(),
            "the authorized replacement chooser cannot submit Finish again while the child is pending"
        );
        assert_eq!(
            serde_json::to_value(runner.state()).expect("state still serializes"),
            before_duplicate,
            "a duplicate Finish rejection leaves the pending source and replacement unchanged"
        );

        let accept_index = match &runner.state().waiting_for {
            WaitingFor::ReplacementChoice { candidates, .. } => candidates
                .iter()
                .position(|candidate| candidate.description == "Accept")
                .expect("the accepted redirect index is available"),
            other => panic!("replacement choice should remain pending, got {other:?}"),
        };
        let replacement = apply(
            runner.state_mut(),
            chooser,
            GameAction::ChooseReplacement {
                index: accept_index,
            },
        )
        .expect("the authorized chooser accepts the replacement");
        assert_eq!(runner.state().objects[&spell].zone, Zone::Exile);
        assert!(runner.state().resolving_stack_entry.is_none());
        assert!(runner.state().pending_replacement.is_none());
        assert_eq!(
            stack_resolved_count(&finish.events, stack_entry_id)
                + stack_resolved_count(&replacement.events, stack_entry_id),
            1,
            "the exact source resolves once across the initial pause and replacement resume"
        );
        assert_eq!(runner.state().players[p0.0 as usize].life, 20);

        for _ in 0..2 {
            if matches!(runner.state().waiting_for, WaitingFor::Priority { player } if player == p0)
            {
                break;
            }
            let player = match &runner.state().waiting_for {
                WaitingFor::Priority { player } => *player,
                other => panic!("replacement completion should return priority, got {other:?}"),
            };
            apply(runner.state_mut(), player, GameAction::PassPriority)
                .expect("ordinary priority remains actionable after source finalization");
        }
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::Priority { player } if player == p0
        ));
        let next_card_id = runner.state().objects[&next_spell].card_id;
        apply(
            runner.state_mut(),
            p0,
            GameAction::CastSpell {
                object_id: next_spell,
                card_id: next_card_id,
                targets: vec![],
                payment_mode: CastPaymentMode::Auto,
            },
        )
        .expect("the next ordinary action is a legal cast");
        let next_entry = runner.state().stack.back().expect("next cast is on stack");
        assert_eq!(
            runner.state().objects[&next_spell].zone,
            Zone::Stack,
            "the legal next cast is on the stack after replacement completion"
        );
        assert_ne!(next_entry.id, stack_entry_id);
        assert_eq!(runner.state().players[p0.0 as usize].life, 20);
    }

    #[test]
    fn pending_manual_finish_replacement_checked_restores_and_rejects_wrong_actor() {
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        scenario
            .add_creature(p1, "Optional Graveyard Exile", 1, 1)
            .with_replacement_definition(optional_graveyard_exile_replacement());
        let spell = scenario
            .add_spell_to_hand_from_oracle(p0, "Manual Restore Probe", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let next_spell = scenario
            .add_spell_to_hand_from_oracle(p0, "Next Ordinary Play", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();

        let card_id = runner.state().objects[&spell].card_id;
        apply(
            runner.state_mut(),
            p0,
            GameAction::CastSpell {
                object_id: spell,
                card_id,
                targets: vec![],
                payment_mode: CastPaymentMode::Auto,
            },
        )
        .expect("the synthetic spell casts through the public engine boundary");
        let stack_entry_id = runner.state().stack.back().expect("spell is on stack").id;
        apply(
            runner.state_mut(),
            p0,
            GameAction::DesignateManualResolution { stack_entry_id },
        )
        .expect("the authenticated controller designates the exact source");
        apply(runner.state_mut(), p0, GameAction::PassPriority)
            .expect("the source controller passes priority");
        apply(runner.state_mut(), p1, GameAction::PassPriority)
            .expect("the response seat passes and the designated source pauses");
        let waiting_id = match &runner.state().waiting_for {
            WaitingFor::ManualResolution {
                player,
                stack_entry_id,
            } if *player == p0 => *stack_entry_id,
            ref other => panic!("expected the designated source to pause for P0, got {other:?}"),
        };
        assert_eq!(waiting_id, stack_entry_id);

        let finish = apply(
            runner.state_mut(),
            p0,
            GameAction::FinishManualResolution { stack_entry_id },
        )
        .expect("Finish enters the replacement-aware terminal path");
        let (chooser, accept_index) = match &runner.state().waiting_for {
            WaitingFor::ReplacementChoice {
                player, candidates, ..
            } => {
                let accept_index = candidates
                    .iter()
                    .position(|candidate| candidate.description == "Accept")
                    .expect("the optional exile branch is offered");
                (*player, accept_index)
            }
            other => panic!("Finish should create a real replacement prompt, got {other:?}"),
        };
        assert_eq!(
            runner
                .state()
                .resolving_stack_entry
                .as_ref()
                .map(|entry| entry.id),
            Some(stack_entry_id)
        );
        assert!(matches!(
            runner
                .state()
                .pending_replacement
                .as_ref()
                .map(|pending| &pending.proposed),
            Some(ProposedEvent::ZoneChange { object_id, .. }) if *object_id == stack_entry_id
        ));
        assert_eq!(stack_resolved_count(&finish.events, stack_entry_id), 1);

        let restored = serde_json::from_value::<PersistedGameState>(
            serde_json::to_value(PersistedGameState::capture(runner.state().clone()))
                .expect("pending replacement captures as a trusted snapshot"),
        )
        .expect("pending replacement trusted snapshot decodes")
        .prepare_for_restore(PersistedRestoreFinalization::Immediate)
        .expect("pending manual Finish state passes checked restore")
        .finalize_immediately()
        .expect("restore preserves the pending replacement without applying it");
        // The terminal child retains typed custody until the original carrier settles.
        assert_eq!(trusted_resolution_version(runner.state()), 6);
        assert!(matches!(
            &restored.waiting_for,
            WaitingFor::ReplacementChoice { player, .. } if *player == chooser
        ));
        assert_eq!(
            restored
                .resolving_stack_entry
                .as_ref()
                .map(|entry| entry.id),
            Some(stack_entry_id)
        );
        assert!(matches!(
            restored
                .pending_replacement
                .as_ref()
                .map(|pending| &pending.proposed),
            Some(ProposedEvent::ZoneChange { object_id, .. }) if *object_id == stack_entry_id
        ));
        runner = GameRunner::from_state(restored);

        let unauthorized = if chooser == p0 { p1 } else { p0 };
        let before_wrong_actor =
            serde_json::to_value(runner.state()).expect("restored prompt state serializes");
        assert!(
            apply(
                runner.state_mut(),
                unauthorized,
                GameAction::ChooseReplacement {
                    index: accept_index,
                },
            )
            .is_err(),
            "only the prompted replacement chooser may answer"
        );
        assert_eq!(
            serde_json::to_value(runner.state()).expect("state still serializes"),
            before_wrong_actor,
            "wrong-actor input leaves the checked-restored replacement untouched"
        );

        let replacement = apply(
            runner.state_mut(),
            chooser,
            GameAction::ChooseReplacement {
                index: accept_index,
            },
        )
        .expect("the authorized chooser settles the restored replacement");
        assert_eq!(runner.state().objects[&spell].zone, Zone::Exile);
        assert!(runner.state().resolving_stack_entry.is_none());
        assert!(runner.state().pending_replacement.is_none());
        assert_eq!(
            stack_resolved_count(&finish.events, stack_entry_id)
                + stack_resolved_count(&replacement.events, stack_entry_id),
            1,
            "checked restore and the accepted choice finalize this source once"
        );
        assert_eq!(runner.state().players[p0.0 as usize].life, 20);

        for _ in 0..2 {
            if matches!(runner.state().waiting_for, WaitingFor::Priority { player } if player == p0)
            {
                break;
            }
            let player = match &runner.state().waiting_for {
                WaitingFor::Priority { player } => *player,
                other => panic!("replacement completion should return priority, got {other:?}"),
            };
            apply(runner.state_mut(), player, GameAction::PassPriority)
                .expect("ordinary priority remains actionable after restore");
        }
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::Priority { player } if player == p0
        ));
        let next_card_id = runner.state().objects[&next_spell].card_id;
        apply(
            runner.state_mut(),
            p0,
            GameAction::CastSpell {
                object_id: next_spell,
                card_id: next_card_id,
                targets: vec![],
                payment_mode: CastPaymentMode::Auto,
            },
        )
        .expect("the next legal play survives checked restore");
        assert_eq!(runner.state().objects[&next_spell].zone, Zone::Stack);
        assert_eq!(runner.state().players[p0.0 as usize].life, 20);
    }

    #[test]
    fn undesignated_ordinary_spell_resolves_automatically_as_positive_control() {
        let p0 = PlayerId(0);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let spell = scenario
            .add_spell_to_hand_from_oracle(
                p0,
                "Automatic Positive Control",
                true,
                "You gain 3 life.",
            )
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut builder = scenario.build();
        let mut runner = builder.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .act(GameAction::PassPriority)
            .expect("first player passes");
        let resolution = runner
            .act(GameAction::PassPriority)
            .expect("undesignated spell resolves automatically");

        assert_eq!(runner.state().players[p0.0 as usize].life, 23);
        assert_eq!(stack_resolved_count(&resolution.events, stack_entry_id), 1);
    }

    #[test]
    fn countering_the_designated_occurrence_retires_its_marker() {
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let designated = scenario
            .add_spell_to_hand_from_oracle(
                p0,
                "Countered Manual Prototype",
                true,
                "You gain 3 life.",
            )
            .with_mana_cost(ManaCost::zero())
            .id();
        let counter = scenario
            .add_spell_to_hand_from_oracle(p1, "Counter Prototype", true, "Counter target spell.")
            .with_mana_cost(ManaCost::zero())
            .id();

        let mut builder = scenario.build();
        let mut runner = builder.cast(designated).commit();
        let designated_entry = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .act(GameAction::DesignateManualResolution {
                stack_entry_id: designated_entry,
            })
            .expect("controller can designate the ordinary spell");
        runner
            .act(GameAction::PassPriority)
            .expect("pass to counterspell player");
        runner
            .cast(counter)
            .target_object(designated_entry)
            .commit();
        let counter_entry = runner.state().stack.back().expect("counter is on stack").id;
        runner
            .act(GameAction::PassPriority)
            .expect("spell controller passes");
        let resolution = runner
            .act(GameAction::PassPriority)
            .expect("counter resolves against the designated occurrence");

        assert!(!runner
            .state()
            .stack
            .iter()
            .any(|entry| entry.id == designated_entry));
        assert_eq!(runner.state().objects[&designated].zone, Zone::Graveyard);
        assert_eq!(runner.state().objects[&counter].zone, Zone::Graveyard);
        assert_eq!(trusted_resolution_version(runner.state()), 4);
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::Priority { .. }
        ));
        assert_eq!(stack_resolved_count(&resolution.events, counter_entry), 1);
        assert_eq!(
        resolution
            .events
            .iter()
            .filter(|event| matches!(event, GameEvent::SpellCountered { object_id, countered_by, .. } if *object_id == designated_entry && *countered_by == counter_entry))
            .count(),
        1
    );
    }

    #[test]
    fn fizzled_designated_spell_uses_its_exact_terminal_occurrence() {
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let target = scenario.add_creature(p1, "Fizzle Target", 2, 2).id();
        let designated = scenario
            .add_spell_to_hand_from_oracle(
                p0,
                "Fizzle Manual Prototype",
                true,
                "Destroy target creature.",
            )
            .with_mana_cost(ManaCost::zero())
            .id();
        let response = scenario
            .add_spell_to_hand_from_oracle(
                p1,
                "Target Exile Response",
                true,
                "Exile target creature.",
            )
            .with_mana_cost(ManaCost::zero())
            .id();

        let mut builder = scenario.build();
        let mut runner = builder.cast(designated).target_object(target).commit();
        let designated_entry = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .act(GameAction::DesignateManualResolution {
                stack_entry_id: designated_entry,
            })
            .expect("controller can designate the targeted instant");
        runner
            .act(GameAction::PassPriority)
            .expect("pass to response player");
        runner.cast(response).target_object(target).commit();
        runner
            .act(GameAction::PassPriority)
            .expect("target spell controller passes");
        runner
            .act(GameAction::PassPriority)
            .expect("response resolves");
        runner
            .act(GameAction::PassPriority)
            .expect("return priority to designated controller");
        let fizzled = runner
            .act(GameAction::PassPriority)
            .expect("Begin applies the ordinary illegal-target fizzle");
        assert!(!matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution { .. }
        ));
        assert_eq!(runner.state().objects[&target].zone, Zone::Exile);
        assert_eq!(runner.state().objects[&designated].zone, Zone::Graveyard);
        assert_eq!(trusted_resolution_version(runner.state()), 4);
        assert_eq!(stack_resolved_count(&fizzled.events, designated_entry), 1);
        assert!(runner
            .act(GameAction::FinishManualResolution {
                stack_entry_id: designated_entry
            })
            .is_err());
    }

    #[test]
    fn rejects_a_resolution_exile_rider_before_taking_over() {
        let p0 = PlayerId(0);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let spell = scenario
            .add_spell_to_hand_from_oracle(p0, "Rider Prototype", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut builder = scenario.build();
        let mut runner = builder.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .state_mut()
            .objects
            .get_mut(&spell)
            .expect("spell object exists")
            .exile_from_stack_rider = Some(engine::types::ability::ExiledSpellRider::BecomePlotted);

        assert!(runner
            .act(GameAction::DesignateManualResolution { stack_entry_id })
            .is_err());
        assert_eq!(trusted_resolution_version(runner.state()), 4);
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::Priority { player } if player == p0
        ));
    }

    #[test]
    fn rejects_unsupported_resolution_hooks_before_taking_over() {
        let p0 = PlayerId(0);
        let source_scope_error = "manual resolution supports only an owned, controlled, ordinary hand-cast instant or sorcery without paid Buyback or an exile rider";
        for keyword in [
            None,
            Some(Keyword::Cipher),
            Some(Keyword::Paradigm),
            Some(Keyword::Rebound),
            Some(Keyword::Epic),
        ] {
            for is_instant in [true, false] {
                let mut scenario = GameScenario::new();
                scenario.at_phase(Phase::PreCombatMain);
                let mut card = scenario.add_spell_to_hand_from_oracle(
                    p0,
                    "Hook Prototype",
                    is_instant,
                    "You gain 3 life.",
                );
                card.with_mana_cost(ManaCost::zero());
                if let Some(keyword) = &keyword {
                    card.with_keyword(keyword.clone());
                }
                let spell = card.id();
                let mut runner = scenario.build();
                runner.cast(spell).commit();
                let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
                let before = runner.state().clone();
                let result = runner.act(GameAction::DesignateManualResolution { stack_entry_id });
                if keyword.is_some() {
                    assert!(matches!(
                        result,
                        Err(EngineError::InvalidAction(reason)) if reason == source_scope_error
                    ));
                    assert_eq!(runner.state(), &before);
                    assert_eq!(trusted_resolution_version(runner.state()), 4);
                } else {
                    result.expect("the same ordinary spell without a hook reaches designation");
                    assert_eq!(
                        trusted_manual_designation(runner.state()),
                        Some(stack_entry_id)
                    );
                }
                assert!(matches!(
                    runner.state().waiting_for,
                    WaitingFor::Priority { player } if player == p0
                ));
            }
        }
    }

    #[test]
    fn rejects_paid_buyback_before_taking_over() {
        let p0 = PlayerId(0);
        let source_scope_error = "manual resolution supports only an owned, controlled, ordinary hand-cast instant or sorcery without paid Buyback or an exile rider";
        for has_buyback in [false, true] {
            for (context_paid, facts_paid) in
                [(false, false), (true, false), (false, true), (true, true)]
            {
                let mut scenario = GameScenario::new();
                scenario.at_phase(Phase::PreCombatMain);
                let mut card = scenario.add_spell_to_hand_from_oracle(
                    p0,
                    "Buyback Prototype",
                    true,
                    "You gain 3 life.",
                );
                card.with_mana_cost(ManaCost::zero());
                if has_buyback {
                    card.with_keyword(Keyword::Buyback(BuybackCost::Mana(ManaCost::zero())));
                }
                let spell = card.id();
                let mut runner = scenario.build();
                if context_paid || facts_paid {
                    runner.cast(spell).accept_optional().commit();
                } else {
                    runner.cast(spell).decline_optional().commit();
                }
                let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
                let StackEntryKind::Spell {
                    ability: Some(ability),
                    ..
                } = &mut runner
                    .state_mut()
                    .stack
                    .back_mut()
                    .expect("cast is on stack")
                    .kind
                else {
                    panic!("synthetic instant has a resolved spell ability");
                };
                ability.context.additional_cost_paid = context_paid;
                runner
                    .state_mut()
                    .stack_paid_facts
                    .entry(stack_entry_id)
                    .or_default()
                    .additional_cost_paid = facts_paid;

                let before = runner.state().clone();
                let result = runner.act(GameAction::DesignateManualResolution { stack_entry_id });
                if has_buyback && (context_paid || facts_paid) {
                    assert!(matches!(
                        result,
                        Err(EngineError::InvalidAction(reason)) if reason == source_scope_error
                    ));
                    assert_eq!(runner.state(), &before);
                    assert_eq!(trusted_resolution_version(runner.state()), 4);
                } else {
                    result.expect("unpaid Buyback or paid facts without Buyback remain eligible");
                    assert_eq!(
                        trusted_manual_designation(runner.state()),
                        Some(stack_entry_id)
                    );
                    assert!(matches!(
                        runner.state().waiting_for,
                        WaitingFor::Priority { player } if player == p0
                    ));
                }
            }
        }
    }

    #[test]
    fn effective_resolution_hooks_follow_live_grants_and_removals() {
        let p0 = PlayerId(0);
        let source_scope_error = "manual resolution supports only an owned, controlled, ordinary hand-cast instant or sorcery without paid Buyback or an exile rider";
        for keyword in [
            Keyword::Cipher,
            Keyword::Paradigm,
            Keyword::Rebound,
            Keyword::Epic,
        ] {
            for printed in [false, true] {
                let mut scenario = GameScenario::new();
                scenario.at_phase(Phase::PreCombatMain);
                let source = scenario.add_creature(p0, "Keyword Source", 1, 1).id();
                let mut card = scenario.add_spell_to_hand_from_oracle(
                    p0,
                    "Effective Hook Prototype",
                    true,
                    "You gain 3 life.",
                );
                card.with_mana_cost(ManaCost::zero());
                if printed {
                    card.with_keyword(keyword.clone());
                }
                let spell = card.id();
                let mut runner = scenario.build();
                runner.cast(spell).commit();
                let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
                assert_eq!(stack_entry_id, spell);
                let StackEntryKind::Spell {
                    casting_variant, ..
                } = &runner.state().stack.back().expect("cast is on stack").kind
                else {
                    panic!("fixture reaches the spell-entry eligibility branch");
                };
                assert!(casting_variant.is_normal());
                let baseline = runner.state().clone();
                for apply_effect in [false, true] {
                    let mut runner = GameRunner::from_state(baseline.clone());
                    if apply_effect {
                        let modification = if printed {
                            ContinuousModification::RemoveKeyword {
                                keyword: keyword.clone(),
                            }
                        } else {
                            ContinuousModification::AddKeyword {
                                keyword: keyword.clone(),
                            }
                        };
                        runner
                            .state_mut()
                            .add_transient_continuous_effect(
                                source,
                                p0,
                                Duration::UntilEndOfTurn,
                                TargetFilter::SpecificObject { id: stack_entry_id },
                                vec![modification],
                                None,
                            )
                            .expect("the fixture's duration begins");
                    }
                    let object = &runner.state().objects[&stack_entry_id];
                    assert_eq!(object.zone, Zone::Stack);
                    assert_eq!(object.owner, p0);
                    assert_eq!(object.controller, p0);
                    assert_eq!(
                        runner
                            .state()
                            .stack
                            .back()
                            .expect("cast is on stack")
                            .ability()
                            .expect("ordinary instant fixture has a resolved ability")
                            .context
                            .cast_from_zone,
                        Some(Zone::Hand)
                    );
                    assert_eq!(object.keywords.contains(&keyword), printed);
                    assert_eq!(object.base_keywords.contains(&keyword), printed);
                    let before = runner.state().clone();
                    let result =
                        runner.act(GameAction::DesignateManualResolution { stack_entry_id });
                    if printed != apply_effect {
                        assert!(matches!(
                            result,
                            Err(EngineError::InvalidAction(reason)) if reason == source_scope_error
                        ));
                        assert_eq!(runner.state(), &before);
                    } else {
                        result.expect("hook-free sibling reaches manual designation");
                        assert_eq!(
                            trusted_manual_designation(runner.state()),
                            Some(stack_entry_id)
                        );
                        assert!(matches!(
                            runner.state().waiting_for,
                            WaitingFor::Priority { player } if player == p0
                        ));
                    }
                }
            }
        }
    }

    #[test]
    fn effective_buyback_uses_paid_facts_and_exact_keyword_identity() {
        let p0 = PlayerId(0);
        let buyback = Keyword::Buyback(BuybackCost::Mana(ManaCost::zero()));
        let source_scope_error = "manual resolution supports only an owned, controlled, ordinary hand-cast instant or sorcery without paid Buyback or an exile rider";
        for (printed_keyword, facts_paid, modification, rejected) in [
            (
                None,
                true,
                Some(ContinuousModification::AddKeyword {
                    keyword: buyback.clone(),
                }),
                [false, true],
            ),
            (
                None,
                false,
                Some(ContinuousModification::AddKeyword {
                    keyword: buyback.clone(),
                }),
                [false, false],
            ),
            (
                Some(buyback.clone()),
                true,
                Some(ContinuousModification::RemoveKeyword {
                    keyword: buyback.clone(),
                }),
                [true, false],
            ),
            (Some(Keyword::Banding), true, None, [false, false]),
        ] {
            let mut scenario = GameScenario::new();
            scenario.at_phase(Phase::PreCombatMain);
            let source = scenario.add_creature(p0, "Buyback Source", 1, 1).id();
            let mut card = scenario.add_spell_to_hand_from_oracle(
                p0,
                "Effective Buyback Prototype",
                true,
                "You gain 3 life.",
            );
            card.with_mana_cost(ManaCost::zero());
            if let Some(keyword) = &printed_keyword {
                card.with_keyword(keyword.clone());
            }
            let spell = card.id();
            let mut runner = scenario.build();
            runner.cast(spell).decline_optional().commit();
            let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
            let StackEntryKind::Spell {
                ability: Some(ability),
                ..
            } = &mut runner
                .state_mut()
                .stack
                .back_mut()
                .expect("cast is on stack")
                .kind
            else {
                panic!("synthetic instant has a resolved spell ability");
            };
            ability.context.additional_cost_paid = false;
            runner
                .state_mut()
                .stack_paid_facts
                .entry(stack_entry_id)
                .or_default()
                .additional_cost_paid = facts_paid;
            let baseline = runner.state().clone();
            for (apply_effect, reject) in [false, true].into_iter().zip(rejected) {
                if apply_effect && modification.is_none() {
                    continue;
                }
                let mut runner = GameRunner::from_state(baseline.clone());
                if apply_effect {
                    runner
                        .state_mut()
                        .add_transient_continuous_effect(
                            source,
                            p0,
                            Duration::UntilEndOfTurn,
                            TargetFilter::SpecificObject { id: stack_entry_id },
                            vec![modification.clone().expect("grant or removal case")],
                            None,
                        )
                        .expect("the fixture's duration begins");
                }
                assert_eq!(
                    runner.state().objects[&stack_entry_id].keywords,
                    baseline.objects[&stack_entry_id].keywords
                );
                let before = runner.state().clone();
                let result = runner.act(GameAction::DesignateManualResolution { stack_entry_id });
                if reject {
                    assert!(matches!(
                        result,
                        Err(EngineError::InvalidAction(reason)) if reason == source_scope_error
                    ));
                    assert_eq!(runner.state(), &before);
                } else {
                    result.expect(
                        "unpaid or removed Buyback and unrelated Unknown-kind keywords remain eligible",
                    );
                    assert_eq!(
                        trusted_manual_designation(runner.state()),
                        Some(stack_entry_id)
                    );
                    assert!(matches!(
                        runner.state().waiting_for,
                        WaitingFor::Priority { player } if player == p0
                    ));
                }
            }
        }
    }

    #[test]
    fn effective_hook_grants_are_scoped_to_the_selected_recipient() {
        let source_scope_error = "manual resolution supports only an owned, controlled, ordinary hand-cast instant or sorcery without paid Buyback or an exile rider";
        let p0 = PlayerId(0);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let sources = [
            scenario.add_creature(p0, "First Keyword Source", 1, 1).id(),
            scenario
                .add_creature(p0, "Second Keyword Source", 1, 1)
                .id(),
        ];
        let decoy = scenario
            .add_spell_to_hand(p0, "Decoy Stack Spell", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let candidate = scenario
            .add_spell_to_hand(p0, "Candidate Stack Spell", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        runner.cast(decoy).commit();
        let decoy_entry = runner.state().stack.back().expect("decoy is on stack").id;
        runner.cast(candidate).commit();
        let stack_entry_id = runner
            .state()
            .stack
            .back()
            .expect("candidate is on stack")
            .id;
        for source in sources {
            runner
                .state_mut()
                .add_transient_continuous_effect(
                    source,
                    p0,
                    Duration::UntilEndOfTurn,
                    TargetFilter::SpecificObject { id: decoy_entry },
                    vec![ContinuousModification::AddKeyword {
                        keyword: Keyword::Rebound,
                    }],
                    None,
                )
                .expect("the fixture's duration begins");
        }
        let baseline = runner.state().clone();
        for affected in [decoy_entry, stack_entry_id] {
            let mut runner = GameRunner::from_state(baseline.clone());
            if affected == stack_entry_id {
                runner.state_mut().transient_continuous_effects[0].affected =
                    TargetFilter::SpecificObject { id: affected };
            }
            assert_eq!(runner.state().stack.len(), 2);
            assert!(sources
                .iter()
                .all(|id| runner.state().objects[id].zone == Zone::Battlefield));
            assert!(!runner.state().objects[&stack_entry_id]
                .keywords
                .contains(&Keyword::Rebound));
            let before = runner.state().clone();
            let result = runner.act(GameAction::DesignateManualResolution { stack_entry_id });
            if affected == stack_entry_id {
                assert!(matches!(
                    result,
                    Err(EngineError::InvalidAction(reason)) if reason == source_scope_error
                ));
                assert_eq!(runner.state(), &before);
            } else {
                result.expect("two grants to the decoy do not veto the selected candidate");
                assert_eq!(
                    trusted_manual_designation(runner.state()),
                    Some(stack_entry_id)
                );
                assert!(matches!(
                    runner.state().waiting_for,
                    WaitingFor::Priority { player } if player == p0
                ));
            }
        }
    }

    #[test]
    fn effective_hook_static_uses_the_source_controller() {
        let source_scope_error = "manual resolution supports only an owned, controlled, ordinary hand-cast instant or sorcery without paid Buyback or an exile rider";
        let p0 = PlayerId(0);
        let p1 = PlayerId(1);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let source = scenario
            .add_creature(p1, "Controller Keyword Source", 1, 1)
            .with_static_definition(
                StaticDefinition::continuous()
                    .affected(TargetFilter::Typed(
                        TypedFilter::card()
                            .controller(ControllerRef::You)
                            .properties(vec![FilterProp::InAnyZone {
                                zones: vec![Zone::Stack],
                            }]),
                    ))
                    .modifications(vec![ContinuousModification::AddKeyword {
                        keyword: Keyword::Rebound,
                    }]),
            )
            .id();
        let spell = scenario
            .add_spell_to_hand(p0, "Controller Candidate", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        runner.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
        let baseline = runner.state().clone();
        for source_controller in [p1, p0] {
            let mut runner = GameRunner::from_state(baseline.clone());
            let source_object = runner
                .state_mut()
                .objects
                .get_mut(&source)
                .expect("source is live");
            source_object.controller = source_controller;
            source_object.base_controller = Some(source_controller);
            assert_eq!(runner.state().objects[&stack_entry_id].owner, p0);
            assert_eq!(runner.state().objects[&stack_entry_id].controller, p0);
            assert!(!runner.state().objects[&stack_entry_id]
                .keywords
                .contains(&Keyword::Rebound));
            let before = runner.state().clone();
            let result = runner.act(GameAction::DesignateManualResolution { stack_entry_id });
            if source_controller == p0 {
                assert!(matches!(
                    result,
                    Err(EngineError::InvalidAction(reason)) if reason == source_scope_error
                ));
                assert_eq!(runner.state(), &before);
            } else {
                result.expect("the opponent's source-relative grant does not affect P0's spell");
                assert_eq!(
                    trusted_manual_designation(runner.state()),
                    Some(stack_entry_id)
                );
                assert!(matches!(
                    runner.state().waiting_for,
                    WaitingFor::Priority { player } if player == p0
                ));
            }
        }
    }

    #[test]
    fn effective_hook_is_revalidated_for_manual_actions_and_checked_restore() {
        let p0 = PlayerId(0);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let source = scenario
            .add_creature(p0, "Live Revalidation Source", 1, 1)
            .id();
        let spell = scenario
            .add_spell_to_hand(p0, "Live Revalidation Spell", true)
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut runner = scenario.build();
        runner.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .act(GameAction::DesignateManualResolution { stack_entry_id })
            .expect("ordinary hand-cast spell is eligible before the grant");
        runner
            .act(GameAction::PassPriority)
            .expect("first player passes");
        runner
            .act(GameAction::PassPriority)
            .expect("second player enters manual wait");
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution { player, stack_entry_id: id }
                if player == p0 && id == stack_entry_id
        ));
        let baseline = runner.state().clone();
        let valid_wire = serde_json::to_value(PersistedGameState::capture(baseline.clone()))
            .expect("valid manual wait serializes before the grant");
        runner
            .state_mut()
            .add_transient_continuous_effect(
                source,
                p0,
                Duration::UntilEndOfTurn,
                TargetFilter::SpecificObject { id: stack_entry_id },
                vec![ContinuousModification::AddKeyword {
                    keyword: Keyword::Rebound,
                }],
                None,
            )
            .expect("the fixture's duration begins");
        assert!(!runner.state().objects[&stack_entry_id]
            .keywords
            .contains(&Keyword::Rebound));
        for action in [
            GameAction::ApplyManualLifeLoss {
                stack_entry_id,
                amount: 1,
            },
            GameAction::FinishManualResolution { stack_entry_id },
        ] {
            let mut control = GameRunner::from_state(runner.state().clone());
            let result = control
                .act(action.clone())
                .expect("a later hook does not replace the saved Begin latch");
            if matches!(action, GameAction::ApplyManualLifeLoss { .. }) {
                assert_eq!(control.state().players[p0.0 as usize].life, 19);
            } else {
                assert_eq!(stack_resolved_count(&result.events, stack_entry_id), 1);
                assert_eq!(control.state().objects[&spell].zone, Zone::Graveyard);
            }
        }
        let mut granted_wire = valid_wire;
        granted_wire["state"]["transient_continuous_effects"] =
            serde_json::to_value(&runner.state().transient_continuous_effects).unwrap();
        let restored = serde_json::from_value::<PersistedGameState>(granted_wire)
            .unwrap()
            .prepare_for_restore(PersistedRestoreFinalization::Immediate)
            .expect("checked restore honors Begin support latch")
            .finalize_immediately()
            .unwrap();
        assert_eq!(trusted_manual_designation(&restored), Some(stack_entry_id));
        assert_eq!(restored.waiting_for, baseline.waiting_for);
    }

    #[test]
    fn legitimate_v4_save_without_manual_state_remains_readable() {
        let runner = GameScenario::new().build();
        let persisted = serde_json::to_value(PersistedGameState::capture(runner.state().clone()))
            .expect("ordinary state serializes as a legacy-compatible v4 save");
        assert_eq!(persisted["state"]["resolution_state_version"], 4);
        assert!(persisted["state"]
            .get("manual_resolution_designation")
            .is_none());
        let restored = serde_json::from_value::<PersistedGameState>(persisted)
            .expect("ordinary v4 saves remain readable with the prototype enabled")
            .prepare_for_restore(PersistedRestoreFinalization::Immediate)
            .expect("ordinary v4 state passes checked restore")
            .finalize_immediately()
            .expect("ordinary v4 state finalizes");
        assert!(matches!(restored.waiting_for, WaitingFor::Priority { .. }));
    }

    #[test]
    fn pending_replacement_blocks_designation_without_mutating_state() {
        let p0 = PlayerId(0);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let spell = scenario
            .add_spell_to_hand_from_oracle(p0, "Replacement Admission", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut builder = scenario.build();
        let mut runner = builder.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
        runner.state_mut().pending_replacement = Some(pending_destroy_replacement(spell));
        let before = runner.state().clone();

        assert!(runner
            .act(GameAction::DesignateManualResolution { stack_entry_id })
            .is_err());
        assert_eq!(
            runner.state(),
            &before,
            "rejection leaves all state unchanged"
        );
    }

    #[test]
    fn rejects_a_spell_copy_before_taking_over() {
        let p0 = PlayerId(0);
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let spell = scenario
            .add_spell_to_hand_from_oracle(p0, "Spell Copy Admission", true, "You gain 3 life.")
            .with_mana_cost(ManaCost::zero())
            .id();
        let mut builder = scenario.build();
        let mut runner = builder.cast(spell).commit();
        let stack_entry_id = runner.state().stack.back().expect("cast is on stack").id;
        runner
            .state_mut()
            .objects
            .get_mut(&spell)
            .expect("spell object exists")
            .is_copy = true;
        let before = runner.state().clone();

        assert!(runner
            .act(GameAction::DesignateManualResolution { stack_entry_id })
            .is_err());
        assert_eq!(
            runner.state(),
            &before,
            "rejection leaves all state unchanged"
        );
    }

    #[test]
    fn debug_remove_object_is_rejected_without_changing_designated_state() {
        let (mut runner, p0, spell, stack_entry_id) = designated_runner();
        enable_debug(&mut runner, p0);
        let before = runner.state().clone();

        assert!(runner
            .act(GameAction::Debug(DebugAction::RemoveObject {
                object_id: spell
            }))
            .is_err());
        assert_eq!(
            runner.state(),
            &before,
            "rejection leaves all state unchanged"
        );
        assert!(runner.state().objects.contains_key(&spell));
        assert_manual_state_checked_roundtrips(&runner, stack_entry_id);
    }

    #[test]
    fn debug_set_phase_is_rejected_without_changing_active_manual_state() {
        let (mut runner, p0, _spell, stack_entry_id) = designated_runner();
        runner
            .act(GameAction::PassPriority)
            .expect("designated controller passes");
        runner
            .act(GameAction::PassPriority)
            .expect("opponent pass enters the manual wait");
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution { stack_entry_id: waiting_id, .. }
                if waiting_id == stack_entry_id
        ));
        enable_debug(&mut runner, p0);
        let before = runner.state().clone();

        assert!(runner
            .act(GameAction::Debug(DebugAction::SetPhase {
                phase: Phase::End,
                active_player: PlayerId(1),
            }))
            .is_err());
        assert_eq!(
            runner.state(),
            &before,
            "rejection leaves all state unchanged"
        );
        assert_manual_state_checked_roundtrips(&runner, stack_entry_id);
    }

    #[test]
    fn concede_remains_available_while_resolution_is_designated() {
        let (mut runner, p0, _spell, _stack_entry_id) = designated_runner();

        runner
            .act(GameAction::Concede { player_id: p0 })
            .expect("Concede remains available during a designation");
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::GameOver { .. }
        ));
        assert_eq!(trusted_resolution_version(runner.state()), 4);
    }
}

#[cfg(not(feature = "manual_resolution_prototype"))]
mod feature_off_restore_tests {
    use engine::game::scenario::GameScenario;
    use engine::types::game_state::{PersistedGameState, PersistedRestoreFinalization};
    use serde_json::Value;

    fn ordinary_v4_save() -> Value {
        let runner = GameScenario::new().build();
        let value = serde_json::to_value(PersistedGameState::capture(runner.state().clone()))
            .expect("ordinary state serializes");
        assert_eq!(value["state"]["resolution_state_version"], 4);
        assert!(value["state"]
            .get("manual_resolution_designation")
            .is_none());
        value
    }

    #[test]
    fn feature_off_reader_rejects_v5_and_any_non_null_manual_field_on_v4() {
        let ordinary = ordinary_v4_save();

        let mut v4_with_valid_marker = ordinary.clone();
        v4_with_valid_marker["state"]["manual_resolution_designation"] = 42.into();
        assert!(serde_json::from_value::<PersistedGameState>(v4_with_valid_marker).is_err());

        let mut v4_with_malformed_marker = ordinary.clone();
        v4_with_malformed_marker["state"]["manual_resolution_designation"] =
            "not-an-object-id".into();
        assert!(serde_json::from_value::<PersistedGameState>(v4_with_malformed_marker).is_err());

        let mut v4_with_current_marker = ordinary.clone();
        v4_with_current_marker["state"]["manual_resolution_state"] =
            serde_json::json!({"phase":"Armed","data":{"binding":{}}});
        assert!(serde_json::from_value::<PersistedGameState>(v4_with_current_marker).is_err());
        let mut enabled_build_v6_payload = ordinary.clone();
        enabled_build_v6_payload["state"]["resolution_state_version"] = 6.into();
        assert!(serde_json::from_value::<PersistedGameState>(enabled_build_v6_payload).is_err());
        let mut enabled_build_v5_payload = ordinary;
        enabled_build_v5_payload["state"]["resolution_state_version"] = 5.into();
        enabled_build_v5_payload["state"]["manual_resolution_designation"] = 42.into();
        assert!(serde_json::from_value::<PersistedGameState>(enabled_build_v5_payload).is_err());
    }

    #[test]
    fn feature_off_reader_checked_restores_an_ordinary_v4_save() {
        let ordinary = ordinary_v4_save();
        let restored = serde_json::from_value::<PersistedGameState>(ordinary)
            .expect("legacy-compatible v4 save stays readable")
            .prepare_for_restore(PersistedRestoreFinalization::Immediate)
            .expect("ordinary v4 save passes checked restore")
            .finalize_immediately()
            .expect("ordinary v4 save finalizes");
        assert!(matches!(
            restored.waiting_for,
            engine::types::game_state::WaitingFor::Priority { .. }
        ));
    }

    #[test]
    fn feature_off_paid_ordinary_controls_and_unknown_manual_fields_refuse() {
        use engine::types::ability::{Effect, QuantityExpr, TargetFilter};
        use engine::types::identifiers::ObjectId;
        use engine::types::mana::{ManaCost, ManaType, ManaUnit};
        use engine::types::phase::Phase;
        use engine::types::player::PlayerId;
        use engine::types::zones::Zone;
        let actor = PlayerId(0);
        for card in ["S", "N", "V"] {
            let mut scenario = GameScenario::new();
            scenario
                .at_phase(Phase::PreCombatMain)
                .with_life(actor, 20)
                .with_mana_pool(
                    actor,
                    vec![
                        ManaUnit::new(ManaType::Colorless, ObjectId(0), false, vec![]),
                        ManaUnit::new(ManaType::Colorless, ObjectId(0), false, vec![]),
                    ],
                );
            let source = if card == "V" {
                scenario
                    .add_creature_to_hand(actor, "OFF Vanilla V", 2, 2)
                    .with_mana_cost(ManaCost::generic(1))
                    .id()
            } else {
                scenario
                    .add_spell_to_hand(actor, &format!("OFF Ordinary {card}"), true)
                    .with_mana_cost(ManaCost::generic(1))
                    .with_ability(if card == "S" {
                        Effect::LoseLife {
                            amount: QuantityExpr::Fixed { value: 2 },
                            target: Some(TargetFilter::Controller),
                        }
                    } else {
                        Effect::GainLife {
                            amount: QuantityExpr::Fixed { value: 3 },
                            player: TargetFilter::Controller,
                        }
                    })
                    .id()
            };
            let mut runner = scenario.build();
            let outcome = runner.cast(source).resolve();
            outcome.assert_life_delta(
                actor,
                match card {
                    "S" => -2,
                    "N" => 3,
                    "V" => 0,
                    _ => unreachable!(),
                },
            );
            outcome.assert_zone(
                &[source],
                if card == "V" {
                    Zone::Battlefield
                } else {
                    Zone::Graveyard
                },
            );
            assert_eq!(runner.state().players[0].mana_pool.total(), 1);
        }
        let mut unknown = ordinary_v4_save();
        unknown["state"]["manual_resolution_future"] =
            serde_json::json!({"bodyAlreadySuppressed":true});
        assert!(
            serde_json::from_value::<PersistedGameState>(unknown).is_err(),
            "OFF must not discard unknown Manual custody and resume automatic play"
        );
    }
}

#[cfg(feature = "manual_resolution_prototype")]
mod p1_native_journey {
    use std::collections::{BTreeMap, BTreeSet};

    use engine::database::CardDatabase;
    use engine::game::derived_views::{manual_resolution_view, manual_resolution_view_for_source};
    use engine::game::engine::{apply, EngineError};
    use engine::game::interaction::{
        bind_interaction_authority, classify_manual_interaction, derive_viewer_interaction,
        manual_interaction_source, resolve_interaction_response, submit_interaction,
        ManualInteractionKind,
    };
    use engine::game::scenario::{GameRunner, GameScenario};
    use engine::game::visibility::filter_state_for_viewer;
    use engine::types::ability::{
        AbilityCost, AbilityDefinition, AbilityKind, AdditionalCost, AdditionalCostRepeatability,
        Effect, EffectScope, ManaContribution, ManaProduction, PtValue, QuantityExpr,
        QuantityModification, ReplacementDefinition, ReplacementMode, TapStateChange, TargetFilter,
        TargetRef, TriggerDefinition, TypeFilter, TypedFilter,
    };
    use engine::types::actions::GameAction;
    use engine::types::card::CardFace;
    use engine::types::events::GameEvent;
    use engine::types::game_state::{
        AutoPassMode, CastPaymentMode, CastingVariant, GameState, PersistedGameState,
        PersistedRestoreFinalization, StackEntryKind, StackResolutionPolicy,
        TrustedGameStateEnvelope, WaitingFor,
    };
    use engine::types::identifiers::{ObjectId, ObjectIncarnationRef};
    use engine::types::interaction::{
        InteractionOpportunityResponse, InteractionResponse, InteractionSessionId,
        InteractionSubmission, ManualResolutionDecision, ManualResolutionPhase,
    };
    use engine::types::keywords::{BuybackCost, Keyword};
    use engine::types::mana::{ManaColor, ManaCost, ManaType, ManaUnit};
    use engine::types::phase::Phase;
    use engine::types::player::PlayerId;
    use engine::types::replacements::ReplacementEvent;
    use engine::types::triggers::TriggerMode;
    use engine::types::zones::{EtbTapState, Zone};

    const A: PlayerId = PlayerId(0);
    const B: PlayerId = PlayerId(1);

    fn terminal_replacement() -> ReplacementDefinition {
        ReplacementDefinition::new(ReplacementEvent::Moved)
            .destination_zone(Zone::Graveyard)
            .mode(ReplacementMode::Optional { decline: None })
            .execute(AbilityDefinition::new(
                AbilityKind::Spell,
                Effect::ChangeZone {
                    destination: Zone::Exile,
                    origin: None,
                    target: TargetFilter::SelfRef,
                    owner_library: false,
                    enter_transformed: false,
                    enters_under: None,
                    enter_tapped: EtbTapState::Unspecified,
                    enters_attacking: false,
                    up_to: false,
                    enter_with_counters: vec![],
                    conditional_enter_with_counters: vec![],
                    face_down_profile: None,
                    enters_modified_if: None,
                },
            ))
    }

    fn fixed_scenario(
        replacement: bool,
        name: &str,
        instant: bool,
        body: Effect,
    ) -> (GameScenario, ObjectId, ObjectId) {
        let mut scenario = GameScenario::new();
        scenario
            .at_phase(Phase::PreCombatMain)
            .with_life(A, 20)
            .with_life(B, 20);
        let source = scenario
            .add_spell_to_hand(A, name, instant)
            .with_mana_cost(ManaCost::generic(1))
            .with_ability(body)
            .id();
        let next = scenario
            .add_spell_to_hand(A, "Next Ordinary Play", true)
            .with_mana_cost(ManaCost::generic(1))
            .with_ability(Effect::GainLife {
                amount: QuantityExpr::Fixed { value: 3 },
                player: TargetFilter::Controller,
            })
            .id();
        scenario
            .add_spell_to_hand(B, "P1 Secret Hand", true)
            .with_mana_cost(ManaCost::generic(1));
        scenario
            .add_spell_to_library_top(A, "P1 A Secret Library", true)
            .with_mana_cost(ManaCost::generic(1));
        scenario
            .add_spell_to_library_top(B, "P1 B Secret Library", true)
            .with_mana_cost(ManaCost::generic(1));
        scenario.with_mana_pool(
            A,
            vec![
                ManaUnit::new(ManaType::Colorless, ObjectId(0), false, vec![]),
                ManaUnit::new(ManaType::Colorless, ObjectId(0), false, vec![]),
            ],
        );
        if replacement {
            scenario
                .add_creature(B, "Optional Graveyard Exile", 1, 1)
                .with_replacement_definition(terminal_replacement());
        }
        (scenario, source, next)
    }

    fn bind_board(scenario: GameScenario) -> GameRunner {
        let mut runner = scenario.build();
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("p1-native-journey".into()),
        )
        .unwrap();
        runner
    }

    fn loss_body() -> Effect {
        Effect::LoseLife {
            amount: QuantityExpr::Fixed { value: 2 },
            target: Some(TargetFilter::Controller),
        }
    }

    fn fixed_board(replacement: bool) -> (GameRunner, ObjectId, ObjectId) {
        let (scenario, source, next) =
            fixed_scenario(replacement, "P1 Self Loss", true, loss_body());
        let runner = bind_board(scenario);
        let pips = &runner.state().players[A.0 as usize].mana_pool.mana;
        assert_eq!(pips.len(), 2);
        assert_ne!(pips[0].pip_id, pips[1].pip_id);
        assert!(runner.state().stack.is_empty());
        assert!(runner.state().resolving_stack_entry.is_none());
        (runner, source, next)
    }

    fn creature_filter() -> TargetFilter {
        TargetFilter::Typed(TypedFilter::creature())
    }

    fn change_zone_body(destination: Zone) -> Effect {
        Effect::ChangeZone {
            destination,
            origin: Some(Zone::Battlefield),
            target: creature_filter(),
            owner_library: false,
            enter_transformed: false,
            enters_under: None,
            enter_tapped: EtbTapState::Unspecified,
            enters_attacking: false,
            up_to: false,
            enter_with_counters: vec![],
            conditional_enter_with_counters: vec![],
            face_down_profile: None,
            enters_modified_if: None,
        }
    }

    fn gain_body(amount: i32) -> Effect {
        Effect::GainLife {
            amount: QuantityExpr::Fixed { value: amount },
            player: TargetFilter::Controller,
        }
    }

    // Each spelling names a finite synthetic board, never a parser pattern or
    // a transport instruction. The exporter below collects the actual faces.
    fn variant_board(kind: &str) -> (GameRunner, ObjectId, ObjectId) {
        let targeted = kind == "target";
        let (mut scenario, source, next) = fixed_scenario(
            false,
            if targeted {
                "P1 Target Tap"
            } else if kind == "sorcery" {
                "P1 Sorcery Loss"
            } else {
                "P1 Self Loss"
            },
            kind != "sorcery",
            if targeted {
                Effect::SetTapState {
                    target: creature_filter(),
                    scope: EffectScope::Single,
                    state: TapStateChange::Tap,
                }
            } else {
                loss_body()
            },
        );
        let mut target_objects = None;
        match kind {
            "response" | "target" => {
                scenario
                    .add_spell_to_hand(B, "P1 Response U", true)
                    .with_mana_cost(ManaCost::zero())
                    .with_ability(gain_body(1));
                for (player, name) in [(A, "P1 Counter Q A"), (B, "P1 Counter Q B")] {
                    scenario
                        .add_spell_to_hand(player, name, true)
                        .with_mana_cost(ManaCost::zero())
                        .with_ability(Effect::Counter {
                            target: TargetFilter::StackSpell,
                            source_rider: None,
                            countered_spell_zone: None,
                        });
                }
                if targeted {
                    let first = scenario.add_creature(B, "P1 Target C", 1, 1).id();
                    let second = scenario.add_creature(B, "P1 Target C", 1, 1).id();
                    target_objects = Some((first, second));
                    scenario
                        .add_spell_to_hand(B, "P1 Departure D", true)
                        .with_mana_cost(ManaCost::zero())
                        .with_ability(change_zone_body(Zone::Graveyard));
                }
            }
            "life-observer" => {
                scenario
                    .add_creature(A, "P1 Life Lost Observer", 1, 1)
                    .with_trigger_definition(
                        TriggerDefinition::new(TriggerMode::LifeLost)
                            .execute(AbilityDefinition::new(AbilityKind::Database, gain_body(1))),
                    );
            }
            "mana-observer" => {
                scenario.add_basic_land(A, ManaColor::Green);
                scenario
                    .add_creature(A, "P1 Mana Observer", 1, 1)
                    .with_trigger_definition(
                        TriggerDefinition::new(TriggerMode::TapsForMana)
                            .valid_card(TargetFilter::Typed(TypedFilter::new(TypeFilter::Land)))
                            .execute(AbilityDefinition::new(
                                AbilityKind::Database,
                                Effect::Mana {
                                    produced: ManaProduction::Fixed {
                                        colors: vec![ManaColor::Green],
                                        contribution: ManaContribution::Additional,
                                    },
                                    restrictions: vec![],
                                    grants: vec![],
                                    expiry: None,
                                    target: None,
                                },
                            )),
                    );
            }
            "death-observer" => {
                scenario.add_creature(B, "P1 Damaged C", 1, 1);
                scenario
                    .add_creature(A, "P1 Death Observer", 1, 1)
                    .with_trigger_definition(
                        TriggerDefinition::new(TriggerMode::ChangesZone)
                            .origin(Zone::Battlefield)
                            .destination(Zone::Graveyard)
                            .valid_card(creature_filter())
                            .execute(AbilityDefinition::new(AbilityKind::Database, gain_body(1))),
                    );
            }
            "replacement-order" => {
                for (player, name, quantity) in [
                    (A, "P1 Loss Doubler", QuantityModification::DOUBLE),
                    (
                        B,
                        "P1 Loss Plus One",
                        QuantityModification::Plus { value: 1 },
                    ),
                ] {
                    let mut replacement = ReplacementDefinition::new(ReplacementEvent::LoseLife)
                        .quantity_modification(quantity);
                    replacement.valid_player =
                        Some(engine::types::ability::ReplacementPlayerScope::AnyPlayer);
                    scenario
                        .add_creature(player, name, 1, 1)
                        .with_replacement_definition(replacement);
                }
            }
            "replacement-substitute" => {
                let mut replacement = ReplacementDefinition::new(ReplacementEvent::LoseLife)
                    .execute(AbilityDefinition::new(AbilityKind::Database, gain_body(1)));
                replacement.valid_player =
                    Some(engine::types::ability::ReplacementPlayerScope::AnyPlayer);
                scenario
                    .add_creature(A, "P1 Loss Substitute", 1, 1)
                    .with_replacement_definition(replacement);
            }
            "vanilla" => {
                scenario
                    .add_creature_to_hand(A, "P1 Vanilla V", 2, 2)
                    .with_mana_cost(ManaCost::generic(1));
            }
            "sorcery" | "base" => {}
            _ => panic!("unlisted finite board {kind}"),
        }
        let mut runner = scenario.build();
        if kind == "mana-observer" {
            // with_mana_pool appends pips, so an empty input cannot remove
            // fixed_scenario's seed. This board must pay from its actual land.
            runner.state_mut().players[A.0 as usize].mana_pool.clear();
        }
        if let Some((first, second)) = target_objects {
            // GameScenario allocates a CardId per object; these two objects
            // instead represent two copies of the same existing typed face.
            let card_id = runner.state().objects[&first].card_id;
            runner.state_mut().objects.get_mut(&second).unwrap().card_id = card_id;
        }
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("p1-native-journey".into()),
        )
        .unwrap();
        (runner, source, next)
    }

    fn named(state: &GameState, name: &str) -> ObjectId {
        state
            .objects
            .values()
            .find(|object| object.name == name)
            .unwrap()
            .id
    }

    fn card_map(state: &GameState) -> String {
        let mut faces: BTreeMap<String, CardFace> = state
            .objects
            .values()
            .map(|object| {
                let text = match object.name.as_str() {
                    "P1 Self Loss" | "P1 Sorcery Loss" => "You lose 2 life.",
                    "P1 Target Tap" => "Tap target creature.",
                    "Next Ordinary Play" => "You gain 3 life.",
                    "P1 Response U" => "You gain 1 life.",
                    "P1 Counter Q A" | "P1 Counter Q B" => "Counter target spell.",
                    "P1 Departure D" => "Put target creature into its owner's graveyard.",
                    "P1 Life Lost Observer" => "Synthetic LifeLost observer: you gain 1 life.",
                    "P1 Mana Observer" => "Synthetic TapsForMana observer: add an additional {G}.",
                    "P1 Death Observer" => "Synthetic creature-dies observer: you gain 1 life.",
                    "P1 Loss Doubler" => "Synthetic life-loss replacement: double that amount.",
                    "P1 Loss Plus One" => {
                        "Synthetic life-loss replacement: increase that amount by one."
                    }
                    "P1 Loss Substitute" => "Synthetic life-loss substitute: you gain 1 life.",
                    "P1 Vanilla V"
                    | "P1 Unsupported Permanent"
                    | "P1 Target C"
                    | "P1 Damaged C" => "",
                    "Optional Graveyard Exile" => {
                        "Synthetic optional graveyard-to-exile replacement."
                    }
                    _ => "Synthetic privacy fixture.",
                };
                (
                    object.name.clone(),
                    CardFace {
                        name: object.name.clone(),
                        mana_cost: object.base_mana_cost.clone(),
                        card_type: object.base_card_types.clone(),
                        power: object.base_power.map(PtValue::Fixed),
                        toughness: object.base_toughness.map(PtValue::Fixed),
                        oracle_text: Some(text.into()),
                        keywords: object.base_keywords.clone(),
                        abilities: object.base_abilities.as_ref().clone(),
                        additional_cost: object.additional_cost.clone(),
                        triggers: object.base_trigger_definitions.as_ref().clone(),
                        static_abilities: object.base_static_definitions.as_ref().clone(),
                        replacements: object.base_replacement_definitions.as_ref().clone(),
                        ..CardFace::default()
                    },
                )
            })
            .collect();
        let mut bootstrap = GameScenario::new();
        let land = bootstrap.add_basic_land(A, engine::types::mana::ManaColor::White);
        let bootstrap = bootstrap.build();
        let object = &bootstrap.state().objects[&land];
        faces.insert(
            object.name.clone(),
            CardFace {
                name: object.name.clone(),
                mana_cost: object.base_mana_cost.clone(),
                card_type: object.base_card_types.clone(),
                keywords: object.base_keywords.clone(),
                ..CardFace::default()
            },
        );
        // Load typed faces, then emit through the existing CardExportEntry writer.
        let database =
            CardDatabase::from_json_str(&serde_json::to_string(&faces).unwrap()).unwrap();
        database.export_subset_json(&faces.keys().cloned().collect::<BTreeSet<_>>())
    }

    fn checked_restore(checkpoint: &str, database: &CardDatabase) -> Result<GameState, String> {
        serde_json::from_str::<PersistedGameState>(checkpoint)
            .map_err(|error| error.to_string())?
            .prepare_for_restore(PersistedRestoreFinalization::DeferUntilRehydrated)
            .map_err(|error| error.to_string())?
            .finalize_after_rehydration(|state| {
                engine::game::printed_cards::rehydrate_game_from_card_db_with_finalization(
                    state,
                    database,
                    engine::game::printed_cards::CardDbRehydrationFinalization::Defer,
                );
                Ok(())
            })
            .map_err(|error| error.to_string())
    }

    fn capture(state: &GameState, database: &CardDatabase) -> String {
        let checkpoint =
            serde_json::to_string(&TrustedGameStateEnvelope::capture(state.clone())).unwrap();
        let restored = checked_restore(&checkpoint, database).unwrap();
        assert_eq!(
            restored.waiting_for, state.waiting_for,
            "restore must preserve the parked decision"
        );
        assert_eq!(
            restored.players[A.0 as usize].life,
            state.players[A.0 as usize].life
        );
        assert_eq!(
            restored.manual_resolution_binding(),
            state.manual_resolution_binding()
        );
        assert_eq!(restored.resolving_stack_entry, state.resolving_stack_entry);
        assert_eq!(
            restored.stack, state.stack,
            "restore preserves armed targets"
        );
        let original_view =
            manual_resolution_view(state, &filter_state_for_viewer(state, A), Some(A));
        let restored_view =
            manual_resolution_view(&restored, &filter_state_for_viewer(&restored, A), Some(A));
        match (original_view, restored_view) {
            (Some(original), Some(restored)) => {
                assert_eq!(restored.source, original.source);
                assert_eq!(restored.phase, original.phase);
                assert_eq!(restored.min_life_loss, original.min_life_loss);
                assert_eq!(restored.max_life_loss, original.max_life_loss);
            }
            (None, None) => {}
            _ => panic!("CardDB rehydration lost or manufactured Manual source context"),
        }
        for (id, object) in &state.objects {
            let restored_object = &restored.objects[id];
            assert_eq!(restored_object.id, object.id);
            assert_eq!(restored_object.incarnation, object.incarnation);
            assert_eq!(restored_object.card_id, object.card_id);
            assert_eq!(restored_object.base_abilities, object.base_abilities);
            assert_eq!(restored_object.base_keywords, object.base_keywords);
            assert_eq!(restored_object.additional_cost, object.additional_cost);
            assert_eq!(
                restored_object.base_trigger_definitions,
                object.base_trigger_definitions
            );
            assert_eq!(
                restored_object.base_replacement_definitions,
                object.base_replacement_definitions
            );
        }
        checkpoint
    }

    type FixtureCases = BTreeMap<String, serde_json::Value>;

    fn save_case(
        cases: &mut FixtureCases,
        id: &str,
        family: &str,
        position: &str,
        runner: &GameRunner,
        database: &CardDatabase,
    ) {
        assert!(matches!(position, "B" | "K0" | "K1" | "K2" | "K3" | "K4"));
        assert!(
            cases
                .insert(
                    id.into(),
                    serde_json::json!({
                        "familyVariant": family,
                        "position": position,
                        "checkpoint": capture(runner.state(), database),
                    })
                )
                .is_none(),
            "finite fixture key must be unique: {id}"
        );
    }

    fn alias_case(cases: &mut FixtureCases, id: &str, family: &str, base: &str) {
        let mut case = cases[base].clone();
        case["familyVariant"] = family.into();
        assert!(cases.insert(id.into(), case).is_none(), "duplicate {id}");
    }

    const SCOPE_VARIANTS: &[&str] = &[
        "owner",
        "controller",
        "controlled-player",
        "copy",
        "token",
        "permanent",
        "nonhand",
        "alternate",
        "paid-buyback",
        "unpaid-buyback",
        "exile-rider",
        "linked-exile",
        "cipher",
        "paradigm",
        "rebound",
        "epic",
    ];

    fn scope_board(kind: &str) -> (GameRunner, ObjectId, ObjectId) {
        let (mut scenario, original, next) =
            fixed_scenario(false, &format!("P1 Scope {kind}"), true, loss_body());
        let source = if kind == "permanent" {
            // Keep the ordinary source too, as a same-board positive guard.
            scenario
                .add_creature_to_hand(A, "P1 Unsupported Permanent", 2, 2)
                .with_mana_cost(ManaCost::generic(1))
                .id()
        } else {
            original
        };
        let mut runner = bind_board(scenario);
        let keyword = match kind {
            "cipher" => Some(Keyword::Cipher),
            "paradigm" => Some(Keyword::Paradigm),
            "rebound" => Some(Keyword::Rebound),
            "epic" => Some(Keyword::Epic),
            "paid-buyback" | "unpaid-buyback" => {
                runner
                    .state_mut()
                    .objects
                    .get_mut(&source)
                    .unwrap()
                    .additional_cost = Some(AdditionalCost::Optional {
                    cost: AbilityCost::Mana {
                        cost: ManaCost::zero(),
                    },
                    repeatability: AdditionalCostRepeatability::Once,
                });
                Some(Keyword::Buyback(BuybackCost::Mana(ManaCost::zero())))
            }
            _ => None,
        };
        if let Some(keyword) = keyword {
            let object = runner.state_mut().objects.get_mut(&source).unwrap();
            object.base_keywords.push(keyword.clone());
            object.keywords.push(keyword);
        }
        match kind {
            "owner" => runner.state_mut().objects.get_mut(&source).unwrap().owner = B,
            "controller" => {
                runner
                    .state_mut()
                    .objects
                    .get_mut(&source)
                    .unwrap()
                    .controller = B
            }
            "copy" => runner.state_mut().objects.get_mut(&source).unwrap().is_copy = true,
            "token" => {
                runner
                    .state_mut()
                    .objects
                    .get_mut(&source)
                    .unwrap()
                    .is_token = true
            }
            "controlled-player" => {
                runner.state_mut().active_full_turn_control =
                    Some(engine::types::game_state::ActivePlayerControl {
                        controller: B,
                        timestamp: 1,
                    });
                runner.state_mut().turn_decision_controller = Some(B);
                runner.state_mut().turn_decision_control_timestamp = Some(1);
                runner.state_mut().priority_player = B;
            }
            _ => {}
        }
        (runner, source, next)
    }

    fn finite_card_map() -> String {
        let mut entries = BTreeMap::<String, serde_json::Value>::new();
        let mut collect = |state: &GameState| {
            let map: BTreeMap<String, serde_json::Value> =
                serde_json::from_str(&card_map(state)).unwrap();
            for (name, face) in map {
                if let Some(previous) = entries.insert(name.clone(), face.clone()) {
                    assert_eq!(previous, face, "one typed face per finite name: {name}");
                }
            }
        };
        collect(fixed_board(true).0.state());
        for kind in [
            "response",
            "target",
            "life-observer",
            "mana-observer",
            "death-observer",
            "replacement-order",
            "replacement-substitute",
            "vanilla",
            "sorcery",
        ] {
            collect(variant_board(kind).0.state());
        }
        for kind in SCOPE_VARIANTS {
            collect(scope_board(kind).0.state());
        }
        // Every entry came from CardDatabase::export_subset_json, including
        // actual typed triggers/replacements and the ordinary bootstrap land.
        serde_json::to_string(&entries).unwrap()
    }

    fn passes(runner: &mut GameRunner) -> Vec<GameEvent> {
        let mut events = runner.act(GameAction::PassPriority).unwrap().events;
        events.extend(runner.act(GameAction::PassPriority).unwrap().events);
        events
    }

    fn arm(runner: &mut GameRunner, source: ObjectId) -> ObjectId {
        arm_with_target(runner, source, None)
    }

    fn arm_with_target(
        runner: &mut GameRunner,
        source: ObjectId,
        target: Option<ObjectId>,
    ) -> ObjectId {
        let spent_before = runner.state().resolved_rules_journal.spent_mana().len();
        let mana_before = runner.state().players[A.0 as usize].mana_pool.clone();
        let source_reference =
            ObjectIncarnationRef::of(source, runner.state().objects[&source].incarnation);
        let submission = manual_cast_submission(runner.state(), source);
        let applied = submit_interaction(runner.state_mut(), A, submission).unwrap();
        assert!(matches!(
            applied.action,
            GameAction::CastSpell {
                object_id,
                payment_mode: CastPaymentMode::Auto,
                ..
            } if object_id == source
        ));
        let mut events = applied.result.events;
        if let Some(target) = target {
            let WaitingFor::TargetSelection {
                player,
                pending_cast,
                target_slots,
                selection,
                ..
            } = &runner.state().waiting_for
            else {
                panic!("two legal targets must require the ordinary target input")
            };
            assert_eq!(*player, A);
            assert_eq!(pending_cast.object_id, source);
            assert_eq!(pending_cast.payment_mode, CastPaymentMode::Auto);
            assert_eq!(pending_cast.cost, ManaCost::generic(1));
            assert!(pending_cast.ability.targets.is_empty());
            assert_eq!(target_slots.len(), 1);
            assert_eq!(selection.current_legal_targets.len(), 2);
            assert!(selection
                .current_legal_targets
                .contains(&TargetRef::Object(target)));
            let casting = manual_resolution_view(
                runner.state(),
                &filter_state_for_viewer(runner.state(), A),
                Some(A),
            )
            .expect("the actor can observe the Manual intent during target selection");
            assert_eq!(casting.phase, ManualResolutionPhase::Casting);
            assert_eq!(casting.source.actor, A.0);
            assert_eq!(casting.source.source_id, source_reference.object_id.0);
            assert_eq!(
                casting.source.source_incarnation,
                source_reference.incarnation
            );
            assert_eq!(runner.state().players[A.0 as usize].mana_pool, mana_before);
            assert_eq!(
                runner.state().resolved_rules_journal.spent_mana().len(),
                spent_before
            );
            assert_eq!(runner.state().stack.len(), 1);
            let announcement = runner.state().stack.back().unwrap();
            assert_eq!(announcement.id, source);
            assert_eq!(announcement.source_id, source);
            assert_eq!(announcement.controller, A);
            assert!(matches!(
                announcement.kind,
                StackEntryKind::Spell {
                    card_id,
                    ability: None,
                    casting_variant: CastingVariant::Normal,
                    actual_mana_spent: 0,
                } if card_id == pending_cast.card_id
            ));
            assert_eq!(runner.state().objects[&source].zone, Zone::Hand);
            assert_eq!(
                runner.state().objects[&source].incarnation,
                source_reference.incarnation
            );
            assert!(runner.state().resolving_stack_entry.is_none());
            assert!(!events.iter().any(|event| matches!(
                event,
                GameEvent::SpellCast { .. }
                    | GameEvent::ZoneChanged { .. }
                    | GameEvent::LifeChanged { .. }
                    | GameEvent::PermanentTapped { .. }
            )));
            let target_reference =
                ObjectIncarnationRef::of(target, runner.state().objects[&target].incarnation);
            let view = derive_viewer_interaction(
                runner.state(),
                &filter_state_for_viewer(runner.state(), A),
                A,
            );
            let opportunity = &view.opportunities[0];
            let InteractionOpportunityResponse::Schema { candidates, .. } = &opportunity.response
            else {
                panic!("target selection publishes an opaque schema")
            };
            assert_eq!(candidates.len(), 2);
            let target_submission = candidates
                .iter()
                .map(|choice| InteractionSubmission {
                    interaction_id: opportunity.interaction_id.clone(),
                    response: InteractionResponse::Sequence {
                        choice_ids: vec![choice.id.clone()],
                    },
                })
                .find(|submission| {
                    resolve_interaction_response(runner.state(), A, submission).is_ok_and(
                        |action| matches!(action, GameAction::ChooseTarget { target: Some(TargetRef::Object(object_id)) } if object_id == target),
                    )
                })
                .expect("the selected C must have its own engine-issued target choice");
            refuses_submission(runner, B, target_submission.clone());
            let selected =
                submit_interaction(runner.state_mut(), A, target_submission.clone()).unwrap();
            assert!(
                matches!(selected.action, GameAction::ChooseTarget { target: Some(TargetRef::Object(object_id)) } if object_id == target)
            );
            events.extend(selected.result.events);
            refuses_submission(runner, A, target_submission);
            let ability = runner.state().stack.back().unwrap().ability().unwrap();
            assert_eq!(ability.targets, vec![TargetRef::Object(target)]);
            assert_eq!(ability.selected_target_incarnations.len(), 1);
            assert!(ability
                .selected_target_incarnations
                .contains(&target_reference));
        }
        assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 1);
        assert_eq!(runner.state().players[A.0 as usize].life, 20);
        assert_eq!(
            runner.state().resolved_rules_journal.spent_mana().len(),
            spent_before + 1
        );
        assert_eq!(events.iter().filter(|event| matches!(event, GameEvent::SpellCast { object_id, controller, .. } if *object_id == source && *controller == A)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event, GameEvent::ZoneChanged { object_id, from: Some(Zone::Hand), to: Zone::Stack, .. } if *object_id == source)).count(), 1);
        let armed = manual_resolution_view(
            runner.state(),
            &filter_state_for_viewer(runner.state(), A),
            Some(A),
        )
        .expect("the paid Manual occurrence publishes its armed phase");
        assert_eq!(armed.phase, ManualResolutionPhase::Armed);
        let binding = runner.state().manual_resolution_binding().unwrap();
        assert_eq!(binding.actor, A);
        assert_eq!(binding.source.object_id, source);
        assert_eq!(
            binding.source.incarnation,
            runner.state().objects[&source].incarnation
        );
        assert_eq!(
            binding.stack_entry_id,
            runner.state().stack.back().unwrap().id
        );
        binding.stack_entry_id
    }

    fn open(runner: &mut GameRunner, source: ObjectId) -> ObjectId {
        let entry = arm(runner, source);
        let events = passes(runner);
        assert_eq!(resolved(&events, entry), 0);
        assert!(runner.state().stack.is_empty());
        assert_eq!(
            runner.state().resolving_stack_entry.as_ref().unwrap().id,
            entry
        );
        assert_eq!(runner.state().players[A.0 as usize].life, 20);
        entry
    }

    fn resolved(events: &[GameEvent], entry: ObjectId) -> usize {
        events.iter().filter(|event| matches!(event, GameEvent::StackResolved { object_id } if *object_id == entry)).count()
    }

    fn moved(events: &[GameEvent], source: ObjectId, to: Zone) -> usize {
        events.iter().filter(|event| matches!(event, GameEvent::ZoneChanged { object_id, from: Some(Zone::Stack), to: destination, .. } if *object_id == source && *destination == to)).count()
    }

    fn assert_loss(events: &[GameEvent], source: ObjectId, amount: u32, total: i32) {
        // CR 119.3: inspect the emitted intermediate total as well as the delta.
        assert_eq!(events.iter().filter(|event| matches!(event, GameEvent::LifeChanged { player_id, amount: delta, new_total } if *player_id == A && *delta == -(amount as i32) && new_total.0 == Some(total))).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event, GameEvent::EffectResolved { kind: engine::types::ability::EffectKind::LoseLife, source_id, .. } if *source_id == source)).count(), 1);
    }

    fn choose_terminal(runner: &mut GameRunner, accept: bool) -> Vec<GameEvent> {
        let WaitingFor::ReplacementChoice {
            player, candidates, ..
        } = &runner.state().waiting_for
        else {
            panic!("real terminal child required")
        };
        assert_eq!(*player, A);
        assert_eq!(candidates.len(), 2);
        let label = if accept { "Accept" } else { "Decline" };
        let index = candidates
            .iter()
            .position(|candidate| candidate.description == label)
            .unwrap();
        runner
            .act(GameAction::ChooseReplacement { index })
            .unwrap()
            .events
    }

    fn next_paid(runner: &mut GameRunner, next: ObjectId, total: i32, replacement: bool) {
        let life = runner.state().players[A.0 as usize].life;
        assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 1);
        let remaining_pip = runner.state().players[A.0 as usize].mana_pool.mana[0].pip_id;
        let spent_before = runner.state().resolved_rules_journal.spent_mana().len();
        let submission = exact_submission(
            runner.state(),
            A,
            |action| matches!(action, GameAction::CastSpell { object_id, payment_mode: CastPaymentMode::Auto, .. } if *object_id == next),
        );
        let cast = submit_interaction(runner.state_mut(), A, submission).unwrap();
        let entry = runner.state().stack.back().unwrap().id;
        assert_eq!(
            runner.state().resolved_rules_journal.spent_mana().len(),
            spent_before + 1
        );
        assert_eq!(
            runner
                .state()
                .resolved_rules_journal
                .spent_mana()
                .last()
                .unwrap()
                .unit
                .pip_id,
            remaining_pip
        );
        assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 0);
        assert_eq!(cast.result.events.iter().filter(|event| matches!(event, GameEvent::SpellCast { object_id, controller, .. } if *object_id == next && *controller == A)).count(), 1);
        let mut events = passes(runner);
        if replacement {
            events.extend(choose_terminal(runner, false));
        }
        assert_eq!(runner.state().players[A.0 as usize].life, life + 3);
        assert_eq!(runner.state().players[A.0 as usize].life, total);
        assert_eq!(resolved(&events, entry), 1);
        assert_eq!(moved(&events, next, Zone::Graveyard), 1);
        assert_eq!(events.iter().filter(|event| matches!(event, GameEvent::EffectResolved { kind: engine::types::ability::EffectKind::GainLife, source_id, .. } if *source_id == next)).count(), 1);
        assert!(runner.state().manual_resolution_binding().is_none());
        assert!(runner.state().resolving_stack_entry.is_none());
    }

    fn life_submission(state: &GameState, amount: u32) -> InteractionSubmission {
        let view = derive_viewer_interaction(state, &filter_state_for_viewer(state, A), A);
        InteractionSubmission {
            interaction_id: view.opportunities[0].interaction_id.clone(),
            response: InteractionResponse::ManualResolution {
                decision: ManualResolutionDecision::LoseOwnLife { amount },
            },
        }
    }

    fn finish_submission(state: &GameState) -> InteractionSubmission {
        let view = derive_viewer_interaction(state, &filter_state_for_viewer(state, A), A);
        let opportunity = &view.opportunities[0];
        let InteractionOpportunityResponse::Schema { candidates, .. } = &opportunity.response
        else {
            panic!("Manual schema")
        };
        InteractionSubmission {
            interaction_id: opportunity.interaction_id.clone(),
            response: InteractionResponse::ManualResolution {
                decision: ManualResolutionDecision::Finish {
                    choice_id: candidates[0].id.clone(),
                },
            },
        }
    }

    fn refuses_submission(
        runner: &mut GameRunner,
        actor: PlayerId,
        submission: InteractionSubmission,
    ) {
        let before = runner.state().clone();
        assert!(submit_interaction(runner.state_mut(), actor, submission).is_err());
        assert_eq!(
            runner.state(),
            &before,
            "refusal preserves all native state"
        );
    }

    fn refuses_action(runner: &mut GameRunner, actor: PlayerId, action: GameAction) {
        let before = runner.state().clone();
        assert!(apply(runner.state_mut(), actor, action).is_err());
        assert_eq!(
            runner.state(),
            &before,
            "reducer rollback includes queues/journal/log/interaction"
        );
    }

    fn manual_cast_submission(state: &GameState, source: ObjectId) -> InteractionSubmission {
        let filtered = filter_state_for_viewer(state, A);
        let view = derive_viewer_interaction(state, &filtered, A);
        for opportunity in view.opportunities {
            let InteractionOpportunityResponse::ExactChoices { choices } = opportunity.response
            else {
                continue;
            };
            for choice in choices {
                let submission = InteractionSubmission {
                    interaction_id: opportunity.interaction_id.clone(),
                    response: InteractionResponse::Choose {
                        choice_id: choice.id,
                    },
                };
                if classify_manual_interaction(state, A, &submission).unwrap()
                    == Some(ManualInteractionKind::CastIntent)
                    && matches!(resolve_interaction_response(state, A, &submission).unwrap(), GameAction::CastSpell { object_id, payment_mode: CastPaymentMode::Auto, .. } if object_id == source)
                {
                    return submission;
                }
            }
        }
        panic!("the engine must offer a supported opaque prepayment Manual choice");
    }

    fn submit_life(
        runner: &mut GameRunner,
        amount: u32,
    ) -> engine::game::interaction::AppliedInteraction {
        let view = derive_viewer_interaction(
            runner.state(),
            &filter_state_for_viewer(runner.state(), A),
            A,
        );
        let submission = InteractionSubmission {
            interaction_id: view.opportunities[0].interaction_id.clone(),
            response: InteractionResponse::ManualResolution {
                decision: ManualResolutionDecision::LoseOwnLife { amount },
            },
        };
        submit_interaction(runner.state_mut(), A, submission).unwrap()
    }

    fn finish(runner: &mut GameRunner) -> engine::game::interaction::AppliedInteraction {
        let view = derive_viewer_interaction(
            runner.state(),
            &filter_state_for_viewer(runner.state(), A),
            A,
        );
        let opportunity = &view.opportunities[0];
        let InteractionOpportunityResponse::Schema { candidates, .. } = &opportunity.response
        else {
            panic!("Manual schema expected");
        };
        let submission = InteractionSubmission {
            interaction_id: opportunity.interaction_id.clone(),
            response: InteractionResponse::ManualResolution {
                decision: ManualResolutionDecision::Finish {
                    choice_id: candidates[0].id.clone(),
                },
            },
        };
        submit_interaction(runner.state_mut(), A, submission).unwrap()
    }

    fn response_families(cases: &mut FixtureCases, database: &CardDatabase) {
        for variant in ["2a", "2b", "2c"] {
            let (mut runner, source, next) = variant_board("response");
            save_case(
                cases,
                &format!("{variant}.B"),
                variant,
                "B",
                &runner,
                database,
            );
            let lower = arm(&mut runner, source);
            let binding = runner.state().manual_resolution_binding().unwrap().clone();
            save_case(
                cases,
                &format!("{variant}.K0"),
                variant,
                "K0",
                &runner,
                database,
            );
            runner.act(GameAction::PassPriority).unwrap();
            let victim = if variant == "2c" {
                lower
            } else {
                let response = named(runner.state(), "P1 Response U");
                runner.cast(response).commit();
                runner.state().stack.back().unwrap().id
            };
            let resolving = if variant == "2a" {
                victim
            } else {
                if variant == "2b" {
                    runner.act(GameAction::PassPriority).unwrap();
                }
                let counter = named(
                    runner.state(),
                    if variant == "2b" {
                        "P1 Counter Q A"
                    } else {
                        "P1 Counter Q B"
                    },
                );
                runner.cast(counter).target_object(victim).commit();
                runner.state().stack.back().unwrap().id
            };
            let events = passes(&mut runner);
            assert_eq!(resolved(&events, resolving), 1);
            assert_eq!(resolved(&events, lower), 0);
            if variant != "2a" {
                assert_eq!(events.iter().filter(|event| matches!(event, GameEvent::SpellCountered { object_id, countered_by, .. } if *object_id == victim && *countered_by == resolving)).count(), 1);
                assert_eq!(moved(&events, victim, Zone::Graveyard), 1);
                assert_eq!(resolved(&events, victim), 0);
            }
            assert_eq!(
                runner.state().players[B.0 as usize].life,
                if variant == "2a" { 21 } else { 20 }
            );
            if variant == "2c" {
                assert!(runner.state().manual_resolution_binding().is_none());
                assert!(runner.state().resolving_stack_entry.is_none());
                refuses_action(
                    &mut runner,
                    A,
                    GameAction::FinishManualResolution {
                        stack_entry_id: lower,
                    },
                );
                save_case(cases, "2c.K4", variant, "K4", &runner, database);
                next_paid(&mut runner, next, 23, false);
            } else {
                assert_eq!(runner.state().manual_resolution_binding(), Some(&binding));
                assert_eq!(runner.state().stack.len(), 1);
                assert!(runner.state().resolving_stack_entry.is_none());
                save_case(
                    cases,
                    &format!("{variant}.after-response.K0"),
                    variant,
                    "K0",
                    &runner,
                    database,
                );
                passes(&mut runner);
                assert_eq!(
                    runner.state().resolving_stack_entry.as_ref().unwrap().id,
                    lower
                );
                save_case(
                    cases,
                    &format!("{variant}.K1"),
                    variant,
                    "K1",
                    &runner,
                    database,
                );
                let life = submit_life(&mut runner, 2);
                assert_loss(&life.result.events, source, 2, 18);
                finish(&mut runner);
                next_paid(&mut runner, next, 21, false);
            }
        }
    }

    fn target_families(cases: &mut FixtureCases, database: &CardDatabase) {
        for variant in ["3a", "3b", "4a", "4b"] {
            let (mut runner, source, next) = variant_board("target");
            let target = named(runner.state(), "P1 Target C");
            let unselected = runner
                .state()
                .objects
                .values()
                .find(|object| object.name == "P1 Target C" && object.id != target)
                .unwrap()
                .id;
            assert_ne!(target, unselected);
            let chosen_object = &runner.state().objects[&target];
            let other_object = &runner.state().objects[&unselected];
            assert_eq!(chosen_object.card_id, other_object.card_id);
            assert_eq!(
                (
                    &chosen_object.base_mana_cost,
                    &chosen_object.base_card_types,
                    chosen_object.base_power,
                    chosen_object.base_toughness,
                    &chosen_object.base_keywords,
                    &chosen_object.base_abilities,
                    &chosen_object.base_trigger_definitions,
                    &chosen_object.base_static_definitions,
                    &chosen_object.base_replacement_definitions,
                ),
                (
                    &other_object.base_mana_cost,
                    &other_object.base_card_types,
                    other_object.base_power,
                    other_object.base_toughness,
                    &other_object.base_keywords,
                    &other_object.base_abilities,
                    &other_object.base_trigger_definitions,
                    &other_object.base_static_definitions,
                    &other_object.base_replacement_definitions,
                )
            );
            save_case(
                cases,
                &format!("{variant}.B"),
                variant,
                "B",
                &runner,
                database,
            );
            let entry = arm_with_target(&mut runner, source, Some(target));
            save_case(
                cases,
                &format!("{variant}.K0"),
                variant,
                "K0",
                &runner,
                database,
            );
            if variant == "3a" {
                runner.act(GameAction::PassPriority).unwrap();
                let departure = named(runner.state(), "P1 Departure D");
                runner.cast(departure).target_object(target).commit();
                let departure_entry = runner.state().stack.back().unwrap().id;
                let departure_events = passes(&mut runner);
                assert_eq!(resolved(&departure_events, departure_entry), 1);
                assert_eq!(runner.state().objects[&target].zone, Zone::Graveyard);
                assert_eq!(runner.state().objects[&unselected].zone, Zone::Battlefield);
                assert!(!runner.state().objects[&unselected].tapped);
                assert_eq!(departure_events.iter().filter(|event| matches!(event, GameEvent::ZoneChanged { object_id, from: Some(Zone::Battlefield), to: Zone::Graveyard, .. } if *object_id == target)).count(), 1);
                // CR 608.2b: this real response makes the sole target illegal
                // before the common Begin intercept, so Manual never opens.
                let events = passes(&mut runner);
                assert_eq!(resolved(&events, entry), 1);
                assert_eq!(moved(&events, source, Zone::Graveyard), 1);
                assert!(runner.state().manual_resolution_binding().is_none());
                assert!(runner.state().resolving_stack_entry.is_none());
                assert!(!matches!(
                    runner.state().waiting_for,
                    WaitingFor::ManualResolution { .. }
                ));
                assert!(!events.iter().any(|event| matches!(
                    event,
                    GameEvent::PermanentTapped { .. } | GameEvent::LifeChanged { .. }
                )));
                save_case(cases, "3a.K4", variant, "K4", &runner, database);
                next_paid(&mut runner, next, 23, false);
                continue;
            }
            passes(&mut runner);
            let carrier = runner
                .state()
                .resolving_stack_entry
                .as_ref()
                .unwrap()
                .clone();
            let ability = carrier.ability().unwrap();
            assert_eq!(ability.targets.len(), 1);
            assert!(ability.illegal_target_slots.is_empty());
            assert!(ability
                .selected_target_incarnations
                .iter()
                .any(|reference| reference.object_id == target
                    && reference.incarnation == runner.state().objects[&target].incarnation));
            assert!(matches!(
                runner.state().waiting_for,
                WaitingFor::ManualResolution { .. }
            ));
            save_case(
                cases,
                &format!("{variant}.legal.K1"),
                variant,
                "K1",
                &runner,
                database,
            );
            if variant != "3b" {
                let mut fixture_events = vec![];
                engine::game::zones::move_to_zone(
                    runner.state_mut(),
                    target,
                    Zone::Graveyard,
                    &mut fixture_events,
                );
                assert_eq!(fixture_events.iter().filter(|event| matches!(event, GameEvent::ZoneChanged { object_id, to: Zone::Graveyard, .. } if *object_id == target)).count(), 1);
                if variant == "4b" {
                    // CR 400.7: same storage id, distinct new incarnation.
                    engine::game::zones::move_to_zone(
                        runner.state_mut(),
                        target,
                        Zone::Battlefield,
                        &mut fixture_events,
                    );
                    assert_ne!(
                        runner.state().objects[&target].incarnation,
                        ability.selected_target_incarnations[0].incarnation
                    );
                }
                assert_eq!(
                    runner.state().resolving_stack_entry.as_ref(),
                    Some(&carrier)
                );
                save_case(
                    cases,
                    &format!("{variant}.K1"),
                    variant,
                    "K1",
                    &runner,
                    database,
                );
            } else {
                alias_case(cases, "3b.K1", variant, "3b.legal.K1");
            }
            // Finish reads the saved Begin. No second target check/body runs.
            let events = finish(&mut runner).result.events;
            assert_eq!(resolved(&events, entry), 1);
            assert_eq!(moved(&events, source, Zone::Graveyard), 1);
            assert!(!events.iter().any(|event| matches!(
                event,
                GameEvent::PermanentTapped { .. } | GameEvent::LifeChanged { .. }
            )));
            assert!(runner.state().resolving_stack_entry.is_none());
            assert_eq!(runner.state().objects[&unselected].zone, Zone::Battlefield);
            assert!(!runner.state().objects[&unselected].tapped);
            if variant == "4b" {
                assert!(!runner.state().objects[&target].tapped);
            }
            save_case(
                cases,
                &format!("{variant}.K4"),
                variant,
                "K4",
                &runner,
                database,
            );
            next_paid(&mut runner, next, 23, false);
        }
    }

    fn refusal_family(cases: &mut FixtureCases, database: &CardDatabase) {
        let (mut runner, source, next) = fixed_board(false);
        let entry = arm(&mut runner, source);
        save_case(cases, "5a.K0", "5a", "K0", &runner, database);
        for actor in [A, B, PlayerId(2)] {
            refuses_action(
                &mut runner,
                actor,
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id: entry,
                    amount: 2,
                },
            );
            refuses_action(
                &mut runner,
                actor,
                GameAction::FinishManualResolution {
                    stack_entry_id: entry,
                },
            );
        }
        passes(&mut runner);
        save_case(cases, "5a.K1", "5a", "K1", &runner, database);
        let fresh = life_submission(runner.state(), 2);
        for actor in [B, PlayerId(2)] {
            refuses_submission(&mut runner, actor, fresh.clone());
        }
        for amount in [0, i32::MAX as u32 + 1] {
            let submission = life_submission(runner.state(), amount);
            refuses_submission(&mut runner, A, submission);
            refuses_action(
                &mut runner,
                A,
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id: entry,
                    amount,
                },
            );
        }
        // Negative signed input is a decode refusal, distinct from the two
        // unsigned values above that reach interaction/reducer amount guards.
        let mut decision =
            serde_json::to_value(ManualResolutionDecision::LoseOwnLife { amount: 1 }).unwrap();
        decision["data"]["amount"] = (-1).into();
        assert!(serde_json::from_value::<ManualResolutionDecision>(decision).is_err());
        for bad_source in [next, ObjectId(u64::MAX)] {
            refuses_action(
                &mut runner,
                A,
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id: bad_source,
                    amount: 2,
                },
            );
            refuses_action(
                &mut runner,
                A,
                GameAction::FinishManualResolution {
                    stack_entry_id: bad_source,
                },
            );
        }
        let mut wrong_finish = finish_submission(runner.state());
        if let InteractionResponse::ManualResolution {
            decision: ManualResolutionDecision::Finish { choice_id },
        } = &mut wrong_finish.response
        {
            choice_id.0.push_str("-wrong");
        }
        refuses_submission(&mut runner, A, wrong_finish);
        let applied = submit_interaction(runner.state_mut(), A, fresh.clone()).unwrap();
        assert_loss(&applied.result.events, source, 2, 18);
        refuses_submission(&mut runner, A, fresh);
        save_case(cases, "5a.K2", "5a", "K2", &runner, database);
        for actor in [B, PlayerId(2)] {
            let submission = finish_submission(runner.state());
            refuses_submission(&mut runner, actor, submission);
        }
        for amount in [0, i32::MAX as u32 + 1] {
            let submission = life_submission(runner.state(), amount);
            refuses_submission(&mut runner, A, submission);
            refuses_action(
                &mut runner,
                A,
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id: entry,
                    amount,
                },
            );
        }
        refuses_action(
            &mut runner,
            A,
            GameAction::FinishManualResolution {
                stack_entry_id: next,
            },
        );
        let stale_finish = finish_submission(runner.state());
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("p1-native-new-branch".into()),
        )
        .unwrap();
        refuses_submission(&mut runner, A, stale_finish);
        finish(&mut runner);
        next_paid(&mut runner, next, 21, false);

        for kind in ["replacement-order", "replacement-substitute"] {
            let (mut runner, source, _) = variant_board(kind);
            save_case(cases, &format!("5c.{kind}.B"), "5c", "B", &runner, database);
            open(&mut runner, source);
            save_case(
                cases,
                &format!("5c.{kind}.K1"),
                "5c",
                "K1",
                &runner,
                database,
            );
            let submission = life_submission(runner.state(), 2);
            refuses_submission(&mut runner, A, submission);
            assert_eq!(runner.state().players[A.0 as usize].life, 20);
            assert!(runner.state().pending_replacement.is_none());
        }
    }

    fn unsupported_family(cases: &mut FixtureCases, database: &CardDatabase) {
        // The exact supported prepayment sibling reaches paid Begin first.
        let (mut positive, source, next) = variant_board("sorcery");
        save_case(cases, "1a.sorcery.B", "1a", "B", &positive, database);
        open(&mut positive, source);
        save_case(cases, "1a.sorcery.K1", "1a", "K1", &positive, database);
        submit_life(&mut positive, 2);
        finish(&mut positive);
        next_paid(&mut positive, next, 21, false);
        for kind in SCOPE_VARIANTS {
            let (mut runner, source, next) = scope_board(kind);
            save_case(cases, &format!("5b.{kind}.B"), "5b", "B", &runner, database);
            if matches!(
                *kind,
                "owner"
                    | "controller"
                    | "controlled-player"
                    | "copy"
                    | "token"
                    | "permanent"
                    | "cipher"
                    | "paradigm"
                    | "rebound"
                    | "epic"
            ) {
                assert!(runner
                    .state()
                    .manual_cast_unavailable_reason(A, source)
                    .is_some());
                assert!(runner.state().manual_resolution_binding().is_none());
                assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 2);
                assert_eq!(runner.state().players[A.0 as usize].life, 20);
            }
            // Use the real paid cast, then install exactly one finite context
            // axis. These axes are game facts, not new printed definitions.
            if *kind == "permanent" {
                continue;
            }
            {
                let state = runner.state_mut();
                let object = state.objects.get_mut(&source).unwrap();
                object.owner = A;
                object.controller = A;
                object.is_copy = false;
                object.is_token = false;
                state.active_full_turn_control = None;
                state.turn_decision_controller = None;
                state.turn_decision_control_timestamp = None;
                state.priority_player = A;
            }
            // Optional costs go through the existing ordinary cost election.
            if *kind == "paid-buyback" {
                runner.cast(source).accept_optional().commit();
            } else if *kind == "unpaid-buyback" {
                runner.cast(source).decline_optional().commit();
            } else {
                runner.cast(source).commit();
            }
            assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 1);
            let entry = runner.state().stack.back().unwrap().id;
            match *kind {
                "owner" => runner.state_mut().objects.get_mut(&source).unwrap().owner = B,
                "controller" => {
                    runner
                        .state_mut()
                        .objects
                        .get_mut(&source)
                        .unwrap()
                        .controller = B
                }
                "copy" => runner.state_mut().objects.get_mut(&source).unwrap().is_copy = true,
                "token" => {
                    runner
                        .state_mut()
                        .objects
                        .get_mut(&source)
                        .unwrap()
                        .is_token = true
                }
                "controlled-player" => {
                    runner.state_mut().active_full_turn_control =
                        Some(engine::types::game_state::ActivePlayerControl {
                            controller: B,
                            timestamp: 1,
                        });
                    runner.state_mut().turn_decision_controller = Some(B);
                    runner.state_mut().turn_decision_control_timestamp = Some(1);
                    runner.state_mut().priority_player = B;
                }
                "nonhand" => {
                    runner
                        .state_mut()
                        .objects
                        .get_mut(&source)
                        .unwrap()
                        .cast_from_zone = Some(Zone::Graveyard);
                    runner
                        .state_mut()
                        .stack
                        .back_mut()
                        .unwrap()
                        .ability_mut()
                        .unwrap()
                        .context
                        .cast_from_zone = Some(Zone::Graveyard);
                }
                "alternate" => {
                    runner
                        .state_mut()
                        .stack
                        .back_mut()
                        .unwrap()
                        .ability_mut()
                        .unwrap()
                        .context
                        .alternative_mana_cost_paid = true
                }
                "exile-rider" => {
                    runner
                        .state_mut()
                        .objects
                        .get_mut(&source)
                        .unwrap()
                        .exile_from_stack_rider =
                        Some(engine::types::ability::ExiledSpellRider::BecomePlotted)
                }
                "linked-exile" => {
                    runner
                        .state_mut()
                        .objects
                        .get_mut(&source)
                        .unwrap()
                        .exile_from_stack_linked_source = Some(next)
                }
                "paid-buyback" | "unpaid-buyback" | "cipher" | "paradigm" | "rebound" | "epic" => {}
                _ => unreachable!(),
            }
            save_case(
                cases,
                &format!("5b.{kind}.K0"),
                "5b",
                "K0",
                &runner,
                database,
            );
            if *kind == "unpaid-buyback" {
                runner
                    .act(GameAction::DesignateManualResolution {
                        stack_entry_id: entry,
                    })
                    .unwrap();
                passes(&mut runner);
                save_case(cases, "5b.unpaid-buyback.K1", "5b", "K1", &runner, database);
                submit_life(&mut runner, 2);
                finish(&mut runner);
                assert_eq!(runner.state().objects[&source].zone, Zone::Graveyard);
            } else {
                refuses_action(
                    &mut runner,
                    A,
                    GameAction::DesignateManualResolution {
                        stack_entry_id: entry,
                    },
                );
                assert!(runner.state().manual_resolution_binding().is_none());
                assert!(runner.state().resolving_stack_entry.is_none());
                assert_eq!(runner.state().players[A.0 as usize].life, 20);
                assert_eq!(
                    runner.state().stack.len(),
                    1,
                    "unsupported refusal retains the ordinary paid stack"
                );
            }
        }
    }

    fn timing_family(cases: &mut FixtureCases, database: &CardDatabase) {
        let (mut runner, source, next) = variant_board("life-observer");
        save_case(cases, "7a.B", "7a", "B", &runner, database);
        let observer = named(runner.state(), "P1 Life Lost Observer");
        open(&mut runner, source);
        save_case(cases, "7a.K1", "7a", "K1", &runner, database);
        let life = submit_life(&mut runner, 2);
        assert_loss(&life.result.events, source, 2, 18);
        // CR 603.3: collected once, placed at the next priority boundary.
        assert_eq!(runner.state().deferred_triggers.len(), 1);
        assert!(runner.state().stack.is_empty());
        save_case(cases, "7a.K2", "7a", "K2", &runner, database);
        finish(&mut runner);
        assert!(runner.state().deferred_triggers.is_empty());
        assert_eq!(runner.state().stack.len(), 1);
        assert_eq!(runner.state().stack.back().unwrap().source_id, observer);
        assert_eq!(runner.state().players[A.0 as usize].life, 18);
        passes(&mut runner);
        assert_eq!(runner.state().players[A.0 as usize].life, 19);
        assert!(runner.state().stack.is_empty());
        save_case(cases, "7a.K4", "7a", "K4", &runner, database);
        next_paid(&mut runner, next, 22, false);

        let (mut runner, source, next) = variant_board("mana-observer");
        assert!(runner.state().players[A.0 as usize]
            .mana_pool
            .mana
            .is_empty());
        let forest = named(runner.state(), "Forest");
        assert!(!runner.state().objects[&forest].tapped);
        save_case(cases, "7b.B", "7b", "B", &runner, database);
        let observer = named(runner.state(), "P1 Mana Observer");
        let submission = manual_cast_submission(runner.state(), source);
        let cast = submit_interaction(runner.state_mut(), A, submission).unwrap();
        // CR 605.1b + CR 605.4a: the exact existing classifier accepts
        // the unmodified targetless body and the real payment's firing event.
        let trigger = runner.state().objects[&observer].trigger_definitions[0]
            .definition
            .execute
            .as_ref()
            .unwrap();
        let ability = engine::types::ability::ResolvedAbility::new(
            *trigger.effect.clone(),
            vec![],
            observer,
            A,
        );
        let tap = cast
            .result
            .events
            .iter()
            .find(|event| matches!(event, GameEvent::TappedForMana { .. }))
            .unwrap();
        assert!(engine::game::mana_abilities::is_triggered_mana_ability(
            &ability,
            Some(tap)
        ));
        assert_eq!(cast.result.events.iter().filter(|event| matches!(event, GameEvent::ManaAdded { player_id, mana_type: ManaType::Green, .. } if *player_id == A)).count(), 2);
        let mana_nodes = runner
            .state()
            .resolved_rules_journal
            .nodes()
            .iter()
            .filter(|node| {
                matches!(
                    node.kind,
                    engine::types::resolved_commands::RulesExecutionNodeKind::TriggeredMana { .. }
                )
            })
            .count();
        assert_eq!(
            mana_nodes, 1,
            "one actual accepted immediate mana occurrence"
        );
        assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 1);
        assert!(runner.state().deferred_triggers.is_empty());
        assert_eq!(runner.state().stack.len(), 1);
        save_case(cases, "7b.K0", "7b", "K0", &runner, database);
        passes(&mut runner);
        save_case(cases, "7b.K1", "7b", "K1", &runner, database);
        let life = submit_life(&mut runner, 2);
        assert_loss(&life.result.events, source, 2, 18);
        assert!(!engine::game::mana_abilities::is_triggered_mana_ability(
            &ability,
            life.result
                .events
                .iter()
                .find(|event| matches!(event, GameEvent::LifeChanged { .. }))
        ));
        save_case(cases, "7b.K2", "7b", "K2", &runner, database);
        finish(&mut runner);
        assert_eq!(
            runner
                .state()
                .resolved_rules_journal
                .nodes()
                .iter()
                .filter(|node| matches!(
                    node.kind,
                    engine::types::resolved_commands::RulesExecutionNodeKind::TriggeredMana { .. }
                ))
                .count(),
            mana_nodes
        );
        save_case(cases, "7b.K4", "7b", "K4", &runner, database);
        next_paid(&mut runner, next, 21, false);

        for damaged in [false, true] {
            let (mut runner, source, next) = variant_board("death-observer");
            let creature = named(runner.state(), "P1 Damaged C");
            let observer = named(runner.state(), "P1 Death Observer");
            if damaged {
                save_case(cases, "7c.B", "7c", "B", &runner, database);
            }
            open(&mut runner, source);
            if damaged {
                runner
                    .state_mut()
                    .objects
                    .get_mut(&creature)
                    .unwrap()
                    .damage_marked = 1;
            }
            save_case(
                cases,
                if damaged { "7c.K1" } else { "7c.clean.K1" },
                "7c",
                "K1",
                &runner,
                database,
            );
            submit_life(&mut runner, 2);
            // CR 704.3 + CR 704.5g: an open resolution is not a priority
            // boundary; the eventual boundary observes this occurrence once.
            assert_eq!(runner.state().objects[&creature].zone, Zone::Battlefield);
            assert!(runner.state().deferred_triggers.is_empty());
            if damaged {
                save_case(cases, "7c.K2", "7c", "K2", &runner, database);
            }
            let finished = finish(&mut runner);
            let death_count = finished.result.events.iter().filter(|event| matches!(event, GameEvent::ZoneChanged { object_id, from: Some(Zone::Battlefield), to: Zone::Graveyard, .. } if *object_id == creature)).count();
            assert_eq!(death_count, usize::from(damaged));
            assert_eq!(runner.state().stack.len(), usize::from(damaged));
            if damaged {
                assert_eq!(runner.state().stack.back().unwrap().source_id, observer);
                passes(&mut runner);
                assert_eq!(runner.state().players[A.0 as usize].life, 19);
                save_case(cases, "7c.K4", "7c", "K4", &runner, database);
                next_paid(&mut runner, next, 22, false);
            } else {
                assert_eq!(runner.state().objects[&creature].zone, Zone::Battlefield);
                next_paid(&mut runner, next, 21, false);
            }
        }
    }

    fn exact_submission(
        state: &GameState,
        actor: PlayerId,
        expected: impl Fn(&GameAction) -> bool,
    ) -> InteractionSubmission {
        let view = derive_viewer_interaction(state, &filter_state_for_viewer(state, actor), actor);
        for opportunity in view.opportunities {
            let InteractionOpportunityResponse::ExactChoices { choices } = opportunity.response
            else {
                continue;
            };
            for choice in choices {
                let submission = InteractionSubmission {
                    interaction_id: opportunity.interaction_id.clone(),
                    response: InteractionResponse::Choose {
                        choice_id: choice.id,
                    },
                };
                if classify_manual_interaction(state, actor, &submission)
                    .unwrap()
                    .is_none()
                    && resolve_interaction_response(state, actor, &submission)
                        .is_ok_and(|action| expected(&action))
                {
                    return submission;
                }
            }
        }
        panic!("required ordinary authenticated choice must exist");
    }

    fn terminal_submission(state: &GameState, accept: bool) -> InteractionSubmission {
        let WaitingFor::ReplacementChoice {
            player, candidates, ..
        } = &state.waiting_for
        else {
            panic!("terminal child required")
        };
        assert_eq!(*player, A);
        assert_eq!(candidates.len(), 2);
        let label = if accept { "Accept" } else { "Decline" };
        let expected_index = candidates
            .iter()
            .position(|candidate| candidate.description == label)
            .unwrap();
        exact_submission(
            state,
            A,
            |action| matches!(action, GameAction::ChooseReplacement { index } if *index == expected_index),
        )
    }

    fn terminal_hostility(cases: &mut FixtureCases, database: &CardDatabase) {
        let (mut runner, source, next) = fixed_board(true);
        let entry = open(&mut runner, source);
        submit_life(&mut runner, 2);
        let parent = finish_submission(runner.state());
        let finished = submit_interaction(runner.state_mut(), A, parent.clone()).unwrap();
        assert_eq!(resolved(&finished.result.events, entry), 1);
        assert_eq!(moved(&finished.result.events, source, Zone::Graveyard), 0);
        assert_eq!(moved(&finished.result.events, source, Zone::Exile), 0);
        save_case(cases, "6c.K3", "6c", "K3", &runner, database);
        let child = terminal_submission(runner.state(), true);
        refuses_submission(&mut runner, B, child.clone());
        refuses_submission(&mut runner, PlayerId(2), child.clone());
        refuses_submission(&mut runner, A, parent);
        refuses_action(
            &mut runner,
            A,
            GameAction::FinishManualResolution {
                stack_entry_id: entry,
            },
        );
        let next_card = runner.state().objects[&next].card_id;
        refuses_action(
            &mut runner,
            A,
            GameAction::CastSpell {
                object_id: next,
                card_id: next_card,
                targets: vec![],
                payment_mode: CastPaymentMode::Auto,
            },
        );
        let resumed = submit_interaction(runner.state_mut(), A, child).unwrap();
        assert_eq!(resolved(&resumed.result.events, entry), 0);
        assert_eq!(moved(&resumed.result.events, source, Zone::Exile), 1);
        assert_eq!(runner.state().objects[&source].zone, Zone::Exile);
        assert!(runner.state().resolving_stack_entry.is_none());
        save_case(cases, "6c.K4", "6c", "K4", &runner, database);
        next_paid(&mut runner, next, 21, true);
    }

    fn independent_restore_family(cases: &mut FixtureCases, database: &CardDatabase) {
        for (family, position, base) in [
            ("8-R1", "K0", "1a.K0"),
            ("8-R2", "K1", "1a.K1"),
            ("8-R3", "K2", "1a.K2"),
            ("8-R4", "K3", "6a.K3"),
            ("8-S1", "K4", "1a.K4"),
        ] {
            alias_case(cases, &format!("{family}.{position}"), family, base);
            let checkpoint = cases[base]["checkpoint"].as_str().unwrap().to_owned();
            let old_state = checked_restore(&checkpoint, database).unwrap();
            let source = named(&old_state, "P1 Self Loss");
            let next = named(&old_state, "Next Ordinary Play");
            let old_submission = match position {
                "K0" | "K4" => exact_submission(&old_state, A, |action| {
                    matches!(action, GameAction::PassPriority)
                }),
                "K1" => life_submission(&old_state, 2),
                "K2" => finish_submission(&old_state),
                "K3" => terminal_submission(&old_state, true),
                _ => unreachable!(),
            };
            // Each position starts from its own saved resident, independently.
            // Transport epoch 0/10 -> 1/11 belongs to the WASM live-owner test;
            // native rebind below proves the actual new opaque session fence.
            let restored = checked_restore(&checkpoint, database).unwrap();
            assert_eq!(
                restored.resolved_rules_journal,
                old_state.resolved_rules_journal
            );
            assert_eq!(
                restored.manual_resolution_binding(),
                old_state.manual_resolution_binding()
            );
            assert_eq!(
                restored.resolving_stack_entry,
                old_state.resolving_stack_entry
            );
            let mut runner = GameRunner::from_state(restored);
            let session = InteractionSessionId(format!("p1-native-restored-{family}"));
            bind_interaction_authority(runner.state_mut(), session.clone()).unwrap();
            assert_eq!(runner.state().interaction_session_id, Some(session));
            assert_ne!(
                runner.state().interaction_session_id,
                old_state.interaction_session_id
            );
            refuses_submission(&mut runner, A, old_submission);
            if position == "K0" {
                assert!(runner.state().resolving_stack_entry.is_none());
                assert_eq!(runner.state().stack.len(), 1);
                passes(&mut runner);
            }
            if matches!(position, "K0" | "K1") {
                assert_eq!(runner.state().players[A.0 as usize].life, 20);
                let applied = submit_life(&mut runner, 2);
                assert_loss(&applied.result.events, source, 2, 18);
            } else {
                assert_eq!(runner.state().players[A.0 as usize].life, 18);
            }
            if matches!(position, "K0" | "K1" | "K2") {
                finish(&mut runner);
            }
            if position == "K3" {
                let child = terminal_submission(runner.state(), true);
                let resumed = submit_interaction(runner.state_mut(), A, child).unwrap();
                assert_eq!(resolved(&resumed.result.events, source), 0);
                assert_eq!(moved(&resumed.result.events, source, Zone::Exile), 1);
            }
            assert!(runner.state().resolving_stack_entry.is_none());
            assert!(runner.state().manual_resolution_binding().is_none());
            next_paid(&mut runner, next, 21, position == "K3");

            // Publish valid engine-authored positions for the hostile sibling.
            // The consuming test corrupts its own copy, never the bundle.
            alias_case(cases, &format!("8x.{position}"), "8x", base);
            let valid: serde_json::Value = serde_json::from_str(&checkpoint).unwrap();
            let mut unsupported_version = valid.clone();
            unsupported_version["state"]["resolution_state_version"] = 99.into();
            assert!(checked_restore(&unsupported_version.to_string(), database).is_err());
            let mut downgrade = valid.clone();
            downgrade["state"]["resolution_state_version"] =
                if position == "K4" { 6.into() } else { 4.into() };
            assert!(checked_restore(&downgrade.to_string(), database).is_err());
            let mut unknown = valid.clone();
            unknown["state"]["manual_resolution_future"] =
                serde_json::json!({"bodyAlreadySuppressed":true});
            assert!(checked_restore(&unknown.to_string(), database).is_err(), "unknown Manual persistence must never degrade to ordinary automatic resolution ({position})");
            if position != "K4" {
                for field in ["actor", "stack_entry_id"] {
                    let mut corrupt = valid.clone();
                    corrupt["state"]["manual_resolution_state"]["data"]["binding"][field] =
                        999.into();
                    assert!(
                        checked_restore(&corrupt.to_string(), database).is_err(),
                        "corrupt binding {field} at {position}"
                    );
                }
                let mut corrupt = valid.clone();
                corrupt["state"]["manual_resolution_state"]["data"]["binding"]["source"]
                    ["incarnation"] = 999.into();
                assert!(checked_restore(&corrupt.to_string(), database).is_err());
                if position != "K0" {
                    let mut carrier = valid.clone();
                    carrier["state"]["resolving_stack_entry"]["id"] = 999.into();
                    assert!(checked_restore(&carrier.to_string(), database).is_err());
                    let mut owner = valid.clone();
                    owner["state"]["manual_resolution_state"]["data"]["begin"]["owner"] = 1.into();
                    assert!(checked_restore(&owner.to_string(), database).is_err());
                }
                if position == "K3" {
                    let mut child = valid.clone();
                    child["state"]["pending_replacement"]["proposed"]["ZoneChange"]["object_id"] =
                        next.0.into();
                    assert!(
                        checked_restore(&child.to_string(), database).is_err(),
                        "parked child must belong to the original carrier"
                    );
                }
            }
            let projection =
                serde_json::to_string(&filter_state_for_viewer(&old_state, A)).unwrap();
            assert!(
                serde_json::from_str::<TrustedGameStateEnvelope>(&projection).is_err(),
                "viewer projection is not a trusted continuation envelope"
            );
        }
        let valid: serde_json::Value =
            serde_json::from_str(cases["3b.K1"]["checkpoint"].as_str().unwrap()).unwrap();
        let mut target = valid.clone();
        target["state"]["manual_resolution_state"]["data"]["begin"]["ability"]
            ["selected_target_incarnations"][0]["incarnation"] = 999.into();
        assert!(
            checked_restore(&target.to_string(), database).is_err(),
            "tampered Begin target must disagree with the installed original carrier"
        );
        alias_case(cases, "8x.target.K1", "8x", "3b.K1");
    }

    fn ack_fixture_positions(cases: &mut FixtureCases, database: &CardDatabase) {
        // ACK knowledge, private receipts, registration/apply queue and epoch
        // rotation are owned by the existing WASM authority tests. Native
        // supplies their real pre/post positions, with no forged receipt data.
        for (operation, pre, post) in [("life", "1a.K1", "1a.K2"), ("finish", "1a.K2", "1a.K4")] {
            for variant in ["9a", "9b", "9c", "9d"] {
                let base = if variant == "9b" { post } else { pre };
                let position = cases[base]["position"].as_str().unwrap().to_owned();
                alias_case(
                    cases,
                    &format!("{variant}.{operation}.{position}"),
                    variant,
                    base,
                );
            }
            let post_position = cases[post]["position"].as_str().unwrap().to_owned();
            alias_case(
                cases,
                &format!("9d.{operation}.applied.{post_position}"),
                "9d",
                post,
            );
        }
        let (mut runner, source, next) = variant_board("response");
        open(&mut runner, source);
        let first = life_submission(runner.state(), 2);
        let applied = submit_interaction(runner.state_mut(), A, first.clone()).unwrap();
        assert_loss(&applied.result.events, source, 2, 18);
        refuses_submission(&mut runner, A, first);
        let parent = finish_submission(runner.state());
        let finished = submit_interaction(runner.state_mut(), A, parent.clone()).unwrap();
        assert_eq!(resolved(&finished.result.events, source), 1);
        refuses_submission(&mut runner, A, parent);
        save_case(
            cases,
            "9b.finish.response.K4",
            "9b",
            "K4",
            &runner,
            database,
        );
        runner.act(GameAction::PassPriority).unwrap();
        let response = named(runner.state(), "P1 Response U");
        let submission = exact_submission(
            runner.state(),
            B,
            |action| matches!(action, GameAction::CastSpell { object_id, payment_mode: CastPaymentMode::Auto, .. } if *object_id == response),
        );
        submit_interaction(runner.state_mut(), B, submission).unwrap();
        let response_entry = runner.state().stack.back().unwrap().id;
        let events = passes(&mut runner);
        assert_eq!(resolved(&events, response_entry), 1);
        assert_eq!(runner.state().players[B.0 as usize].life, 21);
        assert_eq!(runner.state().players[A.0 as usize].life, 18);
        assert!(runner.state().manual_resolution_binding().is_none());
        next_paid(&mut runner, next, 21, false);
    }

    fn projection_family(cases: &mut FixtureCases, database: &CardDatabase) {
        for (family, position, amount) in [
            ("10a", "K1", None),
            ("10b", "K2", Some(2)),
            ("10c", "K1", None),
        ] {
            let (mut runner, source, next) = fixed_board(false);
            open(&mut runner, source);
            if let Some(amount) = amount {
                submit_life(&mut runner, amount);
            }
            save_case(
                cases,
                &format!("{family}.{position}"),
                family,
                position,
                &runner,
                database,
            );
            let captured = manual_resolution_view(
                runner.state(),
                &filter_state_for_viewer(runner.state(), A),
                Some(A),
            )
            .unwrap();
            let before = runner.state().clone();
            for viewer in [A, B, A] {
                let filtered = filter_state_for_viewer(runner.state(), viewer);
                let public_source = &filtered.objects[&source];
                assert_eq!(public_source.name, "P1 Self Loss");
                assert!(
                    filtered.stack.is_empty(),
                    "source is carrier context, not an unresolved stack item"
                );
                let view = manual_resolution_view(runner.state(), &filtered, Some(viewer)).unwrap();
                assert_eq!(view.source, captured.source);
                assert_eq!(view.phase, ManualResolutionPhase::Open);
                assert_eq!(view.interaction_id.is_some(), viewer == A);
                assert!(filtered.interaction_session_id.is_none());
                assert!(filtered.active_interaction_slots.is_empty());
                assert!(!filtered
                    .objects
                    .values()
                    .any(|object| object.zone == Zone::Library && object.name != "Hidden Card"));
                if viewer == A {
                    assert!(!filtered
                        .objects
                        .values()
                        .any(|object| object.name == "P1 Secret Hand"));
                } else {
                    assert!(!filtered
                        .objects
                        .values()
                        .any(|object| object.name == "Next Ordinary Play"));
                }
                assert_eq!(
                    runner.state(),
                    &before,
                    "reading/perspective does not mutate native state"
                );
            }
            let public = engine::game::visibility::filter_state_for_unseated_viewer(runner.state());
            let view = manual_resolution_view(runner.state(), &public, None).unwrap();
            assert_eq!(view.source, captured.source);
            assert!(view.interaction_id.is_none());
            assert!(!public
                .objects
                .values()
                .any(|object| matches!(object.zone, Zone::Hand | Zone::Library)
                    && object.name != "Hidden Card"));
            if family == "10c" {
                let stale = life_submission(runner.state(), 2);
                let checkpoint = capture(runner.state(), database);
                let restored = checked_restore(&checkpoint, database).unwrap();
                runner = GameRunner::from_state(restored);
                bind_interaction_authority(
                    runner.state_mut(),
                    InteractionSessionId("p1-native-invalidated-selection".into()),
                )
                .unwrap();
                refuses_submission(&mut runner, A, stale);
                save_case(cases, "10c.restored.K1", family, "K1", &runner, database);
            }
            if position == "K1" {
                let life = submit_life(&mut runner, 2);
                assert_loss(&life.result.events, source, 2, 18);
            }
            finish(&mut runner);
            next_paid(&mut runner, next, 21, false);
        }
    }

    fn ordinary_and_offer_families(cases: &mut FixtureCases, database: &CardDatabase) {
        for (id, card) in [("11c.S.B", "S"), ("11c.N.B", "N"), ("11c.V.B", "V")] {
            let (mut runner, source, next) = variant_board("vanilla");
            save_case(cases, id, "11c", "B", &runner, database);
            let selected = match card {
                "S" => source,
                "N" => next,
                "V" => named(runner.state(), "P1 Vanilla V"),
                _ => unreachable!(),
            };
            let outcome = runner.cast(selected).resolve();
            match card {
                "S" => outcome.assert_life_delta(A, -2),
                "N" => outcome.assert_life_delta(A, 3),
                "V" => {
                    outcome.assert_life_delta(A, 0);
                    outcome.assert_zone(&[selected], Zone::Battlefield);
                }
                _ => unreachable!(),
            }
            assert_eq!(outcome.events().iter().filter(|event| matches!(event, GameEvent::SpellCast { object_id, .. } if *object_id == selected)).count(), 1);
            assert_eq!(outcome.events().iter().filter(|event| matches!(event, GameEvent::ZoneChanged { object_id, from: Some(Zone::Stack), to, .. } if *object_id == selected && *to == if card == "V" { Zone::Battlefield } else { Zone::Graveyard })).count(), 1);
            assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 1);
            assert!(runner.state().manual_resolution_binding().is_none());
            assert!(runner.state().resolving_stack_entry.is_none());
            assert!(matches!(
                runner.state().waiting_for,
                WaitingFor::Priority { .. }
            ));
        }
        // These are ordinary trusted startup controls. Admission/realm/public
        // restore revocation cannot be manufactured by native engine fixtures.
        alias_case(cases, "11a.B", "11a", "1a.B");
        alias_case(cases, "11b.B", "11b", "1a.B");
        alias_case(cases, "12a.B", "12a", "1a.B");
        alias_case(cases, "12c.K4", "12c", "1a.K4");
        let (mut runner, source, next) = fixed_board(false);
        let before = runner.state().clone();
        let supported = manual_cast_submission(runner.state(), source);
        assert_eq!(
            classify_manual_interaction(runner.state(), A, &supported).unwrap(),
            Some(ManualInteractionKind::CastIntent)
        );
        assert_eq!(
            runner.state(),
            &before,
            "offering scope/intent is read-only before payment"
        );
        assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 2);
        submit_interaction(runner.state_mut(), A, supported).unwrap();
        assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 1);
        passes(&mut runner);
        submit_life(&mut runner, 2);
        finish(&mut runner);
        next_paid(&mut runner, next, 21, false);

        let (mut unsupported, source, next) = scope_board("cipher");
        save_case(cases, "12b.B", "12b", "B", &unsupported, database);
        let before = unsupported.state().clone();
        assert_eq!(
            unsupported
                .state()
                .manual_cast_unavailable_reason(A, source),
            Some(engine::types::interaction::ManualCastUnsupportedReason::ResolutionHook)
        );
        let view = derive_viewer_interaction(
            unsupported.state(),
            &filter_state_for_viewer(unsupported.state(), A),
            A,
        );
        let mut ordinary_reached = false;
        for opportunity in view.opportunities {
            let InteractionOpportunityResponse::ExactChoices { choices } = opportunity.response
            else {
                continue;
            };
            for choice in choices {
                let submission = InteractionSubmission {
                    interaction_id: opportunity.interaction_id.clone(),
                    response: InteractionResponse::Choose {
                        choice_id: choice.id,
                    },
                };
                if matches!(resolve_interaction_response(unsupported.state(), A, &submission).unwrap(), GameAction::CastSpell { object_id, .. } if object_id == source)
                {
                    ordinary_reached = true;
                    assert!(
                        classify_manual_interaction(unsupported.state(), A, &submission)
                            .unwrap()
                            .is_none()
                    );
                    assert!(choice.surfaces.iter().any(|surface| matches!(surface, engine::types::interaction::InteractionPresentationSurface::ManualCast { availability: engine::types::interaction::ManualCastAvailability::Unsupported { reason: engine::types::interaction::ManualCastUnsupportedReason::ResolutionHook } })));
                }
            }
        }
        assert!(
            ordinary_reached,
            "unsupported scope is exposed on the actual otherwise legal paid card context"
        );
        assert_eq!(unsupported.state(), &before);
        unsupported.cast(next).resolve().assert_life_delta(A, 3);
        assert_eq!(
            unsupported.state().players[A.0 as usize].mana_pool.total(),
            1
        );
        assert_eq!(unsupported.state().objects[&source].zone, Zone::Hand);
    }

    #[test]
    fn manual_cast_revalidates_original_hand_custody_before_payment() {
        for kind in [
            "supported",
            "owner",
            "controller",
            "incarnation",
            "stack-zone",
            "announcement-source",
            "announcement-controller",
            "announcement-card",
            "announcement-variant",
            "alternative-cost",
            "paid-buyback",
            "exile-rider",
            "linked-exile",
            "cipher",
            "paradigm",
            "rebound",
            "epic",
        ] {
            let (mut runner, source, next) = scope_board("unpaid-buyback");
            let original =
                ObjectIncarnationRef::of(source, runner.state().objects[&source].incarnation);
            let submission = manual_cast_submission(runner.state(), source);
            let selected = submit_interaction(runner.state_mut(), A, submission).unwrap();
            assert!(
                matches!(selected.action, GameAction::CastSpell { object_id, .. } if object_id == source)
            );
            assert!(matches!(
                runner.state().waiting_for,
                WaitingFor::OptionalCostChoice { .. }
            ));
            assert_eq!(runner.state().objects[&source].zone, Zone::Hand);
            assert_eq!(
                runner.state().objects[&source].incarnation,
                original.incarnation
            );
            assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 2);
            assert_eq!(runner.state().stack.len(), 1);
            assert!(runner.state().stack.back().unwrap().ability().is_none());
            assert!(!selected.result.events.iter().any(|event| matches!(
                event,
                GameEvent::SpellCast { .. }
                    | GameEvent::ZoneChanged { .. }
                    | GameEvent::LifeChanged { .. }
            )));

            // Change custody after the authenticated intent was selected, then
            // resume the same ordinary cost choice through the reducer.
            let other_card = runner.state().objects[&next].card_id;
            match kind {
                "supported" => {}
                "owner" => runner.state_mut().objects.get_mut(&source).unwrap().owner = B,
                "controller" => {
                    runner
                        .state_mut()
                        .objects
                        .get_mut(&source)
                        .unwrap()
                        .controller = B
                }
                "incarnation" => {
                    runner
                        .state_mut()
                        .objects
                        .get_mut(&source)
                        .unwrap()
                        .incarnation += 1
                }
                "stack-zone" => {
                    runner.state_mut().objects.get_mut(&source).unwrap().zone = Zone::Stack
                }
                "announcement-source" => {
                    runner.state_mut().stack.back_mut().unwrap().source_id = next
                }
                "announcement-controller" => {
                    runner.state_mut().stack.back_mut().unwrap().controller = B
                }
                "announcement-card" => {
                    let StackEntryKind::Spell { card_id, .. } =
                        &mut runner.state_mut().stack.back_mut().unwrap().kind
                    else {
                        panic!("announced spell")
                    };
                    *card_id = other_card;
                }
                "announcement-variant" => {
                    let StackEntryKind::Spell {
                        casting_variant, ..
                    } = &mut runner.state_mut().stack.back_mut().unwrap().kind
                    else {
                        panic!("announced spell")
                    };
                    *casting_variant = CastingVariant::Flashback;
                }
                "alternative-cost" | "paid-buyback" => {
                    let WaitingFor::OptionalCostChoice { pending_cast, .. } =
                        &mut runner.state_mut().waiting_for
                    else {
                        panic!("ordinary additional cost choice")
                    };
                    if kind == "alternative-cost" {
                        pending_cast.ability.context.alternative_mana_cost_paid = true;
                    } else {
                        pending_cast.ability.context.additional_cost_paid = true;
                    }
                }
                "exile-rider" => {
                    runner
                        .state_mut()
                        .objects
                        .get_mut(&source)
                        .unwrap()
                        .exile_from_stack_rider =
                        Some(engine::types::ability::ExiledSpellRider::BecomePlotted)
                }
                "linked-exile" => {
                    runner
                        .state_mut()
                        .objects
                        .get_mut(&source)
                        .unwrap()
                        .exile_from_stack_linked_source = Some(next)
                }
                "cipher" | "paradigm" | "rebound" | "epic" => {
                    let keyword = match kind {
                        "cipher" => Keyword::Cipher,
                        "paradigm" => Keyword::Paradigm,
                        "rebound" => Keyword::Rebound,
                        "epic" => Keyword::Epic,
                        _ => unreachable!(),
                    };
                    let object = runner.state_mut().objects.get_mut(&source).unwrap();
                    object.base_keywords.push(keyword.clone());
                    object.keywords.push(keyword);
                }
                _ => unreachable!(),
            }
            let before = runner.state().clone();
            let result = apply(
                runner.state_mut(),
                A,
                GameAction::DecideOptionalCost { pay: false },
            );
            if kind != "supported" {
                let error = result.expect_err(kind);
                assert!(
                    matches!(error, EngineError::InvalidAction(ref reason) if reason == "Selected Manual cast is outside its supported scope; costs were not committed"),
                    "{kind}: {error:?}"
                );
                assert_eq!(
                    runner.state(),
                    &before,
                    "{kind}: refusal rolls back costs, events and custody"
                );
                continue;
            }
            let cast = result.expect("unpaid Buyback retains supported original hand custody");
            assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 1);
            assert_eq!(runner.state().objects[&source].zone, Zone::Stack);
            let binding = runner.state().manual_resolution_binding().unwrap();
            assert_eq!(binding.source.object_id, original.object_id);
            assert_eq!(
                Some(binding.source.incarnation),
                original.incarnation.checked_add(1)
            );
            assert_eq!(cast.events.iter().filter(|event| matches!(event, GameEvent::SpellCast { object_id, .. } if *object_id == source)).count(), 1);
            passes(&mut runner);
            assert!(matches!(
                runner.state().waiting_for,
                WaitingFor::ManualResolution { .. }
            ));
            assert_eq!(runner.state().players[A.0 as usize].life, 20);
            submit_life(&mut runner, 2);
            finish(&mut runner);
            next_paid(&mut runner, next, 21, false);
        }
    }

    #[test]
    fn paid_manual_begin_life_finish_next_and_checked_checkpoints() {
        let mut cases = BTreeMap::new();
        let cards = finite_card_map();
        let database = CardDatabase::from_json_str(&cards).unwrap();
        for (variant, replacement, amounts) in [
            ("1a", false, vec![2]),
            ("1c", false, vec![1, 1]),
            ("6a", true, vec![2]),
            ("6b", true, vec![2]),
        ] {
            let (mut runner, source, next) = fixed_board(replacement);
            cases.insert(format!("{variant}.B"), serde_json::json!({"familyVariant":variant,"position":"B","checkpoint":capture(runner.state(), &database)}));
            let submission = manual_cast_submission(runner.state(), source);
            let pips = runner.state().players[A.0 as usize]
                .mana_pool
                .mana
                .iter()
                .map(|unit| unit.pip_id)
                .collect::<BTreeSet<_>>();
            let spent_before = runner.state().resolved_rules_journal.spent_mana().len();
            let cast = submit_interaction(runner.state_mut(), A, submission).unwrap();
            assert!(matches!(
                cast.action,
                GameAction::CastSpell {
                    payment_mode: CastPaymentMode::Auto,
                    ..
                }
            ));
            assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 1);
            assert_eq!(
                runner.state().resolved_rules_journal.spent_mana().len(),
                spent_before + 1
            );
            let paid_pip = runner
                .state()
                .resolved_rules_journal
                .spent_mana()
                .last()
                .unwrap()
                .unit
                .pip_id;
            let remaining_pip = runner.state().players[A.0 as usize].mana_pool.mana[0].pip_id;
            assert_ne!(paid_pip, remaining_pip);
            assert_eq!(pips, BTreeSet::from([paid_pip, remaining_pip]));
            assert_eq!(cast.result.events.iter().filter(|event| matches!(event, GameEvent::SpellCast { object_id, controller, .. } if *object_id == source && *controller == A)).count(), 1);
            assert_eq!(runner.state().players[A.0 as usize].life, 20);
            let binding = runner.state().manual_resolution_binding().unwrap().clone();
            let entry = binding.stack_entry_id;
            assert_eq!(
                runner.state().stack.len(),
                1,
                "ordinary response opportunity remains"
            );
            cases.insert(format!("{variant}.K0"), serde_json::json!({"familyVariant":variant,"position":"K0","checkpoint":capture(runner.state(), &database)}));
            runner.act(GameAction::PassPriority).unwrap();
            runner.act(GameAction::PassPriority).unwrap();
            assert!(
                runner.state().stack.is_empty(),
                "Begin owns the popped occurrence before any Manual body"
            );
            assert_eq!(
                runner.state().resolving_stack_entry.as_ref().unwrap().id,
                entry
            );
            assert_eq!(runner.state().manual_resolution_binding(), Some(&binding));
            assert_eq!(runner.state().players[A.0 as usize].life, 20);
            cases.insert(format!("{variant}.K1"), serde_json::json!({"familyVariant":variant,"position":"K1","checkpoint":capture(runner.state(), &database)}));
            let mut expected = 20;
            let mut originals: Vec<InteractionSubmission> = vec![];
            for amount in amounts {
                let original = life_submission(runner.state(), amount);
                for previous in &originals {
                    assert_ne!(previous.interaction_id, original.interaction_id);
                    refuses_submission(&mut runner, A, previous.clone());
                }
                let applied = submit_interaction(runner.state_mut(), A, original.clone()).unwrap();
                expected -= amount as i32;
                assert_loss(&applied.result.events, source, amount, expected);
                assert_eq!(runner.state().players[A.0 as usize].life, expected);
                assert_eq!(runner.state().manual_resolution_binding(), Some(&binding));
                assert_eq!(applied.result.events.iter().filter(|event| matches!(event, GameEvent::LifeChanged { player_id, amount: delta, .. } if *player_id == A && *delta == -(amount as i32))).count(), 1);
                assert_eq!(applied.result.events.iter().filter(|event| matches!(event, GameEvent::EffectResolved { kind: engine::types::ability::EffectKind::LoseLife, source_id, .. } if *source_id == source)).count(), 1);
                assert_eq!(
                    applied
                        .result
                        .events
                        .iter()
                        .filter(|event| matches!(event, GameEvent::StackResolved { .. }))
                        .count(),
                    0
                );
                refuses_submission(&mut runner, A, original.clone());
                originals.push(original);
                if variant == "1c" && expected == 19 {
                    save_case(&mut cases, "1c.first.K2", variant, "K2", &runner, &database);
                }
            }
            for previous in originals {
                refuses_submission(&mut runner, A, previous);
            }
            cases.insert(format!("{variant}.K2"), serde_json::json!({"familyVariant":variant,"position":"K2","checkpoint":capture(runner.state(), &database)}));
            let original_finish = finish_submission(runner.state());
            let finished =
                submit_interaction(runner.state_mut(), A, original_finish.clone()).unwrap();
            assert_eq!(finished.result.events.iter().filter(|event| matches!(event, GameEvent::StackResolved { object_id } if *object_id == entry)).count(), 1);
            if replacement {
                let view = manual_resolution_view(
                    runner.state(),
                    &filter_state_for_viewer(runner.state(), A),
                    Some(A),
                )
                .unwrap();
                assert_eq!(view.phase, ManualResolutionPhase::TerminalChildPending);
                assert!(runner.state().resolving_stack_entry.is_some());
                cases.insert(format!("{variant}.K3"), serde_json::json!({"familyVariant":variant,"position":"K3","checkpoint":capture(runner.state(), &database)}));
                refuses_submission(&mut runner, A, original_finish.clone());
                let child = terminal_submission(runner.state(), variant == "6a");
                let resumed = submit_interaction(runner.state_mut(), A, child).unwrap();
                assert_eq!(resolved(&resumed.result.events, entry), 0);
                assert_eq!(
                    moved(
                        &resumed.result.events,
                        source,
                        if variant == "6a" {
                            Zone::Exile
                        } else {
                            Zone::Graveyard
                        }
                    ),
                    1
                );
                assert_eq!(
                    manual_resolution_view_for_source(
                        runner.state(),
                        &filter_state_for_viewer(runner.state(), A),
                        Some(A),
                        &view.source
                    )
                    .phase,
                    ManualResolutionPhase::Closed
                );
            }
            assert!(runner.state().resolving_stack_entry.is_none());
            assert!(runner.state().manual_resolution_binding().is_none());
            assert_eq!(runner.state().players[A.0 as usize].life, 18);
            assert_eq!(
                runner.state().objects[&source].zone,
                if variant == "6a" {
                    Zone::Exile
                } else {
                    Zone::Graveyard
                }
            );
            cases.insert(format!("{variant}.K4"), serde_json::json!({"familyVariant":variant,"position":"K4","checkpoint":capture(runner.state(), &database)}));
            refuses_submission(&mut runner, A, original_finish);
            next_paid(&mut runner, next, 21, replacement);
        }
        alias_case(&mut cases, "1b.K2", "1b", "1a.K2");
        alias_case(&mut cases, "1b.K4", "1b", "1a.K4");
        response_families(&mut cases, &database);
        target_families(&mut cases, &database);
        refusal_family(&mut cases, &database);
        unsupported_family(&mut cases, &database);
        terminal_hostility(&mut cases, &database);
        timing_family(&mut cases, &database);
        independent_restore_family(&mut cases, &database);
        ack_fixture_positions(&mut cases, &database);
        projection_family(&mut cases, &database);
        ordinary_and_offer_families(&mut cases, &database);
        automatic_reference_spells_pay_and_resolve_typed_bodies();
        prepayment_manual_intent_beats_enabled_autopass_and_begin_refusal_never_runs_body();
        let families: BTreeSet<_> = cases
            .values()
            .map(|case| case["familyVariant"].as_str().unwrap())
            .collect();
        assert_eq!(
            families,
            BTreeSet::from([
                "1a", "1b", "1c", "2a", "2b", "2c", "3a", "3b", "4a", "4b", "5a", "5b", "5c", "6a",
                "6b", "6c", "7a", "7b", "7c", "8-R1", "8-R2", "8-R3", "8-R4", "8-S1", "8x", "9a",
                "9b", "9c", "9d", "10a", "10b", "10c", "11a", "11b", "11c", "12a", "12b", "12c",
            ])
        );
        assert_eq!(
            cases.len(),
            145,
            "the reviewed finite bundle includes every fixed variant/position and hostile sibling"
        );
        println!(
            "P1 finite checked fixture keys: {}",
            cases.keys().cloned().collect::<Vec<_>>().join(", ")
        );
        if let Some(directory) = std::env::var_os("P1_FIXTURE_OUTPUT_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("card-data.json"), &cards).unwrap();
            std::fs::write(
                directory.join("trusted-game-states.json"),
                serde_json::to_vec(&serde_json::json!({"version":1,"cases":cases})).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn prepayment_manual_intent_beats_enabled_autopass_and_begin_refusal_never_runs_body() {
        let (mut runner, source, _) = fixed_board(false);
        for player in [A, B] {
            runner.state_mut().auto_pass.insert(
                player,
                AutoPassMode::UntilStackEmpty {
                    initial_stack_len: 1,
                    policy: StackResolutionPolicy::Committed,
                },
            );
        }
        assert!([A, B]
            .iter()
            .all(|player| runner.state().auto_pass.contains_key(player)));
        let entry = arm(&mut runner, source);
        assert!(
            matches!(runner.state().waiting_for, WaitingFor::Priority { player } if player == A)
        );
        assert!(!runner.state().auto_pass.contains_key(&A));
        assert!(runner.state().auto_pass.contains_key(&B));
        assert_eq!(runner.state().stack.len(), 1);
        assert_eq!(runner.state().stack.back().unwrap().id, entry);
        assert!(runner.state().resolving_stack_entry.is_none());
        let events = runner.act(GameAction::PassPriority).unwrap().events;
        assert_eq!(resolved(&events, entry), 0);
        assert!(!events
            .iter()
            .any(|event| matches!(event, GameEvent::LifeChanged { .. })));
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution { .. }
        ));
        assert_eq!(
            runner.state().players[A.0 as usize].life,
            20,
            "auto-pass reaches Begin without running the selected automatic body"
        );
        assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 1);
        assert!(runner.state().stack.is_empty());
        assert_eq!(
            runner.state().resolving_stack_entry.as_ref().unwrap().id,
            entry
        );

        let (mut hostile, source, _) = fixed_board(false);
        let submission = manual_cast_submission(hostile.state(), source);
        submit_interaction(hostile.state_mut(), A, submission).unwrap();
        hostile.act(GameAction::PassPriority).unwrap();
        hostile
            .state_mut()
            .objects
            .get_mut(&source)
            .unwrap()
            .incarnation += 1;
        let before = hostile.state().clone();
        let refused = apply(hostile.state_mut(), B, GameAction::PassPriority);
        assert!(
            matches!(refused, Err(EngineError::InvalidAction(reason)) if reason == "Manual Begin latch does not match its sole carrier"),
            "the hostile case must reach the Begin latch rejection"
        );
        assert_eq!(
            hostile.state(),
            &before,
            "outer boundary rolls back Begin and its provisional events"
        );
        assert_eq!(hostile.state().players[A.0 as usize].life, 20);
    }

    #[test]
    fn checked_begin_carrier_survives_source_departure_without_moving_it_back() {
        let (mut runner, source, _) = fixed_board(false);
        let intent = manual_cast_submission(runner.state(), source);
        submit_interaction(runner.state_mut(), A, intent).unwrap();
        runner.act(GameAction::PassPriority).unwrap();
        runner.act(GameAction::PassPriority).unwrap();
        let binding = runner.state().manual_resolution_binding().unwrap().clone();
        let cards = CardDatabase::from_json_str(&card_map(runner.state())).unwrap();
        // An engine-owned physical move after Begin changes the live object,
        // while the existing original carrier and its saved Begin remain.
        engine::game::zones::move_to_zone(runner.state_mut(), source, Zone::Exile, &mut vec![]);
        capture(runner.state(), &cards);
        submit_life(&mut runner, 2);
        assert_eq!(runner.state().players[A.0 as usize].life, 18);
        let result = finish(&mut runner);
        assert_eq!(runner.state().objects[&source].zone, Zone::Exile);
        assert!(runner.state().resolving_stack_entry.is_none());
        assert_eq!(result.result.events.iter().filter(|event| matches!(event, GameEvent::StackResolved { object_id } if *object_id == binding.stack_entry_id)).count(), 1);
    }

    #[test]
    fn hidden_source_departure_retains_open_phase_and_authenticated_life_and_finish() {
        let (mut runner, source, _) = fixed_board(false);
        let intent = manual_cast_submission(runner.state(), source);
        submit_interaction(runner.state_mut(), A, intent).unwrap();
        runner.act(GameAction::PassPriority).unwrap();
        runner.act(GameAction::PassPriority).unwrap();
        let captured = manual_resolution_view(
            runner.state(),
            &filter_state_for_viewer(runner.state(), A),
            Some(A),
        )
        .unwrap()
        .source;
        let cards = CardDatabase::from_json_str(&card_map(runner.state())).unwrap();
        engine::game::zones::move_to_zone(runner.state_mut(), source, Zone::Library, &mut vec![]);
        capture(runner.state(), &cards);
        let filtered = filter_state_for_viewer(runner.state(), A);
        assert!(
            filtered
                .objects
                .get(&source)
                .is_none_or(|object| object.name == "Hidden Card"),
            "the regression must reach an actually hidden source projection"
        );
        // A later hidden identity must not replace the already public cast label.
        runner.state_mut().objects.get_mut(&source).unwrap().name = "Private later face".into();
        let filtered = filter_state_for_viewer(runner.state(), A);
        let current =
            manual_resolution_view_for_source(runner.state(), &filtered, Some(A), &captured);
        assert_eq!(current.phase, ManualResolutionPhase::Open);
        assert_eq!(current.source, captured);
        assert!(current.interaction_id.is_some());
        let viewer = manual_resolution_view(
            runner.state(),
            &filter_state_for_viewer(runner.state(), B),
            Some(B),
        )
        .unwrap();
        assert_eq!(viewer.source, captured);
        assert!(
            viewer.interaction_id.is_none(),
            "display perspective grants no operation"
        );

        let loss = InteractionSubmission {
            interaction_id: current.interaction_id.unwrap(),
            response: InteractionResponse::ManualResolution {
                decision: ManualResolutionDecision::LoseOwnLife { amount: 2 },
            },
        };
        assert_eq!(
            classify_manual_interaction(runner.state(), A, &loss).unwrap(),
            Some(ManualInteractionKind::LifeLoss)
        );
        assert_eq!(
            manual_interaction_source(runner.state(), A, &loss).unwrap(),
            Some(captured.clone())
        );
        submit_interaction(runner.state_mut(), A, loss).unwrap();
        assert_eq!(runner.state().players[A.0 as usize].life, 18);

        let view = derive_viewer_interaction(
            runner.state(),
            &filter_state_for_viewer(runner.state(), A),
            A,
        );
        let opportunity = &view.opportunities[0];
        let InteractionOpportunityResponse::Schema { candidates, .. } = &opportunity.response
        else {
            panic!("fresh Manual Finish schema");
        };
        let finish = InteractionSubmission {
            interaction_id: opportunity.interaction_id.clone(),
            response: InteractionResponse::ManualResolution {
                decision: ManualResolutionDecision::Finish {
                    choice_id: candidates[0].id.clone(),
                },
            },
        };
        assert_eq!(
            classify_manual_interaction(runner.state(), A, &finish).unwrap(),
            Some(ManualInteractionKind::Finish)
        );
        assert_eq!(
            manual_interaction_source(runner.state(), A, &finish).unwrap(),
            Some(captured.clone())
        );
        let finished = submit_interaction(runner.state_mut(), A, finish).unwrap();
        assert_eq!(
            runner.state().objects[&source].zone,
            Zone::Library,
            "Finish never moves the departed source back"
        );
        assert!(runner.state().resolving_stack_entry.is_none());
        assert_eq!(finished.result.events.iter().filter(|event| matches!(event, GameEvent::StackResolved { object_id } if Some(object_id.0) == captured.stack_entry_id)).count(), 1);
        assert!(!finished.result.events.iter().any(|event| matches!(event, GameEvent::ZoneChanged { object_id, .. } if *object_id == source)));
        assert_eq!(
            manual_resolution_view_for_source(
                runner.state(),
                &filter_state_for_viewer(runner.state(), A),
                Some(A),
                &captured
            )
            .phase,
            ManualResolutionPhase::Closed
        );
    }

    #[test]
    fn automatic_reference_spells_pay_and_resolve_typed_bodies() {
        let (mut runner, source, next) = fixed_board(false);
        runner.cast(source).resolve().assert_life_delta(A, -2);
        runner.cast(next).resolve().assert_life_delta(A, 3);
        assert_eq!(runner.state().players[A.0 as usize].life, 21);
        assert_eq!(runner.state().players[A.0 as usize].mana_pool.total(), 0);
        let (mut alone, _, next) = fixed_board(false);
        alone.cast(next).resolve().assert_life_delta(A, 3);
        assert_eq!(alone.state().players[A.0 as usize].life, 23);
        assert_eq!(alone.state().players[A.0 as usize].mana_pool.total(), 1);
    }
}
