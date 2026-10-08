import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineWorkerClient } from "../engine-worker-client";
import type {
  GameEvent,
  LocalCapture,
  LocalContinuationEnvelope,
  LocalContinuationResult,
  LocalOriginalAttempt,
} from "../types";
import type {
  InteractionChoiceId,
  InteractionId,
  InteractionSessionId,
} from "../generated/interaction";

const notifyEngineSlow = vi.hoisted(() => vi.fn());
vi.mock("../../game/engineRecovery", () => ({
  notifyEngineSlow,
}));

/**
 * Controllable stand-in for the engine Web Worker. Captures posted messages
 * and lets a test decide whether (and when) to reply, so we can exercise the
 * watchdog timeout that surfaces a slow-operation dialog while preserving the
 * in-flight request for a late worker response.
 */
class MockWorker {
  /** The most recently constructed instance, so a test can drive its replies. */
  static last: MockWorker | undefined;

  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly posted: Array<Record<string, unknown>> = [];

  constructor() {
    MockWorker.last = this;
  }

  postMessage(msg: Record<string, unknown>): void {
    this.posted.push(msg);
  }

  terminate(): void {}

  /** Simulate a `result` reply for a previously-posted request id. */
  replyResult(id: number, data: unknown): void {
    this.onmessage?.({ data: { type: "result", id, data } } as MessageEvent);
  }

  /** Simulate a typed failure reply for a previously-posted request id. */
  replyError(
    id: number,
    message: string,
    actionRejection?: unknown,
  ): void {
    this.onmessage?.({
      data: { type: "error", id, message, actionRejection },
    } as MessageEvent);
  }

  /** Simulate failure to load or execute the worker script itself. */
  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function currentWorker(): MockWorker {
  if (!MockWorker.last) throw new Error("no MockWorker constructed yet");
  return MockWorker.last;
}

beforeEach(() => {
  vi.stubGlobal("Worker", MockWorker);
});

describe("EngineWorkerClient initialization", () => {
  it("resolves normally when the worker initializes before the deadline", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const promise = client.initialize();
    const worker = currentWorker();
    const reqId = worker.posted[0].id as number;

    worker.replyResult(reqId, null);

    await expect(promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
  });

  it("rejects when WASM initialization returns a typed worker error", async () => {
    const client = new EngineWorkerClient();
    const promise = client.initialize();
    const worker = currentWorker();
    const reqId = worker.posted[0].id as number;

    worker.replyError(reqId, "WASM initialization failed");

    await expect(promise).rejects.toThrow("WASM initialization failed");
  });

  it("rejects when the worker script fails during initialization", async () => {
    const client = new EngineWorkerClient();
    const promise = client.initialize();

    currentWorker().emitError("Worker script failed to load");

    await expect(promise).rejects.toThrow("Worker script failed to load");
  });

  it("rejects when the worker never responds to initialization", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const promise = client.initialize();
    const rejection = expect(promise).rejects.toThrow(
      "Engine worker init timed out after 30000ms",
    );

    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
  });
});

afterEach(() => {
  vi.useRealTimers();
  notifyEngineSlow.mockClear();
  vi.unstubAllGlobals();
});

describe("EngineWorkerClient request timeout", () => {
  it("notifies on a slow gameplay round-trip but keeps the request alive", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();

    const promise = client.getState();
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const worker = currentWorker();
    const reqId = worker.posted[0].id as number;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(notifyEngineSlow).toHaveBeenCalledWith("getState-timeout");
    expect(settled).toBe(false);

    worker.replyResult(reqId, { stack: [] });
    await expect(promise).resolves.toEqual({ stack: [] });
  });

  it("does not false-reject when the worker replies before the timeout, and clears the timer", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();

    const promise = client.getState();
    const worker = currentWorker();
    const reqId = worker.posted[0].id as number;

    // Slow-but-completing reply at 30s — well within the 60s watchdog.
    await vi.advanceTimersByTimeAsync(30_000);
    worker.replyResult(reqId, { stack: [] });

    await expect(promise).resolves.toEqual({ stack: [] });

    // Pushing past the original deadline must not re-settle or throw: the
    // settle path cleared the watchdog timer. A still-pending timer would
    // fire here and reject an already-resolved promise (an unhandled
    // rejection that fails the run).
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toEqual({ stack: [] });
  });

  it("keeps an ordinary interaction alive for a late ACK after notifying", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const submission = {
      interactionId: "ordinary.frame" as InteractionId,
      response: { type: "choose" as const, data: { choiceId: "ordinary.pass" as InteractionChoiceId } },
    };
    const promise = client.submitInteraction(0, submission);
    const settled = vi.fn();
    void promise.then(settled, settled);
    const worker = currentWorker();
    expect(worker.posted).toEqual([
      { type: "submitInteraction", actor: 0, submission, id: 0 },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(notifyEngineSlow).toHaveBeenCalledExactlyOnceWith("submitInteraction-timeout");
    expect(settled).not.toHaveBeenCalled();
    const answer = { events: [], log_entries: [] };
    worker.replyResult(0, answer);
    await expect(promise).resolves.toEqual(answer);
    expect(worker.posted).toHaveLength(1);
    client.dispose();
  });
});

