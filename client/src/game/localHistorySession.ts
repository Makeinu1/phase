import type { EngineAdapter, EngineSnapshot, GameAction, GameEvent, GameLogEntry } from "../adapter/types";
import type { InteractionSubmission } from "../adapter/generated/interaction";
import { isActionRejection, AdapterError } from "../adapter/types";
import { TrustedHistory, type HistoryBinding } from "../services/trustedHistory";
import { useGameStore } from "../stores/gameStore";
import { useUiStore } from "../stores/uiStore";
import { useAnimationStore } from "../stores/animationStore";
import { abandonPendingDispatches } from "./dispatch";
import { adoptLocalGameplayPreferences, localGameplayPresentation, type LocalGameplayPresentation } from "../hooks/useGameplayPreferencesSync";

export interface LocalHistoryView {
  phase: "idle" | "busy" | "recovery" | "stopped";
  canUndo: boolean;
  entries: number;
  notice: "blocked" | "notStarted" | "rolledBack" | null;
}

type Display = Pick<ReturnType<typeof useGameStore.getState>, "events" | "eventHistory" | "logHistory" | "nextLogSeq"> & { settings: LocalGameplayPresentation };
type Request = { kind: "action"; action: GameAction } | { kind: "interaction"; submission: InteractionSubmission };
type DispatchOutcome = { status: "accepted" | "rejected" | "blocked" | "failed"; events: GameEvent[] };
type WorkerAdapter = EngineAdapter & { getEngineClient(): unknown };

// Reviewed public game-mutating surface, including the raw-client escape hatch.
// These remain closed on a retired adapter, so a late caller cannot revive it.
const CLOSED_METHODS = [
  "initializeGame", "initializeMultiplayerHostGame", "submitAction", "submitInteraction",
  "submitAiActionProposal", "getAiActionProposal", "getAiTacticalActionProposal",
  "buildLlmDecisionRequest", "getAiActionProposalFromLlmResponse", "restoreState",
  "restoreTrustedState", "resumeRestoredGameState", "resumeMultiplayerHostState",
  "resetGameState", "setMultiplayerMode", "applySeatMutation", "releaseHostSession",
  "bindMatchConcede", "enableHostPrecastUndo", "restoreHostPrecastUndo", "getEngineClient",
] as const;

let active: LocalHistorySession | null = null;
let sessionSerial = 0;

export function currentLocalHistory(): LocalHistorySession | null { return active; }

/** An external pair must never publish an unrecorded experimental mutation. */
export function permitLocalHistoryCommit(owner?: symbol): boolean {
  if (!active) return owner === undefined;
  if (owner === active.owner) return active.ownsSession();
  if (owner === undefined) active.violation();
  return false;
}

export function endLocalHistorySession(): void { active?.end(); }

export function startLocalHistorySession(adapter: EngineAdapter, initialSeq = useGameStore.getState().lastCommittedSeq): symbol {
  if (!import.meta.env.DEV || import.meta.env.VITE_PHASE_LOCAL_HISTORY !== "1"
    || useGameStore.getState().gameMode !== "local" || active) {
    throw new Error("Local history requires a new opted-in Local session");
  }
  const workerAdapter = adapter as WorkerAdapter;
  if (typeof workerAdapter.getEngineClient !== "function" || !workerAdapter.getEngineClient()
    || !adapter.exportPersistenceState || !adapter.restoreTrustedState) {
    throw new Error("Local history requires its own initialized module Worker");
  }
  active = new LocalHistorySession(workerAdapter, initialSeq);
  active.publish();
  return active.owner;
}

/** One user submission = one root. Payment, choices and passes are separate roots. */
export class LocalHistorySession {
  readonly owner = Symbol("local-history-adoption");
  private readonly gameId: string;
  private readonly session: number;
  private readonly identity = ++sessionSerial;
  private generation = 1;
  private rootSerial = 0;
  private busy = false;
  private closed = false;
  private notice: LocalHistoryView["notice"] = null;
  private request: Request | null = null;
  private pair: EngineSnapshot | null = null;
  private events: GameEvent[] = [];
  private logs: GameLogEntry[] = [];
  private restoreDisplay: Display | null = null;
  private readonly displays = new Map<string, Display>();
  private readonly history: TrustedHistory;
  private readonly rawDispose: () => void;

