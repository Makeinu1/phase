import type { EngineAdapter, EngineSnapshot, GameAction, GameEvent, GameLogEntry, ViewerSnapshot, ViewerTransitionSnapshot } from "../adapter/types";
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
  session: number;
  seat: number;
  seatGeneration: number;
  concealed: boolean;
  viewerReady: boolean;
}

type Display = Pick<ReturnType<typeof useGameStore.getState>, "events" | "eventHistory" | "logHistory" | "nextLogSeq"> & { settings: LocalGameplayPresentation };
type Displays = Map<number, Display>;
export interface LocalSeatBinding { readonly session: LocalHistorySession; readonly seat: number; readonly generation: number }

export function captureLocalSeat(): LocalSeatBinding | null { return active?.seatBinding() ?? null; }
export function isLocalSeatCurrent(binding: LocalSeatBinding | null | undefined): boolean {
  return active ? active.acceptsSeat(binding) : binding == null;
}

type Request = { kind: "action"; action: GameAction } | { kind: "interaction"; submission: InteractionSubmission };
type DispatchOutcome = { status: "accepted" | "rejected" | "blocked" | "failed"; events: GameEvent[] };
type WorkerAdapter = EngineAdapter & {
  getEngineClient(): unknown;
  getViewerSnapshot(viewer: number): Promise<ViewerSnapshot>;
  getViewerTransitionSnapshot(viewer: number, events: GameEvent[]): Promise<ViewerTransitionSnapshot>;
};

/** Only an engine-authored public log may cross this local display boundary. */
export const publicLocalLogs = (entries: GameLogEntry[] = []): GameLogEntry[] =>
  entries.filter(entry => entry.presentation?.visibility === "Public");

