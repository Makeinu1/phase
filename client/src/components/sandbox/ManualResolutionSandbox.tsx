import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";

import type { PlayerId } from "../../adapter/types.ts";
import { CardImage } from "../card/CardImage.tsx";
import {
  type ManualResolutionCommandBinding,
  type ManualResolutionCommandPort,
  type ManualResolutionOperationAvailability,
  type ManualResolutionReconciliation,
  type ManualResolutionResult,
  type ManualResolutionSourceContext,
  type ManualResolutionSourceReference,
  type ManualResolutionUiCommand,
  type ManualResolutionRequest,
} from "./manual-resolution-ui-contract.ts";

export interface ManualResolutionSandboxSource extends ManualResolutionSourceContext {
  cardName: string;
  oracleText: string;
}

export interface ManualResolutionSandboxTarget {
  playerId: PlayerId;
  name: string;
}

interface ManualResolutionSandboxProps {
  source: ManualResolutionSandboxSource;
  /** Local seat identity used only to constrain the selectable target. */
  viewerPlayerId: PlayerId | null;
  /** Controlled by the board's real PlayerArea selection surfaces. */
  selectedTarget: ManualResolutionSandboxTarget | null;
  onSelectedTargetChange: (target: ManualResolutionSandboxTarget | null) => void;
  /** Must come from the current native frame until its action contract is published. */
  operationAvailability: ManualResolutionOperationAvailability;
  /** Authoritative frame capability; local UI state only adds in-flight safety gates. */
  canFinish: boolean;
  /** Interaction identity and adapter context shown in the current native frame. */
  commandBinding: ManualResolutionCommandBinding;
  /** Increment only after an authoritative Undo/restore replaces the timeline. */
  confirmedRestoreEpoch: number;
  /** Bound to the current authenticated session and exact paused source occurrence. */
  commandPort: ManualResolutionCommandPort;
  returnFocusRef: RefObject<HTMLElement | null>;
  onFinished?: () => void;
}

type PendingCommand = "life-loss" | "finish";
type AttemptPhase = "pending" | "indeterminate" | "reconciling";

interface ActiveAttempt {
  request: ManualResolutionRequest;
  phase: AttemptPhase;
}

function sameBinding(
  left: ManualResolutionCommandBinding,
  right: ManualResolutionCommandBinding,
): boolean {
  return left.interactionId === right.interactionId &&
    left.adapterGeneration === right.adapterGeneration;
}

function parseAmount(value: string, bounds: ManualResolutionOperationAvailability["amountBounds"]): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(bounds.minimum)) return null;
  if (bounds.maximum !== null && !Number.isSafeInteger(bounds.maximum)) return null;
  if (bounds.maximum !== null && bounds.maximum < bounds.minimum) return null;
  if (amount < bounds.minimum || (bounds.maximum !== null && amount > bounds.maximum)) return null;
  return amount;
}

function rejectionMessage(result: Extract<ManualResolutionResult, { status: "rejected" }>): string {
  const reason = result.reason.trim();
  return reason || "The operation was rejected. Review it and try again.";
}

function uncertainMessage(reason?: string): string {
  const detail = reason?.trim();
  return detail
    ? `Delivery is unknown: ${detail} Check status before retrying.`
    : "Delivery is unknown. Check status before retrying.";
}

/**
 * Source refs fence the stateful session. A replacement context-bound port for
 * the same source inherits uncertainty until it can authoritatively reconcile
 * it. `episodeId` only resets local selection/amount input.
 */
export function ManualResolutionSandbox(props: ManualResolutionSandboxProps) {
  const { confirmedRestoreEpoch, onSelectedTargetChange, source } = props;
  const previousRestoreEpochRef = useRef(confirmedRestoreEpoch);
  const lifecycleKey = JSON.stringify([
    source.stackEntryId,
    source.sourceObjectId,
    confirmedRestoreEpoch,
  ]);

  useLayoutEffect(() => {
    if (previousRestoreEpochRef.current === confirmedRestoreEpoch) return;
    previousRestoreEpochRef.current = confirmedRestoreEpoch;
    onSelectedTargetChange(null);
  }, [confirmedRestoreEpoch, onSelectedTargetChange]);

  return <ManualResolutionSandboxSession key={lifecycleKey} {...props} />;
}

