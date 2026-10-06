//! Native-only action and interaction-boundary tests for the manual-resolution prototype.
//! Uses synthetic blank spells; no card generation or Oracle data is needed.

#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
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
    fn interaction_boundary_repeats_loss_rotates_ids_restores_v5_and_finishes_once() {
        let (mut runner, p0, _, spell, stack_entry_id) = designated_runner();
        enter_manual_wait(&mut runner, p0, stack_entry_id);
        bind_interaction_authority(
            runner.state_mut(),
            InteractionSessionId("manual-prototype-session".to_string()),
        )
        .expect("manual wait binds authenticated interaction authority");

        let checkpoint = PersistedGameState::capture(runner.state().clone());
        let checkpoint_wire = serde_json::to_value(&checkpoint).expect("trusted save serializes");
        assert_eq!(checkpoint_wire["state"]["resolution_state_version"], 5);
        let checked_checkpoint =
            serde_json::from_value::<PersistedGameState>(checkpoint_wire.clone())
                .expect("trusted v5 save decodes")
                .prepare_for_restore(PersistedRestoreFinalization::Immediate)
                .expect("trusted v5 manual wait passes checked restore")
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
            .stack
            .back()
            .expect("manual source remains live")
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
            1,
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
        for (
            label,
            quantity,
            modification,
            sentinel,
            captured,
            expected_loss,
            expected_changes,
        ) in [
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
                .with_graveyard(p0, &["P0 Grave A", "P0 Grave B", "P0 Grave C", "P0 Grave D"])
                .with_graveyard(p1, &["P1 Grave A"]);
            let mut replacement = ReplacementDefinition::new(ReplacementEvent::LoseLife)
                .execute(AbilityDefinition::new(
                    AbilityKind::Database,
                    Effect::LoseLife {
                        amount: quantity,
                        target: Some(TargetFilter::Controller),
                    },
                ));
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
            assert_eq!(runner.state().players[p0.0 as usize].hand.len(), 3, "{label}");
            assert_eq!(runner.state().players[p0.0 as usize].graveyard.len(), 4, "{label}");
            assert_eq!(runner.state().players[p1.0 as usize].hand.len(), 2, "{label}");
            assert_eq!(runner.state().players[p1.0 as usize].graveyard.len(), 1, "{label}");
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
                assert!(apply(runner.state_mut(), actor, action).is_err());
                assert_eq!(runner.state(), &before);
            }
        }
        let interaction_id = viewer_interaction(runner.state(), p1).opportunities[0]
            .interaction_id
            .clone();
        for actor in [p0, p1] {
            let before = runner.state().clone();
            assert!(submit_interaction(
                runner.state_mut(),
                actor,
                InteractionSubmission {
                    interaction_id: interaction_id.clone(),
                    response: InteractionResponse::ManualResolution {
                        decision: ManualResolutionDecision::LoseOwnLife { amount: 1 }
                    },
                }
            )
            .is_err());
            assert_eq!(runner.state(), &before);
        }
        let source_scope_error =
            "manual-resolution designation is outside the supported source scope";
        for wire in [valid_designation_wire, valid_manual_wait_wire] {
            assert_eq!(wire["state"]["resolution_state_version"], 5);
            assert_eq!(
                wire["state"]["manual_resolution_designation"],
                stack_entry_id.0
            );
            let restored = serde_json::from_value::<PersistedGameState>(wire.clone())
                .expect("untouched trusted manual state decodes")
                .prepare_for_restore(PersistedRestoreFinalization::Immediate)
                .expect("untouched manual state passes checked restore")
                .finalize_immediately()
                .expect("untouched manual state finalizes successfully");
            let restored_entry = restored
                .stack
                .back()
                .expect("designated spell stays stacked");
            assert_eq!(restored_entry.id, stack_entry_id);
            assert_eq!(restored_entry.source_id, spell);
            assert_eq!(restored_entry.controller, p0);
            let restored_wire = serde_json::to_value(PersistedGameState::capture(restored))
                .expect("restored manual state remains serializable");
            for field in [
                "resolution_state_version",
                "manual_resolution_designation",
                "stack",
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
                .expect("controlled trusted v5 fixture decodes before checked restore");
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
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::game::scenario::{GameRunner, GameScenario};
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::actions::{DebugAction, GameAction};
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::events::GameEvent;
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::game_state::{
    AutoPassMode, CastPaymentMode, GameState, PendingReplacement, PersistedGameState,
    PersistedRestoreFinalization, StackResolutionPolicy, WaitingFor,
};
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::identifiers::ObjectId;
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::keywords::{BuybackCost, Keyword};
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::mana::ManaCost;
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::phase::Phase;
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::player::PlayerId;
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::proposed_event::ProposedEvent;
#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
use engine::types::zones::Zone;

#[cfg(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32")))]
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
        let wire = serde_json::to_value(PersistedGameState::capture(state.clone()))
            .expect("trusted game state serializes");
        serde_json::from_value::<Option<ObjectId>>(
            wire["state"]["manual_resolution_designation"].clone(),
        )
        .expect("trusted wire declares its manual resolution designation")
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
        assert_eq!(persisted["state"]["resolution_state_version"], 5);
        assert_eq!(
            persisted["state"]["manual_resolution_designation"],
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
        assert_eq!(persisted["state"]["resolution_state_version"], 5);
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
        missing_v5_designation["state"]["manual_resolution_designation"] = serde_json::Value::Null;
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
            restored_wire["state"]["manual_resolution_designation"],
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
        // Finish has consumed the manual designation before the replacement
        // prompt is checkpointed, so this trusted resolution wire is v4.
        assert_eq!(trusted_resolution_version(runner.state()), 4);
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
        runner
            .act(GameAction::PassPriority)
            .expect("enter manual wait after target leaves");
        assert!(matches!(
            runner.state().waiting_for,
            WaitingFor::ManualResolution { stack_entry_id, .. } if stack_entry_id == designated_entry
        ));

        let finish = runner
            .act(GameAction::FinishManualResolution {
                stack_entry_id: designated_entry,
            })
            .expect("Finish finalizes the now-illegal target as a fizzle");
        assert_eq!(runner.state().objects[&target].zone, Zone::Exile);
        assert_eq!(runner.state().objects[&designated].zone, Zone::Graveyard);
        assert_eq!(trusted_resolution_version(runner.state()), 4);
        assert_eq!(stack_resolved_count(&finish.events, designated_entry), 1);
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
                let result =
                    runner.act(GameAction::DesignateManualResolution { stack_entry_id });
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
                let result =
                    runner.act(GameAction::DesignateManualResolution { stack_entry_id });
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
                        runner.state_mut().add_transient_continuous_effect(
                            source,
                            p0,
                            Duration::UntilEndOfTurn,
                            TargetFilter::SpecificObject { id: stack_entry_id },
                            vec![modification],
                            None,
                        );
                    }
                    let object = &runner.state().objects[&stack_entry_id];
                    assert_eq!(object.zone, Zone::Stack);
                    assert_eq!(object.owner, p0);
                    assert_eq!(object.controller, p0);
                    assert_eq!(object.cast_from_zone, Some(Zone::Hand));
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
                    runner.state_mut().add_transient_continuous_effect(
                        source,
                        p0,
                        Duration::UntilEndOfTurn,
                        TargetFilter::SpecificObject { id: stack_entry_id },
                        vec![modification.clone().expect("grant or removal case")],
                        None,
                    );
                }
                assert_eq!(
                    runner.state().objects[&stack_entry_id].keywords,
                    baseline.objects[&stack_entry_id].keywords
                );
                let before = runner.state().clone();
                let result =
                    runner.act(GameAction::DesignateManualResolution { stack_entry_id });
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
            scenario.add_creature(p0, "Second Keyword Source", 1, 1).id(),
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
        let stack_entry_id = runner.state().stack.back().expect("candidate is on stack").id;
        for source in sources {
            runner.state_mut().add_transient_continuous_effect(
                source,
                p0,
                Duration::UntilEndOfTurn,
                TargetFilter::SpecificObject { id: decoy_entry },
                vec![ContinuousModification::AddKeyword {
                    keyword: Keyword::Rebound,
                }],
                None,
            );
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
            let result =
                runner.act(GameAction::DesignateManualResolution { stack_entry_id });
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
            let result =
                runner.act(GameAction::DesignateManualResolution { stack_entry_id });
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
        let source = scenario.add_creature(p0, "Live Revalidation Source", 1, 1).id();
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
        runner.state_mut().add_transient_continuous_effect(
            source,
            p0,
            Duration::UntilEndOfTurn,
            TargetFilter::SpecificObject { id: stack_entry_id },
            vec![ContinuousModification::AddKeyword {
                keyword: Keyword::Rebound,
            }],
            None,
        );
        assert!(!runner.state().objects[&stack_entry_id]
            .keywords
            .contains(&Keyword::Rebound));
        for (action, reason) in [
            (
                GameAction::ApplyManualLifeLoss {
                    stack_entry_id,
                    amount: 1,
                },
                "manual life loss source is no longer eligible",
            ),
            (
                GameAction::FinishManualResolution { stack_entry_id },
                "the designated source is no longer eligible for manual Finish",
            ),
        ] {
            let mut control = GameRunner::from_state(baseline.clone());
            let result = control
                .act(action.clone())
                .expect("the pre-grant manual action succeeds");
            if matches!(&action, GameAction::ApplyManualLifeLoss { .. }) {
                assert_eq!(control.state().players[p0.0 as usize].life, 19);
                assert!(matches!(
                    control.state().waiting_for,
                    WaitingFor::ManualResolution { stack_entry_id: id, .. } if id == stack_entry_id
                ));
            } else {
                assert_eq!(stack_resolved_count(&result.events, stack_entry_id), 1);
                assert_eq!(control.state().objects[&spell].zone, Zone::Graveyard);
                assert_eq!(trusted_manual_designation(control.state()), None);
            }
            let before = runner.state().clone();
            assert!(matches!(
                runner.act(action),
                Err(EngineError::InvalidAction(error)) if error == reason
            ));
            assert_eq!(runner.state(), &before);
        }
        let restored = serde_json::from_value::<PersistedGameState>(valid_wire.clone())
            .expect("unchanged manual save decodes")
            .prepare_for_restore(PersistedRestoreFinalization::Immediate)
            .expect("unchanged manual save passes checked restore")
            .finalize_immediately()
            .expect("valid restore finalizes");
        assert_eq!(trusted_manual_designation(&restored), Some(stack_entry_id));
        assert_eq!(restored.waiting_for, baseline.waiting_for);
        let mut granted_wire = valid_wire;
        granted_wire["state"]["transient_continuous_effects"] =
            serde_json::to_value(&runner.state().transient_continuous_effects)
                .expect("the same typed grant serializes independently of invalid manual state");
        let decoded = serde_json::from_value::<PersistedGameState>(granted_wire)
            .expect("granted manual save decodes before checked admission");
        assert!(matches!(
            decoded.prepare_for_restore(PersistedRestoreFinalization::Immediate),
            Err(PersistedRestoreError::UnsupportedFormat(reason))
                if reason == "manual-resolution designation is outside the supported source scope"
        ));
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

#[cfg(not(all(feature = "manual_resolution_prototype", not(target_arch = "wasm32"))))]
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
}
