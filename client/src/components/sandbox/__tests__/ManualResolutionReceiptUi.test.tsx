import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InteractionId } from "../../../adapter/generated/interaction";
import {
  createManualResolutionReceiptSession,
  type ManualResolutionAtomicBoundary,
} from "../../../adapter/experimental/manual-resolution-receipts.ts";
import { ManualResolutionSandbox, type ManualResolutionSandboxTarget } from "../ManualResolutionSandbox.tsx";
import type {
  ManualResolutionCommandBinding,
  ManualResolutionCommandPort,
  ManualResolutionRequest,
  ManualResolutionResult,
} from "../manual-resolution-ui-contract.ts";

vi.mock("../../card/CardImage.tsx", () => ({
  CardImage: ({ cardName }: { cardName: string }) => <div role="img" aria-label={cardName} />,
}));

const initialBinding: ManualResolutionCommandBinding = {
  interactionId: "mock.frame.1" as InteractionId, adapterGeneration: 7,
};
const nextBinding: ManualResolutionCommandBinding = {
  interactionId: "mock.frame.2" as InteractionId, adapterGeneration: 7,
};

function Harness({
  port,
  binding = initialBinding,
  onFinished = () => {},
  stackEntryId = 44,
  sourceObjectId = 40,
  cardName = "Paused source",
  viewerPlayerId = 0,
  confirmedRestoreEpoch = 0,
}: {
  port: ManualResolutionCommandPort;
  binding?: ManualResolutionCommandBinding;
  onFinished?: () => void;
  stackEntryId?: number;
  sourceObjectId?: number;
  cardName?: string;
  viewerPlayerId?: number;
  confirmedRestoreEpoch?: number;
}) {
  const board = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<ManualResolutionSandboxTarget | null>(null);
  return (
    <>
      <div ref={board} role="region" aria-label="Mock board" tabIndex={-1} />
      <button onClick={() => setTarget({ playerId: viewerPlayerId, name: "Mock own seat" })}>Mock own player area</button>
      <ManualResolutionSandbox
        source={{ episodeId: "local-mock", stackEntryId, sourceObjectId, cardName, oracleText: "" }}
        viewerPlayerId={viewerPlayerId}
        selectedTarget={target}
        onSelectedTargetChange={setTarget}
        operationAvailability={{ available: true, amountBounds: { minimum: 1, maximum: 20 } }}
        canFinish
        commandBinding={binding}
        confirmedRestoreEpoch={confirmedRestoreEpoch}
        commandPort={port}
        returnFocusRef={board}
        onFinished={onFinished}
      />
    </>
  );
}

function endpoint() {
  return {
    submitCaptured: vi.fn<ManualResolutionAtomicBoundary["submitCaptured"]>().mockImplementation(async (request) => ({ binding: request.binding, status: "completed" })),
    lookupReceipt: vi.fn<ManualResolutionAtomicBoundary["lookupReceipt"]>().mockImplementation(async (request) => ({ binding: request.binding, status: "indeterminate" })),
  };
}

afterEach(cleanup);

