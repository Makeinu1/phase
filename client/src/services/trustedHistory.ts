import type { EngineAdapter, EngineSnapshot, PlayerId } from "../adapter/types";
import {
  captureTrustedCheckpointString,
  releaseTrustedCheckpointString,
  restoreTrustedCheckpointString,
  type TrustedCheckpointString,
} from "./trustedCheckpointString";

export interface HistoryBinding {
  readonly gameId: string;
  readonly gameSessionGeneration: number;
  readonly branchId: string;
  /** Manager operation generation; a restore must invalidate pending authority. */
  readonly generation: number;
  readonly commitSeq: EngineSnapshot["seq"];
}

export interface HistoryOperation {
  readonly rootId: string;
  readonly actor: PlayerId;
}

export type HistoryAcceptance = { status: "rejected" } | {
  status: "accepted";
  rootId: string;
  parent: HistoryBinding;
  commitSeq: EngineSnapshot["seq"];
};

export interface HistoryPorts {
  adapter: Pick<EngineAdapter, "exportPersistenceState" | "restoreTrustedState" | "getSnapshot">;
  /** Must check session, branch, generation AND committed parent, not just gameId. */
  isCurrent(binding: HistoryBinding): boolean;
  /** Session/adapter ownership remains valid, including during partial-commit recovery. */
  isSessionCurrent(binding: HistoryBinding): boolean;
  /** Resolves only after the entire operation root has been accepted. Rejection is non-mutating. */
  submit(operation: HistoryOperation, parent: HistoryBinding): Promise<HistoryAcceptance>;
  /**
   * Synchronously adopt the corresponding engine snapshot before history changes.
   * False/throw may follow partial store effects: retain PRE and recovery lock.
   */
  commitAccepted(receipt: Extract<HistoryAcceptance, { status: "accepted" }>): boolean;
  /** Non-mutating preflight. No engine calls may occur here. */
  beforeRestore?(): Promise<void>;
  /** Drain/fence ALL previously submitted mutations. No old submit may mutate after resolution. */
  fenceMutations(): Promise<void>;
  /**
   * Synchronously commit this engine pair and invalidate old action/capability
   * authority. Return a fresh branch/generation. A throw may be partial: stay locked.
   * The port must permit retries after partial commit and never resume old authority.
   */
  commitRestore(snapshot: EngineSnapshot, previous: HistoryBinding): HistoryBinding;
  /** Allocation fault injection only, run before submit. No product budget default. */
  prepareStorage?(totalRetainedBytes: number): void;
}

interface Entry {
  checkpoint: TrustedCheckpointString;
  operation: Readonly<HistoryOperation>;
  parent: Readonly<HistoryBinding>;
  acceptedCommitSeq: number;
}

interface Recovery {
  checkpoint: TrustedCheckpointString;
  cursor: number;
  /** A pending PRE must be released after recovery; a historical PRE remains retained. */
  pending: boolean;
  commitAttempted: boolean;
}

function sameBinding(a: HistoryBinding, b: HistoryBinding): boolean {
  return a.gameId === b.gameId && a.gameSessionGeneration === b.gameSessionGeneration
    && a.branchId === b.branchId && a.generation === b.generation && a.commitSeq === b.commitSeq;
}

function copyBinding(binding: HistoryBinding): Readonly<HistoryBinding> {
  return Object.freeze({ gameId: binding.gameId, gameSessionGeneration: binding.gameSessionGeneration,
    branchId: binding.branchId, generation: binding.generation, commitSeq: binding.commitSeq });
}

/**
 * Isolated in-memory prototype. No dispatch, store, agreement or P2P hookup.
 * Callers group casting/payment/choices into operation roots; this class does
 * bookkeeping only and never derives game rules or reconstructs engine state.
 */
export class TrustedHistory {
  private entries: Entry[] = [];
  private cursor = 0;
  private binding: Readonly<HistoryBinding>;
  private phase: "idle" | "capture" | "submit" | "restore" | "recovery" | "disposed" = "idle";
  private canceled = false;
  private recovery: Recovery | null = null;
  private pendingBytes = 0;

