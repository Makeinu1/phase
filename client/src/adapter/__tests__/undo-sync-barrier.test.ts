import { describe, expect, it, vi } from "vitest";

import { createPeerSession } from "../../network/peer";
import type { P2PMessage, P2PUndoSyncMetadata } from "../../network/protocol";
import type { P2PAuthorityStamp } from "../../services/p2pSession";
import { buildGameState } from "../../test/factories/gameStateFactory";
import { UndoSyncGuestBarrier, UndoSyncHostBarrier } from "../undo-sync-barrier";
import { FakeDataConnection } from "../../network/__tests__/fakeDataConnection";

class LinkedFakeDataConnection extends FakeDataConnection {
  remote: LinkedFakeDataConnection | null = null;
  readonly deliveries: Promise<void>[] = [];

  override send(data: unknown): void {
    super.send(data);
    if (this.remote && data instanceof Uint8Array) {
      this.remote.deliveries.push(this.remote.simulateData(data).catch(() => undefined));
    }
  }
}

const authority: P2PAuthorityStamp = {
  sessionKey: "undo-session",
  hostIncarnation: "host-incarnation-1",
};

function makePeerPair() {
  const hostConnection = new LinkedFakeDataConnection();
  const guestConnection = new LinkedFakeDataConnection();
  hostConnection.remote = guestConnection;
  guestConnection.remote = hostConnection;
  const hostSession = createPeerSession(hostConnection as never);
  const guestSession = createPeerSession(guestConnection as never);
  return { hostConnection, guestConnection, hostSession, guestSession };
}

async function drainPair(
  hostConnection: LinkedFakeDataConnection,
  guestConnection: LinkedFakeDataConnection,
): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    const deliveries = [
      ...hostConnection.deliveries.splice(0),
      ...guestConnection.deliveries.splice(0),
    ];
    await Promise.all(deliveries);
    await hostConnection.getSentMessages();
    await guestConnection.getSentMessages();
    if (hostConnection.deliveries.length === 0 && guestConnection.deliveries.length === 0) return;
  }
  throw new Error("PeerSession message queues did not drain");
}

