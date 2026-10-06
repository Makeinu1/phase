// Engine-only feasibility measurement. Opaque PRE bytes are the restore source.
// Never emit hands, libraries, capabilities, envelopes, or assertion values.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { isDeepStrictEqual as nativeDeepEqual } from 'node:util';

const [directoryArg, fixtureArg, outputArg, campaign, historyCountArg] = process.argv.slice(2);
const historyTargetCount = Number(historyCountArg ?? 1000);
const output = path.resolve(outputArg);
mkdirSync(output, { recursive: true });
const sourceSha = 'e10955dc5977f1ba7c65cb1518cb8f4b1679fe92';
const authorityFields = ['interaction_session_id', 'interaction_generation', 'next_interaction_serial', 'active_interaction_slots'];
let stage = 'input', failedCheck, progress, lastActionType, lastOutcomeStatus, mismatchPaths;
let engine, wasmModule, stepCount = 0;
let restoreAttempt = 0;
const observedInteractionNamespaces = new Set();
// Instrument call sites, never the immutable engine exports. Nested categories
// accumulate exclusive elapsed time so a transform's parse is counted once.
let profileCurrent = null, traceCurrent = null;
const timingFrames = [];
function timed(kind, fn) {
  if (!profileCurrent) return fn();
  const frame = { start: performance.now(), children: 0 };
  timingFrames.push(frame);
  try { return fn(); } finally {
    const elapsed = performance.now() - frame.start;
    timingFrames.pop();
    if (timingFrames.length) timingFrames.at(-1).children += elapsed;
    const entry = profileCurrent[kind] ??= { count: 0, exclusiveMs: 0 };
    entry.count++; entry.exclusiveMs += elapsed - frame.children;
  }
}
const sha = raw => timed('hash', () => createHash('sha256').update(raw).digest('hex'));
const parseJSON = raw => timed('jsParse', () => JSON.parse(raw));
const stringifyJSON = value => timed('jsStringify', () => JSON.stringify(value));
const isDeepStrictEqual = (a, b) => timed('deepEquality', () => nativeDeepEqual(a, b));
const canonicalDigest = raw => sha(stringifyJSON(canonical(raw)));
const check = (value, code) => { if (!value) { failedCheck = code; throw Error(code); } };
const receipt = (name, value) => {
  const item = { sourceSha, campaign, ...(campaign === 'history' ? { historyTargetCount } : {}), ...value };
  // Synchronous writes preserve completed samples if the external watchdog stops us.
  writeFileSync(path.join(output, name + '.json'), JSON.stringify(item, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(item));
};
function memory() {
  const usage = process.memoryUsage();
  return { ...usage, maxRssBytes: process.resourceUsage().maxRSS * 1024,
    wasmMemoryBytes: wasmModule.memory.buffer.byteLength };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
// Tag every original string VALUE as well as every exact numeric token.
// Keys remain keys; number1 and an original string '@number:1' cannot collide.
// This comparator never round-trips JS-rounded u64 values into restore.
function lossless(raw) {
  return timed('losslessTransform', () => {
  let text = '', index = 0;
  while (index < raw.length) {
    if (raw[index] === '"') {
      const start = index++;
      while (index < raw.length) {
        if (raw[index] === '\\') { index += 2; continue; }
        if (raw[index++] === '"') break;
      }
      const token = raw.slice(start, index);
      let next = index; while (/\s/.test(raw[next] ?? '')) next++;
      text += raw[next] === ':' ? token : JSON.stringify('@string:' + JSON.parse(token));
    } else if (raw[index] === '-' || /[0-9]/.test(raw[index])) {
      const match = raw.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
      check(match, 'lossless-number-token');
      text += JSON.stringify('@number:' + match[0]); index += match[0].length;
    } else text += raw[index++];
  }
  return parseJSON(text);
  });
}
function canonical(raw) {
  return timed('canonicalTransform', () => {
  const envelope = lossless(raw);
  check(envelope.state, 'trusted-envelope-state');
  for (const key of authorityFields) delete envelope.state[key];
  return stable(envelope);
  });
}
function differentPaths(a, b) {
  if (isDeepStrictEqual(a, b)) return [];
  // Only fixed schema sections may reach a failure receipt. Dynamic object IDs,
  // array locations, journal keys and all differing values stay private.
  const found = [];
  for (const key of [
    "turn_number", "active_player", "phase", "players", "priority_player", "turn_decision_controller", "turn_decision_control_timestamp", "active_full_turn_control",
    "active_combat_phase_control", "active_library_searches", "active_search_decision_controls", "objects", "next_object_id", "next_delayed_trigger_token", "next_delayed_trigger_instance", "next_resolution_cast_offer_id",
    "next_logical_zone_change_group_id", "next_pip_id", "resolved_rules_journal", "active_payment_pins", "active_rules_execution_node", "active_casting_permission_index", "active_paid_resolution_offer_tail", "active_spend_only_on_x_count",
    "battlefield", "stack", "stack_paid_facts", "exile", "command_zone", "rng_seed", "rng_word_pos", "rng",
    "combat", "waiting_for", "game_end", "next_resolve_all_consent_epoch", "viewer_projection", "resolve_all_consent_run", "stack_resolution_session", "interaction_session_id",
    "interaction_generation", "next_interaction_serial", "active_interaction_slots", "has_pending_cast", "allows_cancel_cast", "lands_played_this_turn", "max_lands_per_turn", "priority_pass_count",
    "pending_replacement", "pending_combat_lifelink", "liminal_entries", "pending_liminal_entry_resume", "entering_aura_authority", "replacement_may_cost_paused", "post_replacement_token_choice_applied", "post_replacement_token_substitution_count",
    "deferred_entry_events", "pending_token_battlefield_entry", "layers_dirty", "static_gate_truth", "trigger_index", "replacement_index", "static_source_index", "static_mode_presence",
    "loop_detect_ring", "loop_answer_journal", "precast_shortcut_runtime", "life_safety_probe", "next_timestamp", "public_state_dirty", "state_revision", "transient_continuous_effects",
    "next_continuous_effect_id", "next_end_effect_group_id", "attribution", "remote_type_layer_recipients", "day_night", "spells_cast_this_turn", "spells_cast_last_turn", "cancelled_casts",
    "pending_activations", "pending_trigger", "pending_trigger_firing", "pending_trigger_event_batch", "pending_trigger_entry", "deferred_triggers", "pending_trigger_order", "consumed_before_priority_trigger_events",
    "exile_links", "paradigm_primed", "delayed_triggers", "tracked_object_sets", "next_tracked_set_id", "chain_tracked_set_id", "return_result_frames", "active_return_result_occurrence",
    "next_return_result_occurrence_id", "resolving_modal_instruction", "tracked_set_member_causes", "tracked_set_participants", "commander_cast_count", "commander_cast_owners", "commander_declined_zone_return", "objects_that_dealt_damage",
    "extra_turns", "extra_turn_sequence_anchor", "turns_to_skip", "steps_to_skip", "combat_phase_skip_next_turn", "scheduled_turn_controls", "extra_phases", "extra_phase_resume",
    "next_extra_phase_id", "last_added_phase_ids", "turn_direction", "current_combat_attacker_restriction", "current_combat_attacker_restriction_source", "seat_order", "format_config", "eliminated_players",
    "commander_damage", "priority_passes", "auto_pass", "phase_stops", "priority_passing_modes", "lands_tapped_for_mana", "prepaid_mulligan_bottoms", "debug_mode",
    "debug_permitted", "debug_infinite_mana", "unbounded_resources", "unbounded_loop_enablers", "unbounded_loop_pile", "unbounded_counter_targets", "pending_unbounded_materialization", "pending_materialization_count",
    "unimplemented_oracle_ids", "pending_trigger_abandons", "loop_detection", "match_config", "match_phase", "match_score", "match_forfeit_result", "game_number",
    "current_starting_player", "next_game_chooser", "deck_pools", "outside_game_cards_brought_in", "sideboard_submitted", "triggers_fired_this_turn", "trigger_fire_counts_this_turn", "triggers_fired_this_turn_per_opponent",
    "triggers_fired_this_game", "activated_abilities_this_turn", "activated_abilities_this_game", "crew_activated_this_turn", "crew_resolved_this_turn", "loyalty_abilities_activated_this_turn", "extra_loyalty_activations_this_turn", "exerted_this_turn",
    "object_tap_count_this_turn", "object_counter_placement_count_this_turn", "pending_attack_trigger_events", "ability_resolutions_this_turn", "graveyard_cast_permissions_used", "graveyard_cast_permissions_used_per_type", "pending_permanent_type_slot", "hand_cast_free_permissions_used",
    "alt_cost_grant_permissions_used", "abilities_activated_this_turn_by_player", "exile_play_permissions_used", "exile_play_single_use_consumed", "exile_cast_permissions_used", "top_of_library_cast_permissions_used", "cards_exiled_with_source_this_turn", "first_card_drawn_this_turn",
    "cards_drawn_this_turn", "pending_miracle_offers", "pending_paradigm_remaining_offers", "spells_cast_this_game", "spells_cast_this_game_by_player", "spells_cast_this_turn_by_player", "lands_played_this_turn_by_player", "players_who_searched_library_this_turn",
    "player_actions_this_turn", "players_attacked_this_step", "players_attacked_this_turn", "attacking_creatures_this_turn", "attacked_defenders_this_turn", "attacked_defenders_last_turn", "creature_attacked_defenders_this_turn", "creature_blocked_attackers_this_turn",
    "steps_started_this_turn", "creatures_attacked_this_turn", "attacker_declarations_this_turn", "creatures_blocked_this_turn", "players_who_created_token_this_turn", "created_tokens_this_turn", "counter_added_this_turn", "players_who_discarded_card_this_turn",
    "cards_discarded_this_turn_by_player", "players_who_sacrificed_artifact_this_turn", "sacrificed_permanents_this_turn", "zone_changes_this_turn", "batched_zone_change_trigger_fired", "battlefield_entries_this_turn", "damage_dealt_this_turn", "creatures_exploited_this_turn",
    "assassin_or_commander_dealt_combat_damage_this_turn", "creature_types_dealt_combat_damage_this_turn", "mana_spent_on_spells_this_turn", "pending_spell_cost_reductions", "pending_next_spell_modifiers", "pending_etb_counters", "modal_modes_chosen_this_turn", "modal_modes_chosen_this_game",
    "revealed_cards", "public_revealed_cards", "stack_bound_reveals", "product_knowledge_state", "resolution_stack", "payment_transaction", "payment_transaction_replay", "payment_transaction_just_handled",
    "resolving_continuation_attach_host", "resolving_player_scope_linked_exile", "merged_card_component_route", "resolution_coin_flip", "pending_player_scope_sacrifice_choice", "pending_player_scope_unless_payment", "pending_discard_batch", "pending_exile_from_top_until",
    "pending_mass_library_order_choice", "pending_scoped_library_search", "pending_library_search_delivery", "completed_hidden_search_audiences", "pending_search_found_batch", "pending_die_roll_instruction", "may_trigger_auto_choices", "replacement_auto_choices",
    "replacement_auto_choice_tail", "decision_templates", "priority_yields", "pending_begin_game_abilities", "resolving_begin_game_abilities", "last_named_choice", "chosen_counter_kind_this_resolution", "chosen_color_this_resolution",
    "placed_sticker_this_resolution", "last_chosen_damage_source", "all_creature_types", "all_card_names", "card_face_registry", "meld_pair_registry", "card_db", "booster_shelf",
    "booster_pack_pool", "log_player_names", "last_created_token_ids", "last_revealed_ids", "last_parent_target_missing_reason", "private_look_ids", "private_look_player", "last_zone_changed_ids",
    "exile_rider_countered_ids", "last_vote_ballots", "player_actions_this_way", "last_effect_amount", "last_effect_excess_amount", "die_result_this_resolution", "last_effect_count", "last_effect_counts_by_player",
    "clause_minimum_snapshot", "exiled_from_hand_this_resolution", "monarch", "city_blessing", "enduring_story", "epic_effects", "restrictions", "pending_damage_replacements",
    "pending_step_end_mana_handlers", "pending_phase_transition_progress", "deferred_step_trigger_resume", "pending_team_draw_step", "pending_untap_declines", "current_trigger_event", "current_trigger_match_count", "resolving_stack_entry",
    "resolving_trigger_firing", "pending_resolution_completion", "announced_source_x", "turn_up_paid_cost_source", "resolution_source_relatch", "last_loop_action_sequence", "current_trigger_events", "last_discover_value",
    "stack_trigger_event_batches", "stack_trigger_firings", "lki_cache", "lki_copiable_values", "lki_by_incarnation", "departed_stack_spells", "linked_exile_lki", "cost_payment_failed_flag",
    "pending_taps_for_mana_overrides", "current_triggered_mana_override", "pending_cost_move_resume", "pending_deferred_life_cost_resume", "pending_triggered_mana_resume", "pending_trigger_construction_priority_recipient", "active_accepted_triggered_mana_node", "mana_subresolution_depth",
    "trigger_construction_finisher_ran_this_action", "pending_discard_for_cost", "pending_cast", "ring_level", "ring_bearer", "dungeon_progress", "planar_deck", "planar_controller",
    "planar_die_actions_this_turn", "scheme_deck", "archenemy", "initiative", "combat_prevention_tally", "resolution_frames", "resolution_state_version"
  ]) {
    if (!isDeepStrictEqual(a.state?.[key], b.state?.[key])) found.push('state.' + key);
  }
  if (found.length === 0) found.push('other-authoritative-envelope-section');
  return found;
}
const rawState = (purpose = 'validationExport') => timed(purpose, () => engine.export_game_state_json());
const state = () => parseJSON(rawState()).state; // Internal observations only.
function equalWithVerifiedRekey(expected, actual, code) {
  const a = canonical(expected), b = canonical(actual);
  const before = a.precast_shortcut_runtime, after = b.precast_shortcut_runtime;
  check(before && after && [before, after].every(runtime => runtime.offer === null
    && runtime.must_diverge === null && runtime.materializing === false), 'idle-private-precast-authority-only');
  const epoch = token => {
    check(typeof token === 'string' && /^@number:(?:0|[1-9][0-9]*)$/.test(token), 'exact-private-u64-epoch');
    const value = BigInt(token.slice(8)); check(value <= (1n << 64n) - 1n, 'private-epoch-within-u64'); return value;
  };
  const rotated = (epoch(before.next_epoch) + 1n) & ((1n << 64n) - 1n);
  check(epoch(after.next_epoch) === (rotated === 0n ? 1n : rotated), 'exact-saved-epoch-positive-rotation');
  // The precise authority relation was checked above. Change only the comparison
  // copy, never the original PRE bytes or the engine's installed state.
  const rekeyedExpected = { ...a, precast_shortcut_runtime: { ...before, next_epoch: after.next_epoch } };
  mismatchPaths = differentPaths(rekeyedExpected, b);
  check(mismatchPaths.length === 0, code); mismatchPaths = undefined;
}
function recordFreshNamespace(saved, live, fresh) {
  check([saved, live, fresh].every(value => typeof value === 'string'
    && /^@string:wasm-[0-9a-f]{16}$/.test(value)), 'engine-authored-interaction-namespace');
  observedInteractionNamespaces.add(saved); observedInteractionNamespaces.add(live);
  check(!observedInteractionNamespaces.has(fresh), 'fresh-interaction-namespace-never-reused');
  observedInteractionNamespaces.add(fresh);
}
function legal(actor) {
  const result = timed('legalQueryBoundary', () => engine.get_legal_actions_for_viewer_js(actor));
  return [...result.actions, ...Object.values(result.legalActionsByObject ?? {}).flat()]
    .map(a => ({ type: a.type, ...(a.data ? { data: a.data } : {}) }));
}
function submit(actor, action) {
  lastActionType = action.type;
  const outcome = timed('normalActionBoundary', () => engine.submit_action(actor, action));
  lastOutcomeStatus = outcome?.status;
  check(outcome?.status === 'applied' && outcome.result && !outcome.result.disposition, 'normal-action-applied');
  stepCount++;
  if (traceCurrent) timed('traceNormalization', () => traceCurrent.push(stable(lossless(stringifyJSON({ actor, action, events: outcome.result.events ?? [] })))));
  return outcome.result.events ?? [];
}
function oldCapability(actor, actionCode) {
  const view = timed('viewerQueryBoundary', () => engine.get_viewer_snapshot_js(actor));
  for (const opportunity of view.viewerInteraction.opportunities) {
    if (opportunity.response.type !== 'exactChoices') continue;
    const choice = opportunity.response.data.choices.find(c => c.status.type === 'available'
      && (!actionCode || c.surfaces.some(s => s.type === 'action' && s.data.code === actionCode)));
    if (choice) return { interactionId: opportunity.interactionId, response: { type: 'choose', data: { choiceId: choice.id } } };
  }
  check(false, 'real-issued-exact-interaction-capability');
}
function installChecked(raw, { stale, actor } = {}) {
  const before = rawState(), liveState = lossless(before).state;
  actor ??= parseJSON(before).state.waiting_for.data?.player;
  check(Number.isInteger(actor), 'restore-old-capability-actor');
  stale ??= oldCapability(actor, 'passPriority');
  const start = performance.now();
  timed('restoreBoundary', () => engine.restore_game_state(raw));
  const elapsed = performance.now() - start;
  const restored = rawState();
  const expectedEnvelope = canonical(raw), restoredEnvelope = canonical(restored);
  const expectedRuntime = expectedEnvelope.precast_shortcut_runtime, restoredRuntime = restoredEnvelope.precast_shortcut_runtime;
  const numberToken = token => { check(typeof token === 'string' && token.startsWith('@number:'), 'exact-private-runtime-epoch-token'); return BigInt(token.slice(8)); };
  const rotatedEpoch = (numberToken(expectedRuntime.next_epoch) + 1n) & ((1n << 64n) - 1n);
  receipt('restore-diagnostic-' + (++restoreAttempt), {
    diagnosticOnly: true, comparisonExclusionsUnchanged: authorityFields,
    fullStateModuloFourInteractionCarriersEqual: isDeepStrictEqual(expectedEnvelope.state, restoredEnvelope.state),
    privatePrecastRuntimeEqual: isDeepStrictEqual(expectedRuntime, restoredRuntime),
    privatePrecastFieldEquality: Object.fromEntries(['next_epoch', 'offer', 'suppressed_cast', 'must_diverge', 'materializing'].map(key => [key, isDeepStrictEqual(expectedRuntime[key], restoredRuntime[key])])),
    privatePrecastEpochMatchesDocumentedRotation: numberToken(restoredRuntime.next_epoch) === (rotatedEpoch === 0n ? 1n : rotatedEpoch),
    fixedMismatchingStateSections: differentPaths({ state: expectedEnvelope.state }, { state: restoredEnvelope.state }),
    otherEnvelopeSectionsEqual: isDeepStrictEqual(Object.fromEntries(Object.entries(expectedEnvelope).filter(([key]) => !['state', 'precast_shortcut_runtime'].includes(key))), Object.fromEntries(Object.entries(restoredEnvelope).filter(([key]) => !['state', 'precast_shortcut_runtime'].includes(key))))
  });
  equalWithVerifiedRekey(raw, restored, 'trusted-gameplay-and-private-state-exact-after-verified-rekey');
  recordFreshNamespace(lossless(raw).state.interaction_session_id, liveState.interaction_session_id,
    lossless(restored).state.interaction_session_id);
  const outcome = timed('interactionBoundary', () => engine.submit_interaction_js(actor, stale));
  check(outcome?.status === 'rejected' && outcome.rejection?.code === 'stale_interaction', 'old-issued-capability-rejected-as-stale');
  check(isDeepStrictEqual(lossless(restored), lossless(rawState())), 'stale-capability-preserves-exact-state');
  receipt('restore-authority-' + restoreAttempt, { pass: true, verifiedExactSavedEpochRotation: true,
    nonreusedInteractionNamespace: true, observedNamespaceCount: observedInteractionNamespaces.size,
    staleIssuedCapabilityRejectedWithExactStatePreserved: true,
    numericalEpochGlobalMonotonicityAndNonreuse: 'NOT PROVIDED: saved-snapshot-relative counter; new interaction namespace checked separately',
    activePrecastOfferAuthority: 'NOT RUN: idle private runtime only' });
  return elapsed;
}
function restore(raw, options = {}) {
  const elapsed = installChecked(raw, options);
  const currentActor = state().waiting_for.data.player;
  const fresh = oldCapability(currentActor, 'passPriority'), beforeFresh = rawState();
  const accepted = timed('interactionBoundary', () => engine.submit_interaction_js(currentActor, fresh));
  check(accepted?.status === 'applied' && accepted.result && !accepted.result.disposition, 'fresh-real-capability-applied');
  const afterFresh = rawState();
  // Every diagnostic reinstall checks fresh authority and real stale rejection.
  // These controls are not retained history points or product Redo.
  installChecked(beforeFresh, { stale: fresh, actor: currentActor });
  submit(currentActor, { type: 'PassPriority' });
  equalWithVerifiedRekey(afterFresh, rawState(), 'fresh-capability-equals-normal-legal-transition-with-one-rekey');
  installChecked(raw);
  oldCapability(state().waiting_for.data.player, 'passPriority');
  return elapsed;
}
function idleStep({ target, landGoal = 0, protectedNames = [] } = {}) {
  const current = state(), waiting = current.waiting_for;
  progress = { stepCount, turn: current.turn_number, phase: current.phase, waiting: waiting.type, stackDepth: current.stack.length };
  const actor = waiting.data?.player;
  if (waiting.type === 'MulliganDecision') return submit(waiting.data.pending[0].player, { type: 'MulliganDecision', data: { choice: { type: 'Keep' } } });
  if (waiting.type === 'DeclareAttackers') return submit(actor, { type: 'DeclareAttackers', data: { attacks: [] } });
  if (waiting.type === 'DeclareBlockers') return submit(actor, { type: 'DeclareBlockers', data: { assignments: [] } });
  if (waiting.type === 'DiscardToHandSize') {
    const cards = [...waiting.data.cards].sort((a, b) => Number(protectedNames.includes(current.objects[a].name)) - Number(protectedNames.includes(current.objects[b].name)));
    return submit(actor, { type: 'SelectCards', data: { cards: cards.slice(0, waiting.data.count) } });
  }
  if (['TargetSelection', 'TriggerTargetSelection'].includes(waiting.type)) {
    const targets = waiting.data.target_slots.map(slot => {
      const selected = slot.legal_targets.find(t => t.Object === target);
      check(selected, 'requested-target-is-engine-legal'); return selected;
    });
    return submit(actor, { type: 'SelectTargets', data: { targets } });
  }
  if (waiting.type === 'ScryChoice') return submit(actor, { type: 'SelectCards', data: { cards: waiting.data.cards } });
  if (waiting.type === 'SearchChoice') return submit(actor, { type: 'SelectCards', data: { cards: waiting.data.cards.slice(0, waiting.data.count) } });
  if (waiting.type === 'OrderTriggers') return submit(actor, { type: 'OrderTriggers', data: { order: waiting.data.triggers.map((_, i) => i) } });
  check(waiting.type === 'Priority', 'supported-legal-waiting-boundary');
  if (current.stack.length === 0 && landGoal > 0) {
    const lands = current.battlefield.filter(id => current.objects[id].controller === actor && ['Forest', 'Island'].includes(current.objects[id].name));
    const actions = legal(actor).filter(a => a.type === 'PlayLand');
    if (lands.length < landGoal && actions.length) {
      const counts = name => lands.filter(id => current.objects[id].name === name).length;
      const desired = counts('Forest') <= counts('Island') ? 'Forest' : 'Island';
      return submit(actor, actions.find(a => current.objects[a.data.object_id].name === desired) ?? actions[0]);
    }
  }
  return submit(actor, { type: 'PassPriority' });
}
function seek(predicate, options = {}) {
  for (let step = 0; step < 1600; step++) {
    const found = predicate(state()); if (found) return found;
    idleStep(options);
  }
  check(false, 'bounded-natural-setup-reached');
}
function finishDeclaration(options = {}) {
  const events = [];
  for (let step = 0; step < 30; step++) {
    if (state().waiting_for.type === 'Priority') return events;
    events.push(...idleStep(options));
  }
  check(false, 'bounded-root-declaration-completed');
}
function resolveAll(options = {}) {
  const events = [];
  for (let step = 0; step < 40; step++) {
    const current = state();
    if (current.waiting_for.type === 'Priority' && current.stack.length === 0) return events;
    events.push(...idleStep(options));
  }
  check(false, 'bounded-normal-resolution-completed');
}
function castNamed(actor, name, target) {
  const current = state();
  const cast = legal(actor).find(a => a.type === 'CastSpell' && current.objects[a.data.object_id].name === name);
  check(cast, 'required-normal-cast-is-legal');
  const events = [...submit(actor, cast), ...finishDeclaration({ target })];
  check(events.some(e => e.type === 'SpellCast'), 'actual-spell-cast-event');
  return { cast, events };
}
function init(playerCards, opponentCards, seed = 0xF32002) {
  timed('setupBoundary', () => engine.clear_game_state());
  const format = timed('setupBoundary', () => engine.getFormatRegistry()).find(f => f.format === 'Limited')?.default_config;
  check(format, 'real-limited-format');
  const result = timed('setupBoundary', () => engine.initialize_game({ player: { main_deck: playerCards }, opponent: { main_deck: opponentCards } }, seed, format, null, 2, 0));
  check(!result.error && !timed('setupBoundary', () => engine.is_multiplayer_mode()), 'actual-local-init-not-multiplayer-bypass');
  for (const actor of [0, 1]) submit(actor, { type: 'SetPriorityPassingMode', data: { mode: 'FullControl' } });
}
const copies = (n, name) => Array(n).fill(name);
function spellReady(actor, name, lands) {
  return seek(current => current.waiting_for.type === 'Priority' && current.waiting_for.data.player === actor && current.stack.length === 0
    && current.battlefield.filter(id => current.objects[id].controller === actor && ['Forest', 'Island'].includes(current.objects[id].name)).length >= lands
    && legal(actor).some(a => a.type === 'CastSpell' && current.objects[a.data.object_id].name === name), { landGoal: lands, protectedNames: [name] });
}
function payment() {
  init([...copies(32, 'Forest'), ...copies(8, 'Grizzly Bears')], copies(40, 'Island'));
  spellReady(0, 'Grizzly Bears', 2);
  const mana = legal(0).find(a => a.type === 'TapLandForMana'); check(mana, 'separate-mana-activation'); submit(0, mana);
  const stale = oldCapability(0), pre = rawState();
  check(state().players[0].mana_pool.mana.length === 1, 'separate-prefloat-committed');
  castNamed(0, 'Grizzly Bears'); check(state().stack.length === 1, 'normal-creature-on-stack');
  const latency = restore(pre, { stale, actor: 0 });
  const start = performance.now(); castNamed(0, 'Grizzly Bears'); resolveAll();
  check(state().battlefield.some(id => state().objects[id].name === 'Grizzly Bears'), 'normal-recast-resolved');
  receipt('payment', { pass: true, checks: ['separate-mana-preserved', 'whole-cast-payment-rollback', 'stale-capability-rejected', 'fresh-legal-recast-resolved'], restoreMs: latency, continuationMs: performance.now() - start, memory: memory() });
}
function multistack() {
  init([...copies(32, 'Forest'), ...copies(8, 'Grizzly Bears')], [...copies(28, 'Island'), ...copies(12, 'Counterspell')]);
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 1 && s.stack.length === 0
    && s.battlefield.filter(id => s.objects[id].controller === 1 && s.objects[id].name === 'Island').length >= 2
    && s.players[1].hand.some(id => s.objects[id].name === 'Counterspell'), { landGoal: 2, protectedNames: ['Counterspell'] });
  spellReady(0, 'Grizzly Bears', 3);
  const { cast } = castNamed(0, 'Grizzly Bears');
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 1 && s.stack.length === 1);
  const stale = oldCapability(1), beforeResponse = rawState();
  castNamed(1, 'Counterspell', cast.data.object_id);
  check(state().stack.length === 2, 'two-real-spells-on-stack');
  resolveAll();
  submit(0, { type: 'Debug', data: { type: 'SetLife', data: { player_id: 0, life: 19 } } });
  check(state().players[0].life === 19, 'real-later-life-correction');
  const latency = restore(beforeResponse, { stale, actor: 1 });
  check(state().stack.length === 1 && state().players[0].life === 20, 'global-both-players-future-removed');
  // Branch differently: pass instead of recasting the response; the original spell resolves.
  resolveAll();
  check(state().objects[cast.data.object_id].zone === 'Battlefield', 'alternative-branch-legal-resolution');
  receipt('multistack', { pass: true, checks: ['nonempty-stack-checkpoint', 'actual-two-spell-response', 'later-correction-removed', 'whole-game-both-players-restored', 'fresh-alternative-continuation'], restoreMs: latency, networkDedup: 'NOT RUN', memory: memory() });
}
function rng() {
  init([...copies(12, 'Forest'), ...copies(12, 'Island'), ...copies(8, 'Opt'), ...copies(8, 'Rampant Growth')], copies(40, 'Island'));
  spellReady(0, 'Opt', 3);
  const oldOptCapability = oldCapability(0, 'passPriority'), beforeOpt = rawState();
  castNamed(0, 'Opt'); resolveAll(); const firstOpt = rawState();
  check(state().players[0].hand.length > JSON.parse(beforeOpt).state.players[0].hand.length - 1, 'actual-opt-draw');
  restore(beforeOpt, { stale: oldOptCapability, actor: 0 }); castNamed(0, 'Opt'); resolveAll(); equalWithVerifiedRekey(firstOpt, rawState(), 'same-opt-branch-exact-private-state-with-one-rekey');
  spellReady(0, 'Rampant Growth', 3);
  const oldShuffleCapability = oldCapability(0, 'passPriority'), beforeShuffle = rawState(); const beforePos = lossless(beforeShuffle).state.rng_word_pos;
  castNamed(0, 'Rampant Growth'); resolveAll(); const firstShuffle = rawState();
  check(!isDeepStrictEqual(beforePos, lossless(firstShuffle).state.rng_word_pos), 'actual-shuffle-advances-rng');
  restore(beforeShuffle, { stale: oldShuffleCapability, actor: 0 }); castNamed(0, 'Rampant Growth'); resolveAll(); equalWithVerifiedRekey(firstShuffle, rawState(), 'same-shuffle-branch-exact-private-state-and-rng-with-one-rekey');
  receipt('rng', { pass: true, checks: ['real-scry-and-draw', 'same-opt-private-state', 'real-library-search-and-shuffle', 'rng-advanced', 'restored-seed-offset-same-shuffle-result'], viewerPrivacy: 'NOT RUN: no additional viewer publication', memory: memory() });
}
function abilityResponse() {
  init([...copies(32, 'Forest'), ...copies(8, 'Seeker of Skybreak')], [...copies(32, 'Forest'), ...copies(8, 'Giant Growth')]);
  spellReady(0, 'Seeker of Skybreak', 2); castNamed(0, 'Seeker of Skybreak'); resolveAll();
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 1 && s.stack.length === 0
    && s.battlefield.some(id => s.objects[id].controller === 1 && s.objects[id].name === 'Forest')
    && s.players[1].hand.some(id => s.objects[id].name === 'Giant Growth'), { landGoal: 2, protectedNames: ['Giant Growth'] });
  const seeker = state().battlefield.find(id => state().objects[id].name === 'Seeker of Skybreak');
  const activation = () => legal(0).find(a => a.type === 'ActivateAbility' && a.data.source_id === seeker);
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 0 && s.stack.length === 0 && activation());
  const stale = oldCapability(0), beforeAbility = rawState();
  const abilityEvents = [...submit(0, activation()), ...finishDeclaration({ target: seeker })];
  check(abilityEvents.some(e => e.type === 'AbilityActivated') && state().stack.length === 1, 'actual-ability-root');
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 1 && s.stack.length === 1);
  castNamed(1, 'Giant Growth', seeker); check(state().stack.length === 2, 'ability-plus-spell-response-stack');
  resolveAll();
  submit(0, { type: 'Debug', data: { type: 'SetLife', data: { player_id: 1, life: 19 } } });
  check(state().players[1].life === 19, 'later-opponent-life-correction');
  const elapsed = restore(beforeAbility, { stale, actor: 0 });
  check(state().players[1].life === 20 && state().stack.length === 0, 'global-ability-response-correction-rollback');
  submit(0, activation()); finishDeclaration({ target: seeker }); resolveAll();
  receipt('ability-response', { pass: true, checks: ['actual-ability-target-and-tap', 'opponent-giant-growth-response', 'later-opponent-life-correction', 'both-players-whole-operation-root-restored', 'next-normal-ability-resolved'], restoreMs: elapsed, memory: memory() });
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], p50: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted[Math.floor((sorted.length - 1) * .95)], max: sorted.at(-1) };
}
function profileTwin(label, reuseAdjacentObservation) {
  const preparationStart = performance.now(), setupTiming = {}, setupTrace = [];
  profileCurrent = setupTiming; traceCurrent = setupTrace;
  const startActions = stepCount;
  init([...copies(12, 'Forest'), ...copies(12, 'Island'), ...copies(8, 'Seeker of Skybreak'), ...copies(8, 'Wake Thrasher')], copies(40, 'Island'));
  spellReady(0, 'Seeker of Skybreak', 3); castNamed(0, 'Seeker of Skybreak'); resolveAll();
  spellReady(0, 'Wake Thrasher', 3); castNamed(0, 'Wake Thrasher'); resolveAll();
  const seeker = state().battlefield.find(id => state().objects[id].name === 'Seeker of Skybreak');
  const wake = state().battlefield.find(id => state().objects[id].name === 'Wake Thrasher');
  const activation = () => legal(0).find(a => a.type === 'ActivateAbility' && a.data.source_id === seeker);
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 0 && s.stack.length === 0 && activation(), { landGoal: 3 });
  const initial = canonical(rawState());
  const preparationMs = performance.now() - preparationStart;
  const rootTiming = {}, preEnvelopes = [], retained = [], rootTraces = [], samples = [], hashes = new Set();
  profileCurrent = rootTiming;
  const loopStart = performance.now();
  for (let n = 1; n <= 5; n++) {
    stage = 'observer-profile-' + label + '-' + n;
    const trace = []; traceCurrent = trace;
    const rootStart = performance.now();
    check(activation(), 'real-reusable-ability-legal');
    const captureStart = performance.now(), raw = rawState('retainedPreExport');
    const captureMs = performance.now() - captureStart;
    const preEnvelope = canonical(raw), digest = sha(stringifyJSON(preEnvelope));
    check(!hashes.has(digest), 'independently-distinct-real-pre-state'); hashes.add(digest);
    const preEffects = state().transient_continuous_effects.length;
    const events = [...submit(0, activation()), ...finishDeclaration({ target: seeker }), ...resolveAll()];
    check(events.some(e => e.type === 'AbilityActivated'), 'real-activation-event');
    const untaps = events.filter(e => e.type === 'PermanentUntapped' && e.data.object_id === seeker).length;
    // Only these adjacent assertions share one observation. No engine call is
    // moved, cached across a transition, or removed anywhere else.
    const post = reuseAdjacentObservation ? state() : null;
    check(untaps > 0 && !(post ?? state()).objects[seeker].tapped, 'actual-self-untap');
    const triggered = events.filter(e => e.type === 'EffectResolved' && e.data.source_id === wake && ['Pump', 'PumpSelf'].includes(e.data.kind)).length;
    check(triggered > 0 && (post ?? state()).transient_continuous_effects.length > preEffects, 'actual-wake-trigger-growth');
    retained.push(raw); preEnvelopes.push(preEnvelope); rootTraces.push(trace);
    const sample = { n, completedRealRoot: true, snapshotUtf8Bytes: Buffer.byteLength(raw), captureMs,
      canonicalPreSha256: digest, actualUntaps: untaps, actualWakeEffectResolutions: triggered,
      normalActionCount: trace.length, rootWallMs: performance.now() - rootStart };
    samples.push(sample);
    appendFileSync(path.join(output, 'profile-' + label + '-samples.jsonl'), JSON.stringify(sample) + '\n');
  }
  const rootLoopMs = performance.now() - loopStart;
  traceCurrent = null;
  const observationTiming = {}; profileCurrent = observationTiming;
  const finalRaw = rawState(), finalEnvelope = canonical(finalRaw);
  const finalRng = { seed: finalEnvelope.state.rng_seed, wordPos: finalEnvelope.state.rng_word_pos, rng: finalEnvelope.state.rng };
  profileCurrent = null;
  receipt('profile-' + label, { pass: true, completedRealRoots: 5, distinctCanonicalPreSnapshots: hashes.size, reuseAdjacentObservation,
    actualSetupActionCount: stepCount - startActions - rootTraces.reduce((total, trace) => total + trace.length, 0),
    preparationMs, rootLoopMs, setupTiming, rootTiming, finalObservationTiming: observationTiming,
    setupTraceSha256: sha(JSON.stringify(setupTrace)), rootTraceSha256: rootTraces.map(trace => sha(JSON.stringify(trace))),
    initialCanonicalPreSha256: sha(JSON.stringify(initial)), finalCanonicalEnvelopeSha256: sha(JSON.stringify(finalEnvelope)),
    finalRngSha256: sha(JSON.stringify(finalRng)), samples,
    timingScope: 'exclusive instrumented category elapsed; nested categories subtracted; API times include WASM/JS conversion, not pure Rust CPU; string token decoding is lossless transform; in-frame/nested profiler overhead may remain in category elapsed; final receipt/journal outside categories',
    normalization: 'trace actor/action/all ordered events: object-key sorting and lossless numeric/string tagging only; envelope excludes only original four state interaction carriers; private runtime and all other fields retained',
    benchmarkClaim: 'one ordered pair, same process; cold/warm confound, no speed or device benchmark' });
  return { initial, preEnvelopes, finalEnvelope, finalRng, setupTrace, rootTraces, retained, finalRaw, activation, seeker };
}
function observerProfile() {
  const baseline = profileTwin('baseline', false), variant = profileTwin('adjacent-reuse', true);
  const comparisonTiming = {}; profileCurrent = comparisonTiming;
  check(isDeepStrictEqual(baseline.initial, variant.initial), 'paired-initial-complete-canonical-envelope');
  check(isDeepStrictEqual(baseline.setupTrace, variant.setupTrace), 'paired-exact-setup-action-event-trace');
  for (let n = 0; n < 5; n++) {
    check(isDeepStrictEqual(baseline.preEnvelopes[n], variant.preEnvelopes[n]), 'paired-each-complete-canonical-pre');
    check(isDeepStrictEqual(baseline.rootTraces[n], variant.rootTraces[n]), 'paired-each-exact-normal-action-event-trace');
  }
  check(isDeepStrictEqual(baseline.finalEnvelope, variant.finalEnvelope), 'paired-final-complete-canonical-envelope');
  check(isDeepStrictEqual(baseline.finalRng, variant.finalRng), 'paired-exact-final-rng');
  profileCurrent = null;
  receipt('profile-equivalence', { pass: true, roots: 5, initialAndEveryPreAndFinalCompleteEnvelopeEqual: true,
    setupAndAllRootActionEventTracesEqual: true, rngEqual: true, comparisonTiming,
    unchangedExclusions: authorityFields, privateEpochAndAllOtherFieldsComparedExactly: true });
  // Existing authority/continuation controls remain intact, outside the twin's
  // measured progression and equivalence (fresh game traces contain no probes).
  const probeTiming = {}; profileCurrent = probeTiming;
  const suiteStart = performance.now(), restoreSamples = [];
  for (const position of [0, 2, 4]) {
    stage = 'observer-profile-restore-' + position;
    const elapsed = restore(variant.retained[position]);
    const start = performance.now();
    const events = [...submit(0, variant.activation()), ...finishDeclaration({ target: variant.seeker }), ...resolveAll()];
    check(events.some(e => e.type === 'AbilityActivated'), 'restored-real-history-legal-continuation');
    restoreSamples.push({ position, restoreMs: elapsed, continuationMs: performance.now() - start });
    restore(variant.finalRaw);
  }
  profileCurrent = null;
  receipt('profile-restore', { pass: true, restoreSamples, checkedInstallCount: restoreAttempt,
    suiteMs: performance.now() - suiteStart, probeTiming, controlContract: 'unchanged exact saved-u64 rotation, complete remaining equality, never-reused namespace, real stale rejection and fresh-vs-normal transition' });
  for (const twin of [baseline, variant]) {
    twin.retained.length = 0; twin.preEnvelopes.length = 0; twin.rootTraces.length = 0; twin.setupTrace.length = 0;
  }
  global.gc();
  receipt('observer-profile', { pass: true, pairedRootCount: 5, adjacentReuseAcceptedForThisWorkload: true,
    authorityChecks: 'PASS: existing Priority controls only', nonPriorityRestore: 'NOT PASSED',
    ordinaryFixture: 'NOT RUN in this campaign; separate reviewed policy required', memory: memory() });
}
function history() {
  const preparationStart = performance.now();
  init([...copies(12, 'Forest'), ...copies(12, 'Island'), ...copies(8, 'Seeker of Skybreak'), ...copies(8, 'Wake Thrasher')], copies(40, 'Island'));
  spellReady(0, 'Seeker of Skybreak', 3); castNamed(0, 'Seeker of Skybreak'); resolveAll();
  spellReady(0, 'Wake Thrasher', 3); castNamed(0, 'Wake Thrasher'); resolveAll();
  const seeker = state().battlefield.find(id => state().objects[id].name === 'Seeker of Skybreak');
  const wake = state().battlefield.find(id => state().objects[id].name === 'Wake Thrasher');
  const activation = () => legal(0).find(a => a.type === 'ActivateAbility' && a.data.source_id === seeker);
  seek(s => s.waiting_for.type === 'Priority' && s.waiting_for.data.player === 0 && s.stack.length === 0 && activation(), { landGoal: 3 });
  const canonicalInitialPreSha256 = sha(JSON.stringify(canonical(rawState())));
  global.gc(); const baseline = memory();
  const preparationMs = performance.now() - preparationStart;
  const measurementMethod = 'independent fresh game for requested count; restore probes only after this count; unlike75b5 no intermediate50 probe in200/1000 progression';
  receipt('preparation', { pass: true, preparationMs, actualSetupActionCount: stepCount,
    canonicalInitialPreSha256, initialHashScope: 'complete canonical trusted PRE, original four interaction carriers excluded; no private values disclosed',
    measurementMethod, baselineMemory: baseline,
    timingScope: 'preparation includes real initialization/setup actions, starting-state hash and baseline GC; excludes prior input validation/WASM initialization' });
  const retained = [], hashes = new Set(), captures = [], sizes = [];
  const numericSamples = path.join(output, 'capture-samples.jsonl');
  check(!existsSync(numericSamples), 'do-not-overwrite-or-retry-campaign');
  let totalBytes = 0, activationCount = 0, untapCount = 0, triggers = 0;
  const totals = { preRootLegalValidationMs: 0, snapshotExportMs: 0, snapshotHashAndObservationMs: 0,
    normalProgressionAndValidationMs: 0, bookkeepingAndJournalMs: 0 };
  const captureLoopStart = performance.now();
  for (let n = 1; n <= historyTargetCount; n++) {
    stage = 'actual-history-' + n;
    const legalStart = performance.now();
    check(activation(), 'real-reusable-ability-legal');
    const preRootLegalValidationMs = performance.now() - legalStart;
    const start = performance.now(), raw = rawState();
    const snapshotExportMs = performance.now() - start;
    const observationStart = performance.now();
    captures.push(snapshotExportMs);
    const bytes = Buffer.byteLength(raw); totalBytes += bytes; sizes.push(bytes);
    const digest = sha(JSON.stringify(canonical(raw))); check(!hashes.has(digest), 'independently-distinct-real-pre-state'); hashes.add(digest);
    const preEffects = state().transient_continuous_effects.length;
    const snapshotHashAndObservationMs = performance.now() - observationStart;
    const progressionStart = performance.now();
    const events = [...submit(0, activation()), ...finishDeclaration({ target: seeker }), ...resolveAll()];
    check(events.some(e => e.type === 'AbilityActivated'), 'real-activation-event'); activationCount++;
    const untaps = events.filter(e => e.type === 'PermanentUntapped' && e.data.object_id === seeker).length;
    check(untaps > 0 && !state().objects[seeker].tapped, 'actual-self-untap'); untapCount += untaps;
    const triggered = events.filter(e => e.type === 'EffectResolved' && e.data.source_id === wake && ['Pump', 'PumpSelf'].includes(e.data.kind)).length;
    check(triggered > 0 && state().transient_continuous_effects.length > preEffects, 'actual-wake-trigger-growth'); triggers += triggered;
    const normalProgressionAndValidationMs = performance.now() - progressionStart;
    totals.preRootLegalValidationMs += preRootLegalValidationMs;
    totals.snapshotExportMs += snapshotExportMs;
    totals.snapshotHashAndObservationMs += snapshotHashAndObservationMs;
    totals.normalProgressionAndValidationMs += normalProgressionAndValidationMs;
    const bookkeepingStart = performance.now();
    retained.push(raw);
    appendFileSync(numericSamples, JSON.stringify({ n, snapshotUtf8Bytes: bytes, captureMs: snapshotExportMs, completedRealRoot: true,
      phases: { preRootLegalValidationMs, snapshotExportMs, snapshotHashAndObservationMs, normalProgressionAndValidationMs } }) + '\n');
    totals.bookkeepingAndJournalMs += performance.now() - bookkeepingStart;
    if (n % 10 === 0 || n === historyTargetCount) receipt('progress-' + n, { completedRealRoots: n, cumulativeUtf8Bytes: totalBytes,
      phaseTotals: { ...totals }, captureLoopElapsedMs: performance.now() - captureLoopStart,
      timingScope: 'nonoverlapping measured phases; loop elapsed also includes receipt and miscellaneous harness overhead' });
    if (n === historyTargetCount) {
      global.gc(); const retainedMemory = memory();
      receipt('milestone-' + n, { pass: true, measurementPointsNotCaps: true, realRoots: activationCount, actualUntaps: untapCount, actualWakeTriggerEffectResolutions: triggers, distinctCanonicalPreSnapshots: hashes.size,
        cumulativeUtf8Bytes: totalBytes, snapshotBytes: distribution(sizes), captureMs: distribution(captures), baselineMemory: baseline, retainedMemory,
        preparationMs, capturePhaseTotals: { ...totals }, captureLoopElapsedMs: performance.now() - captureLoopStart, measurementMethod,
        memoryScope: 'whole Node process: growing engine Wake effects plus retained snapshot strings and measurement/runtime allocations; not isolated history-only RSS' });
      const suiteStart = performance.now(), current = rawState(), restoreSamples = [];
      for (const position of [0, Math.floor((n - 1) / 2), n - 1]) {
        const probeStart = performance.now();
        const elapsed = restore(retained[position]);
        const restoreProbeMs = performance.now() - probeStart;
        const continuationStart = performance.now();
        const continued = [...submit(0, activation()), ...finishDeclaration({ target: seeker }), ...resolveAll()];
        check(continued.some(e => e.type === 'AbilityActivated'), 'restored-real-history-legal-continuation');
        const continuationMs = performance.now() - continuationStart;
        const reinstallStart = performance.now();
        restore(current); // Authentic diagnostic reinstall, not a product Redo/history point.
        restoreSamples.push({ position, restoreMs: elapsed, restoreProbeMs, continuationMs,
          currentReinstallProbeMs: performance.now() - reinstallStart });
      }
      receipt('restore-' + n, { pass: true, historyLength: n, restoreSamples, diagnosticCurrentReinstalls: 3,
        restoreSuiteElapsedMs: performance.now() - suiteStart,
        timingScope: 'restoreMs is one engine install; probe includes checked installs/fresh-vs-normal control; suite includes current export, three probes/continuations/current reinstalls and validation receipts',
        interactionCarrierFieldsExcluded: authorityFields, privateEpochRelation: 'exact saved u64 +1 modulo, minimum1; all remaining trusted fields exact',
        authorityChecks: 'every actual install, including controls: new never-reused namespace and real stale-capability rejection' });
    }
  }
  const releaseStart = performance.now();
  retained.length = 0; hashes.clear(); global.gc();
  receipt('history', { pass: true, workload: 'finite legal growing Seeker/Wake ability-loop stress; not ordinary-game frequency', realRoots: activationCount,
    preparationMs, capturePhaseTotals: { ...totals }, historyElapsedMs: performance.now() - preparationStart,
    releaseMs: performance.now() - releaseStart, measurementMethod,
    afterHistoryReleaseMemory: memory(), releaseScope: 'paired whole-process observation; live game Wake effects remain, no pure history-only RSS attribution', ancestorTargetTruncationAndStaleTargetRefusal: 'NOT RUN: no product history-target controller', normalGameFullDb: 'NOT RUN', appUi: 'NOT RUN', twoSeatSync: 'NOT RUN', productPruningBudget: 'NOT CHOSEN' });
}

