//! Bounded native acceptance harness for the host PRE-cast Undo prototype.
//! Uses the real engine crate without selecting the library unit or monolithic harness.

use engine as engine_under_test;

#[path = "../support/host_precast_undo_cases.rs"]
mod cases;

#[path = "../integration/no_top_level_test_binaries.rs"]
mod no_top_level_test_binaries;

#[test]
fn synthetic_activation_metadata_is_not_ordinary_payment() {
    engine_under_test::game::host_precast_undo::test_support::synthetic_activation_metadata_is_not_ordinary_payment();
}

#[test]
fn rejected_correct_cast_captures_private_pre_counter() {
    engine_under_test::game::host_precast_undo::test_support::rejected_correct_cast_captures_private_pre_counter();
}

#[test]
fn installed_delayed_watcher_is_ineligible_pre() {
    engine_under_test::game::host_precast_undo::test_support::installed_delayed_watcher_is_ineligible_pre();
}

#[test]
fn synthetic_private_post_overflow_refuses_before_decoder() {
    engine_under_test::game::host_precast_undo::test_support::synthetic_private_post_overflow_refuses_before_decoder();
}

#[test]
fn capacity_checked_sum_overflow_fails_closed() {
    engine_under_test::game::host_precast_undo::test_support::capacity_checked_sum_overflow_fails_closed();
}

#[test]
fn capacity_each_structural_category_has_inclusive_boundary() {
    engine_under_test::game::host_precast_undo::test_support::capacity_each_structural_category_has_inclusive_boundary();
}

#[test]
fn capacity_nested_history_counts_inner_entries() {
    engine_under_test::game::host_precast_undo::test_support::capacity_nested_history_counts_inner_entries();
}

#[test]
fn capacity_json_counts_utf8_bytes_inclusive() {
    engine_under_test::game::host_precast_undo::test_support::capacity_json_counts_utf8_bytes_inclusive();
}

#[test]
fn capacity_structure_refusal_skips_capture_and_casts_once() {
    engine_under_test::game::host_precast_undo::test_support::capacity_structure_refusal_skips_capture_and_casts_once();
}

#[test]
fn capacity_serializer_error_or_json_refusal_casts_once() {
    engine_under_test::game::host_precast_undo::test_support::capacity_serializer_error_or_json_refusal_casts_once();
}

#[test]
fn capacity_restore_decode_failure_preserves_case() {
    engine_under_test::game::host_precast_undo::test_support::capacity_restore_decode_failure_preserves_case();
}