describe("Undo P2P adoption barrier", () => {
  it("holds both peers through adopted ACK, release, and exact released ACK", async () => {
    const { hostConnection, guestConnection, hostSession, guestSession } = makePeerPair();
    let currentHostSession = true;
    let currentGuestSession = true;
    const hostInputTransitions: boolean[] = [];
    const guestInputTransitions: boolean[] = [];
    const restoreEngine = vi.fn(async () => undefined);
    const adoptHostUi = vi.fn(async () => undefined);
    const adoptGuestUi = vi.fn(async () => undefined);
    let hostAdoptionFinished!: () => void;
    const hostAdoptionFinishedPromise = new Promise<void>((resolve) => { hostAdoptionFinished = resolve; });
    let finishGuestAdoption!: () => void;
    const guestAdoptionGate = new Promise<void>((resolve) => { finishGuestAdoption = resolve; });
    let guestAdoptionStarted!: () => void;
    const guestAdoptionStartedPromise = new Promise<void>((resolve) => { guestAdoptionStarted = resolve; });
    let finishReleaseAck!: () => void;
    const guestReleaseAckGate = new Promise<void>((resolve) => { finishReleaseAck = resolve; });
    let guestReleaseStarted!: () => void;
    const guestReleaseStartedPromise = new Promise<void>((resolve) => { guestReleaseStarted = resolve; });
    const sentPhases: P2PUndoSyncMetadata[] = [];
    let hostCompleted = false;

    const host = new UndoSyncHostBarrier({
      session: hostSession,
      authority,
      isCurrent: () => currentHostSession,
      setInputBlocked: (blocked) => hostInputTransitions.push(blocked),
      onFatalFailure: vi.fn(),
      sendPhase: async (metadata) => {
        sentPhases.push(metadata);
        const update: P2PMessage = {
          type: "state_update",
          revision: 41,
          state: buildGameState(),
          events: [],
          legalActions: [],
          undoSync: metadata,
          authority,
        };
        return hostSession.send(update);
      },
    });
    const guest = new UndoSyncGuestBarrier({
      session: guestSession,
      authority,
      isCurrent: () => currentGuestSession,
      setInputBlocked: (blocked) => guestInputTransitions.push(blocked),
      onFatalFailure: vi.fn(),
      sendAck: async (metadata, stateRevision) => {
        if (metadata.phase === "released") {
          guestReleaseStarted();
          await guestReleaseAckGate;
        }
        return guestSession.send({
          type: "state_ack",
          revision: stateRevision,
          undoSync: metadata,
          authority,
        });
      },
    });

    guestSession.onMessage(async (message) => {
      if (message.type !== "state_update" || !message.undoSync) return;
      await guest.receivePhase(
        guestSession,
        message.authority,
        message.undoSync,
        message.revision ?? 0,
        async () => {
          guestAdoptionStarted();
          await guestAdoptionGate;
          await adoptGuestUi();
        },
      );
    });
    hostSession.onMessage(async (message) => {
      if (message.type === "state_ack" && message.undoSync) {
        await host.receiveAck(hostSession, message.authority, message.undoSync);
      }
    });

    const transaction = host.begin("undo-exact-1", async () => {
      await restoreEngine();
      await adoptHostUi();
      hostAdoptionFinished();
    }).then(() => { hostCompleted = true; });

    expect(host.isInputBlocked).toBe(true);
    expect(restoreEngine).toHaveBeenCalledTimes(1);
    await hostAdoptionFinishedPromise;
    expect(adoptHostUi).toHaveBeenCalledTimes(1);
    await guestAdoptionStartedPromise;
    expect(guest.isInputBlocked).toBe(true);
    expect(adoptGuestUi).not.toHaveBeenCalled();
    expect(hostCompleted).toBe(false);
    expect(sentPhases).toEqual([{ undoId: "undo-exact-1", revision: 1, phase: "adopted" }]);

    finishGuestAdoption();
    await guestReleaseStartedPromise;
    expect(adoptGuestUi).toHaveBeenCalledTimes(1);
    expect(sentPhases).toEqual([
      { undoId: "undo-exact-1", revision: 1, phase: "adopted" },
      { undoId: "undo-exact-1", revision: 1, phase: "released" },
    ]);
    expect(host.isInputBlocked).toBe(true);
    expect(guest.isInputBlocked).toBe(true);
    expect(hostCompleted).toBe(false);

    finishReleaseAck();
    await drainPair(hostConnection, guestConnection);
    await transaction;
    expect(hostCompleted).toBe(true);
    expect(host.isInputBlocked).toBe(false);
    expect(guest.isInputBlocked).toBe(false);
    expect(hostInputTransitions).toEqual([true, false]);
    expect(guestInputTransitions).toEqual([true, false]);

    const duplicateAdopt = await guest.receivePhase(
      guestSession,
      authority,
      { undoId: "undo-exact-1", revision: 1, phase: "adopted" },
      41,
      adoptGuestUi,
    );
    const duplicateRelease = await guest.receivePhase(
      guestSession,
      authority,
      { undoId: "undo-exact-1", revision: 1, phase: "released" },
      41,
      adoptGuestUi,
    );
    await drainPair(hostConnection, guestConnection);
    expect(duplicateAdopt).toBe(true);
    expect(duplicateRelease).toBe(true);
    expect(restoreEngine).toHaveBeenCalledTimes(1);
    expect(adoptHostUi).toHaveBeenCalledTimes(1);
    expect(adoptGuestUi).toHaveBeenCalledTimes(1);
    expect(hostInputTransitions).toEqual([true, false]);
    expect(guestInputTransitions).toEqual([true, false]);

    currentHostSession = false;
    currentGuestSession = false;
    hostSession.close("test complete");
    guestSession.close("test complete");
  });

  it("rejects wrong peer, authority, ID, stale/future revision and premature phase ACKs", async () => {
    const { hostSession, guestSession } = makePeerPair();
    const staleSession = createPeerSession(new FakeDataConnection() as never);
    const hostInputTransitions: boolean[] = [];
    const sendPhase = vi.fn(async () => true);
    const host = new UndoSyncHostBarrier({
      session: hostSession,
      authority,
      isCurrent: () => true,
      setInputBlocked: (blocked) => hostInputTransitions.push(blocked),
      onFatalFailure: vi.fn(),
      sendPhase,
    });
    const transaction = host.begin("undo-exact-2", async () => undefined);
    await Promise.resolve();
    await Promise.resolve();

    const exactAdopted = { undoId: "undo-exact-2", revision: 1, phase: "adopted" } as const;
    expect(await host.receiveAck(staleSession, authority, exactAdopted)).toBe(false);
    expect(await host.receiveAck(hostSession, { ...authority, hostIncarnation: "old" }, exactAdopted)).toBe(false);
    expect(await host.receiveAck(hostSession, authority, { ...exactAdopted, undoId: "other" })).toBe(false);
    expect(await host.receiveAck(hostSession, authority, { ...exactAdopted, revision: 0 })).toBe(false);
    expect(await host.receiveAck(hostSession, authority, { ...exactAdopted, revision: 2 })).toBe(false);
    expect(await host.receiveAck(hostSession, authority, { ...exactAdopted, phase: "released" })).toBe(false);
    expect(sendPhase).toHaveBeenCalledTimes(1);
    expect(host.isInputBlocked).toBe(true);

    expect(await host.receiveAck(hostSession, authority, exactAdopted)).toBe(true);
    expect(sendPhase).toHaveBeenLastCalledWith({
      undoId: "undo-exact-2",
      revision: 1,
      phase: "released",
    });
    expect(host.isInputBlocked).toBe(true);
    expect(await host.receiveAck(hostSession, authority, {
      undoId: "undo-exact-2",
      revision: 1,
      phase: "released",
    })).toBe(true);
    await transaction;
    expect(host.isInputBlocked).toBe(false);
    expect(hostInputTransitions).toEqual([true, false]);

    staleSession.close("test complete");
    hostSession.close("test complete");
    guestSession.close("test complete");
  });

  it("surfaces a rejected host restore and keeps input held until teardown", async () => {
    const { hostSession } = makePeerPair();
    const onFatalFailure = vi.fn();
    const transitions: boolean[] = [];
    const host = new UndoSyncHostBarrier({
      session: hostSession,
      authority,
      isCurrent: () => true,
      setInputBlocked: (blocked: boolean) => transitions.push(blocked),
      sendPhase: vi.fn(async () => true),
      onFatalFailure,
    } as never);
    const failure = new Error("trusted restore may have partially applied");

    await expect(host.begin("restore-rejected", async () => { throw failure; })).rejects.toBe(failure);

    expect(onFatalFailure).toHaveBeenCalledWith(failure);
    expect(host.isInputBlocked).toBe(true);
    expect(transitions).toEqual([true]);
    host.cancel(new Error("test teardown"));
    hostSession.close("test complete");
  });

  it("fails closed when host currentness is lost after trusted restore", async () => {
    const { hostSession } = makePeerPair();
    let current = true;
    const onFatalFailure = vi.fn();
    const transitions: boolean[] = [];
    const sendPhase = vi.fn(async () => true);
    const host = new UndoSyncHostBarrier({
      session: hostSession,
      authority,
      isCurrent: () => current,
      setInputBlocked: (blocked) => transitions.push(blocked),
      sendPhase,
      onFatalFailure,
    });
    const restore = vi.fn(async () => { current = false; });

    await expect(host.begin("restore-lost-currentness", restore)).rejects.toBeInstanceOf(Error);

    expect(restore).toHaveBeenCalledOnce();
    expect(sendPhase).not.toHaveBeenCalled();
    expect(onFatalFailure).toHaveBeenCalledWith(expect.any(Error));
    expect(host.isInputBlocked).toBe(true);
    expect(transitions).toEqual([true]);
    host.cancel(new Error("test teardown"));
    hostSession.close("test complete");
  });

  it("surfaces an uncertain host phase-send failure without unlocking", async () => {
    const { hostSession } = makePeerPair();
    const onFatalFailure = vi.fn();
    const transitions: boolean[] = [];
    const host = new UndoSyncHostBarrier({
      session: hostSession,
      authority,
      isCurrent: () => true,
      setInputBlocked: (blocked: boolean) => transitions.push(blocked),
      sendPhase: vi.fn(async () => false),
      onFatalFailure,
    } as never);

    await expect(host.begin("phase-send-failed", async () => undefined)).rejects.toThrow(
      "Undo adoption phase could not reach the guest",
    );

    expect(onFatalFailure).toHaveBeenCalledWith(expect.any(Error));
    expect(host.isInputBlocked).toBe(true);
    expect(transitions).toEqual([true]);
    host.cancel(new Error("test teardown"));
    hostSession.close("test complete");
  });

  it("surfaces guest UI adoption failure and keeps input held until teardown", async () => {
    const { guestSession } = makePeerPair();
    const onFatalFailure = vi.fn();
    const transitions: boolean[] = [];
    const failure = new Error("guest UI adoption failed");
    const guest = new UndoSyncGuestBarrier({
      session: guestSession,
      authority,
      isCurrent: () => true,
      setInputBlocked: (blocked: boolean) => transitions.push(blocked),
      sendAck: vi.fn(async () => true),
      onFatalFailure,
    } as never);

    await guest.receivePhase(
      guestSession,
      authority,
      { undoId: "guest-adoption-failed", revision: 1, phase: "adopted" },
      10,
      async () => { throw failure; },
    );

    expect(onFatalFailure).toHaveBeenCalledWith(failure);
    expect(guest.isInputBlocked).toBe(true);
    expect(transitions).toEqual([true]);
    guest.cancel();
    guestSession.close("test complete");
  });

  it("surfaces a lost guest release ACK without unlocking", async () => {
    const { guestSession } = makePeerPair();
    const onFatalFailure = vi.fn();
    const transitions: boolean[] = [];
    const sendAck = vi.fn(async (_metadata: P2PUndoSyncMetadata) => sendAck.mock.calls.length < 2);
    const guest = new UndoSyncGuestBarrier({
      session: guestSession,
      authority,
      isCurrent: () => true,
      setInputBlocked: (blocked: boolean) => transitions.push(blocked),
      sendAck,
      onFatalFailure,
    } as never);
    const adopted = { undoId: "guest-release-lost", revision: 1, phase: "adopted" } as const;
    const released = { undoId: "guest-release-lost", revision: 1, phase: "released" } as const;

    await expect(guest.receivePhase(guestSession, authority, adopted, 10, async () => undefined)).resolves.toBe(true);
    await expect(guest.receivePhase(guestSession, authority, released, 10, async () => undefined)).resolves.toBe(false);

    expect(onFatalFailure).toHaveBeenCalledWith(expect.any(Error));
    expect(guest.isInputBlocked).toBe(true);
    expect(transitions).toEqual([true]);
    guest.cancel();
    guestSession.close("test complete");
  });
});
