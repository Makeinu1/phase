import type { PeerSession } from "../network/peer";
import type { P2PAuthorityStamp } from "../services/p2pSession";
import { hasExactP2PAuthority } from "../services/p2pSession";
import type { P2PUndoSyncMetadata } from "../network/protocol";

export type UndoSyncPhase = P2PUndoSyncMetadata["phase"];

export interface UndoSyncBinding {
  /** The exact live transport session captured when this barrier is created. */
  session: PeerSession;
  /** The host lease stamp accepted for this game session. */
  authority: P2PAuthorityStamp;
  /** Re-checks the owning adapter's current-session map and authority lease. */
  isCurrent(): boolean;
  /** Called only when the held/unheld state changes. */
  setInputBlocked(blocked: boolean): void;
}

export interface UndoSyncHostOptions extends UndoSyncBinding {
  /** Sends a normal filtered `state_update` tagged with this phase. */
  sendPhase(metadata: P2PUndoSyncMetadata): Promise<boolean>;
  /** Surfaces an uncertain post-restore failure; callers must tear down. */
  onFatalFailure(error: Error): void;
}

interface HostTransaction {
  metadata: P2PUndoSyncMetadata;
  stage: "restoring" | "adopted" | "released";
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  fatalFailureReported: boolean;
}

/**
 * Host-side half of the opt-in Undo adoption barrier. The checkpoint remains
 * in the caller's trusted local closure; only phase metadata is sent.
 */
export class UndoSyncHostBarrier {
  private revision = 0;
  private active: HostTransaction | null = null;
  private completed: P2PUndoSyncMetadata | null = null;
  private inputBlocked = false;

  constructor(private readonly options: UndoSyncHostOptions) {}

  begin(undoId: string, restoreAndAdopt: () => Promise<void>): Promise<void> {
    if (!isValidUndoId(undoId)) return Promise.reject(new Error("Invalid undoId"));
    if (this.active) {
      return this.active.metadata.undoId === undoId
        ? this.active.promise
        : Promise.reject(new Error("An Undo synchronization is already active"));
    }
    if (this.completed?.undoId === undoId) return Promise.resolve();
    if (!this.options.isCurrent()) return Promise.reject(new Error("Undo peer session is no longer current"));
    if (!Number.isSafeInteger(this.revision + 1)) return Promise.reject(new Error("Undo revision exhausted"));

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const transaction: HostTransaction = {
      metadata: { undoId, revision: ++this.revision, phase: "adopted" },
      stage: "restoring",
      promise: completion,
      resolve,
      reject,
      fatalFailureReported: false,
    };
    this.active = transaction;
    this.setInputBlocked(true);
    void this.restoreThenPublish(transaction, restoreAndAdopt);
    return completion;
  }

  /** Accepts only an exact ACK from the currently authenticated guest session. */
  async receiveAck(
    session: PeerSession,
    authority: P2PAuthorityStamp | undefined,
    metadata: P2PUndoSyncMetadata | undefined,
  ): Promise<boolean> {
    if (!this.isBound(session, authority) || !isValidUndoSyncMetadata(metadata)) return false;
    const active = this.active;
    if (!active) {
      // A duplicate released ACK is harmless. It cannot complete a later turn.
      return sameTransaction(this.completed, metadata) && metadata.phase === "released";
    }
    if (active.fatalFailureReported) return false;
    if (!sameTransaction(active.metadata, metadata)) return false;

    if (metadata.phase === "adopted") {
      if (active.stage === "restoring") return false;
      if (active.stage === "released") {
        // Re-deliver the same release phase if a duplicate adoption ACK arrives.
        return this.publish(active, "released");
      }
      active.stage = "released";
      return this.publish(active, "released");
    }

    if (active.stage !== "released") return false;
    this.completed = { ...active.metadata, phase: "released" };
    this.active = null;
    this.setInputBlocked(false);
    active.resolve();
    return true;
  }

  get isInputBlocked(): boolean {
    return this.inputBlocked;
  }

  /** Fails a pending transaction when its bound transport session ends. */
  cancel(reason = new Error("Undo peer session ended")): void {
    const active = this.active;
    this.active = null;
    this.setInputBlocked(false);
    active?.reject(reason);
  }

