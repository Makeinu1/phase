import { describe, expect, it, vi } from "vitest";
import type { EngineSnapshot } from "../../adapter/types";
import { buildGameState } from "../../test/factories/gameStateFactory";
import { TrustedHistory, type HistoryAcceptance, type HistoryBinding, type HistoryPorts } from "../trustedHistory";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(budget?: number) {
  let seq = 1;
  let raw = "PRE-0";
  let current = true;
  let session = true;
  const nextSeq = () => ++seq;
  const binding: HistoryBinding = { gameId: "game", gameSessionGeneration: 1, branchId: "branch-0", generation: 1, commitSeq: seq };
  const adapter = {
    exportPersistenceState: vi.fn(async () => raw),
    restoreTrustedState: vi.fn(async (value: string) => { raw = value; }),
    getSnapshot: vi.fn(async (): Promise<EngineSnapshot> => ({ state: buildGameState(), legalResult: { actions: [], autoPassRecommended: false }, seq: ++seq })),
  };
  const ports: HistoryPorts = {
    adapter,
    isCurrent: vi.fn(() => current),
    isSessionCurrent: vi.fn(() => session),
    submit: vi.fn(async (operation, parent): Promise<HistoryAcceptance> => {
      raw = `POST-${operation.rootId}`;
      return { status: "accepted", rootId: operation.rootId, parent, commitSeq: ++seq };
    }),
    commitAccepted: vi.fn(() => true),
    beforeRestore: vi.fn(async () => {}),
    fenceMutations: vi.fn(async () => {}),
    commitRestore: vi.fn((snapshot, previous) => {
      current = true;
      return { ...previous, branchId: `branch-${snapshot.seq}`, generation: previous.generation + 1, commitSeq: snapshot.seq };
    }),
    prepareStorage: vi.fn(),
  };
  const history = new TrustedHistory(ports, binding, budget);
  const perform = (rootId: string, actor = 0) => history.perform({ rootId, actor });
  return { history, ports, adapter, perform, nextSeq, raw: () => raw, stale: () => { current = false; }, newSession: () => { session = false; }, binding };
}

function timeline(history: TrustedHistory) {
  const { cursor, binding, entries } = history.inspect();
  return { cursor, binding, entries };
}