describe("reusable UI with client receipt coordinator and disconnected mock boundary", () => {
  it.each(["unmount", "source-change"] as const)("recovers an applied Finish after response loss and remount without resending the old attempt (%s)", async (transition) => {
    const user = userEvent.setup();
    const boundary = endpoint();
    const appliedFinishes = new Set<ManualResolutionRequest>();
    boundary.submitCaptured.mockImplementationOnce(async (request) => {
      expect(request.command.type).toBe("finish");
      appliedFinishes.add(request);
      throw new Error("Mock Finish applied, but its response was lost.");
    });
    boundary.lookupReceipt.mockImplementation(async (request) => ({
      binding: request.binding,
      status: appliedFinishes.has(request) ? "completed" : "indeterminate",
    }));
    const receiptSession = createManualResolutionReceiptSession({ authenticatedActor: 0, describeFailure: (code) => code });
    const factory = receiptSession.bindBoundary(boundary);
    const originalPort = factory({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    const originalFinished = vi.fn();
    const originalView = render(<Harness port={originalPort} onFinished={originalFinished} />);
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("delivery-unknown");
    const originalRequest = boundary.submitCaptured.mock.calls[0]![0];
    expect(appliedFinishes).toEqual(new Set([originalRequest]));
    expect(originalFinished).not.toHaveBeenCalled();
    const newBinding: ManualResolutionCommandBinding = { interactionId: "mock.next-source" as InteractionId, adapterGeneration: 8 };
    const newPort = factory({ stackEntryId: 90, sourceObjectId: 80, adapterGeneration: 8 });
    const newFinished = vi.fn();
    const nextSource = <Harness port={newPort} binding={newBinding} stackEntryId={90} sourceObjectId={80} cardName="Next source" onFinished={newFinished} />;
    if (transition === "unmount") {
      originalView.unmount();
      render(nextSource);
    } else {
      originalView.rerender(nextSource);
    }
    const checkStatus = await screen.findByRole("button", { name: "Check status" });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled();
    await user.click(checkStatus);

    expect(boundary.lookupReceipt).toHaveBeenCalledExactlyOnceWith(originalRequest, 0);
    expect(boundary.lookupReceipt.mock.calls[0]![0]).toBe(originalRequest);
    expect(boundary.submitCaptured).toHaveBeenCalledOnce();
    expect(originalFinished).not.toHaveBeenCalled();
    expect(newFinished).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "Next source" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Mock own player area" }));
    await user.type(screen.getByRole("spinbutton", { name: "Amount" }), "2");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(boundary.submitCaptured).toHaveBeenCalledTimes(2);
    expect(boundary.submitCaptured).toHaveBeenLastCalledWith({
      binding: newBinding,
      command: { type: "lose-life", stackEntryId: 90, sourceObjectId: 80, affectedPlayerId: 0, amount: 2 },
    }, 0);
  });

  it("recovers a still-pending Finish on same-source StrictMode remount and ignores its late delivery callback", async () => {
    const user = userEvent.setup();
    const boundary = endpoint();
    let loseResponse!: (reason: Error) => void;
    boundary.submitCaptured.mockImplementationOnce(async () => new Promise((_resolve, reject) => { loseResponse = reject; }));
    boundary.lookupReceipt.mockImplementation(async (request) => ({ binding: request.binding, status: "completed" }));
    const receiptSession = createManualResolutionReceiptSession({ authenticatedActor: 0, describeFailure: (code) => code });
    const oldPort = receiptSession.bindBoundary(boundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    const oldFinished = vi.fn();
    const oldView = render(<Harness port={oldPort} onFinished={oldFinished} />);
    await user.click(screen.getByRole("button", { name: "Finish" }));
    const originalRequest = boundary.submitCaptured.mock.calls[0]![0];
    oldView.unmount();
    const replacementPort = receiptSession.bindBoundary(boundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 8 });
    const restoredFinished = vi.fn();
    render(<StrictMode><Harness port={replacementPort} binding={{ ...nextBinding, adapterGeneration: 8 }} onFinished={restoredFinished} /></StrictMode>);
    await user.click(await screen.findByRole("button", { name: "Check status" }));
    expect(boundary.lookupReceipt).toHaveBeenCalledExactlyOnceWith(originalRequest, 0);
    expect(boundary.lookupReceipt.mock.calls[0]![0]).toBe(originalRequest);
    expect(restoredFinished).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Mock board" })).toHaveFocus();
    await act(async () => loseResponse(new Error("Late original response loss")));
    expect(oldFinished).not.toHaveBeenCalled();
    expect(restoredFinished).toHaveBeenCalledOnce();
    expect(boundary.submitCaptured).toHaveBeenCalledOnce();
  });

  it.each([
    { boundaryName: "authenticated actor replacement", actor: 1, confirmedRestoreEpoch: 0 },
    { boundaryName: "authoritative timeline restore", actor: 0, confirmedRestoreEpoch: 1 },
  ])("does not import the old attempt into a separate receipt session after $boundaryName", async ({ actor, confirmedRestoreEpoch }) => {
    const user = userEvent.setup();
    const boundary = endpoint();
    boundary.submitCaptured.mockRejectedValueOnce(new Error("Old timeline outcome is unknown."));
    const oldSession = createManualResolutionReceiptSession({ authenticatedActor: 0, describeFailure: (code) => code });
    const oldPort = oldSession.bindBoundary(boundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    const oldView = render(<Harness port={oldPort} />);
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("delivery-unknown");
    const originalRequest = boundary.submitCaptured.mock.calls[0]![0];
    oldView.unmount();
    const newSession = createManualResolutionReceiptSession({ authenticatedActor: actor, describeFailure: (code) => code });
    const newPort = newSession.bindBoundary(boundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 8 });
    render(<Harness port={newPort} binding={{ ...nextBinding, adapterGeneration: 8 }} viewerPlayerId={actor} confirmedRestoreEpoch={confirmedRestoreEpoch} />);
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(boundary.submitCaptured).toHaveBeenLastCalledWith({
      binding: { ...nextBinding, adapterGeneration: 8 }, command: { type: "finish", stackEntryId: 44, sourceObjectId: 40 },
    }, actor);
    expect(boundary.lookupReceipt).not.toHaveBeenCalled();
    expect(oldPort.getUnresolvedManualResolutionRequest()).toBe(originalRequest);
    expect(newPort.getUnresolvedManualResolutionRequest()).toBeNull();
  });

  it.each([0, 1])("isolates a new authenticated receipt session on same-source rerender without unmount (actor %s)", async (actor) => {
    const user = userEvent.setup();
    const oldBoundary = endpoint();
    oldBoundary.submitCaptured.mockRejectedValueOnce(new Error("Old Finish delivery is unknown."));
    const oldSession = createManualResolutionReceiptSession({ authenticatedActor: 0, describeFailure: (code) => code });
    const oldPort = oldSession.bindBoundary(oldBoundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    const oldFinished = vi.fn();
    const view = render(<Harness port={oldPort} onFinished={oldFinished} />);
    await user.click(screen.getByRole("button", { name: "Mock own player area" }));
    await user.type(screen.getByRole("spinbutton", { name: "Amount" }), "2");
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("delivery-unknown");
    const originalRequest = oldBoundary.submitCaptured.mock.calls[0]![0];
    const newBoundary = endpoint();
    const newSession = createManualResolutionReceiptSession({ authenticatedActor: actor, describeFailure: (code) => code });
    const newPort = newSession.bindBoundary(newBoundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    const newFinished = vi.fn();

    // Keep source, binding, generation, and restore epoch identical. Only the
    // real authenticated receipt session changes; the host does not unmount.
    view.rerender(<Harness port={newPort} viewerPlayerId={actor} onFinished={newFinished} />);
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Clear target" })).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Amount" })).toHaveDisplayValue("");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(newPort.getUnresolvedManualResolutionRequest()).toBeNull();
    expect(oldPort.getUnresolvedManualResolutionRequest()).toBe(originalRequest);
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(newBoundary.submitCaptured).toHaveBeenCalledExactlyOnceWith({
      binding: initialBinding, command: { type: "finish", stackEntryId: 44, sourceObjectId: 40 },
    }, actor);
    expect(newBoundary.lookupReceipt).not.toHaveBeenCalled();
    expect(oldBoundary.lookupReceipt).not.toHaveBeenCalled();
    expect(oldBoundary.submitCaptured).toHaveBeenCalledOnce();
    expect(oldFinished).not.toHaveBeenCalled();
    expect(newFinished).toHaveBeenCalledOnce();
    expect(newPort.getUnresolvedManualResolutionRequest()).toBeNull();
  });

  it("keeps an unknown Finish in the same receipt session when its source port is replaced without unmount", async () => {
    const user = userEvent.setup();
    const oldBoundary = endpoint();
    oldBoundary.submitCaptured.mockRejectedValueOnce(new Error("Old Finish delivery is unknown."));
    const receiptSession = createManualResolutionReceiptSession({ authenticatedActor: 0, describeFailure: (code) => code });
    const oldPort = receiptSession.bindBoundary(oldBoundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    const onFinished = vi.fn();
    const view = render(<Harness port={oldPort} onFinished={onFinished} />);
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("delivery-unknown");
    const originalRequest = oldBoundary.submitCaptured.mock.calls[0]![0];
    const replacementBoundary = endpoint();
    replacementBoundary.lookupReceipt.mockImplementation(async (request) => ({ binding: request.binding, status: "completed" }));
    const replacementPort = receiptSession.bindBoundary(replacementBoundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    expect(replacementPort.receiptSessionIdentity).toBe(oldPort.receiptSessionIdentity);
    view.rerender(<Harness port={replacementPort} onFinished={onFinished} />);
    expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(replacementBoundary.lookupReceipt).toHaveBeenCalledExactlyOnceWith(originalRequest, 0);
    expect(replacementBoundary.lookupReceipt.mock.calls[0]![0]).toBe(originalRequest);
    expect(oldBoundary.submitCaptured).toHaveBeenCalledOnce();
    expect(replacementBoundary.submitCaptured).not.toHaveBeenCalled();
    expect(replacementPort.getUnresolvedManualResolutionRequest()).toBeNull();
    expect(onFinished).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Mock board" })).toHaveFocus();
  });

  it("ignores an old session's late Finish after same-source authenticated-session rerender", async () => {
    const user = userEvent.setup();
    const oldBoundary = endpoint();
    let completeOld!: (result: ManualResolutionResult) => void;
    oldBoundary.submitCaptured.mockReturnValueOnce(new Promise((resolve) => { completeOld = resolve; }));
    const oldSession = createManualResolutionReceiptSession({ authenticatedActor: 0, describeFailure: (code) => code });
    const oldPort = oldSession.bindBoundary(oldBoundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    const oldFinished = vi.fn();
    const view = render(<Harness port={oldPort} onFinished={oldFinished} />);
    await user.click(screen.getByRole("button", { name: "Finish" }));
    const originalRequest = oldBoundary.submitCaptured.mock.calls[0]![0];
    const newBoundary = endpoint();
    const newSession = createManualResolutionReceiptSession({ authenticatedActor: 1, describeFailure: (code) => code });
    const newPort = newSession.bindBoundary(newBoundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    const newFinished = vi.fn();
    view.rerender(<Harness port={newPort} viewerPlayerId={1} onFinished={newFinished} />);
    await act(async () => completeOld({ binding: originalRequest.binding, status: "completed" }));
    expect(oldFinished).not.toHaveBeenCalled();
    expect(newFinished).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Mock board" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    expect(newBoundary.lookupReceipt).not.toHaveBeenCalled();
    expect(newBoundary.submitCaptured).not.toHaveBeenCalled();
    expect(newPort.getUnresolvedManualResolutionRequest()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(newFinished).toHaveBeenCalledOnce();
    expect(newBoundary.submitCaptured).toHaveBeenCalledExactlyOnceWith({
      binding: initialBinding, command: { type: "finish", stackEntryId: 44, sourceObjectId: 40 },
    }, 1);
  });

  it("keeps Finish locked during loss delivery and restores board focus after its own receipt", async () => {
    const user = userEvent.setup();
    const boundary = endpoint();
    let completeLoss!: (result: ManualResolutionResult) => void;
    boundary.submitCaptured.mockReturnValueOnce(new Promise((resolve) => { completeLoss = resolve; }));
    const port = createManualResolutionReceiptSession({ authenticatedActor: 0, describeFailure: (code) => code })
      .bindBoundary(boundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    const onFinished = vi.fn();
    const view = render(<Harness port={port} onFinished={onFinished} />);
    await user.click(screen.getByRole("button", { name: "Mock own player area" }));
    await user.type(screen.getByRole("spinbutton", { name: "Amount" }), "2");
    await user.dblClick(screen.getByRole("button", { name: "Apply" }));
    expect(boundary.submitCaptured).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled();
    const original = boundary.submitCaptured.mock.calls[0]![0];
    await act(async () => completeLoss({ binding: original.binding, status: "completed" }));
    view.rerender(<Harness port={port} binding={nextBinding} onFinished={onFinished} />);
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(boundary.submitCaptured).toHaveBeenLastCalledWith({
      binding: nextBinding, command: { type: "finish", stackEntryId: 44, sourceObjectId: 40 },
    }, 0);
    expect(onFinished).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Mock board" })).toHaveFocus();
  });

  it("uses a fresh UI request after rejection and reconciles that retry without resending it", async () => {
    const user = userEvent.setup();
    const boundary = endpoint();
    boundary.submitCaptured.mockImplementationOnce(async (request) => ({
      binding: request.binding, status: "rejected", reason: "First attempt not applied.",
    })).mockRejectedValueOnce(new Error("Second attempt transport failure"));
    boundary.lookupReceipt.mockImplementation(async (request) => ({
      binding: request.binding, status: "not-applied", reason: "Exact second attempt was not applied.",
    }));
    const port = createManualResolutionReceiptSession({ authenticatedActor: 0, describeFailure: (code) => code })
      .bindBoundary(boundary)({ stackEntryId: 44, sourceObjectId: 40, adapterGeneration: 7 });
    render(<Harness port={port} />);
    await user.click(screen.getByRole("button", { name: "Mock own player area" }));
    await user.type(screen.getByRole("spinbutton", { name: "Amount" }), "2");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("First attempt not applied.");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("delivery-unknown");
    expect(boundary.submitCaptured).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Exact second attempt was not applied.");
    const first = boundary.submitCaptured.mock.calls[0]![0];
    const retry = boundary.submitCaptured.mock.calls[1]![0];
    expect(retry).not.toBe(first);
    expect(retry).toEqual(first);
    expect(boundary.lookupReceipt.mock.calls[0]![0]).toBe(retry);
    expect(boundary.submitCaptured).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(boundary.submitCaptured).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
