//! Opt-in host RAM ownership of the engine's bounded cast checkpoint.
//! No checkpoint or identity is exported in a game snapshot or persistence.

use super::*;
use engine::game::host_precast_undo::{HostPrecastUndo, HostUndoBinding, HostUndoPhase};

thread_local! {
    static RUNTIME: Cell<Option<Runtime>> = const { Cell::new(None) };
    // Outside the movable registry: a panic-lost registry cannot reuse identity.
    static INCARNATION: Cell<u64> = const { Cell::new(0) };
}

struct Runtime {
    binding: HostUndoBinding,
    enabled: bool,
    exhausted: bool,
    undo: HostPrecastUndo,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    pub binding: String,
    pub enabled: bool,
    pub phase: &'static str,
    pub receipt: Option<String>,
}

pub(super) enum Boundary {
    Game,
    Database,
    Claim,
}

fn next_incarnation() -> Result<u64, String> {
    INCARNATION.with(|serial| {
        let next = serial
            .get()
            .checked_add(1)
            .ok_or("host incarnation exhausted")?;
        serial.set(next);
        Ok(next)
    })
}

impl Runtime {
    fn new() -> Result<Self, String> {
        Ok(Self {
            binding: HostUndoBinding {
                incarnation: next_incarnation()?,
                database: 0,
                claim: 0,
            },
            enabled: false,
            exhausted: false,
            undo: HostPrecastUndo::default(),
        })
    }

    fn binding_key(&self) -> String {
        format!(
            "{}.{}.{}",
            self.binding.incarnation, self.binding.database, self.binding.claim
        )
    }

    fn check(&self, expected: &str) -> Result<(), String> {
        if self.exhausted || self.binding_key() != expected {
            return Err("host checkpoint binding is no longer current".into());
        }
        Ok(())
    }

    fn status(&self) -> Status {
        Status {
            binding: self.binding_key(),
            enabled: self.enabled,
            phase: match self.undo.phase() {
                HostUndoPhase::Empty => "Empty",
                HostUndoPhase::Pending => "Pending",
                HostUndoPhase::Armed => "Armed",
                HostUndoPhase::Invalidated => "Invalidated",
                HostUndoPhase::Consumed => "Consumed",
            },
            receipt: self.undo.receipt().map(|receipt| receipt.to_string()),
        }
    }
}

fn with_runtime<T>(f: impl FnOnce(&mut Runtime) -> Result<T, String>) -> Result<T, String> {
    RUNTIME.with(|cell| {
        let mut runtime = match cell.take() {
            Some(runtime) => runtime,
            None => Runtime::new()?,
        };
        let result = if runtime.exhausted {
            Err("host checkpoint identity exhausted".into())
        } else {
            f(&mut runtime)
        };
        cell.set(Some(runtime));
        result
    })
}

pub(super) fn invalidate() {
    RUNTIME.with(|cell| {
        if let Some(mut runtime) = cell.take() {
            runtime.undo.invalidate();
            cell.set(Some(runtime));
        }
    });
}

pub(super) fn disable() {
    RUNTIME.with(|cell| {
        if let Some(mut runtime) = cell.take() {
            runtime.enabled = false;
            runtime.undo.invalidate();
            cell.set(Some(runtime));
        }
    });
}

pub(super) fn boundary(boundary: Boundary) {
    let _ = with_runtime(|runtime| {
        runtime.enabled = false;
        runtime.undo.invalidate();
        let next = match boundary {
            Boundary::Game => next_incarnation(),
            Boundary::Database => runtime
                .binding
                .database
                .checked_add(1)
                .ok_or_else(|| "database identity exhausted".into()),
            Boundary::Claim => runtime
                .binding
                .claim
                .checked_add(1)
                .ok_or_else(|| "host claim exhausted".into()),
        };
        match next {
            Ok(next) => match boundary {
                Boundary::Game => runtime.binding.incarnation = next,
                Boundary::Database => runtime.binding.database = next,
                Boundary::Claim => runtime.binding.claim = next,
            },
            Err(_) => runtime.exhausted = true,
        }
        Ok(())
    });
}