  constructor(private readonly ports: HistoryPorts, binding: HistoryBinding, private readonly testByteBudget?: number) {
    if (testByteBudget !== undefined && (!Number.isSafeInteger(testByteBudget) || testByteBudget < 0)) {
      throw new Error("Invalid injected byte budget");
    }
    this.binding = copyBinding(binding);
  }

  inspect() {
    return {
      phase: this.phase,
      cursor: this.cursor,
      binding: this.binding,
      retainedBytes: this.entries.reduce((sum, entry) => sum + entry.checkpoint.bytes, 0) + this.pendingBytes,
      entries: this.entries.map(({ operation, parent, acceptedCommitSeq, checkpoint }) => ({
        operation, parent, acceptedCommitSeq, bytes: checkpoint.bytes,
      })),
    };
  }

  cancelPending(): void {
    if (this.phase === "capture" || this.phase === "submit") this.canceled = true;
  }

  private lock(phase: "capture" | "restore"): void {
    if (this.phase !== "idle") throw new Error("History locked");
    if (!this.ports.isCurrent(this.binding)) throw new Error("Stale history binding");
    this.phase = phase;
    this.canceled = false;
  }

  async perform(operation: HistoryOperation): Promise<"accepted" | "rejected" | "canceled"> {
    this.lock("capture");
    const parent = this.binding;
    let checkpoint: TrustedCheckpointString | null = null;
    let submitted = false;
    let commitAttempted = false;
    try {
      const root = Object.freeze({ rootId: operation.rootId, actor: operation.actor });
      if (!root.rootId || this.entries.some((entry) => entry.operation.rootId === root.rootId
        && entry.parent.branchId === parent.branchId)) throw new Error("Duplicate operation root");
      checkpoint = await captureTrustedCheckpointString(this.ports.adapter);
      this.pendingBytes = checkpoint.bytes;
      if (this.canceled) return "canceled";
      if (!this.ports.isCurrent(parent)) throw new Error("Stale capture");
      const totalBytes = this.inspect().retainedBytes;
      if (this.testByteBudget !== undefined && totalBytes > this.testByteBudget) throw new Error("Injected history budget exceeded");
      // Both the entry and replacement array exist before the engine may change.
      const candidate: Entry = { checkpoint, operation: root, parent, acceptedCommitSeq: 0 };
      const nextEntries = [...this.entries.slice(0, this.cursor), candidate];
      const future = this.entries.slice(this.cursor);
      this.ports.prepareStorage?.(totalBytes);
      if (this.canceled) return "canceled";
      if (!this.ports.isCurrent(parent)) throw new Error("Stale reservation");
      this.phase = "submit";
      submitted = true;
      const receipt = await this.ports.submit(root, parent);
      if (receipt.status === "rejected") return "rejected";
      if (this.canceled || !this.ports.isCurrent(parent) || receipt.rootId !== root.rootId
        || !sameBinding(receipt.parent, parent) || !Number.isSafeInteger(receipt.commitSeq)
        || receipt.commitSeq <= parent.commitSeq) throw new Error("Stale or invalid acceptance");
      const nextBinding = copyBinding({ ...parent, commitSeq: receipt.commitSeq });
      candidate.acceptedCommitSeq = receipt.commitSeq;
      commitAttempted = true;
      if (this.ports.commitAccepted(receipt) !== true) throw new Error("Accepted snapshot adoption failed");
      if (this.canceled || !this.ports.isSessionCurrent(nextBinding) || !this.ports.isCurrent(nextBinding)) {
        throw new Error("Stale adopted snapshot");
      }
      this.entries = nextEntries;
      this.cursor = nextEntries.length;
      this.binding = nextBinding;
      for (const entry of future) releaseTrustedCheckpointString(entry.checkpoint);
      checkpoint = null; // Ownership transferred exactly once to the retained entry.
      return "accepted";
    } catch (error) {
      if (submitted && checkpoint) {
        // A throw or stale acceptance can follow an engine mutation. Roll back to
        // the captured PRE with fresh authority; never unlock using the old cursor.
        this.recovery = { checkpoint, cursor: this.cursor, pending: true, commitAttempted };
        checkpoint = null;
        this.phase = "recovery";
      }
      throw error;
    } finally {
      if (checkpoint) releaseTrustedCheckpointString(checkpoint);
      if (this.phase !== "recovery") {
        this.pendingBytes = 0;
        this.phase = "idle";
      }
    }
  }

