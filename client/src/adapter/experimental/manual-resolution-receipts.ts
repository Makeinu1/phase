import type { InteractionId } from "../generated/interaction";
import type { PlayerId } from "../types.ts";
import type {
  ManualResolutionCommandBinding,
  ManualResolutionCommandPortFactory,
  ManualResolutionPortScope,
  ManualResolutionReconciliation,
  ManualResolutionRequest,
  ManualResolutionResult,
} from "../../components/sandbox/manual-resolution-ui-contract.ts";

/**
 * The admitted adapter attaches the real register/apply/lookup WASM boundary.
 * Private native custody validates the captured context immediately before
 * mutation and submits the original interaction ID through submit_interaction_js.
 * This coordinator retains immutable UI requests and defines no native JSON.
 *
 * A rejection must prove this exact submission was not applied. Receipt lookup
 * is read-only and receives the complete original request, including across a
 * same-timeline boundary replacement. It receives the identical frozen object
 * originally passed to submitCaptured. The boundary must retain its transport
 * attempt identity independently from the disposable worker RPC ID, since a fresh retry after terminal
 * rejection may have the same semantic values. Missing evidence or a stale-ID rejection
 * from replay is insufficient proof of nonapplication. Never replay on lookup.
 */
export interface ManualResolutionAtomicBoundary {
  submitCaptured(
    request: ManualResolutionRequest,
    authenticatedActor: PlayerId,
  ): Promise<ManualResolutionResult>;
  lookupReceipt(
    originalRequest: ManualResolutionRequest,
    authenticatedActor: PlayerId,
  ): Promise<ManualResolutionReconciliation>;
}

export type ManualResolutionPortFailure =
  | "actor-unavailable"
  | "wrong-player"
  | "source-mismatch"
  | "generation-mismatch"
  | "intent-conflict"
  | "attempt-identity-unknown"
  | "operation-unresolved"
  | "receipt-mismatch"
  | "delivery-unknown"
  | "lookup-unknown";

interface Attempt {
  readonly request: ManualResolutionRequest;
  readonly ambiguousBinding: boolean;
  delivery: Promise<ManualResolutionResult>;
  result?: ManualResolutionResult;
  lookup?: {
    readonly boundary: ManualResolutionAtomicBoundary;
    readonly promise: Promise<ManualResolutionReconciliation>;
  };
}

function freezeRequest(request: ManualResolutionRequest): ManualResolutionRequest {
  return Object.freeze({
    binding: Object.freeze({ ...request.binding }),
    command: Object.freeze({ ...request.command }),
  });
}

function sameBinding(a: ManualResolutionCommandBinding, b: ManualResolutionCommandBinding): boolean {
  return a.interactionId === b.interactionId && a.adapterGeneration === b.adapterGeneration;
}

function sameRequest(a: ManualResolutionRequest, b: ManualResolutionRequest): boolean {
  return sameBinding(a.binding, b.binding)
    && a.command.stackEntryId === b.command.stackEntryId
    && a.command.sourceObjectId === b.command.sourceObjectId
    && (a.command.type === "finish"
      ? b.command.type === "finish"
      : b.command.type === "lose-life"
        && a.command.affectedPlayerId === b.command.affectedPlayerId
        && a.command.amount === b.command.amount);
}

function asReconciliation(result: ManualResolutionResult): ManualResolutionReconciliation {
  switch (result.status) {
    case "completed": return { binding: result.binding, status: "completed" };
    case "rejected": return { binding: result.binding, status: "not-applied", reason: result.reason };
    case "indeterminate": return { binding: result.binding, status: "indeterminate", reason: result.reason };
  }
}