describe("EngineWorkerClient Local continuation timeout", () => {
  const context: LocalCapture = {
    ownerLineage: "owner.fixture",
    interactionSessionId: "session.fixture" as InteractionSessionId,
    restoreEpoch: 0,
    adapterGeneration: 10,
  };
  const attempt: LocalOriginalAttempt = {
    context,
    attemptId: "attempt.fixture",
    submission: {
      interactionId: "manual.frame" as InteractionId,
      response: {
        type: "choose",
        data: { choiceId: "manual.life" as InteractionChoiceId },
      },
    },
    source: {
      actor: 0,
      sourceId: 40,
      sourceIncarnation: 2,
      stackEntryId: 44,
      castTurnJournalIndex: 0,
      cardId: 1,
      name: "Fixture",
    },
  };
  const envelopes: LocalContinuationEnvelope[] = [
    { type: "localContinuation", operation: "register", attempt },
    { type: "localContinuation", operation: "apply", attempt },
    { type: "localContinuation", operation: "lookup", attempt },
    { type: "localContinuation", operation: "restore", context, checkpoint: "trusted.fixture" },
  ];
  const requests = [
    ...envelopes.map((submission) => ({
      name: submission.operation,
      message: { type: "submitInteraction", actor: 0, submission },
      send: (client: EngineWorkerClient) => client.submitLocalContinuation(0, submission),
    })),
    {
      name: "current read",
      message: { type: "getViewerSnapshot", viewerId: 0, localContinuation: true },
      send: (client: EngineWorkerClient) => client.readLocalCurrent(),
    },
  ];
  const answer: LocalContinuationResult = {
    type: "localContinuation",
    receipt: null,
    current: null,
    appliedResult: null,
  };

  it.each(requests)("rejects $name at 60 seconds and ignores its late reply without resending", async ({ message, send }) => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const promise = send(client);
    const resolved = vi.fn();
    const rejected = vi.fn();
    void promise.then(resolved, rejected);
    const worker = currentWorker();
    expect(worker.posted).toEqual([{ ...message, id: 0 }]);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(resolved).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    await expect(promise).rejects.toThrow(`Engine worker ${message.type} timed out after 60000ms`);
    expect(notifyEngineSlow).not.toHaveBeenCalled();

    worker.replyResult(0, answer);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolved).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(worker.posted).toEqual([{ ...message, id: 0 }]);
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  });

  it.each(requests)("resolves $name before the deadline and clears its timer", async ({ message, send }) => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const promise = send(client);
    const worker = currentWorker();
    expect(worker.posted).toEqual([{ ...message, id: 0 }]);

    await vi.advanceTimersByTimeAsync(59_999);
    worker.replyResult(0, answer);
    await expect(promise).resolves.toEqual(answer);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toEqual(answer);
    expect(notifyEngineSlow).not.toHaveBeenCalled();
    expect(worker.posted).toHaveLength(1);
    client.dispose();
  });
});

describe("EngineWorkerClient viewer transition projection", () => {
  it("posts the viewer id and event slice to the transition endpoint", async () => {
    const client = new EngineWorkerClient();
    const events: GameEvent[] = [{ type: "GameStarted" }];
    const pending = client.getViewerTransitionSnapshot(1, events);
    const worker = currentWorker();
    const posted = worker.posted[0];

    expect(posted).toMatchObject({
      type: "getViewerTransitionSnapshot",
      viewerId: 1,
      events,
    });

    const answer = {
      state: { state: { waiting_for: { type: "Priority", player: 1 } } },
      actions: [],
      autoPassRecommended: false,
      events,
    };
    worker.replyResult(posted.id as number, answer);

    await expect(pending).resolves.toEqual(answer);
    client.dispose();
  });

  it("surfaces recoverable Rust validation errors from the transition endpoint", async () => {
    const client = new EngineWorkerClient();
    const pending = client.getViewerTransitionSnapshot(256, []);
    const worker = currentWorker();
    const requestId = worker.posted[0].id as number;

    worker.replyError(requestId, "INVALID_VIEWER_ID: 256 exceeds u8 range");

    await expect(pending).rejects.toThrow("INVALID_VIEWER_ID: 256 exceeds u8 range");
    client.dispose();
  });

  it("does not treat malformed event input as a successful snapshot", async () => {
    const client = new EngineWorkerClient();
    const pending = client.getViewerTransitionSnapshot(0, []);
    const worker = currentWorker();
    const requestId = worker.posted[0].id as number;

    worker.replyError(requestId, "INVALID_TRANSITION_EVENTS: invalid event payload");

    await expect(pending).rejects.toThrow("INVALID_TRANSITION_EVENTS: invalid event payload");
    client.dispose();
  });
});