  constructor(readonly adapter: WorkerAdapter, initialSeq: number) {
    const game = useGameStore.getState();
    if (!game.gameId || game.adapter !== adapter) throw new Error("Local history session not initialized");
    this.gameId = game.gameId;
    this.session = game.gameSessionGeneration;
    const rawSnapshot = adapter.getSnapshot.bind(adapter);
    const rawExport = adapter.exportPersistenceState!.bind(adapter);
    const rawRestore = adapter.restoreTrustedState!.bind(adapter);
    const rawSubmit = adapter.submitAction.bind(adapter);
    const rawInteraction = adapter.submitInteraction?.bind(adapter);
    const rawClient = adapter.getEngineClient.bind(adapter);
    const client = rawClient();
    this.rawDispose = adapter.dispose.bind(adapter);
    this.history = new TrustedHistory({
      adapter: { exportPersistenceState: rawExport, restoreTrustedState: rawRestore, getSnapshot: rawSnapshot },
      isCurrent: binding => this.ownsSession() && binding.branchId === this.branch()
        && binding.generation === this.generation && binding.commitSeq === useGameStore.getState().lastCommittedSeq,
      isSessionCurrent: () => this.ownsSession(),
      submit: async (operation, parent) => {
        const request = this.request!;
        let result;
        try {
          if (request.kind === "action") result = await rawSubmit(request.action, operation.actor);
          else {
            if (!rawInteraction) throw new Error("Interaction unsupported");
            result = await rawInteraction(request.submission, operation.actor);
          }
        } catch (error) {
          // Only an engine-authored structured refusal proves no mutation.
          if (error instanceof AdapterError && isActionRejection(error.rejection)) return { status: "rejected" };
          throw error;
        }
        if (!this.ownsSession()) throw new Error("Retired Local history submission");
        this.events = result.events; this.logs = result.log_entries ?? [];
        this.pair = await rawSnapshot();
        return { status: "accepted", rootId: operation.rootId, parent, commitSeq: this.pair.seq };
      },
      commitAccepted: () => {
        if (!this.ownsSession() || !this.pair) return false;
        return useGameStore.getState().commitEngineSnapshot(this.pair, {
          localHistoryOwner: this.owner, events: this.events, logEntries: this.logs,
          extraState: { restoredStackAutomation: null },
        });
      },
      // The dedicated normal Worker serializes messages. This round-trip fences
      // all earlier submit/restore messages; failure never unlocks the session.
      fenceMutations: async () => { await rawSnapshot(); },
      commitRestore: snapshot => {
        if (!this.ownsSession() || !this.restoreDisplay) throw new Error("Retired Local history restore");
        const { settings, ...display } = this.restoreDisplay;
        const accepted = useGameStore.getState().commitEngineSnapshot(snapshot, {
          localHistoryOwner: this.owner,
          extraState: { ...display, stateHistory: [], restoredStackAutomation: null },
        });
        if (!accepted) throw new Error("Local history restore adoption failed");
        if (!this.ownsSession()) throw new Error("Retired Local history adoption");
        adoptLocalGameplayPreferences(this.adapter, this.session, snapshot.state, settings);
        if (!this.ownsSession()) throw new Error("Retired Local history settings adoption");
        abandonPendingDispatches();
        useAnimationStore.getState().clearQueue();
        const ui = useUiStore.getState();
        ui.clearSelectedCards(); ui.clearCombatSelection(); ui.setPendingAbilityChoice(null);
        ui.setMobileHandGesture(null); ui.resetDiceRoll(); ui.resetScryOutcome();
        this.generation++;
        return this.binding(snapshot.seq);
      },
    }, this.binding(initialSeq));
    for (const method of CLOSED_METHODS) {
      if (typeof (adapter as unknown as Record<string, unknown>)[method] !== "function") continue;
      Object.defineProperty(adapter, method, { value: () => { this.violation(); throw new Error("Unrecorded Local history mutation blocked"); } });
    }
    // Card-data read helpers call initialize internally. It may only confirm
    // this already-initialized executor; it never creates or resets a Worker.
    Object.defineProperty(adapter, "initialize", { value: async () => {
      if (!this.closed && rawClient() === client) return;
      throw new Error("Retired Local history adapter");
    } });
    Object.defineProperty(adapter, "dispose", { value: () => this.end() });
  }