try {
  check(!isDeepStrictEqual(lossless('{"x":1}'), lossless('{"x":"@number:1"}')), 'comparator-preserves-number-string-type');
  check(!isDeepStrictEqual(lossless('{"x":18446744073709551614}'), lossless('{"x":18446744073709551615}')), 'comparator-preserves-u64-token');
  check(['payment', 'multistack', 'ability-response', 'rng', 'history', 'observer-profile'].includes(campaign), 'fixed-campaign');
  check(campaign !== 'history' || [50, 200, 1000].includes(historyTargetCount), 'fixed-independent-history-measurement-count');
  check(typeof global.gc === 'function', 'expose-gc-required');
  const inputStart = performance.now();
  const directory = path.resolve(directoryArg), fixture = path.resolve(fixtureArg);
  const wasm = readFileSync(path.join(directory, 'engine_wasm_bg.wasm'));
  check(wasm.length === 295869347 && sha(wasm) === '1861c7d90af448a1c98d17bcd42e9dc6ad41f317a05afe2ec1cc13e4de2e450f', 'exact-e109-wasm-binary');
  check(sha(readFileSync(path.join(directory, 'engine_wasm.js'))) === 'cc3e67a1e4cf930a9107826aa676ee9b36a16494c92887897ec881251cc0ea6a', 'exact-generated-binding-pair');
  const fixtureRaw = readFileSync(fixture, 'utf8');
  check(Buffer.byteLength(fixtureRaw) === 79406 && sha(fixtureRaw) === '1849fbe675e2e5acac2b32e6f96fd8d4e2d67a8c426138452d32cb0db4f494db', 'exact-official-nine-card-fixture');
  engine = await import(pathToFileURL(path.join(directory, 'engine_wasm.js')));
  wasmModule = await engine.default({ module_or_path: await WebAssembly.compile(wasm) });
  check(engine.ping() === 'phase-rs engine ready' && engine.load_card_database(fixtureRaw) === 9, 'real-wasm-and-fixture-compatible');
  receipt('inputs', { pass: true, inputValidationAndWasmInitMs: performance.now() - inputStart,
    binaryProfile: 'unoptimized tool WASM; not release-device latency', fixtureCards: 9, node: process.version, memory: memory() });
  stage = campaign;
  ({ payment, multistack, 'ability-response': abilityResponse, rng, history, 'observer-profile': observerProfile })[campaign]();
} catch {
  receipt('failure', { pass: false, stage, failedCheck: failedCheck ?? 'wasm-api-or-runtime-error', progress, lastActionType, lastOutcomeStatus, mismatchPaths });
  process.exitCode = 1;
}
