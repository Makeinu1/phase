//! Test-only characterization of trusted pre-cast snapshots through the
//! engine's persisted JSON envelope. The checkpoints here are made at settled
//! priority before casting; this does not claim arbitrary mid-resolution or
//! mid-payment snapshots are restorable.

use engine::ai_support::legal_actions;
use engine::game::scenario::{GameRunner, GameScenario, P0, P1};
use engine::types::actions::GameAction;
use engine::types::game_state::{
    CastOfferKind, GameState, PersistedGameState, TrustedGameStateEnvelope, WaitingFor,
};
use engine::types::identifiers::ObjectId;
use engine::types::mana::{ManaColor, ManaCost, ManaCostShard, ManaType};
use engine::types::phase::Phase;
use engine::types::zones::Zone;
use rand::RngCore;

const COLLECTED_CONJURING: &str = "Exile the top six cards of your library. You may cast up to two sorcery spells with mana value 3 or less from among them without paying their mana costs. Put the exiled cards not cast this way on the bottom of your library in a random order.";

/// Serialize through the engine's trusted persistence envelope, then restore
/// through the same checked `PersistedGameState` path used by its consumers.
/// `pending_discard_for_cost` is intentionally skipped by serde; these tests
/// take the checkpoint at priority with no pending cost, so they make no claim
/// about restoring that transient mid-cost continuation.
fn trusted_json_at_priority(state: &GameState) -> (String, u128, u32) {
    assert!(
        state.pending_discard_for_cost.is_none(),
        "the checkpoint must be outside the skipped discard-cost continuation"
    );
    let mut exported = state.clone();
    exported.capture_rng_word_pos();
    let rng_word_pos = exported.rng_word_pos;
    let mut expected_rng = exported.rng.clone();
    let expected_next_rng_output = expected_rng.next_u32();

    let json = serde_json::to_string(&TrustedGameStateEnvelope::capture(exported))
        .expect("trusted game state serializes to JSON");
    let wire: serde_json::Value =
        serde_json::from_str(&json).expect("trusted export is valid JSON");
    assert!(
        wire.get("state").is_some(),
        "export must be the trusted envelope"
    );
    assert!(
        wire["state"].get("pending_discard_for_cost").is_none(),
        "the transient cost continuation is intentionally absent from JSON"
    );

    (json, rng_word_pos, expected_next_rng_output)
}

fn restore_trusted_json(json: &str) -> GameState {
    serde_json::from_str::<PersistedGameState>(json)
        .expect("trusted envelope decodes through PersistedGameState")
        .into_game_state()
        .expect("trusted persisted state passes the checked engine restore path")
}

fn player_zone_ids(
    state: &GameState,
    player: engine::types::player::PlayerId,
) -> (Vec<ObjectId>, Vec<ObjectId>, Vec<ObjectId>) {
    let player = state
        .players
        .iter()
        .find(|candidate| candidate.id == player)
        .expect("scenario player exists");
    (
        player.hand.iter().copied().collect(),
        player.library.iter().copied().collect(),
        player.graveyard.iter().copied().collect(),
    )
}

/// Compare ordered zone membership and pending resolution ownership directly;
/// `GameState::PartialEq` does not cover every persistence-relevant field.
fn assert_precast_zones_and_pending_work(pre: &GameState, restored: &GameState) {
    assert_eq!(restored.phase, pre.phase);
    assert_eq!(restored.active_player, pre.active_player);
    assert_eq!(restored.priority_player, pre.priority_player);
    assert_eq!(restored.waiting_for, pre.waiting_for);
    assert_eq!(player_zone_ids(restored, P0), player_zone_ids(pre, P0));
    assert_eq!(player_zone_ids(restored, P1), player_zone_ids(pre, P1));
    assert_eq!(
        restored.battlefield.iter().copied().collect::<Vec<_>>(),
        pre.battlefield.iter().copied().collect::<Vec<_>>(),
        "battlefield membership/order returns to the pre-cast snapshot"
    );
    assert_eq!(
        restored.exile.iter().copied().collect::<Vec<_>>(),
        pre.exile.iter().copied().collect::<Vec<_>>()
    );
    assert_eq!(
        restored.command_zone.iter().copied().collect::<Vec<_>>(),
        pre.command_zone.iter().copied().collect::<Vec<_>>()
    );
    assert_eq!(restored.stack.len(), pre.stack.len());
    assert!(
        restored.stack.is_empty(),
        "no stack item remains at this boundary"
    );
    assert!(restored.resolution_stack.is_empty());
    assert!(restored.resolving_stack_entry.is_none());
    assert!(restored.pending_cast.is_none());
    assert!(restored.pending_trigger.is_none());
    assert!(restored.pending_trigger_event_batch.is_empty());
    assert!(restored.deferred_triggers.is_empty());
    assert!(restored.pending_cost_move_resume.is_none());
    assert!(restored.pending_deferred_life_cost_resume.is_none());
    assert!(restored.pending_discard_for_cost.is_none());
}

