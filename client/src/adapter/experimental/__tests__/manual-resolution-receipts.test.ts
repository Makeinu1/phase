import { describe, expect, it, vi } from "vitest";

import type { InteractionId } from "../../generated/interaction";
import type {
  ManualLifeLossCommand,
  ManualResolutionPortScope,
  ManualResolutionReconciliation,
  ManualResolutionRequest,
  ManualResolutionResult,
} from "../../../components/sandbox/manual-resolution-ui-contract.ts";
import {
  createManualResolutionReceiptSession,
  type ManualResolutionAtomicBoundary,
} from "../manual-resolution-receipts.ts";

// Opaque-ID fixtures only; these are not generated native manual DTOs.
const interactionId = (id: string) => id as InteractionId;
const scope: ManualResolutionPortScope = { stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 };

function loss(id = "captured.1", amount = 2, generation = 7): ManualResolutionRequest {
  return {
    binding: { interactionId: interactionId(id), adapterGeneration: generation },
    command: { type: "lose-life", stackEntryId: 44, sourceObjectId: 40, affectedPlayerId: 0, amount },
  };
}

function finish(id = "captured.2", generation = 7): ManualResolutionRequest {
  return {
    binding: { interactionId: interactionId(id), adapterGeneration: generation },
    command: { type: "finish", stackEntryId: 44, sourceObjectId: 40 },
  };
}

function completed(request: ManualResolutionRequest): ManualResolutionResult {
  return { binding: request.binding, status: "completed" };
}

function session(actor: number | null = 0) {
  return createManualResolutionReceiptSession({ authenticatedActor: actor, describeFailure: (code) => code });
}

