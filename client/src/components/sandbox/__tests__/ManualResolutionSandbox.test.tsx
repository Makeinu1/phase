import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useRef, useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InteractionId } from "../../../adapter/generated/interaction";
import type { PlayerId } from "../../../adapter/types.ts";
import { useKeyboardShortcuts } from "../../../hooks/useKeyboardShortcuts.ts";
import { useUiStore } from "../../../stores/uiStore.ts";
import { ManualResolutionSandbox } from "../ManualResolutionSandbox.tsx";
import type {
  ManualResolutionCommandPort,
  ManualResolutionCommandBinding,
  ManualResolutionRequest,
  ManualResolutionReconciliation,
  ManualResolutionResult,
} from "../manual-resolution-ui-contract.ts";

vi.mock("../../card/CardImage.tsx", () => ({
  CardImage: ({ cardName }: { cardName: string }) => <div role="img" aria-label={cardName} />,
}));

const source = {
  episodeId: "episode-44",
  stackEntryId: 403,
  sourceObjectId: 401,
  cardName: "Thoughtseize",
  oracleText: "Target opponent reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.",
};

const bounds = { minimum: 1, maximum: 20 };
const initialBinding: ManualResolutionCommandBinding = {
  interactionId: "manual-session.1.1" as InteractionId,
  adapterGeneration: 7,
};

function completedReceipt(request: ManualResolutionRequest): ManualResolutionResult {
  return { binding: request.binding, status: "completed" };
}

function rejectedReceipt(request: ManualResolutionRequest, reason: string): ManualResolutionResult {
  return { binding: request.binding, status: "rejected", reason };
}

function indeterminateReceipt(request: ManualResolutionRequest, reason: string): ManualResolutionResult {
  return { binding: request.binding, status: "indeterminate", reason };
}

function completedReconciliation(request: ManualResolutionRequest): ManualResolutionReconciliation {
  return { binding: request.binding, status: "completed" };
}

function notAppliedReconciliation(request: ManualResolutionRequest, reason?: string): ManualResolutionReconciliation {
  return { binding: request.binding, status: "not-applied", reason };
}

function indeterminateReconciliation(request: ManualResolutionRequest, reason?: string): ManualResolutionReconciliation {
  return { binding: request.binding, status: "indeterminate", reason };
}

function makePort(
  submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
    .mockImplementation(async (request) => completedReceipt(request)),
  reconcile = vi.fn<ManualResolutionCommandPort["reconcileManualResolution"]>()
    .mockImplementation(async (request) => indeterminateReconciliation(request, "Still waiting for an authoritative answer.")),
): ManualResolutionCommandPort {
  return { submitManualResolutionCommand: submit, reconcileManualResolution: reconcile };
}

interface HarnessProps {
  commandPort?: ManualResolutionCommandPort;
  canFinish?: boolean;
  sourceEpisodeId?: string;
  sourceStackEntryId?: number;
  sourceObjectId?: number;
  commandBinding?: ManualResolutionCommandBinding;
  confirmedRestoreEpoch?: number;
  onFinished?: () => void;
  bounds?: { minimum: number; maximum: number | null };
  available?: boolean;
  viewerPlayerId?: PlayerId | null;
}

