import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
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
}: {
  port: ManualResolutionCommandPort;
  binding?: ManualResolutionCommandBinding;
  onFinished?: () => void;
}) {
  const board = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<ManualResolutionSandboxTarget | null>(null);
  return (
    <>
      <div ref={board} role="region" aria-label="Mock board" tabIndex={-1} />
      <button onClick={() => setTarget({ playerId: 0, name: "Mock own seat" })}>Mock own player area</button>
      <ManualResolutionSandbox
        source={{ episodeId: "local-mock", stackEntryId: 44, sourceObjectId: 40, cardName: "Paused source", oracleText: "" }}
        viewerPlayerId={0}
        selectedTarget={target}
        onSelectedTargetChange={setTarget}
        operationAvailability={{ available: true, amountBounds: { minimum: 1, maximum: 20 } }}
        canFinish
        commandBinding={binding}
        confirmedRestoreEpoch={0}
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