function boundary() {
  return {
    submitCaptured: vi.fn<ManualResolutionAtomicBoundary["submitCaptured"]>().mockImplementation(async (request) => completed(request)),
    lookupReceipt: vi.fn<ManualResolutionAtomicBoundary["lookupReceipt"]>().mockImplementation(async (request) => ({
      binding: request.binding, status: "indeterminate", reason: "No terminal evidence.",
    })),
  };
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

describe("client manual-resolution receipt coordinator (mock atomic boundary)", () => {
  it("owns one opaque identity across its ports and isolates genuinely different receipt sessions", () => {
    const receiptSession = session();
    const original = receiptSession.bindBoundary(boundary())(scope);
    const replacement = receiptSession.bindBoundary(boundary())({ stackEntryId: 90, sourceObjectId: 80, adapterGeneration: 8 });
    expect(replacement).not.toBe(original);
    expect(replacement.receiptSessionIdentity).toBe(original.receiptSessionIdentity);
    expect(Object.isFrozen(original.receiptSessionIdentity)).toBe(true);
    expect(session(1).bindBoundary(boundary())(scope).receiptSessionIdentity).not.toBe(original.receiptSessionIdentity);
    expect(session(0).bindBoundary(boundary())(scope).receiptSessionIdentity).not.toBe(original.receiptSessionIdentity);
  });

  it("exposes the immutable pending/unknown request across source ports for read-only remount recovery", async () => {
    const endpoint = boundary();
    const delivery = deferred<ManualResolutionResult>();
    endpoint.submitCaptured.mockReturnValue(delivery.promise);
    const receiptSession = session();
    const port = receiptSession.bindBoundary(endpoint)(scope);
    expect(port.getUnresolvedManualResolutionRequest()).toBeNull();
    const input = loss();
    const pending = port.submitManualResolutionCommand(input);
    const original = port.getUnresolvedManualResolutionRequest()!;
    expect(original).not.toBe(input);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.binding)).toBe(true);
    expect(Object.isFrozen(original.command)).toBe(true);
    const replacement = boundary();
    const replacementPort = receiptSession.bindBoundary(replacement)({ stackEntryId: 90, sourceObjectId: 80, adapterGeneration: 8 });
    expect(replacementPort.getUnresolvedManualResolutionRequest()).toBe(original);
    delivery.reject(new Error("Original delivery unknown"));
    await pending;
    expect(endpoint.submitCaptured.mock.calls[0]![0]).toBe(original);
    expect(replacementPort.getUnresolvedManualResolutionRequest()).toBe(original);
    replacement.lookupReceipt.mockResolvedValue({ binding: original.binding, status: "completed" });
    expect(await replacementPort.reconcileManualResolution(original)).toMatchObject({ status: "completed" });
    expect(replacement.lookupReceipt.mock.calls[0]![0]).toBe(original);
    expect(port.getUnresolvedManualResolutionRequest()).toBeNull();
    expect(replacementPort.getUnresolvedManualResolutionRequest()).toBeNull();
    expect(endpoint.submitCaptured).toHaveBeenCalledOnce();
    expect(replacement.submitCaptured).not.toHaveBeenCalled();
  });

  it("recovers the exact retry identity when a rejected attempt and its unknown retry have identical values", async () => {
    const endpoint = boundary();
    endpoint.submitCaptured.mockImplementationOnce(async (request) => ({ binding: request.binding, status: "rejected", reason: "First attempt not applied." }))
      .mockRejectedValueOnce(new Error("Retry unknown"));
    const port = session().bindBoundary(endpoint)(scope);
    await port.submitManualResolutionCommand(loss());
    expect(port.getUnresolvedManualResolutionRequest()).toBeNull();
    await port.submitManualResolutionCommand(loss());
    const retry = port.getUnresolvedManualResolutionRequest()!;
    expect(retry).not.toBe(endpoint.submitCaptured.mock.calls[0]![0]);
    expect(retry).toBe(endpoint.submitCaptured.mock.calls[1]![0]);
    endpoint.lookupReceipt.mockResolvedValue({ binding: retry.binding, status: "not-applied" });
    expect(await port.reconcileManualResolution(retry)).toMatchObject({ status: "not-applied" });
    expect(endpoint.lookupReceipt.mock.calls[0]![0]).toBe(retry);
    expect(port.getUnresolvedManualResolutionRequest()).toBeNull();
    expect(endpoint.submitCaptured).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent delivery, retains its exact receipt, and allows another newly bound loss", async () => {
    const endpoint = boundary();
    const receiptSession = session();
    const factory = receiptSession.bindBoundary(endpoint);
    const firstPort = factory(scope);
    const secondPort = factory(scope);
    const request = loss();
    const first = firstPort.submitManualResolutionCommand(request);
    expect(secondPort.submitManualResolutionCommand(loss())).toBe(first);
    expect(await first).toEqual(completed(request));
    expect(await firstPort.submitManualResolutionCommand(request)).toEqual(completed(request));
    expect(endpoint.submitCaptured).toHaveBeenCalledExactlyOnceWith(request, 0);

    expect(await firstPort.submitManualResolutionCommand(loss("captured.2", 3))).toEqual(completed(loss("captured.2", 3)));
    expect(endpoint.submitCaptured).toHaveBeenCalledTimes(2);
  });

  it("registers the attempt before a synchronous reentrant boundary call", async () => {
    const endpoint = boundary();
    const port = session().bindBoundary(endpoint)(scope);
    let reentrant: Promise<ManualResolutionResult> | undefined;
    endpoint.submitCaptured.mockImplementation(async (request) => {
      reentrant = port.submitManualResolutionCommand(request);
      return completed(request);
    });
    const initial = port.submitManualResolutionCommand(loss());
    await initial;
    expect(reentrant).toBe(initial);
    expect(endpoint.submitCaptured).toHaveBeenCalledOnce();
  });

  it("permits a corrected retry only after terminal nonapplication proof", async () => {
    const endpoint = boundary();
    endpoint.submitCaptured.mockImplementationOnce(async (request) => ({
      binding: request.binding, status: "rejected", reason: "Authoritative amount-domain refusal.",
    }));
    const port = session().bindBoundary(endpoint)(scope);
    expect(await port.submitManualResolutionCommand(loss("captured.1", 21))).toMatchObject({ status: "rejected" });
    expect(await port.submitManualResolutionCommand(loss("captured.1", 2))).toEqual(completed(loss()));
    expect(endpoint.submitCaptured).toHaveBeenCalledTimes(2);
  });

  it("does not retarget an old rejected request's reconciliation to a fresh identical retry", async () => {
    const endpoint = boundary();
    endpoint.submitCaptured.mockImplementationOnce(async (request) => ({
      binding: request.binding, status: "rejected", reason: "Exact first delivery was not applied.",
    })).mockRejectedValueOnce(new Error("Fresh retry has an unknown outcome."));
    const port = session().bindBoundary(endpoint)(scope);
    const original = loss();
    const retry = loss();
    expect(await port.submitManualResolutionCommand(original)).toMatchObject({ status: "rejected" });
    expect(await port.submitManualResolutionCommand(original)).toMatchObject({ status: "rejected" });
    expect(endpoint.submitCaptured).toHaveBeenCalledOnce();
    expect(await port.submitManualResolutionCommand(retry)).toMatchObject({ status: "indeterminate" });
    expect(await port.reconcileManualResolution(original)).toMatchObject({ status: "not-applied", reason: "Exact first delivery was not applied." });
    expect(endpoint.lookupReceipt).not.toHaveBeenCalled();
    expect(await port.reconcileManualResolution(retry)).toMatchObject({ status: "indeterminate" });
    const firstFrozenRequest = endpoint.submitCaptured.mock.calls[0]![0];
    const retryFrozenRequest = endpoint.submitCaptured.mock.calls[1]![0];
    expect(retryFrozenRequest).not.toBe(firstFrozenRequest);
    expect(retryFrozenRequest).toEqual(firstFrozenRequest);
    expect(endpoint.lookupReceipt.mock.calls[0]![0]).toBe(retryFrozenRequest);
    expect(endpoint.submitCaptured).toHaveBeenCalledTimes(2);
  });

  it("keeps reconstructed values ambiguous after identical retries instead of returning the latest receipt", async () => {
    const endpoint = boundary();
    endpoint.submitCaptured.mockImplementationOnce(async (request) => ({
      binding: request.binding, status: "rejected", reason: "First delivery was not applied.",
    }));
    const port = session().bindBoundary(endpoint)(scope);
    const original = loss();
    const retry = loss();
    await port.submitManualResolutionCommand(original);
    expect(await port.submitManualResolutionCommand(retry)).toEqual(completed(retry));

    expect(await port.reconcileManualResolution(loss())).toMatchObject({ status: "indeterminate", reason: "attempt-identity-unknown" });
    expect(await port.submitManualResolutionCommand(loss())).toMatchObject({ status: "indeterminate", reason: "attempt-identity-unknown" });
    expect(await port.reconcileManualResolution(original)).toMatchObject({ status: "not-applied", reason: "First delivery was not applied." });
    expect(await port.reconcileManualResolution(retry)).toEqual(completed(retry));
    expect(endpoint.lookupReceipt).not.toHaveBeenCalled();
    expect(endpoint.submitCaptured).toHaveBeenCalledTimes(2);
  });

  it("retains a pending or unknown original attempt when its port's source changes", async () => {
    const endpoint = boundary();
    const delivery = deferred<ManualResolutionResult>();
    endpoint.submitCaptured.mockReturnValue(delivery.promise);
    const receiptSession = session();
    const original = loss();
    const pending = receiptSession.bindBoundary(endpoint)(scope).submitManualResolutionCommand(original);
    const replacement = boundary();
    const anotherScope = { stackEntryId: 90, sourceObjectId: 80, adapterGeneration: 8 };
    const replacementPort = receiptSession.bindBoundary(replacement)(anotherScope);
    expect(replacementPort.submitManualResolutionCommand(original)).toBe(pending);

    delivery.reject(new Error("Delivery has no terminal evidence."));
    const unknown = await pending;
    expect(unknown).toMatchObject({ status: "indeterminate", reason: "delivery-unknown" });
    expect(await replacementPort.submitManualResolutionCommand(original)).toBe(unknown);
    const next: ManualResolutionRequest = { binding: finish("next.source", 8).binding, command: { type: "finish", stackEntryId: 90, sourceObjectId: 80 } };
    expect(await replacementPort.submitManualResolutionCommand(next)).toMatchObject({ status: "rejected", reason: "operation-unresolved" });
    expect(endpoint.submitCaptured).toHaveBeenCalledOnce();
    expect(replacement.submitCaptured).not.toHaveBeenCalled();
    expect(replacement.lookupReceipt).not.toHaveBeenCalled();
  });

  it("protects a pending loss from Finish and from an intent change on the same frame", async () => {
    const endpoint = boundary();
    const delivery = deferred<ManualResolutionResult>();
    endpoint.submitCaptured.mockReturnValue(delivery.promise);
    const port = session().bindBoundary(endpoint)(scope);
    const pending = port.submitManualResolutionCommand(loss());
    expect(await port.submitManualResolutionCommand(loss("captured.1", 3))).toMatchObject({ status: "rejected", reason: "intent-conflict" });
    expect(await port.submitManualResolutionCommand(finish())).toMatchObject({ status: "rejected", reason: "operation-unresolved" });
    delivery.resolve(completed(loss()));
    await pending;
    endpoint.submitCaptured.mockImplementation(async (request) => completed(request));
    expect(await port.submitManualResolutionCommand(finish())).toEqual(completed(finish()));
    expect(endpoint.submitCaptured).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a completed receipt for a different intent on the same binding", async () => {
    const endpoint = boundary();
    const port = session().bindBoundary(endpoint)(scope);
    await port.submitManualResolutionCommand(loss());
    expect(await port.submitManualResolutionCommand(loss("captured.1", 3))).toMatchObject({ status: "rejected", reason: "intent-conflict" });
    expect(await port.reconcileManualResolution(loss("captured.1", 3))).toMatchObject({ status: "indeterminate", reason: "intent-conflict" });
    expect(endpoint.submitCaptured).toHaveBeenCalledOnce();
    expect(endpoint.lookupReceipt).not.toHaveBeenCalled();
  });

  it("turns delivery failure into unknown and never resends that request on lookup or retry", async () => {
    const endpoint = boundary();
    endpoint.submitCaptured.mockRejectedValue(new Error("Transport failed; internal details must not leak."));
    const port = session().bindBoundary(endpoint)(scope);
    const request = loss();
    const unknown = await port.submitManualResolutionCommand(request);
    expect(unknown).toEqual({ binding: request.binding, status: "indeterminate", reason: "delivery-unknown" });
    expect(await port.submitManualResolutionCommand(request)).toEqual(unknown);
    expect(await port.reconcileManualResolution(request)).toMatchObject({ status: "indeterminate" });
    expect(await port.submitManualResolutionCommand(finish())).toMatchObject({ status: "rejected", reason: "operation-unresolved" });
    expect(endpoint.submitCaptured).toHaveBeenCalledOnce();
    expect(endpoint.lookupReceipt).toHaveBeenCalledExactlyOnceWith(request, 0);
  });

  it.each([
    { interactionId: interactionId("another.frame"), adapterGeneration: 7 },
    { interactionId: interactionId("captured.1"), adapterGeneration: 8 },
  ])("treats a mismatched receipt binding as unknown: %j", async (binding) => {
    const endpoint = boundary();
    endpoint.submitCaptured.mockResolvedValue({ binding, status: "completed" });
    const port = session().bindBoundary(endpoint)(scope);
    expect(await port.submitManualResolutionCommand(loss())).toEqual({ binding: loss().binding, status: "indeterminate", reason: "receipt-mismatch" });
    expect(await port.submitManualResolutionCommand(loss())).toMatchObject({ status: "indeterminate" });
    expect(endpoint.submitCaptured).toHaveBeenCalledOnce();
  });

  it("requires exact original binding from a receipt lookup before unlocking", async () => {
    const endpoint = boundary();
    endpoint.submitCaptured.mockRejectedValue(new Error("Disconnected"));
    const port = session().bindBoundary(endpoint)(scope);
    await port.submitManualResolutionCommand(loss());
    endpoint.lookupReceipt.mockResolvedValueOnce({ binding: loss("newer.frame").binding, status: "not-applied" });
    expect(await port.reconcileManualResolution(loss())).toMatchObject({ status: "indeterminate", reason: "receipt-mismatch" });
    expect(await port.submitManualResolutionCommand(finish())).toMatchObject({ status: "rejected", reason: "operation-unresolved" });
    endpoint.lookupReceipt.mockResolvedValueOnce({ binding: loss().binding, status: "not-applied", reason: "Exact original delivery definitively cancelled." });
    expect(await port.reconcileManualResolution(loss())).toMatchObject({ status: "not-applied" });
    endpoint.submitCaptured.mockImplementation(async (request) => completed(request));
    expect(await port.submitManualResolutionCommand(loss())).toEqual(completed(loss()));
    expect(endpoint.submitCaptured).toHaveBeenCalledTimes(2);
  });

  it("does not equate absence from client memory with nonapplication", async () => {
    const endpoint = boundary();
    const port = session().bindBoundary(endpoint)(scope);
    expect(await port.reconcileManualResolution(loss())).toMatchObject({ status: "indeterminate" });
    expect(endpoint.lookupReceipt).toHaveBeenCalledExactlyOnceWith(loss(), 0);
    expect(endpoint.submitCaptured).not.toHaveBeenCalled();
    expect(await port.submitManualResolutionCommand(finish())).toMatchObject({ status: "rejected", reason: "operation-unresolved" });
  });

  it("keeps failed lookup unknown without leaking the error or replaying", async () => {
    const endpoint = boundary();
    endpoint.lookupReceipt.mockRejectedValue(new Error("Internal transport details"));
    const port = session().bindBoundary(endpoint)(scope);
    expect(await port.reconcileManualResolution(loss())).toEqual({ binding: loss().binding, status: "indeterminate", reason: "lookup-unknown" });
    expect(endpoint.submitCaptured).not.toHaveBeenCalled();
  });

  it("captures the authenticated actor, scope and immutable full request before async entry", async () => {
    const endpoint = boundary();
    const options = { authenticatedActor: 0, describeFailure: (code: string) => code };
    const receiptSession = createManualResolutionReceiptSession(options);
    const mutableScope = { ...scope };
    const port = receiptSession.bindBoundary(endpoint)(mutableScope);
    const binding = { interactionId: interactionId("captured.1"), adapterGeneration: 7 };
    const command: ManualLifeLossCommand = { type: "lose-life", stackEntryId: 44, sourceObjectId: 40, affectedPlayerId: 0, amount: 2 };
    const pending = port.submitManualResolutionCommand({ binding, command });
    options.authenticatedActor = 1;
    mutableScope.adapterGeneration = 8;
    binding.adapterGeneration = 8;
    command.amount = 9;
    command.affectedPlayerId = 1;
    await pending;
    expect(endpoint.submitCaptured).toHaveBeenCalledExactlyOnceWith(loss(), 0);
    const sent = endpoint.submitCaptured.mock.calls[0]![0];
    expect(Object.isFrozen(sent)).toBe(true);
    expect(Object.isFrozen(sent.binding)).toBe(true);
    expect(Object.isFrozen(sent.command)).toBe(true);
  });

  it("rejects spectators without creating any submission or receipt lookup", async () => {
    const endpoint = boundary();
    const port = session(null).bindBoundary(endpoint)(scope);
    expect(await port.submitManualResolutionCommand(finish())).toMatchObject({ status: "rejected", reason: "actor-unavailable" });
    expect(await port.reconcileManualResolution(loss())).toMatchObject({ status: "indeterminate", reason: "actor-unavailable" });
    expect(endpoint.submitCaptured).not.toHaveBeenCalled();
    expect(endpoint.lookupReceipt).not.toHaveBeenCalled();
  });

  it("cannot alter the own-life affected player through UI input", async () => {
    const endpoint = boundary();
    const port = session().bindBoundary(endpoint)(scope);
    const otherPlayer: ManualResolutionRequest = { ...loss(), command: { ...loss().command, type: "lose-life", affectedPlayerId: 1, amount: 2 } };
    expect(await port.submitManualResolutionCommand(otherPlayer)).toMatchObject({ status: "rejected", reason: "wrong-player" });
    expect(await port.reconcileManualResolution(otherPlayer)).toMatchObject({ status: "indeterminate", reason: "wrong-player" });
    expect(endpoint.submitCaptured).not.toHaveBeenCalled();
    expect(endpoint.lookupReceipt).not.toHaveBeenCalled();
  });

  it.each([
    { ...scope, stackEntryId: 45 },
    { ...scope, sourceObjectId: 41 },
  ])("rejects a different source scope before delivery: %j", async (differentScope) => {
    const endpoint = boundary();
    const port = session().bindBoundary(endpoint)(differentScope);
    expect(await port.submitManualResolutionCommand(loss())).toMatchObject({ status: "rejected", reason: "source-mismatch" });
    expect(endpoint.submitCaptured).not.toHaveBeenCalled();
  });

  it("refuses a new submission with a different generation from its captured port scope", async () => {
    const endpoint = boundary();
    const port = session().bindBoundary(endpoint)(scope);
    expect(await port.submitManualResolutionCommand(loss("captured.1", 2, 8))).toMatchObject({ status: "rejected", reason: "generation-mismatch" });
    expect(endpoint.submitCaptured).not.toHaveBeenCalled();
  });

  it("passes the old binding unchanged to a mocked serialized mutation boundary that has advanced", async () => {
    const endpoint = boundary();
    let boundaryGeneration = 7;
    const queue = deferred<void>();
    endpoint.submitCaptured.mockImplementation(async (request) => {
      await queue.promise;
      return request.binding.adapterGeneration !== boundaryGeneration
        ? { binding: request.binding, status: "rejected", reason: "Mock boundary atomically refused stale generation." }
        : completed(request);
    });
    const port = session().bindBoundary(endpoint)(scope);
    const pending = port.submitManualResolutionCommand(loss());
    boundaryGeneration = 8;
    queue.resolve();
    expect(await pending).toMatchObject({ binding: loss().binding, status: "rejected" });
    expect(endpoint.submitCaptured).toHaveBeenCalledExactlyOnceWith(loss(), 0);
    // This tests the contract with a mock, not a real worker/native atomic gate.
  });

  it("retains unknown across a boundary/generation replacement and reconciles the exact old request", async () => {
    const oldBoundary = boundary();
    oldBoundary.submitCaptured.mockRejectedValue(new Error("Timeout"));
    const receiptSession = session();
    await receiptSession.bindBoundary(oldBoundary)(scope).submitManualResolutionCommand(loss());
    const replacement = boundary();
    const port = receiptSession.bindBoundary(replacement)({ ...scope, adapterGeneration: 8 });
    expect(await port.submitManualResolutionCommand(finish("new.frame", 8))).toMatchObject({ status: "rejected", reason: "operation-unresolved" });
    replacement.lookupReceipt.mockResolvedValue({ binding: loss().binding, status: "completed" });
    expect(await port.reconcileManualResolution(loss())).toEqual(completed(loss()));
    expect(replacement.lookupReceipt).toHaveBeenCalledExactlyOnceWith(loss(), 0);
    expect(replacement.submitCaptured).not.toHaveBeenCalled();
    expect(await port.submitManualResolutionCommand(finish("new.frame", 8))).toEqual(completed(finish("new.frame", 8)));
  });

  it("coalesces receipt queries while letting a replacement boundary recover original evidence", async () => {
    const receiptSession = session();
    const oldBoundary = boundary();
    const oldAnswer = deferred<ManualResolutionReconciliation>();
    oldBoundary.lookupReceipt.mockReturnValue(oldAnswer.promise);
    const oldPort = receiptSession.bindBoundary(oldBoundary)(scope);
    const first = oldPort.reconcileManualResolution(loss());
    expect(oldPort.reconcileManualResolution(loss())).toBe(first);
    const replacement = boundary();
    replacement.lookupReceipt.mockResolvedValue({ binding: loss().binding, status: "completed" });
    const newPort = receiptSession.bindBoundary(replacement)({ ...scope, adapterGeneration: 8 });
    expect(await newPort.reconcileManualResolution(loss())).toEqual(completed(loss()));
    oldAnswer.resolve({ binding: loss().binding, status: "indeterminate" });
    expect(await first).toEqual(completed(loss()));
    expect(oldBoundary.lookupReceipt).toHaveBeenCalledOnce();
    expect(replacement.lookupReceipt).toHaveBeenCalledExactlyOnceWith(loss(), 0);
    expect(oldBoundary.submitCaptured).not.toHaveBeenCalled();
    expect(replacement.submitCaptured).not.toHaveBeenCalled();
  });

  it("keeps native held-pending evidence distinct and retains the exact original across a generation change", async () => {
    const endpoint = boundary();
    endpoint.submitCaptured.mockRejectedValueOnce(new Error("registration ACK lost"));
    const receiptSession = session();
    const port = receiptSession.bindBoundary(endpoint)(scope);
    await port.submitManualResolutionCommand(loss());
    const original = port.getUnresolvedManualResolutionRequest()!;
    const replacement = boundary();
    replacement.lookupReceipt.mockResolvedValueOnce({ binding: original.binding, status: "pending" });
    const newPort = receiptSession.bindBoundary(replacement)({ ...scope, adapterGeneration: 8 });
    expect(await newPort.reconcileManualResolution(original)).toEqual({ binding: original.binding, status: "pending" });
    expect(newPort.getUnresolvedManualResolutionRequest()).toBe(original);
    expect(await newPort.submitManualResolutionCommand(finish("new.frame", 8))).toMatchObject({ status: "rejected", reason: "operation-unresolved" });
    replacement.lookupReceipt.mockResolvedValueOnce({ binding: original.binding, status: "completed" });
    expect(await newPort.reconcileManualResolution(original)).toEqual(completed(original));
    expect(newPort.getUnresolvedManualResolutionRequest()).toBeNull();
    expect(replacement.lookupReceipt.mock.calls.every(([request]) => request === original)).toBe(true);
    expect(replacement.submitCaptured).not.toHaveBeenCalled();
  });

  it("accepts a late original receipt and preserves it over a later nonterminal lookup answer", async () => {
    const receiptSession = session();
    const oldBoundary = boundary();
    const delivery = deferred<ManualResolutionResult>();
    oldBoundary.submitCaptured.mockReturnValue(delivery.promise);
    const pending = receiptSession.bindBoundary(oldBoundary)(scope).submitManualResolutionCommand(loss());
    const replacement = boundary();
    const lookup = deferred<ManualResolutionReconciliation>();
    replacement.lookupReceipt.mockReturnValue(lookup.promise);
    const newPort = receiptSession.bindBoundary(replacement)({ ...scope, adapterGeneration: 8 });
    const recovering = newPort.reconcileManualResolution(loss());
    delivery.resolve(completed(loss()));
    expect(await pending).toEqual(completed(loss()));
    lookup.resolve({ binding: loss().binding, status: "indeterminate" });
    expect(await recovering).toEqual(completed(loss()));
    expect(await newPort.reconcileManualResolution(loss())).toEqual(completed(loss()));
    expect(replacement.lookupReceipt).toHaveBeenCalledOnce();
    expect(replacement.submitCaptured).not.toHaveBeenCalled();
  });

  it("does not let a different source bypass an unknown attempt in the same authenticated timeline", async () => {
    const endpoint = boundary();
    endpoint.submitCaptured.mockRejectedValue(new Error("Unknown outcome"));
    const receiptSession = session();
    await receiptSession.bindBoundary(endpoint)(scope).submitManualResolutionCommand(loss());
    const anotherScope = { stackEntryId: 90, sourceObjectId: 80, adapterGeneration: 8 };
    const next: ManualResolutionRequest = { binding: finish("next.source", 8).binding, command: { type: "finish", stackEntryId: 90, sourceObjectId: 80 } };
    expect(await receiptSession.bindBoundary(endpoint)(anotherScope).submitManualResolutionCommand(next)).toMatchObject({ status: "rejected", reason: "operation-unresolved" });
    expect(endpoint.submitCaptured).toHaveBeenCalledOnce();
  });
});