function TestHarness({
  commandPort: commandPortProp,
  canFinish = false,
  sourceEpisodeId = source.episodeId,
  sourceStackEntryId = source.stackEntryId,
  sourceObjectId = source.sourceObjectId,
  commandBinding = initialBinding,
  confirmedRestoreEpoch = 0,
  onFinished = vi.fn(),
  bounds: amountBounds = bounds,
  available = true,
  viewerPlayerId = 0,
}: HarnessProps) {
  const [selectedTarget, setSelectedTarget] = useState<{ playerId: PlayerId; name: string } | null>(null);
  const boardFocusRef = useRef<HTMLDivElement>(null);
  const defaultPortRef = useRef<ManualResolutionCommandPort | null>(null);
  if (defaultPortRef.current === null) defaultPortRef.current = makePort();
  const activePort = commandPortProp ?? defaultPortRef.current;

  // These mock surfaces live in the harness, as real board PlayerAreas will.
  const sandboxProps = {
    source: {
      ...source,
      episodeId: sourceEpisodeId,
      stackEntryId: sourceStackEntryId,
      sourceObjectId,
    },
    viewerPlayerId,
    selectedTarget,
    onSelectedTargetChange: setSelectedTarget,
    operationAvailability: { available, amountBounds },
    canFinish,
    commandBinding,
    confirmedRestoreEpoch,
    commandPort: activePort,
    returnFocusRef: boardFocusRef,
    onFinished,
  } as ComponentProps<typeof ManualResolutionSandbox>;

  return createElement(
    "div",
    null,
    <div ref={boardFocusRef} role="region" aria-label="Game board" tabIndex={-1}>Board</div>,
    <button type="button">Outside control</button>,
    <div role="group" aria-label="Mock board player areas">
      <button
        type="button"
        onKeyDownCapture={(event) => event.stopPropagation()}
        onClick={() => setSelectedTarget({ playerId: 0, name: "Ari" })}
      >Ari player area</button>
      <button
        type="button"
        onKeyDownCapture={(event) => event.stopPropagation()}
        onClick={() => setSelectedTarget({ playerId: 1, name: "Mira" })}
      >Mira player area</button>
    </div>,
    createElement(ManualResolutionSandbox, sandboxProps),
  );
}

function KeyboardSandboxHarness(props: HarnessProps) {
  useKeyboardShortcuts();
  return <TestHarness {...props} />;
}

function submitButton() {
  return screen.getByRole("button", { name: "Apply" });
}

function finishButton() {
  return screen.getByRole("button", { name: /^Fin/ });
}

async function selectTargetAndEnterAmount(user: ReturnType<typeof userEvent.setup>, amount = "2") {
  await user.click(screen.getByRole("button", { name: "Ari player area" }));
  const input = screen.getByRole("spinbutton", { name: "Amount" });
  await user.type(input, amount);
  return input;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  act(() => useUiStore.setState({ selectedCardIds: [] }));
  vi.clearAllMocks();
});