  private branch(): string { return `local-${this.identity}-${this.generation}`; }
  private binding(commitSeq: number): HistoryBinding {
    return { gameId: this.gameId, gameSessionGeneration: this.session, branchId: this.branch(), generation: this.generation, commitSeq };
  }
  ownsSession(): boolean {
    const game = useGameStore.getState();
    return active === this && !this.closed && game.adapter === this.adapter
      && game.gameId === this.gameId && game.gameSessionGeneration === this.session && game.gameMode === "local";
  }
  private display(): Display {
    const game = useGameStore.getState();
    return { events: game.events, eventHistory: game.eventHistory, logHistory: game.logHistory, nextLogSeq: game.nextLogSeq,
      settings: localGameplayPresentation(this.adapter, this.session, game.gameState!),
    };
  }
  publish(): void {
    if (active !== this || useGameStore.getState().adapter !== this.adapter) return;
    const info = this.history.inspect();
    useGameStore.setState({ localHistory: {
      phase: this.closed ? "stopped" : this.busy ? info.phase === "recovery" ? "recovery" : "busy" : "idle",
      canUndo: !this.closed && !this.busy && info.cursor > 0,
      entries: info.cursor, notice: this.notice,
    } });
  }
  violation(): void {
    if (this.closed) return;
    this.notice = "blocked";
    this.closed = true; this.rawDispose(); this.publish();
  }

  async dispatch(request: Request, actor: number): Promise<DispatchOutcome> {
    if (!this.ownsSession() || this.busy || !useGameStore.getState().gameState) return { status: "blocked", events: [] };
    this.busy = true; this.notice = null; this.request = request;
    const rootId = `ui-${this.identity}-${++this.rootSerial}`, before = this.display();
    this.restoreDisplay = before; this.publish();
    try {
      const result = await this.history.perform({ rootId, actor });
      if (result === "accepted") {
        this.displays.set(rootId, before);
        const retained = new Set(this.history.inspect().entries.map(entry => entry.operation.rootId));
        for (const key of this.displays.keys()) if (!retained.has(key)) this.displays.delete(key);
        return { status: "accepted", events: this.events };
      }
      return { status: "rejected", events: [] };
    } catch {
      await this.recoverOrStop();
      return { status: "failed", events: [] };
    } finally {
      this.request = null; this.pair = null; this.events = []; this.logs = []; this.restoreDisplay = null;
      this.busy = false; this.publish(); this.releaseRetiredHistory();
    }
  }

  async undo(): Promise<void> {
    if (!this.ownsSession() || this.busy) return;
    const info = this.history.inspect();
    if (!info.cursor) return;
    this.busy = true; this.notice = null;
    this.restoreDisplay = this.displays.get(info.entries[info.cursor - 1].operation.rootId) ?? null;
    this.publish();
    try { await this.history.undo(); }
    catch { await this.recoverOrStop(); }
    finally { this.busy = false; this.restoreDisplay = null; this.publish(); this.releaseRetiredHistory(); }
  }

  private async recoverOrStop(): Promise<void> {
    if (!this.ownsSession()) return;
    if (this.history.inspect().phase !== "recovery") {
      this.notice = "notStarted";
      return;
    }
    this.publish();
    try { await this.history.recover(); this.notice = "rolledBack"; }
    catch { this.violation(); }
  }
  private releaseRetiredHistory(): void {
    if (this.closed && ["idle", "recovery"].includes(this.history.inspect().phase)) {
      this.history.dispose(); this.displays.clear();
    }
  }
  end(): void {
    if (!this.closed) { this.closed = true; this.rawDispose(); }
    if (active === this) active = null;
    this.releaseRetiredHistory();
  }
}
