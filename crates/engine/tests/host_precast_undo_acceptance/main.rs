//! Bounded native acceptance harness for the host PRE-cast Undo prototype.
//! Uses the real engine crate without selecting the library unit or monolithic harness.

use engine as engine_under_test;

#[path = "../support/host_precast_undo_cases.rs"]
mod cases;

#[path = "../integration/no_top_level_test_binaries.rs"]
mod no_top_level_test_binaries;