function ManualResolutionSandboxSession({
  source,
  viewerPlayerId,
  selectedTarget,
  onSelectedTargetChange,
  operationAvailability,
  canFinish,
  commandBinding,
  commandPort,
  returnFocusRef,
  onFinished,
}: ManualResolutionSandboxProps) {
  const titleId = useId();
  const amountLabelId = useId();
  const amountHintId = useId();
  const [amountText, setAmountText] = useState("");
  const [activeAttempt, setActiveAttempt] = useState<ActiveAttempt | null>(null);
  const [announcement, setAnnouncement] = useState("Select a player area on the board.");
  const [error, setError] = useState<string | null>(null);
  const [hasFinished, setHasFinished] = useState(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const previousEpisodeIdRef = useRef(source.episodeId);
  const previousCommandPortRef = useRef(commandPort);
  const previousAdapterGenerationRef = useRef(commandBinding.adapterGeneration);
  const activeAttemptRef = useRef<ActiveAttempt | null>(null);
  const reconciliationPendingRef = useRef(false);
  const reconciliationTokenRef = useRef(0);
  const hasFinishedRef = useRef(false);

  const updateActiveAttempt = useCallback((next: ActiveAttempt | null): void => {
    activeAttemptRef.current = next;
    setActiveAttempt(next);
  }, []);

  const invalidateReconciliation = useCallback((): void => {
    reconciliationTokenRef.current += 1;
    reconciliationPendingRef.current = false;
  }, []);

  useLayoutEffect(() => {
    const generation = ++generationRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (generationRef.current === generation) generationRef.current += 1;
      activeAttemptRef.current = null;
      reconciliationTokenRef.current += 1;
      reconciliationPendingRef.current = false;
    };
  }, [source.stackEntryId, source.sourceObjectId]);

  useLayoutEffect(() => {
    const portChanged = previousCommandPortRef.current !== commandPort;
    const adapterGenerationChanged =
      previousAdapterGenerationRef.current !== commandBinding.adapterGeneration;
    const episodeChanged = previousEpisodeIdRef.current !== source.episodeId;
    if (!portChanged && !adapterGenerationChanged && !episodeChanged) return;

    previousCommandPortRef.current = commandPort;
    previousAdapterGenerationRef.current = commandBinding.adapterGeneration;
    previousEpisodeIdRef.current = source.episodeId;
    onSelectedTargetChange(null);
    setAmountText("");

    if (portChanged || adapterGenerationChanged) {
      // Preserve the full request across same-timeline context changes. A
      // matching original receipt may still settle it; otherwise the new port
      // must reconcile that exact request before another action is enabled.
      invalidateReconciliation();
      const attempt = activeAttemptRef.current;
      if (attempt !== null) {
        updateActiveAttempt({ request: attempt.request, phase: "indeterminate" });
        setError(uncertainMessage("The command context changed before delivery was confirmed."));
        setAnnouncement("Delivery is unknown. Check status before retrying.");
      } else {
        setError(null);
        setAnnouncement("Select a player area on the board.");
      }
    } else if (activeAttemptRef.current?.phase === "indeterminate") {
      setAnnouncement("Delivery remains unknown. Check status before retrying.");
    } else if (activeAttemptRef.current?.phase === "pending" || activeAttemptRef.current?.phase === "reconciling") {
      setAnnouncement("The current operation remains pending.");
    } else {
      setError(null);
      setAnnouncement("Episode changed. Select a player area on the board.");
    }
  }, [
    source.episodeId,
    commandPort,
    commandBinding.adapterGeneration,
    onSelectedTargetChange,
    invalidateReconciliation,
    updateActiveAttempt,
  ]);

  const sourceReference: ManualResolutionSourceReference = {
    stackEntryId: source.stackEntryId,
    sourceObjectId: source.sourceObjectId,
  };
  const parsedAmount = parseAmount(amountText, operationAvailability.amountBounds);
  const selectedOwnArea = viewerPlayerId !== null && selectedTarget?.playerId === viewerPlayerId;
  const activeKind: PendingCommand | null = activeAttempt === null
    ? null
    : activeAttempt.request.command.type === "lose-life" ? "life-loss" : "finish";
  const busy = activeAttempt?.phase === "pending" || activeAttempt?.phase === "reconciling";
  const isUnresolved = activeAttempt?.phase === "indeterminate" || activeAttempt?.phase === "reconciling";
  const canSubmit =
    operationAvailability.available &&
    selectedOwnArea &&
    parsedAmount !== null &&
    !busy &&
    !isUnresolved &&
    !hasFinished;
  const effectiveCanFinish = canFinish && !busy && !isUnresolved && !hasFinished;

  function isCurrentGeneration(generation: number): boolean {
    return mountedRef.current && generationRef.current === generation;
  }

  function activeAttemptFor(request: ManualResolutionRequest): ActiveAttempt | null {
    const current = activeAttemptRef.current as ActiveAttempt | null;
    return current?.request === request ? current : null;
  }

  function unresolvedPhase(): AttemptPhase {
    return reconciliationPendingRef.current ? "reconciling" : "indeterminate";
  }

  function reportUncertainRequest(request: ManualResolutionRequest, reason?: string): void {
    const phase = unresolvedPhase();
    updateActiveAttempt({ request, phase });
    setError(uncertainMessage(reason));
    setAnnouncement(phase === "reconciling"
      ? "Checking operation status."
      : "Delivery is unknown. Check status before retrying.");
  }

  function focusSafely(): void {
    try {
      returnFocusRef.current?.focus();
    } catch {
      // Focus is an accessibility side effect and cannot change a native receipt.
    }
  }

  function runFinishEffects(): void {
    hasFinishedRef.current = true;
    setHasFinished(true);
    setError(null);
    setAnnouncement("Resolution finished.");
    try {
      onFinished?.();
    } catch {
      // The native Finish result remains successful if an observer fails.
    }
    focusSafely();
  }

  function completeCommand(kind: PendingCommand): void {
    invalidateReconciliation();
    updateActiveAttempt(null);
    setError(null);
    if (kind === "finish") {
      runFinishEffects();
      return;
    }
    setAmountText("");
    setAnnouncement("Operation complete. You may apply another operation or finish when allowed.");
  }

  function applyResult(result: ManualResolutionResult, request: ManualResolutionRequest, kind: PendingCommand): void {
    if (!sameBinding(result.binding, request.binding)) {
      reportUncertainRequest(request, "The receipt binding did not match the submitted request.");
      return;
    }

    if (result.status === "completed") {
      completeCommand(kind);
    } else if (result.status === "rejected") {
      invalidateReconciliation();
      updateActiveAttempt(null);
      setError(rejectionMessage(result));
      setAnnouncement("The operation was not applied. Review it and try again.");
    } else {
      reportUncertainRequest(request, result.reason);
    }
  }

  async function submitCommand(command: ManualResolutionUiCommand, kind: PendingCommand): Promise<void> {
    if (activeAttemptRef.current !== null || reconciliationPendingRef.current || hasFinishedRef.current) return;
    const request: ManualResolutionRequest = {
      binding: { ...commandBinding },
      command: { ...command },
    };
    updateActiveAttempt({ request, phase: "pending" });
    setError(null);
    setAnnouncement(kind === "finish" ? "Finishing resolution." : "Applying operation.");
    const generation = generationRef.current;

    try {
      const result = await commandPort.submitManualResolutionCommand(request);
      if (!isCurrentGeneration(generation)) return;
      if (activeAttemptFor(request) === null) return;
      applyResult(result, request, kind);
    } catch (submitError: unknown) {
      if (!isCurrentGeneration(generation)) return;
      if (activeAttemptFor(request) === null) return;
      reportUncertainRequest(request, submitError instanceof Error ? submitError.message : undefined);
    } finally {
      if (isCurrentGeneration(generation)) {
        const attempt = activeAttemptFor(request);
        if (attempt?.phase === "pending") {
          updateActiveAttempt({ request, phase: "indeterminate" });
          setError(uncertainMessage());
          setAnnouncement("Delivery is unknown. Check status before retrying.");
        }
      }
    }
  }

  async function submitLifeLoss(): Promise<void> {
    if (!canSubmit || parsedAmount === null || selectedTarget === null) return;
    const command: ManualResolutionUiCommand = {
      type: "lose-life",
      ...sourceReference,
      affectedPlayerId: selectedTarget.playerId,
      amount: parsedAmount,
    };
    await submitCommand(command, "life-loss");
  }

  async function finishResolution(): Promise<void> {
    if (!effectiveCanFinish || activeAttemptRef.current !== null || reconciliationPendingRef.current) return;
    await submitCommand({ type: "finish", ...sourceReference }, "finish");
  }

  function applyReconciliation(
    result: ManualResolutionReconciliation,
    request: ManualResolutionRequest,
    kind: PendingCommand,
  ): void {
    if (!sameBinding(result.binding, request.binding)) {
      updateActiveAttempt({ request, phase: "indeterminate" });
      setError(uncertainMessage("The reconciliation binding did not match the original request."));
      setAnnouncement("Delivery is still unknown. Check status before retrying.");
      return;
    }

    if (result.status === "completed") {
      completeCommand(kind);
    } else if (result.status === "not-applied") {
      invalidateReconciliation();
      updateActiveAttempt(null);
      setError(result.reason?.trim() || "The operation was not applied. You may try again.");
      setAnnouncement("The operation was not applied. Review it and try again.");
    } else {
      updateActiveAttempt({ request, phase: "indeterminate" });
      setError(uncertainMessage(result.reason));
      setAnnouncement("Delivery is still unknown. Check status before retrying.");
    }
  }

  async function checkStatus(): Promise<void> {
    const attempt = activeAttemptRef.current;
    if (attempt?.phase !== "indeterminate" || reconciliationPendingRef.current) return;
    const request = attempt.request;
    const kind: PendingCommand = request.command.type === "lose-life" ? "life-loss" : "finish";
    const generation = generationRef.current;
    const reconciliationToken = ++reconciliationTokenRef.current;
    reconciliationPendingRef.current = true;
    updateActiveAttempt({ request, phase: "reconciling" });
    setError(null);
    setAnnouncement("Checking operation status.");

    try {
      const result = await commandPort.reconcileManualResolution(request);
      if (
        !isCurrentGeneration(generation) ||
        reconciliationTokenRef.current !== reconciliationToken ||
        activeAttemptRef.current?.request !== request
      ) return;
      applyReconciliation(result, request, kind);
    } catch {
      if (
        !isCurrentGeneration(generation) ||
        reconciliationTokenRef.current !== reconciliationToken ||
        activeAttemptRef.current?.request !== request
      ) return;
      updateActiveAttempt({ request, phase: "indeterminate" });
      setError(uncertainMessage("The port could not confirm the result."));
      setAnnouncement("Delivery is still unknown. Check status before retrying.");
    } finally {
      if (reconciliationTokenRef.current === reconciliationToken) {
        reconciliationPendingRef.current = false;
        const current = activeAttemptRef.current;
        if (current?.request === request && current.phase === "reconciling") {
          updateActiveAttempt({ request, phase: "indeterminate" });
        }
      }
    }
  }

  function handleKeyDownCapture(event: KeyboardEvent<HTMLElement>): void {
    // This sandbox owns its local keyboard scope. Keep browser defaults for
    // Enter, Space, Tab, and other keys while preventing global shortcuts.
    event.stopPropagation();
    if (event.key !== "Escape") return;
    event.preventDefault();

    if (busy) {
      setAnnouncement("Wait for the current operation to finish.");
      return;
    }
    if (isUnresolved) {
      setAnnouncement("Check status before retrying this operation.");
      return;
    }

    onSelectedTargetChange(null);
    setAmountText("");
    setError(null);
    setAnnouncement("Selection cleared. Choose a player area on the board.");
    focusSafely();
  }

  if (hasFinished) {
    return (
      <section aria-labelledby={titleId} className="rounded-xl border border-emerald-400/30 bg-slate-950/80 p-5 text-slate-100">
        <h2 id={titleId} className="text-lg font-semibold">Finished</h2>
        <p role="status" className="mt-2 text-sm text-emerald-200">Resolution finished.</p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-cyan-200/20 bg-slate-950/90 p-4 text-slate-100 shadow-lg sm:p-6"
      onKeyDownCapture={handleKeyDownCapture}
    >
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
        <div>
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-cyan-200/75">Private UI experiment</p>
          <h2 id={titleId} className="mt-1 text-xl font-semibold">Manual resolution</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-300">Keep the resolving card in view, choose a target on the board, apply the available operation, then finish when the native frame allows it.</p>
        </div>
        <span className="rounded-full border border-amber-200/30 bg-amber-100/5 px-3 py-1 text-xs text-amber-100">Sandbox only</span>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(14rem,0.8fr)_minmax(20rem,1.4fr)]">
        <aside aria-label="Resolving source card" className="rounded-lg border border-white/10 bg-black/20 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">Resolving source</h3>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <div
              className="shrink-0"
              style={{ "--card-w": "9rem", "--card-h": "12.6rem", "--card-size-scale": 1 } as CSSProperties}
            >
              <CardImage cardName={source.cardName} oracleText={source.oracleText} size="normal" />
            </div>
            <div className="min-w-0">
              <h4 className="font-semibold text-white">{source.cardName}</h4>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{source.oracleText}</p>
            </div>
          </div>
        </aside>

        <div className="rounded-lg border border-white/10 bg-slate-900/70 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">Manual operation</h3>
          {selectedTarget ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-white/10 bg-black/25 px-3 py-2">
              <p className="text-sm text-slate-200">Target: <span className="font-semibold text-white">{selectedTarget.name}</span></p>
              <button
                type="button"
                disabled={busy || isUnresolved || hasFinished}
                onClick={() => onSelectedTargetChange(null)}
                className="rounded px-2 py-1 text-xs text-cyan-100 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200 disabled:opacity-50"
              >
                Clear target
              </button>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-400">Select a player area on the board.</p>
          )}

          <form
            className="mt-3 rounded-lg border border-cyan-200/20 bg-black/25 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitLifeLoss();
            }}
          >
            <label htmlFor={amountLabelId} className="block text-sm font-medium text-white">Amount</label>
            <input
              id={amountLabelId}
              aria-describedby={amountHintId}
              aria-invalid={amountText.length > 0 && parsedAmount === null}
              type="number"
              inputMode="numeric"
              min={operationAvailability.amountBounds.minimum}
              max={operationAvailability.amountBounds.maximum ?? undefined}
              step={1}
              value={amountText}
              disabled={!operationAvailability.available || !selectedOwnArea || busy || isUnresolved || hasFinished}
              onChange={(event) => {
                setAmountText(event.currentTarget.value);
                setError(null);
              }}
              className="mt-2 w-full rounded-md border border-white/15 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-200 focus:ring-2 focus:ring-cyan-200/30 disabled:opacity-60"
            />
            <p id={amountHintId} className="mt-1 text-xs text-slate-400">
              {operationAvailability.available
                ? selectedTarget !== null && !selectedOwnArea
                  ? "Select your player area to apply this operation."
                  : `Allowed amount: ${operationAvailability.amountBounds.minimum} to ${operationAvailability.amountBounds.maximum ?? "no upper limit"}.`
                : "This operation is unavailable in the current frame."}
            </p>
            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-3 w-full rounded-md bg-cyan-100 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {activeKind === "life-loss" && activeAttempt?.phase === "pending" ? "Applying…" : "Apply"}
            </button>
            <button
              type="button"
              disabled={!effectiveCanFinish}
              onClick={() => void finishResolution()}
              className="mt-2 w-full rounded-md border border-white/15 px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-slate-500"
            >
              {activeKind === "finish" && activeAttempt?.phase === "pending" ? "Finishing…" : "Finish"}
            </button>
            {isUnresolved && (
              <button
                type="button"
                disabled={activeAttempt?.phase === "reconciling"}
                onClick={() => void checkStatus()}
                className="mt-2 w-full rounded-md border border-amber-200/30 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-100/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200 disabled:opacity-50"
              >
                {activeAttempt?.phase === "reconciling" ? "Checking…" : "Check status"}
              </button>
            )}
          </form>
        </div>
      </div>

      <p role="status" aria-live="polite" className="mt-4 min-h-5 text-sm text-slate-300">{announcement}</p>
      {error && <p role="alert" className="mt-2 rounded-md border border-rose-300/20 bg-rose-950/30 px-3 py-2 text-sm text-rose-100">{error}</p>}
      <p role="note" className="mt-4 border-t border-white/10 pt-3 text-xs leading-relaxed text-slate-400">
        Local experiment only. The board owns target selection; this component submits through a session-bound port and does not update game state.
      </p>
      <p className="sr-only" aria-live="polite">{busy ? "A manual-resolution operation is pending." : isUnresolved ? "Operation delivery is unknown; check status before continuing." : ""}</p>
    </section>
  );
}