/**
 * Client receipt coordination, separately testable from native serialization.
 * Create once per authenticated timeline, preserving it across port/generation
 * replacements. A new session is allowed only for a new authenticated context
 * or a revoking public reset/restore; a same-owner trusted rekey preserves it. Ordinary snapshots and adapter replacement must not discard
 * an unresolved attempt. Callers retain the original immutable request for
 * reconciliation; a fresh click after known rejection creates a new request
 * instance. Reusing the original instance only reads its original receipt.
 * The actor is captured here, never supplied by UI.
 * Failure text is injected so the eventual host can supply translated chrome.
 */
export function createManualResolutionReceiptSession({
  authenticatedActor,
  describeFailure,
}: {
  authenticatedActor: PlayerId | null;
  describeFailure: (failure: ManualResolutionPortFailure) => string;
}): {
  bindBoundary: (boundary: ManualResolutionAtomicBoundary) => ManualResolutionCommandPortFactory;
} {
  const receiptSessionIdentity = Object.freeze({});
  const attempts = new Map<number, Map<InteractionId, Attempt>>();
  const requestAttempts = new WeakMap<ManualResolutionRequest, Attempt>();
  const find = (request: ManualResolutionRequest) =>
    attempts.get(request.binding.adapterGeneration)?.get(request.binding.interactionId);
  const reject = (request: ManualResolutionRequest, failure: ManualResolutionPortFailure): ManualResolutionResult =>
    Object.freeze({ binding: request.binding, status: "rejected", reason: describeFailure(failure) });
  const unknown = (request: ManualResolutionRequest, failure: ManualResolutionPortFailure): ManualResolutionResult =>
    Object.freeze({ binding: request.binding, status: "indeterminate", reason: describeFailure(failure) });
  const actorFailure = (request: ManualResolutionRequest): ManualResolutionPortFailure | null =>
    authenticatedActor === null
      ? "actor-unavailable"
      : request.command.type === "lose-life" && request.command.affectedPlayerId !== authenticatedActor
        ? "wrong-player" : null;
  const remember = (attempt: Attempt, result: ManualResolutionResult): ManualResolutionResult => {
    // Original terminal evidence stays authoritative over any later partial answer.
    if (attempt.result && attempt.result.status !== "indeterminate") return attempt.result;
    attempt.result = sameBinding(attempt.request.binding, result.binding)
      ? Object.freeze({ ...result, binding: attempt.request.binding })
      : unknown(attempt.request, "receipt-mismatch");
    return attempt.result;
  };
  const unresolved = () => [...attempts.values()].flatMap((byId) => [...byId.values()])
    .find((attempt) => !attempt.result || attempt.result.status === "indeterminate");
  const record = (attempt: Attempt) => {
    const generation = attempt.request.binding.adapterGeneration;
    let byId = attempts.get(generation);
    if (!byId) {
      byId = new Map();
      attempts.set(generation, byId);
    }
    byId.set(attempt.request.binding.interactionId, attempt);
  };

  return {
    bindBoundary: (boundary) => (scope: ManualResolutionPortScope) => {
      const capturedScope = Object.freeze({ ...scope });
      return {
        receiptSessionIdentity,
        getUnresolvedManualResolutionRequest: () => unresolved()?.request ?? null,
        submitManualResolutionCommand: (input) => {
          const request = freezeRequest(input);
          const originalAttempt = requestAttempts.get(input);
          if (originalAttempt) {
            if (!sameRequest(originalAttempt.request, request)) {
              return Promise.resolve(unknown(request, "intent-conflict"));
            }
            return originalAttempt.result ? Promise.resolve(originalAttempt.result) : originalAttempt.delivery;
          }
          const invalidActor = actorFailure(request);
          if (invalidActor) return Promise.resolve(reject(request, invalidActor));
          if (request.command.stackEntryId !== capturedScope.stackEntryId
            || request.command.sourceObjectId !== capturedScope.sourceObjectId) {
            return Promise.resolve(reject(request, "source-mismatch"));
          }
          const existing = find(request);
          if (existing && existing.result?.status !== "rejected") {
            if (existing.ambiguousBinding) {
              return Promise.resolve(unknown(request, "attempt-identity-unknown"));
            }
            if (!sameRequest(existing.request, request)) {
              return Promise.resolve(reject(request, "intent-conflict"));
            }
            requestAttempts.set(input, existing);
            return existing.result ? Promise.resolve(existing.result) : existing.delivery;
          }
          if (request.binding.adapterGeneration !== capturedScope.adapterGeneration) {
            return Promise.resolve(reject(request, "generation-mismatch"));
          }
          // A different frame/source does not erase an earlier uncertain operation.
          if (unresolved()) return Promise.resolve(reject(request, "operation-unresolved"));
          if (authenticatedActor === null) return Promise.resolve(reject(request, "actor-unavailable"));
          const attempt: Attempt = {
            request,
            ambiguousBinding: existing !== undefined,
            // Defer boundary entry until the attempt is registered. Even a
            // synchronous reentrant call therefore shares this delivery.
            delivery: Promise.resolve().then(() => boundary.submitCaptured(request, authenticatedActor))
              .then((result) => remember(attempt, result))
              .catch(() => remember(attempt, unknown(request, "delivery-unknown"))),
          };
          record(attempt);
          requestAttempts.set(input, attempt);
          requestAttempts.set(request, attempt);
          return attempt.delivery;
        },
        reconcileManualResolution: (input) => {
          const request = freezeRequest(input);
          const invalidActor = actorFailure(request);
          if (invalidActor || authenticatedActor === null) {
            return Promise.resolve(asReconciliation(unknown(request, invalidActor ?? "actor-unavailable")));
          }
          const originalAttempt = requestAttempts.get(input);
          let attempt = originalAttempt ?? find(request);
          if (!originalAttempt && attempt?.ambiguousBinding) {
            return Promise.resolve(asReconciliation(unknown(request, "attempt-identity-unknown")));
          }
          if (attempt && !sameRequest(attempt.request, request)) {
            return Promise.resolve(asReconciliation(unknown(request, "intent-conflict")));
          }
          if (!attempt) {
            // Absence from client memory is not proof that nothing was applied.
            const result = unknown(request, "lookup-unknown");
            attempt = { request, ambiguousBinding: false, result, delivery: Promise.resolve(result) };
            record(attempt);
            requestAttempts.set(request, attempt);
          }
          requestAttempts.set(input, attempt);
          if (attempt.result && attempt.result.status !== "indeterminate") {
            return Promise.resolve(asReconciliation(attempt.result));
          }
          if (attempt.lookup?.boundary === boundary) return attempt.lookup.promise;
          const original = attempt;
          const promise = Promise.resolve().then(() => boundary.lookupReceipt(original.request, authenticatedActor))
            .then((receipt) => {
              if (receipt.status === "pending") {
                if (!sameBinding(original.request.binding, receipt.binding)) {
                  return asReconciliation(remember(original, unknown(original.request, "receipt-mismatch")));
                }
                if (original.result && original.result.status !== "indeterminate") return asReconciliation(original.result);
                return { binding: original.request.binding, status: "pending" } as const;
              }
              const result: ManualResolutionResult = receipt.status === "not-applied"
                ? { binding: receipt.binding, status: "rejected", reason: receipt.reason ?? describeFailure("lookup-unknown") }
                : receipt.status === "completed"
                  ? { binding: receipt.binding, status: "completed" }
                  : { binding: receipt.binding, status: "indeterminate", reason: receipt.reason ?? describeFailure("lookup-unknown") };
              return asReconciliation(remember(original, result));
            })
            .catch(() => asReconciliation(remember(original, unknown(original.request, "lookup-unknown"))));
          original.lookup = { boundary, promise };
          const clearLookup = () => {
            if (original.lookup?.promise === promise) original.lookup = undefined;
          };
          void promise.then(clearLookup, clearLookup);
          return promise;
        },
      };
    },
  };
}