  private async restoreThenPublish(
    transaction: HostTransaction,
    restoreAndAdopt: () => Promise<void>,
  ): Promise<void> {
    try {
      await restoreAndAdopt();
      if (this.active !== transaction) return;
      if (!this.options.isCurrent()) {
        this.failClosed(transaction, new Error("Undo host session or game state is no longer current"));
        return;
      }
      transaction.stage = "adopted";
      const sent = await this.options.sendPhase(transaction.metadata);
      if (!sent && this.active === transaction) {
        this.failClosed(transaction, new Error("Undo adoption phase could not reach the guest"));
      }
    } catch (error) {
      if (this.active === transaction) {
        this.failClosed(transaction, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async publish(transaction: HostTransaction, phase: UndoSyncPhase): Promise<boolean> {
    const metadata = { ...transaction.metadata, phase };
    try {
      const sent = await this.options.sendPhase(metadata);
      if (this.active === transaction && sent) transaction.metadata = metadata;
      if (!sent && this.active === transaction) {
        this.failClosed(transaction, new Error(`Undo ${phase} phase could not reach the guest`));
      }
      return sent;
    } catch (error) {
      if (this.active === transaction) {
        this.failClosed(transaction, error instanceof Error ? error : new Error(String(error)));
      }
      return false;
    }
  }

  private failClosed(transaction: HostTransaction, error: Error): void {
    transaction.reject(error);
    if (transaction.fatalFailureReported || this.active !== transaction) return;
    transaction.fatalFailureReported = true;
    this.options.onFatalFailure(error);
  }

  private isBound(session: PeerSession, authority: P2PAuthorityStamp | undefined): boolean {
    return session === this.options.session
      && this.options.isCurrent()
      && hasExactP2PAuthority(authority, this.options.authority);
  }

  private setInputBlocked(blocked: boolean): void {
    if (this.inputBlocked === blocked) return;
    this.inputBlocked = blocked;
    this.options.setInputBlocked(blocked);
  }
}

export interface UndoSyncGuestOptions extends UndoSyncBinding {
  /** Sends a normal `state_ack` carrying the exact accepted barrier phase. */
  sendAck(metadata: P2PUndoSyncMetadata, stateRevision: number): Promise<boolean>;
  /** Surfaces an uncertain UI/ACK failure; callers must tear down. */
  onFatalFailure(error: Error): void;
}

interface GuestTransaction {
  metadata: P2PUndoSyncMetadata;
  adopted: boolean;
  adoptionPromise: Promise<boolean> | null;
}

/** Guest-side half. Adoption is injected so the UI can acknowledge only after
 * its normal state commit has completed. */
export class UndoSyncGuestBarrier {
  private revision = 0;
  private active: GuestTransaction | null = null;
  private completed: P2PUndoSyncMetadata | null = null;
  private inputBlocked = false;

  constructor(private readonly options: UndoSyncGuestOptions) {}

  receivePhase(
    session: PeerSession,
    authority: P2PAuthorityStamp | undefined,
    metadata: P2PUndoSyncMetadata | undefined,
    stateRevision: number,
    adopt: () => Promise<void>,
  ): Promise<boolean> {
    if (
      !this.isBound(session, authority)
      || !isValidUndoSyncMetadata(metadata)
      || !Number.isSafeInteger(stateRevision)
      || stateRevision < 0
    ) {
      return Promise.resolve(false);
    }

    if (this.active) {
      if (!sameTransaction(this.active.metadata, metadata)) return Promise.resolve(false);
      if (metadata.phase === "adopted") {
        if (!this.active.adopted) return this.active.adoptionPromise ?? Promise.resolve(false);
        return this.options.sendAck(metadata, stateRevision);
      }
      if (!this.active.adopted) return Promise.resolve(false);
      return this.acknowledgeRelease(this.active, metadata, stateRevision);
    }

    if (sameTransaction(this.completed, metadata)) {
      // Duplicate delivery after completion re-ACKs without re-locking, adopting,
      // advancing the revision or invoking any completion callback.
      return this.options.sendAck(metadata, stateRevision);
    }

    if (metadata.phase !== "adopted" || metadata.revision !== this.revision + 1) {
      return Promise.resolve(false);
    }

    this.revision = metadata.revision;
    const transaction: GuestTransaction = {
      metadata,
      adopted: false,
      adoptionPromise: null,
    };
    this.active = transaction;
    this.setInputBlocked(true);
    transaction.adoptionPromise = this.adoptAndAcknowledge(transaction, stateRevision, adopt);
    return transaction.adoptionPromise;
  }

  get isInputBlocked(): boolean {
    return this.inputBlocked;
  }

  /** Drops a pending adoption when its bound host session ends. */
  cancel(): void {
    this.active = null;
    this.setInputBlocked(false);
  }

  private async adoptAndAcknowledge(
    transaction: GuestTransaction,
    stateRevision: number,
    adopt: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await adopt();
    } catch (error) {
      this.failClosed(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    if (this.active !== transaction || !this.options.isCurrent()) return false;
    transaction.adopted = true;
    try {
      const sent = await this.options.sendAck(transaction.metadata, stateRevision);
      if (!sent) this.failClosed(new Error("Undo adoption acknowledgement could not reach the host"));
      return sent;
    } catch (error) {
      this.failClosed(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private async acknowledgeRelease(
    transaction: GuestTransaction,
    metadata: P2PUndoSyncMetadata,
    stateRevision: number,
  ): Promise<boolean> {
    let sent: boolean;
    try {
      sent = await this.options.sendAck(metadata, stateRevision);
    } catch (error) {
      this.failClosed(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    if (!sent && this.active === transaction) {
      this.failClosed(new Error("Undo released acknowledgement could not reach the host"));
      return false;
    }
    if (this.active !== transaction || !this.options.isCurrent()) return sent;
    this.completed = { ...metadata };
    this.active = null;
    this.setInputBlocked(false);
    return true;
  }

  private failClosed(error: Error): void {
    if (!this.active) return;
    this.options.onFatalFailure(error);
  }

  private isBound(session: PeerSession, authority: P2PAuthorityStamp | undefined): boolean {
    return session === this.options.session
      && this.options.isCurrent()
      && hasExactP2PAuthority(authority, this.options.authority);
  }

  private setInputBlocked(blocked: boolean): void {
    if (this.inputBlocked === blocked) return;
    this.inputBlocked = blocked;
    this.options.setInputBlocked(blocked);
  }
}

export function isValidUndoSyncMetadata(value: unknown): value is P2PUndoSyncMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return Object.keys(metadata).length === 3
    && typeof metadata.undoId === "string"
    && isValidUndoId(metadata.undoId)
    && Number.isSafeInteger(metadata.revision)
    && (metadata.revision as number) > 0
    && (metadata.phase === "adopted" || metadata.phase === "released");
}

function isValidUndoId(undoId: string): boolean {
  return undoId.length > 0 && undoId.trim() === undoId;
}

function sameTransaction(
  left: P2PUndoSyncMetadata | null,
  right: P2PUndoSyncMetadata,
): boolean {
  return left !== null && left.undoId === right.undoId && left.revision === right.revision;
}
