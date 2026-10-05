import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportConnection, TransportPeer } from "../transport";
import type { HostResult, JoinResult } from "../connection";
import { createPrivateQaRtcTransportFactory } from "../privateQaRtcTransport";

vi.mock("peerjs", () => ({
  default: class FakePeerJsForPrivateQaTest {
    constructor() { throw new Error("PeerJS must not be constructed in private QA RTC tests"); }
  },
}));

const signalPrefix = "phase-private-qa-rtc-v1:";
let uuidCount = 0;

function uuid(): string {
  uuidCount += 1;
  return `00000000-0000-4000-8000-${uuidCount.toString(16).padStart(12, "0")}`;
}

function fire(target: EventTarget, type: string, details: Record<string, unknown> = {}): void {
  const event = new Event(type);
  for (const [key, value] of Object.entries(details)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  target.dispatchEvent(event);
}

class FakeBroadcastChannel extends EventTarget {
  static readonly all: FakeBroadcastChannel[] = [];
  static readonly sent: { channel: string; data: unknown }[] = [];
  readonly name: string;
  closed = false;

  constructor(name: string) {
    super();
    this.name = name;
    FakeBroadcastChannel.all.push(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new Error("BroadcastChannel is closed");
    FakeBroadcastChannel.sent.push({ channel: this.name, data });
    for (const recipient of FakeBroadcastChannel.all) {
      if (recipient === this || recipient.closed || recipient.name !== this.name) continue;
      queueMicrotask(() => fire(recipient, "message", { data }));
    }
  }

  close(): void { this.closed = true; }
}

class FakeDataChannel extends EventTarget {
  readonly label: string;
  readonly ordered: boolean;
  binaryType: BinaryType = "blob";
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  private partner: FakeDataChannel | null = null;

  constructor(label: string, ordered: boolean) {
    super();
    this.label = label;
    this.ordered = ordered;
  }

  pair(partner: FakeDataChannel): void { this.partner = partner; }

  open(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    fire(this, "open");
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== "open" || !this.partner) throw new Error("Fake channel is not paired");
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new TextEncoder().encode(String(data));
    const copy = new Uint8Array(bytes);
    queueMicrotask(() => fire(this.partner!, "message", { data: copy.buffer }));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    fire(this, "close");
    const partner = this.partner;
    if (partner && partner.readyState !== "closed") {
      partner.readyState = "closed";
      fire(partner, "close");
    }
  }
}

class FakeRTCPeerConnection extends EventTarget {
  static readonly all = new Map<string, FakeRTCPeerConnection>();
  readonly id = uuid();
  readonly sctp = { maxMessageSize: 65_536 } as RTCSctpTransport;
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  localChannel: FakeDataChannel | null = null;
  remoteChannel: FakeDataChannel | null = null;
  remoteId: string | null = null;
  closed = false;
  readonly appliedCandidates: (RTCIceCandidateInit | null)[] = [];

  constructor(readonly configuration: RTCConfiguration) {
    super();
    FakeRTCPeerConnection.all.set(this.id, this);
  }

  createDataChannel(label: string, options: RTCDataChannelInit = {}): RTCDataChannel {
    const channel = new FakeDataChannel(label, options.ordered ?? false);
    this.localChannel = channel;
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: `offer:${this.id}` }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: `answer:${this.id}` }; }

  async setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
    if (!description?.type || !description.sdp) throw new Error("missing local SDP");
    this.localDescription = description as RTCSessionDescription;
    queueMicrotask(() => fire(this, "icecandidate", {
      candidate: { toJSON: () => ({ candidate: `candidate:${this.id}`, sdpMid: "0", sdpMLineIndex: 0 }) },
    }));
    this.tryConnect();
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (!description.sdp) throw new Error("missing remote SDP");
    this.remoteDescription = description as RTCSessionDescription;
    this.remoteId = description.sdp.slice(description.sdp.indexOf(":") + 1);
    if (description.type === "offer") this.pairIncomingDataChannel();
    await Promise.resolve();
    this.tryConnect();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    this.appliedCandidates.push(candidate);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
    this.signalingState = "closed";
    this.localChannel?.close();
    this.remoteChannel?.close();
    fire(this, "connectionstatechange");
  }

  private pairIncomingDataChannel(): void {
    const remote = this.remoteId ? FakeRTCPeerConnection.all.get(this.remoteId) : undefined;
    if (!remote?.localChannel || this.remoteChannel) return;
    const channel = new FakeDataChannel(remote.localChannel.label, remote.localChannel.ordered);
    remote.localChannel.pair(channel);
    channel.pair(remote.localChannel);
    this.remoteChannel = channel;
    fire(this, "datachannel", { channel });
  }

  private tryConnect(): void {
    if (this.closed || !this.localDescription || !this.remoteDescription || !this.remoteId) return;
    const remote = FakeRTCPeerConnection.all.get(this.remoteId);
    if (!remote || remote.closed || !remote.localDescription || !remote.remoteDescription || remote.remoteId !== this.id) return;
    for (const endpoint of [this, remote]) {
      if (endpoint.connectionState === "connected") continue;
      endpoint.connectionState = "connected";
      endpoint.iceConnectionState = "connected";
      fire(endpoint, "connectionstatechange");
      if (endpoint.localChannel) endpoint.localChannel.open();
      if (endpoint.remoteChannel) endpoint.remoteChannel.open();
    }
  }
}

