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
import { useTranslation } from "react-i18next";

import type { PlayerId } from "../../adapter/types.ts";
import type { ManualResolutionPhase } from "../../adapter/generated/interaction";
import i18n from "../../i18n";
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
  /** Receipt completion never substitutes for this current engine-owned phase. */
  resolutionPhase: ManualResolutionPhase;
  /** The production board retains input across private viewing round trips. */
  amountText?: string;
  onAmountTextChange?: (amount: string) => void;
  onPreviewSource?: () => void;
  /** Interaction identity and adapter context shown in the current native frame. */
  commandBinding: ManualResolutionCommandBinding;
  /** Increment only after an authoritative Undo/restore replaces the timeline. */
  confirmedRestoreEpoch: number;
  /** Bound to the current authenticated session and exact paused source occurrence. */
  commandPort: ManualResolutionCommandPort | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  onFinished?: () => void;
}

type PendingCommand = "life-loss" | "finish";
type AttemptPhase = "pending" | "authority-pending" | "indeterminate" | "reconciling";

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
  return reason || i18n.t("game:manualResolution.operationRejected");
}

function uncertainMessage(reason?: string): string {
  const detail = reason?.trim();
  return detail
    ? i18n.t("game:manualResolution.deliveryUnknownDetail", { detail })
    : i18n.t("game:manualResolution.deliveryUnknown");
}

/**
 * The receipt session identity and source refs fence local state. Replacing a
 * port within that same authenticated timeline preserves its uncertainty.
 * `episodeId` only resets local selection/amount input.
 */
export function ManualResolutionSandbox(props: ManualResolutionSandboxProps) {
  const { t } = useTranslation("game");
  if (props.commandPort === null) {
    return (
      <section aria-label={t("manualResolution.title")} className="rounded-xl border border-cyan-200/20 bg-slate-950/90 p-4 text-slate-100 shadow-lg">
        <h2 className="text-lg font-semibold">{props.source.cardName}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{props.source.oracleText}</p>
        {props.onPreviewSource && <button type="button" onClick={props.onPreviewSource} className="mt-2 rounded px-2 py-1 text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200">{t("manualResolution.readSource")}</button>}
        <p className="mt-3 text-sm text-slate-400">{t("manualResolution.displayOnly")}</p>
      </section>
    );
  }
  return <ManualResolutionSandboxOwner {...props} commandPort={props.commandPort} />;
}

type ManualResolutionOwnerProps = Omit<ManualResolutionSandboxProps, "commandPort"> & {
  commandPort: ManualResolutionCommandPort;
};

function ManualResolutionSandboxOwner(props: ManualResolutionOwnerProps) {
  const { commandPort, confirmedRestoreEpoch, onSelectedTargetChange, source } = props;
  const { receiptSessionIdentity } = commandPort;
  const [sessionFence, setSessionFence] = useState(() => ({ receiptSessionIdentity, revision: 0 }));
  // Reset during render so the old child never commits the new session's port.
  // This revision only keys React state; the port's actual session identity is
  // the authority for the comparison, not a UI-invented authentication key.
  if (sessionFence.receiptSessionIdentity !== receiptSessionIdentity) {
    setSessionFence({ receiptSessionIdentity, revision: sessionFence.revision + 1 });
  }
  const previousContextRef = useRef({ confirmedRestoreEpoch, receiptSessionIdentity });
  const lifecycleKey = JSON.stringify([
    source.stackEntryId,
    source.sourceObjectId,
    confirmedRestoreEpoch,
    sessionFence.revision,
  ]);

  useLayoutEffect(() => {
    const previous = previousContextRef.current;
    if (previous.confirmedRestoreEpoch === confirmedRestoreEpoch &&
      previous.receiptSessionIdentity === receiptSessionIdentity) return;
    previousContextRef.current = { confirmedRestoreEpoch, receiptSessionIdentity };
    onSelectedTargetChange(null);
  }, [confirmedRestoreEpoch, onSelectedTargetChange, receiptSessionIdentity]);

  return <ManualResolutionSandboxSession key={lifecycleKey} {...props} />;
}