describe("unconnected trusted history transaction", () => {
  it.each(["session", "binding"])("keeps restore PRE/cursor locked if adopted restore loses %s", async (fault) => {
    const s = setup(); await s.perform("a"); const before = timeline(s.history);
    const bytes = s.history.inspect().retainedBytes;
    vi.mocked(s.ports.commitRestore).mockImplementationOnce((snapshot, previous) => {
      if (fault === "session") s.newSession(); else s.stale();
      return { ...previous, branchId: "fresh", generation: previous.generation + 1, commitSeq: snapshot.seq };
    });
    await expect(s.history.undo()).rejects.toThrow("Stale adopted restore");
    expect(timeline(s.history)).toEqual(before);
    expect(s.history.inspect()).toMatchObject({ phase: "recovery", retainedBytes: bytes });
    await expect(s.perform("blocked")).rejects.toThrow("locked");
    if (fault === "session") { await expect(s.history.recover()).rejects.toThrow("Stale restore session"); s.history.dispose(); }
    else { await s.history.recover(); expect(s.history.inspect()).toMatchObject({ phase: "idle", cursor: 0, retainedBytes: bytes }); }
  });

  it("adopts the accepted pair while locked before replacing history", async () => {
    const s = setup();
    vi.mocked(s.ports.commitAccepted).mockImplementationOnce((receipt) => {
      expect(s.history.inspect()).toMatchObject({ phase: "submit", cursor: 0, entries: [] });
      expect(receipt).toMatchObject({ rootId: "a", parent: s.binding, commitSeq: 2 });
      return true;
    });
    await expect(s.perform("a")).resolves.toBe("accepted");
    expect(s.ports.commitAccepted).toHaveBeenCalledTimes(1);
  });

  it.each(["false", "throw", "partial", "session", "cancel", "binding"])(
    "keeps old history/future and pending PRE locked after %s adoption", async (fault) => {
      const s = setup(); await s.perform("a"); await s.perform("b"); await s.history.undo();
      const before = timeline(s.history); const bytes = s.history.inspect().retainedBytes;
      vi.mocked(s.ports.commitAccepted).mockImplementationOnce(() => {
        if (fault === "false") return false;
        if (fault === "throw") throw new Error("before adoption");
        if (fault === "partial") { s.stale(); throw new Error("partial adoption"); }
        if (fault === "session") s.newSession();
        if (fault === "cancel") s.history.cancelPending();
        if (fault === "binding") s.stale();
        return true;
      });
      await expect(s.perform("new")).rejects.toThrow();
      expect(timeline(s.history)).toEqual(before);
      expect(s.history.inspect()).toMatchObject({ phase: "recovery", retainedBytes: bytes + 6 });
      await expect(s.perform("forbidden")).rejects.toThrow("locked");
      if (fault === "session") {
        await expect(s.history.recover()).rejects.toThrow("Stale restore session");
        s.history.dispose();
      } else {
        await s.history.recover();
        expect(s.raw()).toBe("POST-a");
        expect(s.history.inspect()).toMatchObject({ phase: "idle", cursor: before.cursor,
          entries: before.entries, retainedBytes: bytes });
      }
    },
  );

  it("captures and reserves BEFORE submit, binds actor/root/parent and confirms once", async () => {
    const s = setup();
    await expect(s.perform("cast-and-payment", 1)).resolves.toBe("accepted");
    expect(s.history.inspect()).toMatchObject({ phase: "idle", cursor: 1, retainedBytes: 5, entries: [{ operation: { rootId: "cast-and-payment", actor: 1 }, parent: s.binding, acceptedCommitSeq: 2 }] });
    expect(s.adapter.exportPersistenceState.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(s.ports.prepareStorage!).mock.invocationCallOrder[0]);
    expect(vi.mocked(s.ports.prepareStorage!).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(s.ports.submit).mock.invocationCallOrder[0]);
    const before = timeline(s.history);
    await expect(s.perform("cast-and-payment")).rejects.toThrow("Duplicate");
    expect(timeline(s.history)).toEqual(before);
    expect(s.ports.submit).toHaveBeenCalledTimes(1);
  });

  it.each(["capture", "reserve", "budget"])("%s failure occurs before submit with unchanged engine/history", async (fault) => {
    const s = setup(fault === "budget" ? 4 : undefined);
    if (fault === "capture") s.adapter.exportPersistenceState.mockRejectedValueOnce(new Error("capture failed"));
    if (fault === "reserve") vi.mocked(s.ports.prepareStorage!).mockImplementationOnce(() => { throw new Error("reservation failed"); });
    const before = timeline(s.history);
    await expect(s.perform("op")).rejects.toThrow();
    expect(timeline(s.history)).toEqual(before);
    expect(s.history.inspect()).toMatchObject({ phase: "idle", retainedBytes: 0 });
    expect(s.raw()).toBe("PRE-0");
    expect(s.ports.submit).not.toHaveBeenCalled();
  });

  it("rejection after Undo keeps the entire future and byte references", async () => {
    const s = setup();
    await s.perform("a"); await s.perform("b", 1); await s.history.undo();
    const before = timeline(s.history);
    const bytes = s.history.inspect().retainedBytes;
    vi.mocked(s.ports.submit).mockResolvedValueOnce({ status: "rejected" });
    await expect(s.perform("new")).resolves.toBe("rejected");
    expect(timeline(s.history)).toEqual(before);
    expect(s.history.inspect().retainedBytes).toBe(bytes);
    expect(s.history.inspect().phase).toBe("idle");
  });

  it("cancellation during capture never submits or drops future", async () => {
    const s = setup(); await s.perform("a"); await s.history.undo();
    const before = timeline(s.history);
    const capture = deferred<string>(); s.adapter.exportPersistenceState.mockReturnValueOnce(capture.promise);
    const result = s.perform("canceled"); s.history.cancelPending(); capture.resolve("captured");
    await expect(result).resolves.toBe("canceled");
    expect(timeline(s.history)).toEqual(before);
    expect(s.ports.submit).toHaveBeenCalledTimes(1);
  });

  it("stale capture or reservation never submits", async () => {
    for (const fault of ["capture", "reserve"]) {
      const s = setup(); const before = timeline(s.history);
      if (fault === "capture") s.adapter.exportPersistenceState.mockImplementationOnce(async () => { s.stale(); return "PRE"; });
      else vi.mocked(s.ports.prepareStorage!).mockImplementationOnce(s.stale);
      await expect(s.perform("op")).rejects.toThrow("Stale");
      expect(timeline(s.history)).toEqual(before);
      expect(s.ports.submit).not.toHaveBeenCalled();
      expect(s.history.inspect().retainedBytes).toBe(0);
    }
  });

  it.each(["root", "parent", "duplicate", "stale", "cancel", "throw"])("%s result after submit leaves history unchanged and locks recovery", async (fault) => {
    const s = setup(); await s.perform("a"); const before = timeline(s.history);
    vi.mocked(s.ports.submit).mockImplementationOnce(async (operation, parent) => {
      if (fault === "throw") throw new Error("uncertain submit");
      if (fault === "stale") s.stale();
      if (fault === "cancel") s.history.cancelPending();
      return { status: "accepted", rootId: fault === "root" ? "other" : operation.rootId,
        parent: fault === "parent" ? { ...parent, branchId: "old-branch" } : parent,
        commitSeq: fault === "duplicate" ? parent.commitSeq : 99 };
    });
    await expect(s.perform("b")).rejects.toThrow();
    expect(timeline(s.history)).toEqual(before);
    expect(s.history.inspect().phase).toBe("recovery");
    await expect(s.perform("c")).rejects.toThrow("locked");
    await expect(s.history.undo()).rejects.toThrow("locked");
  });

  it("continuous global Undo crosses actors; future is released only after accepted new root", async () => {
    const s = setup(); await s.perform("a", 0); await s.perform("b", 1); await s.perform("c", 0);
    const bytes = s.history.inspect().retainedBytes;
    await s.history.undo(); expect(s.raw()).toBe("POST-b");
    await s.history.undo(); expect(s.raw()).toBe("POST-a");
    expect(s.history.inspect()).toMatchObject({ cursor: 1, retainedBytes: bytes });
    const pending = deferred<HistoryAcceptance>();
    vi.mocked(s.ports.submit).mockReturnValueOnce(pending.promise);
    const before = timeline(s.history); const result = s.perform("new", 1);
    await vi.waitFor(() => expect(s.history.inspect().phase).toBe("submit"));
    expect(timeline(s.history)).toEqual(before);
    pending.resolve({ status: "accepted", rootId: "new", parent: before.binding, commitSeq: s.nextSeq() });
    await result;
    expect(s.history.inspect()).toMatchObject({ cursor: 2, retainedBytes: 11 });
    expect(s.history.inspect().entries.map((entry) => entry.operation.rootId)).toEqual(["a", "new"]);
    await s.history.undo(); await s.history.undo(); expect(s.raw()).toBe("PRE-0");
    await expect(s.history.undo()).rejects.toThrow("No history");
    expect(s.history.inspect().phase).toBe("idle");
  });

  it("keeps future while checking injected total bytes; no silent eviction", async () => {
    const s = setup(11); await s.perform("a"); await s.perform("b"); await s.history.undo();
    const before = timeline(s.history);
    await expect(s.perform("new")).rejects.toThrow("budget");
    expect(timeline(s.history)).toEqual(before);
    expect(s.ports.submit).toHaveBeenCalledTimes(2);
    expect(s.history.inspect().retainedBytes).toBe(11);
  });

  it("preflight failure does not restore, commit or change cursor/authority", async () => {
    const s = setup(); await s.perform("a"); const before = timeline(s.history);
    vi.mocked(s.ports.beforeRestore!).mockRejectedValueOnce(new Error("preflight failed"));
    await expect(s.history.undo()).rejects.toThrow("preflight");
    expect(timeline(s.history)).toEqual(before);
    expect(s.raw()).toBe("POST-a"); expect(s.adapter.restoreTrustedState).not.toHaveBeenCalled();
    expect(s.ports.commitRestore).not.toHaveBeenCalled(); expect(s.history.inspect().phase).toBe("idle");
  });

  it.each(["restore", "snapshot", "commit", "authority", "fence"])("%s failure after lock requires recovery with fresh authority", async (fault) => {
    const s = setup(); await s.perform("a"); const before = timeline(s.history);
    if (fault === "restore") s.adapter.restoreTrustedState.mockRejectedValueOnce(new Error("restore uncertain"));
    if (fault === "snapshot") s.adapter.getSnapshot.mockRejectedValueOnce(new Error("snapshot failed"));
    if (fault === "commit") vi.mocked(s.ports.commitRestore).mockImplementationOnce(() => { s.stale(); throw new Error("partial commit"); });
    if (fault === "authority") vi.mocked(s.ports.commitRestore).mockImplementationOnce(() => s.binding);
    if (fault === "fence") vi.mocked(s.ports.fenceMutations).mockRejectedValueOnce(new Error("fence failed"));
    await expect(s.history.undo()).rejects.toThrow();
    expect(timeline(s.history)).toEqual(before); expect(s.history.inspect().phase).toBe("recovery");
    await expect(s.history.undo()).rejects.toThrow("locked");
    await s.history.recover();
    expect(s.raw()).toBe("PRE-0");
    expect(s.history.inspect()).toMatchObject({ phase: "idle", cursor: 0 });
    expect(s.history.inspect().binding.generation).toBeGreaterThan(before.binding.generation);
    expect(s.history.inspect().binding.branchId).not.toBe(before.binding.branchId);
  });

  it("waits for the actual delayed mutation fence before recovery restore", async () => {
    const s = setup();
    vi.mocked(s.ports.submit).mockRejectedValueOnce(new Error("timeout: mutation still live"));
    await expect(s.perform("late")).rejects.toThrow("timeout");
    const drained = deferred<void>(); vi.mocked(s.ports.fenceMutations).mockReturnValueOnce(drained.promise);
    const recovery = s.history.recover();
    expect(s.history.inspect().phase).toBe("restore");
    await expect(s.history.recover()).rejects.toThrow("No recovery");
    await expect(s.perform("race")).rejects.toThrow("locked");
    expect(s.adapter.restoreTrustedState).not.toHaveBeenCalled();
    // Transport settles the old mutation, then signals the fence. The manager
    // must restore AFTER it, so the late operation cannot overwrite the recovery.
    await s.adapter.restoreTrustedState("LATE-MUTATION");
    drained.resolve(); await recovery;
    expect(s.raw()).toBe("PRE-0");
    expect(s.adapter.restoreTrustedState.mock.calls.map(([raw]) => raw)).toEqual(["LATE-MUTATION", "PRE-0"]);
    expect(s.history.inspect()).toMatchObject({ phase: "idle", cursor: 0, retainedBytes: 0 });
  });

  it("old session result cannot commit or unlock; session teardown releases references", async () => {
    const s = setup(); await s.perform("a"); const before = timeline(s.history);
    s.adapter.getSnapshot.mockImplementationOnce(async () => { s.newSession(); return { state: buildGameState(), legalResult: { actions: [], autoPassRecommended: false }, seq: 3 }; });
    await expect(s.history.undo()).rejects.toThrow("Stale restore");
    expect(timeline(s.history)).toEqual(before); expect(s.ports.commitRestore).not.toHaveBeenCalled();
    await expect(s.history.recover()).rejects.toThrow("Stale restore session");
    s.history.dispose(); expect(s.history.inspect()).toMatchObject({ phase: "disposed", retainedBytes: 0, entries: [] });
    await expect(s.perform("op")).rejects.toThrow("locked");
  });

  it("cannot discard a live-session recovery PRE while a timed-out mutation may still run", async () => {
    const s = setup(); await s.perform("a");
    vi.mocked(s.ports.submit).mockRejectedValueOnce(new Error("timeout: still running"));
    await expect(s.perform("late")).rejects.toThrow("timeout");
    const before = s.history.inspect();
    expect(() => s.history.dispose()).toThrow("session still active");
    expect(s.history.inspect()).toEqual(before);
    expect(s.history.inspect().phase).toBe("recovery");
    s.newSession();
    s.history.dispose();
    expect(s.history.inspect()).toMatchObject({ phase: "disposed", cursor: 0, retainedBytes: 0, entries: [] });
  });

  it("also requires session teardown before disposing idle history", async () => {
    const s = setup(); await s.perform("a"); const before = s.history.inspect();
    expect(() => s.history.dispose()).toThrow("session still active");
    expect(s.history.inspect()).toEqual(before);
    s.newSession(); s.history.dispose();
    expect(s.history.inspect()).toMatchObject({ phase: "disposed", retainedBytes: 0 });
  });

  it("competing submit/Undo cannot enter while capture or restore is in flight", async () => {
    const s = setup(); const capture = deferred<string>(); s.adapter.exportPersistenceState.mockReturnValueOnce(capture.promise);
    const result = s.perform("a"); await expect(s.history.undo()).rejects.toThrow("locked");
    await expect(s.perform("b")).rejects.toThrow("locked"); expect(() => s.history.dispose()).toThrow("locked");
    capture.resolve("PRE-0"); await result;
    const restore = deferred<void>(); s.adapter.restoreTrustedState.mockReturnValueOnce(restore.promise);
    const undo = s.history.undo(); await vi.waitFor(() => expect(s.adapter.restoreTrustedState).toHaveBeenCalled());
    await expect(s.history.undo()).rejects.toThrow("locked"); await expect(s.perform("c")).rejects.toThrow("locked");
    restore.resolve(); await undo;
  });

  it("copies caller metadata before asynchronous capture", async () => {
    const s = setup(); const capture = deferred<string>(); s.adapter.exportPersistenceState.mockReturnValueOnce(capture.promise);
    const operation = { rootId: "original", actor: 1 };
    const pending = s.history.perform(operation);
    operation.rootId = "mutated"; operation.actor = 0;
    capture.resolve("PRE"); await pending;
    expect(s.history.inspect().entries[0].operation).toEqual({ rootId: "original", actor: 1 });
    expect(Object.isFrozen(s.history.inspect().entries[0].operation)).toBe(true);
    expect(Object.isFrozen(s.history.inspect().binding)).toBe(true);
  });

  it("retains only explicit metadata, without caller payload/state references", async () => {
    const s = setup(); const payload = { secret: "not history authority" };
    const binding = { ...s.binding, raw: "RAW", payload };
    const history = new TrustedHistory(s.ports, binding);
    const operation = { rootId: "op", actor: 0, raw: "RAW", payload };
    await history.perform(operation);
    const entry = history.inspect().entries[0];
    expect(entry.operation).toEqual({ rootId: "op", actor: 0 });
    expect(entry.parent).toEqual(s.binding);
    expect(history.inspect().binding).toEqual({ ...s.binding, commitSeq: 2 });
    vi.mocked(s.ports.commitRestore).mockImplementationOnce((snapshot, previous) => ({ ...previous,
      branchId: "restored", generation: 2, commitSeq: snapshot.seq, raw: "RAW", payload }));
    await history.undo();
    expect(Object.keys(history.inspect().binding).sort()).toEqual(Object.keys(s.binding).sort());
  });

  it("unlocks an operation metadata getter failure before capture/submit", async () => {
    const s = setup(); const before = timeline(s.history);
    const operation = { get rootId(): string { throw new Error("metadata copy failed"); }, actor: 0 };
    await expect(s.history.perform(operation)).rejects.toThrow("metadata copy");
    expect(timeline(s.history)).toEqual(before);
    expect(s.history.inspect()).toMatchObject({ phase: "idle", retainedBytes: 0 });
    expect(s.adapter.exportPersistenceState).not.toHaveBeenCalled();
    expect(s.ports.submit).not.toHaveBeenCalled();
    await expect(s.perform("next")).resolves.toBe("accepted");
  });

  it("same-session branch/generation invalidation during fence never writes the old PRE", async () => {
    const s = setup(); await s.perform("a"); const before = timeline(s.history);
    const fence = deferred<void>(); vi.mocked(s.ports.fenceMutations).mockReturnValueOnce(fence.promise);
    const undo = s.history.undo(); await vi.waitFor(() => expect(s.ports.fenceMutations).toHaveBeenCalled());
    s.stale(); fence.resolve();
    await expect(undo).rejects.toThrow("Stale restore binding");
    expect(s.adapter.restoreTrustedState).not.toHaveBeenCalled();
    expect(s.adapter.getSnapshot).not.toHaveBeenCalled();
    expect(s.ports.commitRestore).not.toHaveBeenCalled();
    expect(timeline(s.history)).toEqual(before);
    expect(s.history.inspect().phase).toBe("recovery");
    await expect(s.history.recover()).rejects.toThrow("Stale restore binding");
    expect(s.adapter.restoreTrustedState).not.toHaveBeenCalled();
  });

  it.each(["gameId", "gameSessionGeneration", "branchId", "generation", "commitSeq"] as const)("rejects a receipt with stale %s", async (field) => {
    const s = setup(); const before = timeline(s.history);
    vi.mocked(s.ports.submit).mockImplementationOnce(async (operation, parent) => ({
      status: "accepted", rootId: operation.rootId, parent: { ...parent, [field]: typeof parent[field] === "string" ? "stale" : -1 }, commitSeq: 2,
    }));
    await expect(s.perform("op")).rejects.toThrow("Stale");
    expect(timeline(s.history)).toEqual(before); expect(s.history.inspect().phase).toBe("recovery");
  });

  it("cancellation after submit waits for terminal result then restores pending PRE under recovery lock", async () => {
    const s = setup(); await s.perform("a"); await s.perform("b"); await s.history.undo();
    const before = timeline(s.history); const bytes = s.history.inspect().retainedBytes;
    const receipt = deferred<HistoryAcceptance>(); vi.mocked(s.ports.submit).mockReturnValueOnce(receipt.promise);
    const pending = s.perform("new"); await vi.waitFor(() => expect(s.history.inspect().phase).toBe("submit"));
    s.history.cancelPending(); await expect(s.history.recover()).rejects.toThrow("No recovery");
    receipt.resolve({ status: "accepted", rootId: "new", parent: before.binding, commitSeq: s.nextSeq() });
    await expect(pending).rejects.toThrow("Stale"); expect(timeline(s.history)).toEqual(before);
    await s.history.recover(); expect(s.raw()).toBe("POST-a");
    expect(s.history.inspect()).toMatchObject({ phase: "idle", cursor: 1, retainedBytes: bytes, entries: before.entries });
    expect(s.history.inspect().binding).not.toEqual(before.binding);
  });
});