export async function initialLocalViewer(adapter: EngineAdapter, seq: number): Promise<EngineSnapshot> {
  const worker = adapter as WorkerAdapter;
  if (!worker.getViewerSnapshot || !worker.getViewerTransitionSnapshot) throw new Error("Local history requires engine viewer snapshots");
  return viewerPair(await worker.getViewerSnapshot(0), seq);
}
function viewerPair(viewer: ViewerSnapshot, seq: number): EngineSnapshot {
  const { state, ...legalResult } = viewer;
  return { state, legalResult, seq };
}

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
    || !adapter.exportPersistenceState || !adapter.restoreTrustedState
    || !workerAdapter.getViewerSnapshot || !workerAdapter.getViewerTransitionSnapshot) {
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
  private restoreDisplay: Displays | null = null;
  private readonly displays = new Map<string, Displays>();
  private seatDisplays: Displays = new Map();
  private seat = 0;
  private seatGeneration = 1;
  private concealed = false;
  private viewerReady = true;
  private readonly readViewer: WorkerAdapter["getViewerSnapshot"];
  private readonly history: TrustedHistory;
  private readonly rawDispose: () => void;

  constructor(readonly adapter: WorkerAdapter, initialSeq: number) {
    const game = useGameStore.getState();
    if (!game.gameId || game.adapter !== adapter) throw new Error("Local history session not initialized");
    this.gameId = game.gameId;
    this.session = game.gameSessionGeneration;
    const rawSnapshot = adapter.getSnapshot.bind(adapter);
    this.readViewer = adapter.getViewerSnapshot.bind(adapter);
    const readTransition = adapter.getViewerTransitionSnapshot.bind(adapter);
    const selectedSnapshot = async () => {
      const canonical = await rawSnapshot();
      const binding = this.seatBinding();
      const viewer = await this.readViewer(binding.seat);
      if (!this.ownsSeat(binding)) throw new Error("Retired Local viewer read");
      return viewerPair(viewer, canonical.seq);
    };
    const rawExport = adapter.exportPersistenceState!.bind(adapter);
    const rawRestore = adapter.restoreTrustedState!.bind(adapter);
    const rawSubmit = adapter.submitAction.bind(adapter);
    const rawInteraction = adapter.submitInteraction?.bind(adapter);
    const rawClient = adapter.getEngineClient.bind(adapter);
    const client = rawClient();
    this.rawDispose = adapter.dispose.bind(adapter);
    this.history = new TrustedHistory({
      adapter: { exportPersistenceState: rawExport, restoreTrustedState: rawRestore, getSnapshot: selectedSnapshot },
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
        const canonical = await rawSnapshot();
        const binding = this.seatBinding();
        const viewer = await readTransition(binding.seat, result.events);
        if (!this.ownsSeat(binding)) throw new Error("Retired Local transition read");
        this.events = viewer.events; this.logs = publicLocalLogs(result.log_entries);
        this.pair = viewerPair(viewer, canonical.seq);
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
        this.seatDisplays = new Map(this.restoreDisplay);
        const { settings, ...display } = this.displayForSeat(snapshot.state);
        const accepted = useGameStore.getState().commitEngineSnapshot(snapshot, {
          localHistoryOwner: this.owner,
          extraState: { ...display, stateHistory: [], restoredStackAutomation: null },
        });
        if (!accepted) throw new Error("Local history restore adoption failed");
        if (!this.ownsSession()) throw new Error("Retired Local history adoption");
        adoptLocalGameplayPreferences(this.adapter, this.session, snapshot.state, settings, this.seatBinding());
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
  seatBinding(): LocalSeatBinding { return { session: this, seat: this.seat, generation: this.seatGeneration }; }
  ownsSeat(binding: LocalSeatBinding): boolean {
    return this.ownsSession() && binding.session === this && binding.seat === this.seat && binding.generation === this.seatGeneration;
  }
  acceptsSeat(binding: LocalSeatBinding | null | undefined): boolean {
    return !!binding && this.ownsSeat(binding) && this.viewerReady && !this.concealed;
  }
  private displayForSeat(state: EngineSnapshot["state"]): Display {
    return this.seatDisplays.get(this.seat) ?? {
      events: [], eventHistory: [], logHistory: [], nextLogSeq: 0,
      settings: { priorityPassingMode: state.priority_passing_modes?.[this.seat] ?? "Standard", fullControl: false },
    };
  }
  private captureDisplay(): Displays {
    this.seatDisplays.set(this.seat, this.display());
    return new Map(this.seatDisplays);
  }
  private clearSeatUi(): void {
    abandonPendingDispatches(); useAnimationStore.getState().clearQueue();
    const ui = useUiStore.getState();
    ui.dismissPreview(); ui.selectObject(null); ui.hoverObject(null); ui.setCombatClickHandler(null);
    ui.setDragging(false); ui.setShiftHeld(false); ui.closeCardReportDialog();
    ui.clearSelectedCards(); ui.clearCombatSelection(); ui.setPendingAbilityChoice(null);
    ui.setEnchantmentsDialogPlayer(null); ui.setAttachmentFanHost(null); ui.setMobileHandGesture(null);
    ui.resetDiceRoll(); ui.resetScryOutcome(); ui.setManualManaOverride(false); ui.setHandFilter("none");
    useUiStore.setState({ mobileHandOpen: false, debugContextMenu: null, debugLibraryViewer: null, debugPanelOpen: false });
  }
  /** Explicit display handoff: no engine submission, checkpoint, or cursor advance. */
  async handoff(seat: number, binding: LocalSeatBinding): Promise<void> {
    const game = useGameStore.getState();
    if (!this.acceptsSeat(binding) || this.busy || !game.gameState || seat === this.seat
      || !Number.isInteger(seat) || !game.gameState.players[seat]) return;
    this.captureDisplay(); this.busy = true; this.concealed = true; this.viewerReady = false;
    this.seat = seat; this.seatGeneration++; this.notice = null; this.clearSeatUi(); this.publish();
    const target = this.seatBinding(), seq = game.lastCommittedSeq;
    try {
      const viewer = await this.readViewer(seat);
      if (!this.ownsSeat(target)) return;
      const { settings, ...display } = this.displayForSeat(viewer.state);
      if (!useGameStore.getState().commitEngineSnapshot(viewerPair(viewer, seq), {
        localHistoryOwner: this.owner, extraState: { ...display, restoredStackAutomation: null },
      })) throw new Error("Local viewer adoption failed");
      if (!this.ownsSeat(target)) return;
      adoptLocalGameplayPreferences(this.adapter, this.session, viewer.state, settings, target);
      if (!this.ownsSeat(target)) return;
      this.viewerReady = true;
    } catch { if (this.ownsSeat(target)) this.violation(); }
    finally { if (this.ownsSeat(target)) { this.busy = false; this.publish(); } }
  }
  reveal(binding: LocalSeatBinding): void {
    if (!this.ownsSeat(binding) || this.busy || !this.viewerReady || !this.concealed) return;
    this.concealed = false; this.publish();
  }
  private display(): Display {
    const game = useGameStore.getState();
    return { events: game.events, eventHistory: game.eventHistory, logHistory: game.logHistory, nextLogSeq: game.nextLogSeq,
      settings: localGameplayPresentation(this.adapter, this.session, game.gameState!, this.seatBinding()),
    };
  }
  publish(): void {
    if (active !== this || useGameStore.getState().adapter !== this.adapter) return;
    const info = this.history.inspect();
    useGameStore.setState({ localHistory: {
      phase: this.closed ? "stopped" : this.busy ? info.phase === "recovery" ? "recovery" : "busy" : "idle",
      canUndo: !this.closed && !this.busy && !this.concealed && this.viewerReady && info.cursor > 0,
      entries: info.cursor, notice: this.notice, session: this.identity, seat: this.seat, seatGeneration: this.seatGeneration,
      concealed: this.concealed, viewerReady: this.viewerReady,
    } });
  }
  violation(): void {
    if (this.closed) return;
    this.notice = "blocked";
    this.closed = true; this.rawDispose(); this.publish();
  }

  async dispatch(request: Request, actor: number, seatBinding?: LocalSeatBinding | null): Promise<DispatchOutcome> {
    if (!this.acceptsSeat(seatBinding) || actor !== this.seat || this.busy || !useGameStore.getState().gameState) return { status: "blocked", events: [] };
    this.busy = true; this.notice = null; this.request = request;
    const rootId = `ui-${this.identity}-${++this.rootSerial}`, before = this.captureDisplay();
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

  async undo(binding?: LocalSeatBinding | null): Promise<void> {
    if (!this.acceptsSeat(binding) || this.busy) return;
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