describe("EngineWorkerClient canonical card names", () => {
  it("posts the name list to the canonical-name endpoint", async () => {
    const client = new EngineWorkerClient();
    const pending = client.canonicalCardNames(["Revival/Revenge"]);
    const worker = currentWorker();
    const posted = worker.posted[0];

    expect(posted).toMatchObject({
      type: "canonicalCardNames",
      names: ["Revival/Revenge"],
    });

    worker.replyResult(posted.id as number, ["Revival // Revenge"]);

    await expect(pending).resolves.toEqual(["Revival // Revenge"]);
    client.dispose();
  });
});

describe("EngineWorkerClient structured action rejections", () => {
  it("preserves engine rejection metadata and stale disposition", async () => {
    const client = new EngineWorkerClient();
    const promise = client.submitAction(0, { type: "PassPriority" });
    const worker = currentWorker();
    const reqId = worker.posted[0].id as number;
    const rejection = {
      code: "stale_action" as const,
      disposition: "stale" as const,
      message: "That action is based on outdated game state.",
      related_object_ids: [7],
    };

    worker.replyError(reqId, rejection.message, rejection);

    await expect(promise).rejects.toMatchObject({
      code: "STALE_ACTION",
      recoverable: false,
      rejection,
    });
  });

  it("rejects a malformed DTO without surfacing its untrusted message", async () => {
    const client = new EngineWorkerClient();
    const promise = client.submitAction(0, { type: "PassPriority" });
    const worker = currentWorker();
    const reqId = worker.posted[0].id as number;

    worker.replyError(reqId, "untrusted diagnostic", {
      code: "stale_action",
      disposition: "invalid",
      message: "untrusted diagnostic",
      related_object_ids: [7],
    });

    await expect(promise).rejects.toMatchObject({
      code: "ACTION_REJECTED",
      message: "The engine rejected that action.",
      rejection: undefined,
    });
  });
});


describe("EngineWorkerClient experimental Local", () => {
  it("forwards only the valid payload with its own envelope", async () => {
    const client = new EngineWorkerClient();
    const fields = { deckData: null, seed: 42, formatConfig: null, matchConfig: null, playerCount: 2, firstPlayer: 0 };
    const pending = client.initializeExperimentalLocalGame(fields);
    const worker = currentWorker();
    expect(worker.posted[0]).toEqual({ ...fields, type: "initializeExperimentalLocalGame", id: 0 });
    worker.replyResult(0, { events: [], log_entries: [] });
    await expect(pending).resolves.toEqual({ events: [], log_entries: [] }); client.dispose();
  });
  it("rejects hostile fields including caller envelope fields before posting", async () => {
    const client = new EngineWorkerClient();
    for (const key of ["type", "id", "actor", "authenticatedActor", "owner", "session", "ticket", "enrollment", "worker", "unknown"]) {
      await expect(client.initializeExperimentalLocalGame({ seed: 42, [key]: 0 })).rejects.toThrow("Invalid experimental Local request");
    }
    for (const request of [new Date(), new Map(), new (class {})()]) {
      await expect(client.initializeExperimentalLocalGame(request as never)).rejects.toThrow("Invalid experimental Local request");
    }
    expect(currentWorker().posted).toHaveLength(0); client.dispose();
  });
  it("normalizes the primitive verifier without granting another seat", async () => {
    const client = new EngineWorkerClient(); const worker = currentWorker();
    for (const value of [0, 1, null, undefined]) {
      const pending = client.experimentalLocalActor(); const last = worker.posted[worker.posted.length - 1];
      expect(last.type).toBe("experimentalLocalActor"); worker.replyResult(last.id as number, value);
      await expect(pending).resolves.toBe(value === 0 ? 0 : null);
    }
    client.dispose();
  });
});