function ManualResolutionSandboxSession({
  source,
  viewerPlayerId,
  selectedTarget,
  onSelectedTargetChange,
  operationAvailability,
  canFinish,
  resolutionPhase,
  amountText: controlledAmountText,
  onAmountTextChange,
  onPreviewSource,
  commandBinding,
  commandPort,
  returnFocusRef,
  onFinished,
}: ManualResolutionOwnerProps) {
  const { t } = useTranslation("game");
  const titleId = useId();
  const amountLabelId = useId();
  const amountHintId = useId();
  const [localAmountText, setLocalAmountText] = useState("");
  const amountText = controlledAmountText ?? localAmountText;
  const setAmountText = useCallback((value: string) => {
    setLocalAmountText(value);
    onAmountTextChange?.(value);
  }, [onAmountTextChange]);
  const [activeAttempt, setActiveAttempt] = useState<ActiveAttempt | null>(null);
  const [announcement, setAnnouncement] = useState(() => t("manualResolution.selectPlayerArea"));
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
  const currentBindingRef = useRef(commandBinding);
  const [completedFinish, setCompletedFinish] = useState<ManualResolutionRequest | null>(null);

  useLayoutEffect(() => {
    currentBindingRef.current = commandBinding;
  }, [commandBinding]);

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
    if (activeAttemptRef.current !== null) return;
    const retainedRequest = commandPort.getUnresolvedManualResolutionRequest();
    if (retainedRequest === null) return;
    // Recover the session's exact request, rather than reconstructing it from
    // the newly displayed source/binding or treating a remount as a restore.
    updateActiveAttempt({ request: retainedRequest, phase: "indeterminate" });
    setError(uncertainMessage(t("manualResolution.contextChanged")));
    setAnnouncement(t("manualResolution.deliveryRemainsUnknown"));
  }, [commandPort, t, updateActiveAttempt]);

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
        setError(uncertainMessage(t("manualResolution.contextChanged")));
        setAnnouncement(t("manualResolution.deliveryUnknown"));
      } else {
        setError(null);
        setAnnouncement(t("manualResolution.selectPlayerArea"));
      }
    } else if (activeAttemptRef.current?.phase === "indeterminate") {
      setAnnouncement(t("manualResolution.deliveryRemainsUnknown"));
    } else if (activeAttemptRef.current?.phase === "pending" || activeAttemptRef.current?.phase === "reconciling") {
      setAnnouncement(t("manualResolution.operationPending"));
    } else {
      setError(null);
      setAnnouncement(t("manualResolution.sourceChanged"));
    }
  }, [
    source.episodeId,
    commandPort,
    commandBinding.adapterGeneration,
    onSelectedTargetChange,
    invalidateReconciliation,
    updateActiveAttempt,
    setAmountText,
    t,
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
  const isUnresolved = activeAttempt?.phase === "authority-pending" || activeAttempt?.phase === "indeterminate" || activeAttempt?.phase === "reconciling";
  const hasCurrentCompletedFinish = completedFinish !== null && sameBinding(completedFinish.binding, commandBinding)
    && completedFinish.command.stackEntryId === source.stackEntryId
    && completedFinish.command.sourceObjectId === source.sourceObjectId;
  const canSubmit =
    operationAvailability.available &&
    selectedOwnArea &&
    parsedAmount !== null &&
    !busy &&
    !isUnresolved &&
    resolutionPhase === "open" &&
    !hasCurrentCompletedFinish &&
    !hasFinished;
  const effectiveCanFinish = canFinish && resolutionPhase === "open" && !hasCurrentCompletedFinish && !busy && !isUnresolved && !hasFinished;

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
      ? t("manualResolution.checkingStatus")
      : t("manualResolution.deliveryUnknown"));
  }

  function focusSafely(): void {
    try {
      returnFocusRef.current?.focus();
    } catch {
      // Focus is an accessibility side effect and cannot change a native receipt.
    }
  }

  function runFinishEffects(): void {
    if (hasFinishedRef.current) return;
    hasFinishedRef.current = true;
    setHasFinished(true);
    setError(null);
    setAnnouncement(t("manualResolution.finished"));
    try {
      onFinished?.();
    } catch {
      // The native Finish result remains successful if an observer fails.
    }
    focusSafely();
  }

  function completeCommand(kind: PendingCommand, request: ManualResolutionRequest): void {
    invalidateReconciliation();
    updateActiveAttempt(null);
    setError(null);
    // A historical receipt only clears its original uncertainty. A restored
    // interaction on the same source retains its own input and Finish state.
    if (!sameBinding(request.binding, currentBindingRef.current) ||
      request.command.stackEntryId !== source.stackEntryId ||
      request.command.sourceObjectId !== source.sourceObjectId) {
      setAnnouncement(t("manualResolution.operationComplete"));
      return;
    }
    if (kind === "finish") {
      setCompletedFinish(request);
      setAnnouncement(t("manualResolution.waitingForClosure"));
      return;
    }
    setAmountText("");
    setAnnouncement(t("manualResolution.operationComplete"));
  }

  function applyResult(result: ManualResolutionResult, request: ManualResolutionRequest, kind: PendingCommand): void {
    if (!sameBinding(result.binding, request.binding)) {
      reportUncertainRequest(request, t("manualResolution.receiptMismatch"));
      return;
    }

    if (result.status === "completed") {
      completeCommand(kind, request);
    } else if (result.status === "rejected") {
      invalidateReconciliation();
      updateActiveAttempt(null);
      setError(rejectionMessage(result));
      setAnnouncement(t("manualResolution.notAppliedReview"));
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
    setAnnouncement(kind === "finish" ? t("manualResolution.finishing") : t("manualResolution.applying"));
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
          setAnnouncement(t("manualResolution.deliveryUnknown"));
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
      setError(uncertainMessage(t("manualResolution.reconciliationMismatch")));
      setAnnouncement(t("manualResolution.deliveryStillUnknown"));
      return;
    }

    if (result.status === "pending") {
      updateActiveAttempt({ request, phase: "authority-pending" });
      setError(null);
      setAnnouncement(t("manualResolution.authorityPending"));
    } else if (result.status === "completed") {
      completeCommand(kind, request);
    } else if (result.status === "not-applied") {
      invalidateReconciliation();
      updateActiveAttempt(null);
      setError(result.reason?.trim() || t("manualResolution.notAppliedRetry"));
      setAnnouncement(t("manualResolution.notAppliedReview"));
    } else {
      updateActiveAttempt({ request, phase: "indeterminate" });
      setError(uncertainMessage(result.reason));
      setAnnouncement(t("manualResolution.deliveryStillUnknown"));
    }
  }

  async function checkStatus(): Promise<void> {
    const attempt = activeAttemptRef.current;
    if ((attempt?.phase !== "indeterminate" && attempt?.phase !== "authority-pending") || reconciliationPendingRef.current) return;
    const request = attempt.request;
    const kind: PendingCommand = request.command.type === "lose-life" ? "life-loss" : "finish";
    const generation = generationRef.current;
    const reconciliationToken = ++reconciliationTokenRef.current;
    reconciliationPendingRef.current = true;
    updateActiveAttempt({ request, phase: "reconciling" });
    setError(null);
    setAnnouncement(t("manualResolution.checkingStatus"));

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
      setError(uncertainMessage(t("manualResolution.lookupUnavailable")));
      setAnnouncement(t("manualResolution.deliveryStillUnknown"));
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
      setAnnouncement(t("manualResolution.waitForOperation"));
      return;
    }
    if (isUnresolved) {
      setAnnouncement(t("manualResolution.checkBeforeRetry"));
      return;
    }

    onSelectedTargetChange(null);
    setAmountText("");
    setError(null);
    setAnnouncement(t("manualResolution.selectionCleared"));
    focusSafely();
  }

  useLayoutEffect(() => {
    if (hasCurrentCompletedFinish && resolutionPhase === "closed") {
      runFinishEffects();
    }
  });

  if (hasFinished) {
    return (
      <section aria-labelledby={titleId} className="rounded-xl border border-emerald-400/30 bg-slate-950/80 p-5 text-slate-100">
        <h2 id={titleId} className="text-lg font-semibold">{t("manualResolution.finishedTitle")}</h2>
        <p role="status" className="mt-2 text-sm text-emerald-200">{t("manualResolution.finished")}</p>
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
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-cyan-200/75">{t("manualResolution.localOnly")}</p>
          <h2 id={titleId} className="mt-1 text-xl font-semibold">{t("manualResolution.title")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-300">{t("manualResolution.scope")}</p>
        </div>
        <span className="rounded-full border border-amber-200/30 bg-amber-100/5 px-3 py-1 text-xs text-amber-100">{t("manualResolution.localOnly")}</span>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)]">
        <aside aria-label={t("manualResolution.sourceCard")} className="rounded-lg border border-white/10 bg-black/20 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">{t("manualResolution.source")}</h3>
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
              {onPreviewSource && (
                <button type="button" onClick={onPreviewSource} className="mt-2 rounded px-2 py-1 text-sm text-cyan-100 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200">
                  {t("manualResolution.readSource")}
                </button>
              )}
            </div>
          </div>
        </aside>

        <div className="rounded-lg border border-white/10 bg-slate-900/70 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">{t("manualResolution.operation")}</h3>
          {selectedTarget ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-white/10 bg-black/25 px-3 py-2">
              <p className="text-sm text-slate-200">{t("manualResolution.target")} <span className="font-semibold text-white">{selectedTarget.name}</span></p>
              <button
                type="button"
                disabled={busy || isUnresolved || hasFinished}
                onClick={() => onSelectedTargetChange(null)}
                className="rounded px-2 py-1 text-xs text-cyan-100 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200 disabled:opacity-50"
              >
                {t("manualResolution.clearTarget")}
              </button>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-400">{t("manualResolution.selectPlayerArea")}</p>
          )}

          <form
            className="mt-3 rounded-lg border border-cyan-200/20 bg-black/25 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitLifeLoss();
            }}
          >
            <label htmlFor={amountLabelId} className="block text-sm font-medium text-white">{t("manualResolution.amount")}</label>
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
              disabled={!operationAvailability.available || !selectedOwnArea || busy || isUnresolved || hasFinished || completedFinish !== null || resolutionPhase !== "open"}
              onChange={(event) => {
                setAmountText(event.currentTarget.value);
                setError(null);
              }}
              className="mt-2 w-full rounded-md border border-white/15 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-200 focus:ring-2 focus:ring-cyan-200/30 disabled:opacity-60"
            />
            <p id={amountHintId} className="mt-1 text-xs text-slate-400">
              {operationAvailability.available
                ? selectedTarget !== null && !selectedOwnArea
                  ? t("manualResolution.selectOwnArea")
                  : operationAvailability.amountBounds.maximum === null
                    ? t("manualResolution.amountUnbounded", { minimum: operationAvailability.amountBounds.minimum })
                    : t("manualResolution.amountBounded", { minimum: operationAvailability.amountBounds.minimum, maximum: operationAvailability.amountBounds.maximum })
                : t("manualResolution.operationUnavailable")}
            </p>
            <p className="mt-2 text-sm text-cyan-100">
              {selectedOwnArea && parsedAmount !== null && selectedTarget !== null
                ? t("manualResolution.lossPreview", { player: selectedTarget.name, amount: parsedAmount })
                : t("manualResolution.lifeLossOnly")}
            </p>
            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-3 w-full rounded-md bg-cyan-100 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {activeKind === "life-loss" && activeAttempt?.phase === "pending" ? t("manualResolution.applyingButton") : t("manualResolution.apply")}
            </button>
            <button
              type="button"
              disabled={!effectiveCanFinish}
              onClick={() => void finishResolution()}
              className="mt-2 w-full rounded-md border border-white/15 px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-slate-500"
            >
              {activeKind === "finish" && activeAttempt?.phase === "pending" ? t("manualResolution.finishingButton") : t("manualResolution.finish")}
            </button>
            {isUnresolved && (
              <button
                type="button"
                disabled={activeAttempt?.phase === "reconciling"}
                onClick={() => void checkStatus()}
                className="mt-2 w-full rounded-md border border-amber-200/30 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-100/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200 disabled:opacity-50"
              >
                {activeAttempt?.phase === "reconciling" ? t("manualResolution.checkingButton") : t("manualResolution.checkStatus")}
              </button>
            )}
          </form>
        </div>
      </div>

      <p role="status" aria-live="polite" className="mt-4 min-h-5 text-sm text-slate-300">{announcement}</p>
      {error && <p role="alert" className="mt-2 rounded-md border border-rose-300/20 bg-rose-950/30 px-3 py-2 text-sm text-rose-100">{error}</p>}
      <p role="note" className="mt-4 border-t border-white/10 pt-3 text-xs leading-relaxed text-slate-400">
        {resolutionPhase === "terminalChildPending" ? t("manualResolution.terminalChildPending") : t("manualResolution.lifeLossOnly")}
      </p>
      <p className="sr-only" aria-live="polite">{busy ? t("manualResolution.operationPending") : activeAttempt?.phase === "authority-pending" ? t("manualResolution.authorityPending") : isUnresolved ? t("manualResolution.deliveryUnknown") : ""}</p>
    </section>
  );
}