fn assert_rng_restored(restored: &GameState, expected_pos: u128, expected_next: u32) {
    assert_eq!(
        restored.rng_word_pos, expected_pos,
        "the persisted RNG position is outside GameState equality"
    );
    let mut restored_rng = restored.rng.clone();
    assert_eq!(
        restored_rng.next_u32(),
        expected_next,
        "the next random output after restore must match the pre-cast stream"
    );
}

fn green_cost(generic: u32) -> ManaCost {
    ManaCost::Cost {
        generic,
        shards: vec![ManaCostShard::Green],
    }
}

#[test]
fn resolved_grizzly_bears_restore_returns_to_the_precast_priority_boundary() {
    let mut scenario = GameScenario::new_n_player(2, 0x32_00_01);
    scenario.at_phase(Phase::PreCombatMain);
    let forest_a = scenario.add_basic_land(P0, ManaColor::Green);
    let forest_b = scenario.add_basic_land(P0, ManaColor::Green);
    let bears = scenario
        .add_creature_to_hand(P0, "Grizzly Bears", 2, 2)
        .with_mana_cost(green_cost(1))
        .id();

    let mut runner = scenario.build();
    runner
        .act(GameAction::ActivateAbility {
            source_id: forest_a,
            ability_index: 0,
        })
        .expect("tap Forest A and float green before the spell checkpoint");
    assert!(runner.state().objects[&forest_a].tapped);
    assert!(!runner.state().objects[&forest_b].tapped);
    assert_eq!(runner.state().players[P0.0 as usize].mana_pool.total(), 1);
    assert_eq!(
        runner.state().players[P0.0 as usize]
            .mana_pool
            .count_color(ManaType::Green),
        1
    );

    // Export at the requested pre-cast boundary. The prior Forest activation
    // and floating mana are deliberately part of the checkpoint.
    let precast = runner.state().clone();
    let (json, rng_pos, expected_next_rng) = trusted_json_at_priority(&precast);
    let outcome = runner.cast(bears).resolve();
    let resolved = runner.state();
    assert_eq!(outcome.zone_of(bears), Zone::Battlefield);
    assert_eq!(resolved.objects[&bears].zone, Zone::Battlefield);
    assert!(resolved.objects[&forest_a].tapped);
    assert!(
        resolved.objects[&forest_b].tapped,
        "Forest B pays the generic portion during the Bears cast"
    );
    assert_eq!(resolved.players[P0.0 as usize].mana_pool.total(), 0);
    assert!(resolved.stack.is_empty());

    let restored = restore_trusted_json(&json);
    assert_precast_zones_and_pending_work(&precast, &restored);
    assert_rng_restored(&restored, rng_pos, expected_next_rng);
    assert_eq!(restored.objects[&bears].zone, Zone::Hand);
    assert!(restored.objects[&forest_a].tapped);
    assert!(!restored.objects[&forest_b].tapped);
    assert_eq!(restored.players[P0.0 as usize].mana_pool.total(), 1);
    assert_eq!(
        restored.players[P0.0 as usize]
            .mana_pool
            .count_color(ManaType::Green),
        1
    );

    let legal = legal_actions(&restored);
    assert!(
        legal.iter().any(|action| matches!(
            action,
            GameAction::CastSpell { object_id, .. } if *object_id == bears
        )),
        "the restored game must offer Grizzly Bears as a legal next play"
    );
    let mut after_restore = GameRunner::from_state(restored);
    let committed = after_restore.cast(bears).commit();
    assert_eq!(committed.state().objects[&bears].zone, Zone::Stack);
    assert!(committed.state().objects[&forest_b].tapped);
}

