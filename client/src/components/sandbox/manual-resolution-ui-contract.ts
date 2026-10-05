import type { ObjectId, PlayerId } from "../../adapter/types.ts";
import type { InteractionId } from "../../adapter/generated/interaction";

/**
 * UI context for one paused resolution. `episodeId` only fences React UI state;
 * it is not an engine or native action identity.
 */
export interface ManualResolutionSourceContext {
  episodeId: string;
  /** Current GameState stack occurrence; an adapter maps it to its published native identity. */
  stackEntryId: ObjectId;
  /** Current GameState source object; an adapter maps it to its published native identity. */
  sourceObjectId: ObjectId;
}

/** Source references included in each command so an adapter can map the exact paused occurrence. */
export type ManualResolutionSourceReference = Pick<
  ManualResolutionSourceContext,
  "stackEntryId" | "sourceObjectId"
>;

/** Client-side authority fence paired with the interaction shown to the user. */
export interface ManualResolutionCommandBinding {
  readonly interactionId: InteractionId;
  /** Adapter-owned context generation; it is not sent to the native action. */
  readonly adapterGeneration: number;
}

/** Semantic life-loss operation for the experimental UI seam. */
export interface ManualLifeLossCommand extends ManualResolutionSourceReference {
  type: "lose-life";
  affectedPlayerId: PlayerId;
  amount: number;
}

/** Explicitly finish the same source occurrence after the native frame allows it. */
export interface FinishManualResolutionCommand extends ManualResolutionSourceReference {
  type: "finish";
}

export type ManualResolutionUiCommand =
  | ManualLifeLossCommand
  | FinishManualResolutionCommand;

/** Immutable intent captured from one displayed authoritative frame. */
export interface ManualResolutionRequest {
  readonly binding: ManualResolutionCommandBinding;
  readonly command: Readonly<ManualResolutionUiCommand>;
}

/**
 * `rejected` means the port has terminal proof that this exact bound attempt
 * was not applied. A stale-ID rejection from replaying an earlier uncertain
 * attempt does not establish that fact.
 * `indeterminate` means delivery may have applied and must be reconciled before
 * the UI permits another operation.
 */
export type ManualResolutionResult =
  | { binding: ManualResolutionCommandBinding; status: "completed" }
  | { binding: ManualResolutionCommandBinding; status: "rejected"; reason: string }
  | { binding: ManualResolutionCommandBinding; status: "indeterminate"; reason: string };

/** Authoritative lookup for the exact frozen request, not merely its source. */
export type ManualResolutionReconciliation =
  | { binding: ManualResolutionCommandBinding; status: "completed" }
  | { binding: ManualResolutionCommandBinding; status: "not-applied"; reason?: string }
  | { binding: ManualResolutionCommandBinding; status: "indeterminate"; reason?: string };

/** Native frame availability and action-domain bounds; callers must not invent defaults. */
export interface ManualResolutionOperationAvailability {
  available: boolean;
  amountBounds: {
    minimum: number;
    /** `null` means the published native operation has no upper bound. */
    maximum: number | null;
  };
}

/** Adapter-local identity for one authenticated source context. */
export interface ManualResolutionPortScope extends ManualResolutionSourceReference {
  adapterGeneration: number;
}

/**
 * A command port is created from the authenticated session context and bound
 * to one source occurrence and adapter generation. It closes over the session
 * actor; UI components do not pass an actor ID. The command binding carries
 * the existing interaction ID shown by the authoritative frame plus this
 * client-side adapter generation. Neither becomes a native action field.
 *
 * The adapter must atomically validate the captured binding at its serialized
 * mutation boundary and use the captured interaction ID. It must not read a
 * newer ID and silently retarget a stale click. A port stays stable when an
 * accepted action advances the interaction ID. Its receipt identifies the
 * original binding, even when the displayed frame has advanced. Reconcile
 * receives the complete original request and returns evidence for that
 * request, or remains indeterminate; stale-ID rejection alone is not proof
 * that an earlier attempt was not applied. A port replacement may recover an
 * old request, but must not map it to a fresh interaction ID.
 *
 * `sourceObjectId` and `affectedPlayerId` are UI mapping inputs: the adapter
 * validates them against the paused frame and maps only fields in the
 * published native action. `episodeId`, the binding, and adapter generation
 * are never native action fields. This contract does not assert that the
 * unpublished native action has matching fields.
 */
export interface ManualResolutionCommandPort {
  submitManualResolutionCommand(
    request: ManualResolutionRequest,
  ): Promise<ManualResolutionResult>;
  /** Reconciles this exact request, including across a same-timeline port replacement. */
  reconcileManualResolution(
    originalRequest: ManualResolutionRequest,
  ): Promise<ManualResolutionReconciliation>;
}

/** The factory is owned by an authenticated session context and binds its actor. */
export type ManualResolutionCommandPortFactory = (
  scope: ManualResolutionPortScope,
) => ManualResolutionCommandPort;