  async undo(): Promise<void> {
    this.lock("restore");
    if (this.cursor === 0) { this.phase = "idle"; throw new Error("No history"); }
    const entry = this.entries[this.cursor - 1];
    try {
      await this.ports.beforeRestore?.();
      if (!this.ports.isCurrent(this.binding)) throw new Error("Stale restore preflight");
    } catch (error) {
      this.phase = "idle";
      throw error;
    }
    this.recovery = { checkpoint: entry.checkpoint, cursor: this.cursor - 1, pending: false, commitAttempted: false };
    await this.finishRestore();
  }

  /** Retry the known PRE after uncertain mutation/commit; success always mints fresh authority. */
  async recover(): Promise<void> {
    if (this.phase !== "recovery") throw new Error("No recovery pending");
    this.phase = "restore";
    await this.finishRestore();
  }

  private async finishRestore(): Promise<void> {
    const recovery = this.recovery!;
    const previous = this.binding;
    try {
      await this.ports.fenceMutations();
      if (!this.ports.isSessionCurrent(previous)) throw new Error("Stale restore session");
      if (!recovery.commitAttempted && !this.ports.isCurrent(previous)) throw new Error("Stale restore binding");
      await restoreTrustedCheckpointString(this.ports.adapter, recovery.checkpoint,
        () => this.ports.isSessionCurrent(previous)
          && (recovery.commitAttempted || this.ports.isCurrent(previous)));
      const snapshot = await this.ports.adapter.getSnapshot();
      if (!this.ports.isSessionCurrent(previous)
        || (!recovery.commitAttempted && !this.ports.isCurrent(previous))) throw new Error("Stale restore result");
      recovery.commitAttempted = true;
      const fresh = this.ports.commitRestore(snapshot, previous);
      if (fresh.gameId !== previous.gameId || fresh.gameSessionGeneration !== previous.gameSessionGeneration
        || fresh.branchId === previous.branchId || !Number.isSafeInteger(fresh.generation) || fresh.generation <= previous.generation
        || !Number.isSafeInteger(fresh.commitSeq) || fresh.commitSeq !== snapshot.seq || fresh.commitSeq <= previous.commitSeq) {
        throw new Error("Restore commit did not invalidate old authority");
      }
      const adopted = copyBinding(fresh);
      if (!this.ports.isSessionCurrent(adopted) || !this.ports.isCurrent(adopted)) {
        throw new Error("Stale adopted restore");
      }
      this.binding = adopted;
      this.cursor = recovery.cursor;
      if (recovery.pending) releaseTrustedCheckpointString(recovery.checkpoint);
      this.pendingBytes = 0;
      this.recovery = null;
      this.phase = "idle";
    } catch (error) {
      this.phase = "recovery";
      throw error;
    }
  }

  /** Only after the owning session is torn down; cannot dispose an in-flight engine operation. */
  dispose(): void {
    if (this.phase !== "idle" && this.phase !== "recovery") throw new Error("History locked");
    if (this.ports.isSessionCurrent(this.binding)) throw new Error("Owning session still active");
    for (const entry of this.entries) releaseTrustedCheckpointString(entry.checkpoint);
    if (this.recovery?.pending) releaseTrustedCheckpointString(this.recovery.checkpoint);
    this.entries = [];
    this.recovery = null;
    this.cursor = 0;
    this.pendingBytes = 0;
    this.phase = "disposed";
  }
}