beforeEach(() => {
  uuidCount = 0;
  FakeBroadcastChannel.all.length = 0;
  FakeBroadcastChannel.sent.length = 0;
  FakeRTCPeerConnection.all.clear();
  vi.stubGlobal("crypto", { randomUUID: uuid });
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel as unknown as typeof BroadcastChannel);
  vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection as unknown as typeof RTCPeerConnection);
});

afterEach(() => vi.unstubAllGlobals());

const namespace = "f82fbc0355df4bcda80dd2c6847a4aa1";
const roomId = "phase2-ABCDE";

function onceOpen(peer: TransportPeer): Promise<void> {
  return new Promise((resolve) => peer.once("open", resolve));
}

async function tick(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("private QA RTC transport", () => {
  it("routes only bounded SDP/ICE signals and round-trips ordered binary frames, then closes idempotently", async () => {
    const hostFactory = createPrivateQaRtcTransportFactory(namespace);
    const guestFactory = createPrivateQaRtcTransportFactory(namespace);
    const hostPeer = hostFactory.create(roomId, { config: { iceServers: [{ urls: "stun:must-not-be-used" }] } });
    const guestPeer = guestFactory.create();
    const cancelledPeerOpen = vi.fn();
    hostPeer.once("open", cancelledPeerOpen);
    hostPeer.off("open", cancelledPeerOpen);
    const hostOpened = onceOpen(hostPeer);
    const guestOpened = onceOpen(guestPeer);
    const incoming = new Promise<TransportConnection>((resolve) => {
      hostPeer.on("connection", (connection) => {
        connection.on("data", (data) => connection.send(data));
        resolve(connection);
      });
    });
    await Promise.all([hostOpened, guestOpened]);

    const guestConnection = guestPeer.connect(roomId, { serialization: "binary", reliable: true });
    const hostConnection = await incoming;
    await vi.waitFor(() => {
      expect(guestConnection.open).toBe(true);
      expect(hostConnection.open).toBe(true);
    });

    expect(guestConnection.peer).toBe(roomId);
    expect(hostConnection.peer).toBe(guestPeer.id);
    expect(guestConnection.peerConnection).toBeInstanceOf(FakeRTCPeerConnection);
    expect(guestConnection.dataChannel?.ordered).toBe(true);
    expect(hostConnection.dataChannel?.ordered).toBe(true);
    expect((guestConnection.peerConnection as unknown as FakeRTCPeerConnection).configuration.iceServers).toEqual([]);
    expect((hostConnection.peerConnection as unknown as FakeRTCPeerConnection).configuration.iceServers).toEqual([]);

    const cancelledData = vi.fn();
    guestConnection.once("data", cancelledData);
    guestConnection.off("data", cancelledData);
    const echo = new Promise<unknown>((resolve) => guestConnection.once("data", resolve));
    const bytes = new Uint8Array([0, 1, 2, 255]);
    guestConnection.send(bytes);
    expect(await echo).toEqual(bytes);
    expect(cancelledPeerOpen).not.toHaveBeenCalled();
    expect(cancelledData).not.toHaveBeenCalled();
    expect(() => guestConnection.send("not a binary frame")).toThrow("only sends ArrayBuffer or typed-array");
    expect(() => guestConnection.send(new Uint8Array(16_301))).toThrow("maximum is 16300");

    const guestSnapshot = guestFactory.snapshot();
    const hostSnapshot = hostFactory.snapshot();
    expect(guestSnapshot.iceServers).toEqual([]);
    expect(hostSnapshot.peers[0]?.tabPeerId).not.toBe(guestSnapshot.peers[0]?.tabPeerId);
    expect(guestSnapshot.peers[0]?.connections[0]).toMatchObject({
      connectionState: "connected",
      iceConnectionState: "connected",
      channelState: "open",
      ordered: true,
      negotiatedMaxMessageSize: 65_536,
      framesSent: 1,
      bytesSent: 4,
      framesReceived: 1,
      bytesReceived: 4,
    });
    expect(hostSnapshot.peers[0]?.connections[0]).toMatchObject({
      connectionState: "connected",
      channelState: "open",
      ordered: true,
      framesSent: 1,
      framesReceived: 1,
    });

    const signals = FakeBroadcastChannel.sent.map(({ data }) => {
      expect(typeof data).toBe("string");
      return JSON.parse(data as string) as Record<string, unknown>;
    });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => ["offer", "answer", "candidate"].includes(String(signal.type)))).toBe(true);
    expect(signals.every((signal) => !("payload" in signal) && !("data" in signal))).toBe(true);
    expect(signals.every((signal) => signal.namespace === namespace && signal.room === roomId
      && typeof signal.from === "string" && typeof signal.to === "string" && typeof signal.connectionId === "string")).toBe(true);
    expect(new Set(signals.map((signal) => signal.from)).size).toBe(2);
    expect(signals.every((signal) => signal.to === roomId || signal.to === guestSnapshot.peers[0]?.tabPeerId)).toBe(true);

    let guestCloseEvents = 0;
    guestConnection.on("close", () => { guestCloseEvents += 1; });
    guestConnection.close();
    guestConnection.close();
    expect(guestCloseEvents).toBe(1);
    hostPeer.destroy();
    hostPeer.destroy();
    guestPeer.destroy();
    guestPeer.destroy();
    expect(hostFactory.snapshot().peers).toEqual([]);
    expect(guestFactory.snapshot().peers).toEqual([]);

    // The factory remains usable for a fresh ephemeral join after a close.
    const nextHost = hostFactory.create("phase2-FGHIJ");
    const nextGuest = guestFactory.create();
    await Promise.all([onceOpen(nextHost), onceOpen(nextGuest)]);
    expect(nextHost.id).toBe("phase2-FGHIJ");
    expect(nextGuest.id).toBe(guestPeer.id);
    const nextIncoming = new Promise<TransportConnection>((resolve) => {
      nextHost.on("connection", (connection) => {
        connection.on("data", (data) => connection.send(data));
        resolve(connection);
      });
    });
    const nextGuestConnection = nextGuest.connect(nextHost.id, { serialization: "binary", reliable: true });
    const nextHostConnection = await nextIncoming;
    await vi.waitFor(() => {
      expect(nextGuestConnection.open).toBe(true);
      expect(nextHostConnection.open).toBe(true);
    });
    const secondEcho = new Promise<unknown>((resolve) => nextGuestConnection.once("data", resolve));
    nextGuestConnection.send(new Uint8Array([9, 8, 7]));
    expect(await secondEcho).toEqual(new Uint8Array([9, 8, 7]));
    nextGuestConnection.close();
    nextHostConnection.close();
    nextHost.destroy();
    nextGuest.destroy();
    hostFactory.dispose();
    hostFactory.dispose();
    guestFactory.dispose();
    expect(FakeBroadcastChannel.all.every((channel) => channel.closed)).toBe(true);
  });

  it("ignores offers and ICE addressed to another room or peer, plus stale connection IDs", async () => {
    const factory = createPrivateQaRtcTransportFactory(namespace);
    const host = factory.create(roomId);
    await onceOpen(host);
    const onConnection = vi.fn();
    host.on("connection", onConnection);
    const channel = new FakeBroadcastChannel(`${signalPrefix}${namespace}`);
    const from = "10000000-0000-4000-8000-000000000001";
    const connectionId = "20000000-0000-4000-8000-000000000001";
    const offer = {
      protocol: "phase-private-qa-rtc-v1",
      namespace,
      room: roomId,
      from,
      to: roomId,
      connectionId,
      type: "offer",
      description: { type: "offer", sdp: "offer:stale" },
    };

    channel.postMessage(JSON.stringify({ ...offer, room: "another-room" }));
    channel.postMessage(JSON.stringify({ ...offer, to: "some-other-peer" }));
    channel.postMessage(JSON.stringify({ ...offer, connectionId: "not-a-uuid" }));
    channel.postMessage(JSON.stringify({ ...offer, type: "candidate", description: undefined, candidate: { candidate: "candidate:stale" } }));
    await tick();

    expect(onConnection).not.toHaveBeenCalled();
    expect(FakeRTCPeerConnection.all.size).toBe(0);
    host.destroy();
    factory.dispose();
    channel.close();
  });

  it("uses the injected empty ICE config for host and guest without requesting TURN credentials", async () => {
    const { hostRoom, joinRoom } = await import("../connection");
    const hostFactory = createPrivateQaRtcTransportFactory(namespace);
    const guestFactory = createPrivateQaRtcTransportFactory(namespace);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network fetch"));
    let hosted: HostResult | null = null;
    let joined: JoinResult | null = null;
    try {
      hosted = await hostRoom(undefined, { transportFactory: hostFactory });
      const incomingPromise = new Promise<TransportConnection>((resolve) => {
        hosted!.onGuestConnected((connection) => resolve(connection));
      });
      joined = await joinRoom(hosted.roomCode, undefined, 1000, guestFactory);
      const incoming = await incomingPromise;
      expect(joined.conn.open).toBe(true);
      expect(incoming.open).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((joined.conn.peerConnection as unknown as FakeRTCPeerConnection).configuration.iceServers).toEqual([]);
      expect((incoming.peerConnection as unknown as FakeRTCPeerConnection).configuration.iceServers).toEqual([]);
    } finally {
      joined?.conn.close();
      joined?.peer.destroy();
      hosted?.destroy();
      hostFactory.dispose();
      guestFactory.dispose();
      fetchSpy.mockRestore();
    }
  });

  it("fails the injected route without falling back to TURN/STUN or PeerJS", async () => {
    const { joinRoom } = await import("../connection");
    const create = vi.fn();
    const failingFactory = {
      create,
      getRtcConfiguration: vi.fn(() => { throw new Error("provider failure"); }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network fetch"));
    try {
      await expect(joinRoom("ABCDE", undefined, 1000, failingFactory)).rejects.toThrow("provider failure");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects invalid namespace and refuses setup when required browser APIs are absent", () => {
    expect(() => createPrivateQaRtcTransportFactory("short")).toThrow("room namespace");
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => createPrivateQaRtcTransportFactory(namespace)).toThrow("requires BroadcastChannel");
  });
});