fn host_context(state: &GameState) -> Result<(), String> {
    if !MULTIPLAYER_MODE.with(Cell::get)
        || state.players.len() != 2
        || state.viewer_projection.is_some()
    {
        return Err("checkpoint requires a live authoritative two-seat host".into());
    }
    CARD_DB.with(|cell| {
        let db = cell.borrow();
        match (db.as_ref(), state.card_db.as_ref()) {
            (Some(db), Some(installed)) if std::sync::Arc::ptr_eq(db, installed.arc()) => Ok(()),
            _ => Err("checkpoint requires the host's installed card database".into()),
        }
    })
}

fn with_host<T>(
    f: impl FnOnce(&mut Runtime, &mut GameState) -> Result<T, String>,
) -> Result<T, String> {
    GAME_STATE.with(|cell| {
        let mut state = cell.take().ok_or_else(|| NOT_INITIALIZED_ERR.to_string())?;
        let result =
            host_context(&state).and_then(|()| with_runtime(|runtime| f(runtime, &mut state)));
        cell.set(Some(state));
        result
    })
}

pub(super) fn status() -> Result<Status, String> {
    with_host(|runtime, _| Ok(runtime.status()))
}

pub(super) fn enable(expected: &str) -> Result<Status, String> {
    with_host(|runtime, _| {
        runtime.check(expected)?;
        runtime.enabled = true;
        Ok(runtime.status())
    })
}

pub(super) fn restore(expected: &str, receipt: &str) -> Result<Status, String> {
    let receipt_number: u64 = receipt.parse().map_err(|_| "invalid checkpoint receipt")?;
    if receipt_number.to_string() != receipt {
        return Err("noncanonical checkpoint receipt".into());
    }
    let status = with_host(|runtime, state| {
        runtime.check(expected)?;
        if !runtime.enabled {
            return Err("host checkpoint experiment is disabled".into());
        }
        runtime
            .undo
            .compare_restore(state, runtime.binding, receipt_number, |json| {
                decode_and_rehydrate_restored_game_state(json, |candidate| {
                    candidate.rehydrate_rng();
                    bind_interaction_session(candidate);
                    Ok(())
                })
                .map(|restored| restored.state)
            })?;
        Ok(runtime.status())
    })?;
    REPLAY_LOG.with(|cell| cell.set(None));
    clear_ai_session_cache();
    invalidate_ai_proposals();
    Ok(status)
}

pub(super) fn submit_action(
    state: &mut GameState,
    actor: PlayerId,
    action: GameAction,
) -> Result<engine::types::game_state::ActionResult, ActionRejection> {
    RUNTIME.with(|cell| {
        let Some(mut runtime) = cell.take() else {
            return apply_with_rejection(state, actor, action);
        };
        let result = if runtime.enabled && !runtime.exhausted {
            runtime
                .undo
                .submit_action(state, runtime.binding, actor, action)
        } else {
            apply_with_rejection(state, actor, action)
        };
        cell.set(Some(runtime));
        result
    })
}

pub(super) fn submit_interaction(
    state: &mut GameState,
    actor: PlayerId,
    submission: InteractionSubmission,
) -> Result<engine::game::interaction::AppliedInteraction, ActionRejection> {
    RUNTIME.with(|cell| {
        let Some(mut runtime) = cell.take() else {
            return submit_interaction_with_rejection(state, actor, submission);
        };
        let result = if runtime.enabled && !runtime.exhausted {
            runtime
                .undo
                .submit_interaction(state, runtime.binding, actor, submission)
        } else {
            submit_interaction_with_rejection(state, actor, submission)
        };
        cell.set(Some(runtime));
        result
    })
}

#[cfg(test)]
#[path = "host_precast_undo_tests.rs"]
mod tests;
