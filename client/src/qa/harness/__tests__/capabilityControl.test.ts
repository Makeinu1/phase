import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCapabilityControl } from "../capabilityControl";

const SECRET = "synthetic-private-sdp-ip-203.0.113.42-ice-password-player-token";
let peers: FakePeer[];
let hangOffer: boolean;
let rejectOffer: boolean;
let openChannels: boolean;
let announceOpen: boolean;
let offerGate: Promise<RTCSessionDescriptionInit> | null;
let candidateGate: Promise<void> | null;

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  binaryType = "arraybuffer";
  partner: FakeChannel | null = null;
  close = vi.fn(() => { this.readyState = "closed"; });
  send = vi.fn((bytes: Uint8Array) => {
    if (this.readyState !== "open") throw new Error(SECRET);
    const data = bytes.slice().buffer;
    queueMicrotask(() => this.partner?.dispatchEvent(new MessageEvent("message", { data })));
  });
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
}

class FakePeer extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channel: FakeChannel | null = null;
  constructor(readonly config: RTCConfiguration) { super(); peers.push(this); }
  createDataChannel = vi.fn((_label: string, _options: RTCDataChannelInit) => {
    this.channel = new FakeChannel();
    return this.channel;
  });
  createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => {
    if (rejectOffer) throw Object.assign(new Error(SECRET), { name: SECRET });
    if (offerGate) return offerGate;
    if (hangOffer) return new Promise(() => {});
    return { type: "offer", sdp: SECRET };
  });
  createAnswer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({ type: "answer", sdp: SECRET }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
    this.iceGatheringState = "complete";
    this.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: { toJSON: () => ({ candidate: SECRET, sdpMid: "0", sdpMLineIndex: 0 }) } }));
    this.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: null }));
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
    if (description.type === "offer") {
      this.channel = new FakeChannel();
      if (announceOpen) this.channel.readyState = "open";
      this.channel.partner = peers[0].channel;
      peers[0].channel!.partner = this.channel;
      this.dispatchEvent(Object.assign(new Event("datachannel"), { channel: this.channel }));
    } else if (openChannels) queueMicrotask(() => { peers[0].channel!.open(); peers[1].channel!.open(); });
  });
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit | null) => { if (candidateGate) await candidateGate; });
  close = vi.fn(() => { this.connectionState = "closed"; });
}

async function settleOperations() { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }

beforeEach(() => {
  peers = []; hangOffer = false; rejectOffer = false; openChannels = true; announceOpen = false; offerGate = null; candidateGate = null;
  vi.useFakeTimers();
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("BroadcastChannel", vi.fn(() => { throw new Error("BroadcastChannel must not be used by A2"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("A2 isolated native API control (unit doubles only)", () => {
  it("does not send or count an open event from receiver announcement readyState", async () => {
    announceOpen = true; openChannels = false;
    const control = startCapabilityControl();
    await settleOperations();
    expect(control.snapshot().sides[1].counts.openEvents).toBe(0);
    expect(peers[1].channel!.readyState).toBe("open");
    for (const peer of peers) expect(peer.channel!.send).not.toHaveBeenCalled();
    peers[0].channel!.open();
    for (const peer of peers) expect(peer.channel!.send).not.toHaveBeenCalled();
    peers[1].channel!.open();
    expect((await control.completion).result).toBe("pass");
  });

  it.each([[0, 1], [1, 0]])("waits for both open events in order %s then %s", async (first, second) => {
    openChannels = false;
    const control = startCapabilityControl();
    await settleOperations();
    peers[first].channel!.open();
    peers[first].channel!.dispatchEvent(new Event("open"));
    expect(control.snapshot().sides[first].counts.openEvents).toBe(1);
    for (const peer of peers) expect(peer.channel!.send).not.toHaveBeenCalled();
    peers[second].channel!.open();
    const result = await control.completion;
    expect(result.result).toBe("pass");
    for (const peer of peers) expect(peer.channel!.send).toHaveBeenCalledTimes(2);
    for (const side of result.sides) expect(side.counts.openEvents).toBe(1);
    peers[first].channel!.dispatchEvent(new Event("open"));
    for (const peer of peers) expect(peer.channel!.send).toHaveBeenCalledTimes(2);
  });

  it("keeps a missing second open event as a 30-second failure without sending or retrying", async () => {
    openChannels = false;
    const control = startCapabilityControl();
    await settleOperations(); peers[0].channel!.open();
    await vi.advanceTimersByTimeAsync(30000);
    expect((await control.completion).result).toBe("timeout");
    for (const peer of peers) expect(peer.channel!.send).not.toHaveBeenCalled();
    peers[1].channel!.dispatchEvent(new Event("open"));
    for (const peer of peers) expect(peer.channel!.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels while waiting at the barrier and ignores a late second open", async () => {
    openChannels = false;
    const control = startCapabilityControl();
    await settleOperations(); peers[0].channel!.open(); control.cancel();
    expect((await control.completion).result).toBe("cancelled");
    peers[1].channel!.dispatchEvent(new Event("open"));
    for (const peer of peers) expect(peer.channel!.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a send exception as failure and does not send the other payload or retry", async () => {
    openChannels = false;
    const control = startCapabilityControl(); await settleOperations();
    peers[0].channel!.send.mockImplementationOnce(() => { throw new Error(SECRET); });
    peers[0].channel!.open(); peers[1].channel!.open();
    const result = await control.completion;
    expect(result.result).toBe("operation-failed");
    expect(result.exchangeEvents.at(-1)).toEqual({ side: 0, event: "send-payload" });
    expect(peers[0].channel!.send).toHaveBeenCalledOnce();
    expect(peers[1].channel!.send).not.toHaveBeenCalled();
    for (const side of result.sides) expect(side.counts.messagesSent).toBe(0);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("keeps an accepted but undelivered payload as a timeout with no retransmission", async () => {
    openChannels = false;
    const control = startCapabilityControl(); await settleOperations();
    peers[1].channel!.send.mockImplementationOnce(() => {}); // Unit-only delivery loss.
    peers[0].channel!.open(); peers[1].channel!.open(); await settleOperations();
    expect(control.snapshot().result).toBe("running");
    await vi.advanceTimersByTimeAsync(30000);
    const result = await control.completion;
    expect(result.result).toBe("timeout");
    expect(result.sides[0]).toMatchObject({ payloadReceived: false, acknowledgementReceived: true,
      counts: { messagesSent: 1, messagesReceived: 1 } });
    expect(result.sides[1]).toMatchObject({ payloadReceived: true, acknowledgementReceived: false,
      counts: { messagesSent: 2, messagesReceived: 1 } });
    expect(peers[0].channel!.send).toHaveBeenCalledOnce();
    expect(peers[1].channel!.send).toHaveBeenCalledTimes(2);
    expect(result.exchangeEvents).toHaveLength(9);
  });

  it("uses two fixed empty ICE configurations and verifies four 32-byte messages", async () => {
    const removed = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const control = startCapabilityControl();
    const result = await control.completion;
    expect(peers).toHaveLength(2);
    expect(peers.map((peer) => peer.config)).toEqual([{ iceServers: [] }, { iceServers: [] }]);
    expect(peers[0].createDataChannel).toHaveBeenCalledWith("qa-a2-capability", { ordered: true });
    expect(result).toMatchObject({ result: "pass", payloadBytes: 32, iceServerCount: 0, limitMs: 30000 });
    expect(result.exchangeEvents).toHaveLength(12);
    expect(result.exchangeEvents.slice(0, 4)).toEqual([
      { side: 0, event: "handlers-attached" }, { side: 1, event: "handlers-attached" },
      { side: 0, event: "open" }, { side: 1, event: "open" },
    ]);
    for (const side of result.sides) expect(side).toMatchObject({ payloadReceived: true, acknowledgementReceived: true,
      counts: { messagesSent: 2, messagesReceived: 2, bytesSent: 64, bytesReceived: 64, openEvents: 1 } });
    for (const peer of peers) { expect(peer.close).toHaveBeenCalledOnce(); expect(peer.channel!.close).toHaveBeenCalledOnce(); }
    expect(removed).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(BroadcastChannel).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("times out once after 30 seconds and retains bounded pre-cleanup states", async () => {
    hangOffer = true;
    const control = startCapabilityControl();
    await vi.advanceTimersByTimeAsync(29999);
    expect(control.snapshot().result).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect(await control.completion).toMatchObject({ result: "timeout", stage: "create-offer", elapsedMs: 30000 });
    for (const peer of peers) expect(peer.close).toHaveBeenCalledOnce();
    expect(control.snapshot().sides[0].states.connection).toBe("new");
    await vi.advanceTimersByTimeAsync(5000);
    expect(control.snapshot().elapsedMs).toBe(30000); expect(vi.getTimerCount()).toBe(0);
  });

  it("suppresses arbitrary native exception text/name and cleans up both peers", async () => {
    rejectOffer = true;
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const control = startCapabilityControl();
    expect(await control.completion).toMatchObject({ result: "operation-failed", stage: "create-offer" });
    expect(JSON.stringify(control.snapshot())).not.toContain(SECRET);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    for (const peer of peers) expect(peer.close).toHaveBeenCalledOnce();
  });

  it("cancels pending negotiation and prevents work after a late operation settles", async () => {
    let resolveOffer: (value: RTCSessionDescriptionInit) => void = () => {};
    offerGate = new Promise((resolve) => { resolveOffer = resolve; });
    const control = startCapabilityControl();
    control.cancel(); control.cancel();
    expect((await control.completion).result).toBe("cancelled");
    resolveOffer({ type: "offer", sdp: SECRET }); await settleOperations();
    for (const peer of peers) { expect(peer.close).toHaveBeenCalledOnce(); expect(peer.setLocalDescription).not.toHaveBeenCalled(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports queued/applying ICE counts and returns isolated snapshot copies", async () => {
    let resolveCandidates: () => void = () => {};
    candidateGate = new Promise((resolve) => { resolveCandidates = resolve; });
    openChannels = false;
    const control = startCapabilityControl();
    await settleOperations();
    expect(control.snapshot().sides[1].counts).toMatchObject({ localCandidates: 1, queuedCandidates: 0, applyingCandidates: 1, appliedCandidates: 0 });
    const copy = control.snapshot(); copy.sides[0].counts.bytesSent = 123;
    expect(control.snapshot().sides[0].counts.bytesSent).toBe(0);
    resolveCandidates(); await settleOperations();
    expect(control.snapshot().sides[1].counts).toMatchObject({ applyingCandidates: 0, appliedCandidates: 1 });
    control.cancel(); await control.completion;
  });

  it("stops counting a rejected native ICE operation as still applying", async () => {
    let rejectCandidates: (error: Error) => void = () => {};
    candidateGate = new Promise((_resolve, reject) => { rejectCandidates = reject; });
    openChannels = false;
    const control = startCapabilityControl(); await settleOperations();
    expect(control.snapshot().sides[1].counts.applyingCandidates).toBe(1);
    rejectCandidates(new Error(SECRET));
    const result = await control.completion;
    expect(result.result).toBe("operation-failed");
    expect(result.sides[1].counts).toMatchObject({ applyingCandidates: 0, appliedCandidates: 0 });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("contains native callback exceptions and rejects arbitrary state strings", async () => {
    hangOffer = true;
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const control = startCapabilityControl();
    Object.defineProperty(peers[0], "iceConnectionState", { get: () => SECRET });
    expect(control.snapshot().sides[0].states.ice).toBeNull();
    peers[0].dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: { toJSON() { throw new Error(SECRET); } } }));
    expect((await control.completion).result).toBe("operation-failed");
    expect(JSON.stringify(control.snapshot())).not.toContain(SECRET);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("reports API absence without any fallback or retry", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const control = startCapabilityControl();
    expect((await control.completion).result).toBe("api-unavailable");
    expect(peers).toHaveLength(0); expect(BroadcastChannel).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an unexpected message without retaining its contents", async () => {
    hangOffer = true;
    const control = startCapabilityControl();
    peers[0].channel!.dispatchEvent(new MessageEvent("message", { data: SECRET }));
    expect((await control.completion).result).toBe("unexpected-data");
    expect(JSON.stringify(control.snapshot())).not.toContain(SECRET);
    for (const peer of peers) expect(peer.close).toHaveBeenCalledOnce();
  });

  it("bounds even repeated candidate events while negotiation is pending", async () => {
    hangOffer = true;
    const control = startCapabilityControl();
    for (let i = 0; i < 257; i += 1) peers[0].dispatchEvent(Object.assign(new Event("icecandidate"), {
      candidate: { toJSON: () => ({ candidate: SECRET, sdpMid: "0", sdpMLineIndex: 0 }) },
    }));
    expect((await control.completion).result).toBe("resource-limit");
    expect(control.snapshot().sides[1].counts.queuedCandidates).toBe(256);
    expect(JSON.stringify(control.snapshot())).not.toContain(SECRET);
    for (const peer of peers) expect(peer.close).toHaveBeenCalledOnce();
  });
});