#[test]
fn collected_conjuring_decline_restore_rewinds_the_real_random_library_tail() {
    let mut scenario = GameScenario::new_n_player(2, 0x32_95_03);
    scenario.at_phase(Phase::PreCombatMain);
    let mountains: Vec<_> = (0..5)
        .map(|_| scenario.add_basic_land(P0, ManaColor::Red))
        .collect();
    let conjuring = scenario
        .add_spell_to_hand_from_oracle(P0, "Collected Conjuring", false, COLLECTED_CONJURING)
        .with_mana_cost(ManaCost::Cost {
            generic: 3,
            shards: vec![ManaCostShard::Red, ManaCostShard::Red],
        })
        .id();

    // Match the #9503 shape: the top six are one castable mana-value-1
    // sorcery followed by five lands. The candidate is built from Oracle text
    // and runs through the production free-cast-window rules path.
    let library_lands: Vec<_> = (0..5)
        .map(|_| scenario.add_land_to_library_top(P0, "Forest").id())
        .collect();
    let preordain = scenario
        .add_spell_to_library_top(P0, "Preordain", false)
        .with_mana_cost(ManaCost::Cost {
            generic: 0,
            shards: vec![ManaCostShard::Blue],
        })
        .from_oracle_text("Scry 2. Draw a card.")
        .id();

    let mut runner = scenario.build();
    let precast = runner.state().clone();
    let (json, rng_pos, expected_next_rng) = trusted_json_at_priority(&precast);
    let mut committed = runner.cast(conjuring).commit();
    assert_eq!(committed.state().objects[&conjuring].zone, Zone::Stack);
    assert!(mountains
        .iter()
        .all(|id| committed.state().objects[id].tapped));
    committed
        .act(GameAction::PassPriority)
        .expect("caster passes priority");
    committed
        .act(GameAction::PassPriority)
        .expect("opponent passes and Collected Conjuring resolves");

    match &committed.state().waiting_for {
        WaitingFor::CastOffer {
            player: P0,
            kind: CastOfferKind::FreeCastWindow { candidates, .. },
        } => assert!(
            candidates.contains(&preordain),
            "reach guard: the mana-value-1 sorcery must be offered; candidates={candidates:?}"
        ),
        other => panic!("expected Collected Conjuring's free-cast window, got {other:?}"),
    }
    committed
        .act(GameAction::FreeCastWindowChoice { selection: None })
        .expect("decline the child free cast");

    let after_decline = committed.state();
    let parent_on_stack = after_decline
        .stack
        .iter()
        .any(|entry| entry.id == conjuring);
    let orphan_reproduced =
        after_decline.objects[&conjuring].zone == Zone::Stack && !parent_on_stack;
    let issue_fixed = after_decline.objects[&conjuring].zone == Zone::Graveyard && !parent_on_stack;
    assert!(
        orphan_reproduced || issue_fixed,
        "unexpected #9503 post-decline shape: zone={:?}, parent_on_stack={parent_on_stack}, stack={:?}",
        after_decline.objects[&conjuring].zone,
        after_decline.stack
    );
    assert!(after_decline.stack.is_empty());
    let uncast_cards: Vec<_> = std::iter::once(preordain)
        .chain(library_lands.iter().copied())
        .collect();
    let mut expected_uncast_ids = uncast_cards.clone();
    expected_uncast_ids.sort_unstable();
    if orphan_reproduced {
        let mut exiled_ids: Vec<_> = after_decline.exile.iter().copied().collect();
        exiled_ids.sort_unstable();
        assert_eq!(
            exiled_ids, expected_uncast_ids,
            "the live #9503 path leaves the revealed six exiled"
        );
        assert!(after_decline.players[P0.0 as usize].library.is_empty());
        assert!(!after_decline.players[P0.0 as usize]
            .graveyard
            .contains(&conjuring));
        println!("Issue #9503 reproduced on pinned base e5af25d: Collected Conjuring is orphaned in Stack; six revealed cards remain exiled.");
    } else {
        assert!(after_decline.exile.is_empty());
        let mut library_ids: Vec<_> = after_decline.players[P0.0 as usize]
            .library
            .iter()
            .copied()
            .collect();
        library_ids.sort_unstable();
        assert_eq!(library_ids, expected_uncast_ids);
        assert_eq!(after_decline.players[P0.0 as usize].library.len(), 6);
        for id in &uncast_cards {
            assert_eq!(
                after_decline.objects[id].zone,
                Zone::Library,
                "all uncast cards return to the library on the fixed path"
            );
        }
        assert!(after_decline.players[P0.0 as usize]
            .graveyard
            .contains(&conjuring));
        println!("Issue #9503 already fixed on pinned base e5af25d: Collected Conjuring is in its graveyard.");
    }

    // Check actual next-output behavior on either path. The fixed path randomizes
    // the six-card library tail. The current orphan path never reaches that
    // continuation, so its live stream remains at the pre-cast position. In both
    // cases the trusted restore must return to the same exported next output.
    let mut after_decline_export = after_decline.clone();
    after_decline_export.capture_rng_word_pos();
    let mut after_decline_rng = after_decline_export.rng.clone();
    let next_after_decline = after_decline_rng.next_u32();
    if issue_fixed {
        assert!(
            after_decline_export.rng_word_pos > rng_pos,
            "random bottoming advances the persisted RNG position"
        );
        assert_ne!(next_after_decline, expected_next_rng);
    } else {
        assert_eq!(
            after_decline_export.rng_word_pos, rng_pos,
            "the orphaned path never reaches the random bottoming continuation"
        );
        assert_eq!(next_after_decline, expected_next_rng);
    }

    let restored = restore_trusted_json(&json);
    assert_precast_zones_and_pending_work(&precast, &restored);
    assert_rng_restored(&restored, rng_pos, expected_next_rng);
    assert_eq!(restored.objects[&conjuring].zone, Zone::Hand);
    assert_eq!(restored.objects[&preordain].zone, Zone::Library);
    assert_eq!(
        player_zone_ids(&restored, P0).1,
        player_zone_ids(&precast, P0).1,
        "the complete ordered library returns to its pre-cast sequence"
    );

    let legal = legal_actions(&restored);
    assert!(
        legal.iter().any(|action| matches!(
            action,
            GameAction::CastSpell { object_id, .. } if *object_id == conjuring
        )),
        "Collected Conjuring must be a legal next play after restore"
    );
    let mut after_restore = GameRunner::from_state(restored);
    let replay_cast = after_restore.cast(conjuring).commit();
    assert_eq!(replay_cast.state().objects[&conjuring].zone, Zone::Stack);
}