describe("ManualResolutionSandbox", () => {
  it("submits only a semantic operation through a session-bound port and uses controlled board selection", async () => {
    const user = userEvent.setup();
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => completedReceipt(request));
    render(<TestHarness commandPort={makePort(submit)} />);

    expect(screen.getByRole("img", { name: "Thoughtseize" })).toBeInTheDocument();
    expect(screen.getByText(source.oracleText)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /select your player area/i })).not.toBeInTheDocument();
    expect(finishButton()).toBeDisabled();

    await selectTargetAndEnterAmount(user, "2");
    await user.click(submitButton());

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const [request, ...extraArguments] = submit.mock.calls[0]!;
    expect(request).toEqual({
      binding: initialBinding,
      command: {
      type: "lose-life",
      stackEntryId: 403,
      sourceObjectId: 401,
      affectedPlayerId: 0,
      amount: 2,
      },
    });
    expect(extraArguments).toEqual([]);
    expect(request.command).not.toHaveProperty("episodeId");
    expect(request.command).toMatchObject({ stackEntryId: 403, sourceObjectId: 401 });
    expect(screen.getByRole("button", { name: "Mira player area" })).toBeInTheDocument();
  });

  it("keeps a potentially applied life loss locked until authoritative reconciliation", async () => {
    const user = userEvent.setup();
  const reconcile = vi.fn<ManualResolutionCommandPort["reconcileManualResolution"]>()
      .mockImplementationOnce(async (request) => indeterminateReconciliation(request, "No authoritative result yet."))
      .mockImplementationOnce(async (request) => notAppliedReconciliation(request, "The server confirms it was not applied."));
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => indeterminateReceipt(request, "Delivery is unknown."));
    render(<TestHarness commandPort={makePort(submit, reconcile)} canFinish />);
    await selectTargetAndEnterAmount(user);
    await user.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(/delivery is unknown/i);
    expect(submitButton()).toBeDisabled();
    expect(finishButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no authoritative result yet/i);
    expect(submitButton()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent(/confirms it was not applied/i);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([
    ["completed", { status: "completed" as const }],
    ["not applied", { status: "not-applied" as const, reason: "The source confirms no application." }],
  ])("preserves unresolved delivery across an episodeId-only change until %s is reconciled", async (_label, resolvedStatus) => {
    const user = userEvent.setup();
    const reconciliation = deferred<ManualResolutionReconciliation>();
    const reconcile = vi.fn<ManualResolutionCommandPort["reconcileManualResolution"]>()
      .mockImplementation(() => reconciliation.promise);
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => indeterminateReceipt(request, "The delivery result is unknown."));
    const port = makePort(submit, reconcile);
    const { rerender } = render(
      <TestHarness commandPort={port} canFinish={resolvedStatus.status === "completed"} />,
    );
    await selectTargetAndEnterAmount(user);
    await user.click(submitButton());

    expect(await screen.findByRole("button", { name: "Check status" })).toBeInTheDocument();
    rerender(
      <TestHarness
        commandPort={port}
        canFinish={resolvedStatus.status === "completed"}
        sourceEpisodeId="episode-45"
      />,
    );

    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Clear target" })).not.toBeInTheDocument();
    expect((screen.getByRole("spinbutton", { name: "Amount" }) as HTMLInputElement).value).toBe("");
    expect(submitButton()).toBeDisabled();
    expect(finishButton()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(submitButton()).toBeDisabled();
    expect(finishButton()).toBeDisabled();

    const originalRequest = submit.mock.calls[0]![0];
    await act(async () => reconciliation.resolve({ binding: originalRequest.binding, ...resolvedStatus }));
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();

    if (resolvedStatus.status === "completed") {
      expect(finishButton()).toBeEnabled();
    } else {
      expect(finishButton()).toBeDisabled();
      await selectTargetAndEnterAmount(user);
      expect(submitButton()).toBeEnabled();
    }
  });

  it("does not retry an unknown request with its old interaction ID when the displayed ID advances", async () => {
    const user = userEvent.setup();
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => indeterminateReceipt(request, "The first attempt is unresolved."));
    const reconcile = vi.fn<ManualResolutionCommandPort["reconcileManualResolution"]>()
      .mockImplementation(async (request) => indeterminateReconciliation(request, "Still unresolved."));
    const port = makePort(submit, reconcile);
    const secondBinding: ManualResolutionCommandBinding = {
      interactionId: "manual-session.1.2" as InteractionId,
      adapterGeneration: initialBinding.adapterGeneration,
    };
    const { rerender } = render(<TestHarness commandPort={port} />);
    await selectTargetAndEnterAmount(user);
    await user.click(submitButton());
    expect(await screen.findByRole("button", { name: "Check status" })).toBeInTheDocument();

    rerender(<TestHarness commandPort={port} commandBinding={secondBinding} />);
    expect(submitButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check status" }));

    expect(reconcile).toHaveBeenCalledWith(submit.mock.calls[0]![0]);
    expect(reconcile.mock.calls[0]![0].binding).toEqual(initialBinding);
    expect(submit).toHaveBeenCalledOnce();
    expect(submitButton()).toBeDisabled();
  });

  it("keeps mismatched submission and reconciliation receipts indeterminate", async () => {
    const user = userEvent.setup();
    const mismatchedBinding: ManualResolutionCommandBinding = {
      interactionId: "manual-session.1.99" as InteractionId,
      adapterGeneration: initialBinding.adapterGeneration,
    };
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async () => ({ binding: mismatchedBinding, status: "completed" }));
    const reconcile = vi.fn<ManualResolutionCommandPort["reconcileManualResolution"]>()
      .mockImplementationOnce(async () => ({ binding: mismatchedBinding, status: "completed" }))
      .mockImplementationOnce(async (request) => completedReconciliation(request));
    render(<TestHarness commandPort={makePort(submit, reconcile)} canFinish />);
    await selectTargetAndEnterAmount(user);
    await user.click(submitButton());

    expect(await screen.findByRole("button", { name: "Check status" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/receipt binding did not match/i);
    expect(finishButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reconciliation binding did not match/i);
    expect(finishButton()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(finishButton()).toBeEnabled());
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("treats thrown delivery errors as indeterminate instead of offering a retry", async () => {
    const user = userEvent.setup();
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockRejectedValue(new Error("connection lost"));
    render(<TestHarness commandPort={makePort(submit)} />);
    await selectTargetAndEnterAmount(user);
    await user.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(/delivery is unknown/i);
    expect(submitButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
  });

  it("allows zero-operation Finish only when the authoritative frame permits it", async () => {
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => completedReceipt(request));
    const onFinished = vi.fn();
    const port = makePort(submit);
    const { rerender } = render(<TestHarness commandPort={port} canFinish={false} onFinished={onFinished} />);
    expect(finishButton()).toBeDisabled();
    expect(submit).not.toHaveBeenCalled();

    rerender(<TestHarness commandPort={port} canFinish onFinished={onFinished} />);
    expect(finishButton()).toBeEnabled();
    await userEvent.setup().click(finishButton());

    expect(submit).toHaveBeenCalledWith({
      binding: initialBinding,
      command: { type: "finish", stackEntryId: 403, sourceObjectId: 401 },
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(onFinished).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Finished" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Game board" })).toHaveFocus();
  });

  it("blocks duplicate Apply and Finish while each receipt is pending", async () => {
    const user = userEvent.setup();
    const lifeLoss = deferred<ManualResolutionResult>();
    const finish = deferred<ManualResolutionResult>();
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation((request) => request.command.type === "finish" ? finish.promise : lifeLoss.promise);
    render(<TestHarness commandPort={makePort(submit)} canFinish />);
    await selectTargetAndEnterAmount(user);

    act(() => {
      fireEvent.click(submitButton());
      fireEvent.click(submitButton());
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(finishButton()).toBeDisabled();

    await act(async () => lifeLoss.resolve(completedReceipt(submit.mock.calls[0]![0])));
    await waitFor(() => expect(finishButton()).toBeEnabled());
    act(() => {
      fireEvent.click(finishButton());
      fireEvent.click(finishButton());
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(finishButton()).toBeDisabled();

    await act(async () => finish.resolve(completedReceipt(submit.mock.calls[1]![0])));
    expect(screen.getByRole("heading", { name: "Finished" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Game board" })).toHaveFocus();
  });

  it("allows retry only after an authoritative rejection, then follows canFinish", async () => {
    const user = userEvent.setup();
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementationOnce(async (request) => rejectedReceipt(request, "Not applied by the native frame."))
      .mockImplementationOnce(async (request) => completedReceipt(request));
    const port = makePort(submit);
    const { rerender } = render(<TestHarness commandPort={port} canFinish={false} />);
    await selectTargetAndEnterAmount(user);

    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Not applied by the native frame.");
    expect(submitButton()).toBeEnabled();
    expect(finishButton()).toBeDisabled();

    await user.click(submitButton());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(finishButton()).toBeDisabled();

    rerender(<TestHarness commandPort={port} canFinish />);
    expect(finishButton()).toBeEnabled();
  });

  it("permits repeated operations after success within explicit native bounds", async () => {
    const user = userEvent.setup();
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => completedReceipt(request));
    const port = makePort(submit);
    const { rerender } = render(<TestHarness commandPort={port} canFinish={false} bounds={{ minimum: 1, maximum: 20 }} />);
    await user.click(screen.getByRole("button", { name: "Ari player area" }));
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "20");
    await user.type(input, "2");
    await user.click(submitButton());
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]?.[0]).toEqual({
      binding: initialBinding,
      command: {
        type: "lose-life",
        stackEntryId: 403,
        sourceObjectId: 401,
        affectedPlayerId: 0,
        amount: 2,
      },
    });
    expect(finishButton()).toBeDisabled();

    const secondBinding: ManualResolutionCommandBinding = {
      interactionId: "manual-session.1.2" as InteractionId,
      adapterGeneration: initialBinding.adapterGeneration,
    };
    rerender(<TestHarness commandPort={port} commandBinding={secondBinding} canFinish={false} bounds={{ minimum: 1, maximum: 20 }} />);
    const nextInput = screen.getByRole("spinbutton", { name: "Amount" });
    expect((nextInput as HTMLInputElement).value).toBe("");
    expect(nextInput).toBeEnabled();
    await user.type(nextInput, "3");
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1]?.[0]).toEqual({
      binding: secondBinding,
      command: {
        type: "lose-life",
        stackEntryId: 403,
        sourceObjectId: 401,
        affectedPlayerId: 0,
        amount: 3,
      },
    });
  });

  it("requires operation availability from the caller", () => {
    render(<TestHarness available={false} bounds={{ minimum: 2, maximum: 3 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Ari player area" }));
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("min", "2");
    expect(input).toHaveAttribute("max", "3");
    expect(submitButton()).toBeDisabled();
  });

  it("validates input against the supplied native amount bounds", async () => {
    const user = userEvent.setup();
    render(<TestHarness bounds={{ minimum: 2, maximum: 3 }} />);
    await user.click(screen.getByRole("button", { name: "Ari player area" }));
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    expect(input).toHaveAttribute("min", "2");
    expect(input).toHaveAttribute("max", "3");

    fireEvent.change(input, { target: { value: "1" } });
    expect(submitButton()).toBeDisabled();
    fireEvent.change(input, { target: { value: "4" } });
    expect(submitButton()).toBeDisabled();
    fireEvent.change(input, { target: { value: "2" } });
    expect(submitButton()).toBeEnabled();
  });

  it("does not accept a board selection for another player as the local target", async () => {
    const user = userEvent.setup();
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => completedReceipt(request));
    render(<TestHarness commandPort={makePort(submit)} viewerPlayerId={0} />);
    await user.click(screen.getByRole("button", { name: "Mira player area" }));

    expect(screen.getByRole("spinbutton", { name: "Amount" })).toBeDisabled();
    expect(submitButton()).toBeDisabled();
    expect(screen.getByText(/select your player area/i)).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("preserves native Tab order through target surfaces and the operation form", async () => {
    const user = userEvent.setup();
    render(<TestHarness canFinish />);
    await user.click(screen.getByRole("button", { name: "Ari player area" }));
    expect(screen.getByRole("button", { name: "Ari player area" })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Mira player area" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Clear target" })).toHaveFocus();
    await user.tab();
    const amount = screen.getByRole("spinbutton", { name: "Amount" });
    expect(amount).toHaveFocus();
    await user.type(amount, "2");
    await user.tab();
    expect(submitButton()).toHaveFocus();
    await user.tab();
    expect(finishButton()).toHaveFocus();
  });

  it("isolates callback and focus failures from a successful Finish receipt", async () => {
    const user = userEvent.setup();
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => completedReceipt(request));
    const onFinished = vi.fn(() => { throw new Error("observer failed"); });
    render(<TestHarness commandPort={makePort(submit)} canFinish onFinished={onFinished} />);
    const focusDestination = screen.getByRole("region", { name: "Game board" });
    vi.spyOn(focusDestination, "focus").mockImplementation(() => { throw new Error("focus failed"); });

    await user.click(finishButton());

    expect(await screen.findByRole("heading", { name: "Finished" })).toBeInTheDocument();
    expect(onFinished).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("resets completed UI state only after a confirmed restore replaces the timeline", async () => {
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => completedReceipt(request));
    const port = makePort(submit);
    const nextBinding: ManualResolutionCommandBinding = {
      interactionId: "manual-session.2.1" as InteractionId,
      adapterGeneration: initialBinding.adapterGeneration + 1,
    };
    const { rerender } = render(<TestHarness commandPort={port} canFinish />);
    await userEvent.setup().click(finishButton());
    expect(await screen.findByRole("heading", { name: "Finished" })).toBeInTheDocument();

    rerender(<TestHarness commandPort={port} commandBinding={nextBinding} canFinish />);
    expect(screen.getByRole("heading", { name: "Finished" })).toBeInTheDocument();

    rerender(<TestHarness commandPort={port} commandBinding={nextBinding} confirmedRestoreEpoch={1} canFinish />);
    expect(screen.getByRole("heading", { name: "Manual resolution" })).toBeInTheDocument();
    expect(finishButton()).toBeEnabled();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("fences a late operation result when source refs change", async () => {
    const user = userEvent.setup();
    const oldOperation = deferred<ManualResolutionResult>();
    const oldSubmit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockReturnValue(oldOperation.promise);
    const oldPort = makePort(oldSubmit);
    const { rerender } = render(<TestHarness commandPort={oldPort} />);
    await selectTargetAndEnterAmount(user);
    await user.click(submitButton());

    rerender(<TestHarness commandPort={oldPort} sourceStackEntryId={404} />);
    await act(async () => oldOperation.resolve(completedReceipt(oldSubmit.mock.calls[0]![0])));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(finishButton()).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Manual resolution" })).toBeInTheDocument();
  });

  it("reconciles the original request across port and interaction changes, then accepts its matching receipt", async () => {
    const user = userEvent.setup();
    const oldOperation = deferred<ManualResolutionResult>();
    const oldSubmit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockReturnValue(oldOperation.promise);
    const oldPort = makePort(oldSubmit);
    const nextSessionReconcile = vi.fn<ManualResolutionCommandPort["reconcileManualResolution"]>()
      .mockImplementation(async (request) => indeterminateReconciliation(request, "Still checking the original request."));
    const nextSessionPort = makePort(vi.fn(), nextSessionReconcile);
    const nextBinding: ManualResolutionCommandBinding = {
      interactionId: "manual-session.1.2" as InteractionId,
      adapterGeneration: initialBinding.adapterGeneration + 1,
    };
    const { rerender } = render(<TestHarness commandPort={oldPort} />);
    await selectTargetAndEnterAmount(user);
    await user.click(submitButton());

    rerender(<TestHarness commandPort={nextSessionPort} commandBinding={nextBinding} canFinish />);
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    expect(submitButton()).toBeDisabled();
    expect(finishButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(nextSessionReconcile).toHaveBeenCalledOnce());
    expect(nextSessionReconcile).toHaveBeenCalledWith(oldSubmit.mock.calls[0]![0]);
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();

    await act(async () => oldOperation.resolve(completedReceipt(oldSubmit.mock.calls[0]![0])));
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(finishButton()).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Manual resolution" })).toBeInTheDocument();
  });

  it.each(["indeterminate receipt", "mismatched receipt", "thrown error"] as const)(
    "keeps replacement-port reconciliation pending after a late %s",
    async (lateOutcome) => {
      const user = userEvent.setup();
      const oldSubmission = deferred<ManualResolutionResult>();
      const oldSubmit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
        .mockReturnValue(oldSubmission.promise);
      const oldPort = makePort(oldSubmit);
      const reconciliation = deferred<ManualResolutionReconciliation>();
      const newReconcile = vi.fn<ManualResolutionCommandPort["reconcileManualResolution"]>()
        .mockReturnValue(reconciliation.promise);
      const newPort = makePort(vi.fn(), newReconcile);
      const nextBinding: ManualResolutionCommandBinding = {
        interactionId: "manual-session.1.2" as InteractionId,
        adapterGeneration: initialBinding.adapterGeneration + 1,
      };
      const { rerender } = render(<TestHarness commandPort={oldPort} canFinish />);
      await selectTargetAndEnterAmount(user);
      await user.click(submitButton());

      rerender(<TestHarness commandPort={newPort} commandBinding={nextBinding} canFinish />);
      await user.click(screen.getByRole("button", { name: "Check status" }));
      expect(newReconcile).toHaveBeenCalledOnce();

      const originalRequest = oldSubmit.mock.calls[0]![0];
      await act(async () => {
        if (lateOutcome === "indeterminate receipt") {
          oldSubmission.resolve(indeterminateReceipt(originalRequest, "The original result is still unknown."));
        } else if (lateOutcome === "mismatched receipt") {
          oldSubmission.resolve({
            binding: {
              ...originalRequest.binding,
              interactionId: "manual-session.1.3" as InteractionId,
            },
            status: "completed",
          });
        } else {
          oldSubmission.reject(new Error("The original delivery call failed."));
        }
      });

      expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
      expect(submitButton()).toBeDisabled();
      expect(finishButton()).toBeDisabled();
      expect(newReconcile).toHaveBeenCalledOnce();

      await act(async () => reconciliation.resolve(
        indeterminateReconciliation(originalRequest, "The authoritative result remains unknown."),
      ));
      expect(await screen.findByRole("button", { name: "Check status" })).toBeEnabled();
      expect(submitButton()).toBeDisabled();
      expect(finishButton()).toBeDisabled();
    },
  );

  it("keeps the original request indeterminate if reconciliation cannot confirm it after replacement", async () => {
    const user = userEvent.setup();
    const oldSubmission = deferred<ManualResolutionResult>();
    const oldSubmit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockReturnValue(oldSubmission.promise);
    const oldPort = makePort(oldSubmit);
    const newReconciliation = deferred<ManualResolutionReconciliation>();
    const newReconcile = vi.fn<ManualResolutionCommandPort["reconcileManualResolution"]>()
      .mockReturnValue(newReconciliation.promise);
    const newSubmit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>();
    const newPort = makePort(newSubmit, newReconcile);
    const nextBinding: ManualResolutionCommandBinding = {
      interactionId: "manual-session.1.2" as InteractionId,
      adapterGeneration: initialBinding.adapterGeneration + 1,
    };
    const { rerender } = render(<TestHarness commandPort={oldPort} canFinish />);
    await selectTargetAndEnterAmount(user);
    await user.click(submitButton());

    rerender(<TestHarness commandPort={newPort} commandBinding={nextBinding} canFinish />);
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    expect(submitButton()).toBeDisabled();
    expect(finishButton()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(newReconcile).toHaveBeenCalledOnce();
    expect(newReconcile).toHaveBeenCalledWith(oldSubmit.mock.calls[0]![0]);
    expect(oldPort.reconcileManualResolution).not.toHaveBeenCalled();
    expect(submitButton()).toBeDisabled();
    expect(finishButton()).toBeDisabled();

    await act(async () => oldSubmission.resolve(completedReceipt(oldSubmit.mock.calls[0]![0])));
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    expect(finishButton()).toBeEnabled();

    // A late reconciliation response for that same request cannot undo the
    // matching original completion receipt.
    await act(async () => newReconciliation.resolve(
      notAppliedReconciliation(oldSubmit.mock.calls[0]![0], "Conflicting late status."),
    ));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(finishButton()).toBeEnabled();
    expect(newSubmit).not.toHaveBeenCalled();
  });

  it("carries an indeterminate operation to the replacement port's reconciliation", async () => {
    const user = userEvent.setup();
    const oldSubmit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockImplementation(async (request) => indeterminateReceipt(request, "The old port could not determine delivery."));
    const oldPort = makePort(oldSubmit);
    const newReconcile = vi.fn<ManualResolutionCommandPort["reconcileManualResolution"]>()
      .mockImplementation(async (request) => completedReconciliation(request));
    const newPort = makePort(vi.fn(), newReconcile);
    const nextBinding: ManualResolutionCommandBinding = {
      interactionId: "manual-session.1.2" as InteractionId,
      adapterGeneration: initialBinding.adapterGeneration + 1,
    };
    const { rerender } = render(<TestHarness commandPort={oldPort} canFinish />);
    await selectTargetAndEnterAmount(user);
    await user.click(submitButton());
    expect(await screen.findByRole("button", { name: "Check status" })).toBeInTheDocument();

    rerender(<TestHarness commandPort={newPort} commandBinding={nextBinding} canFinish />);
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    expect(submitButton()).toBeDisabled();
    expect(finishButton()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(finishButton()).toBeEnabled());
    expect(newReconcile).toHaveBeenCalledOnce();
    expect(newReconcile).toHaveBeenCalledWith(oldSubmit.mock.calls[0]![0]);
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
  });

  it("does not publish a late Finish completion after unmount", async () => {
    const finish = deferred<ManualResolutionResult>();
    const submit = vi.fn<ManualResolutionCommandPort["submitManualResolutionCommand"]>()
      .mockReturnValue(finish.promise);
    const onFinished = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<TestHarness commandPort={makePort(submit)} canFinish onFinished={onFinished} />);
    await user.click(finishButton());
    unmount();

    await act(async () => finish.resolve(completedReceipt(submit.mock.calls[0]![0])));

    expect(onFinished).not.toHaveBeenCalled();
  });

  it("stops only handled Escape from reaching the actual global keyboard listener", () => {
    act(() => useUiStore.setState({ selectedCardIds: [10] }));
    render(<KeyboardSandboxHarness />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Outside control" }), { key: "Escape" });
    expect(useUiStore.getState().selectedCardIds).toEqual([]);

    act(() => useUiStore.setState({ selectedCardIds: [10] }));
    fireEvent.click(screen.getByRole("button", { name: "Ari player area" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Clear target" }), { key: "Escape" });

    expect(useUiStore.getState().selectedCardIds).toEqual([10]);
    expect(screen.getByRole("region", { name: "Game board" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear target" })).not.toBeInTheDocument();

    act(() => useUiStore.setState({ selectedCardIds: [10] }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Mira player area" }), { key: "Escape" });
    expect(useUiStore.getState().selectedCardIds).toEqual([10]);
  });
});
