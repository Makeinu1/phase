import type {
  PeerTransportFactory,
  TransportConnectOptions,
  TransportConnection,
  TransportPeer,
  TransportPeerOptions,
} from "./transport";

const SIGNAL_PROTOCOL = "phase-private-qa-rtc-v1";
const SIGNAL_CHANNEL_PREFIX = "phase-private-qa-rtc-v1:";
const DATA_CHANNEL_LABEL = "phase-private-qa-game";
const MAX_ROOM_NAMESPACE_LENGTH = 128;
const MAX_PEER_ID_LENGTH = 128;
const MAX_SIGNAL_CHARACTERS = 256 * 1024;
const MAX_DESCRIPTION_CHARACTERS = 192 * 1024;
const MAX_CANDIDATE_QUEUE = 128;
const MAX_CONNECTIONS_PER_PEER = 1;
const MAX_FRAME_BYTES = 16_300;
const MAX_BUFFERED_BYTES = 512 * 1024;
const FRAME_HEADER_BYTES = 16;
const FRAME_MAGIC = 0x50515231; // "PQR1"
const MAX_LOGICAL_MESSAGE_BYTES = 256 * 1024;
const MAX_MESSAGE_PARTS = 65_535;
const MAX_CANDIDATES_PER_CONNECTION = 128;
const MAX_RETIRED_CONNECTIONS = 256;
const RETIRED_CONNECTION_TTL_MS = 60_000;
const CONNECTION_SETUP_TIMEOUT_MS = 30_000;
const MESSAGE_REASSEMBLY_TIMEOUT_MS = 30_000;

type SignalBase = {
  protocol: typeof SIGNAL_PROTOCOL;
  namespace: string;
  room: string;
  from: string;
  to: string;
  connectionId: string;
};

type PrivateRtcSignal =
  | (SignalBase & { type: "offer"; description: RTCSessionDescriptionInit })
  | (SignalBase & { type: "answer"; description: RTCSessionDescriptionInit })
  | (SignalBase & { type: "candidate"; candidate: RTCIceCandidateInit | null });

type ConnectionEvents = {
  open: () => void;
  close: () => void;
  error: (error: Error & { type?: string }) => void;
  data: (data: unknown) => void;
};

type PeerEvents = {
  open: () => void;
  disconnected: () => void;
  close: () => void;
  error: (error: Error & { type?: string }) => void;
  connection: (connection: TransportConnection) => void;
};

type EventName<T> = Extract<keyof T, string>;
type EventHandler<T, K extends EventName<T>> = T[K];
type StoredHandler = (...args: never[]) => void;

export interface PrivateQaConnectionSnapshot {
  peer: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  channelState: RTCDataChannelState | null;
  ordered: boolean | null;
  negotiatedMaxMessageSize: number | null;
  maxLogicalMessageBytes: number;
  framesSent: number;
  bytesSent: number;
  framesReceived: number;
  bytesReceived: number;
}

export interface PrivateQaPeerSnapshot {
  id: string;
  tabPeerId: string;
  destroyed: boolean;
  connectionCount: number;
  connections: PrivateQaConnectionSnapshot[];
}

export interface PrivateQaTransportSnapshot {
  transport: "private-broadcastchannel-webrtc";
  iceServers: [];
  signaling: "same-origin-broadcastchannel-sdp-ice-only";
  peers: PrivateQaPeerSnapshot[];
}

function qaError(message: string, type = "network"): Error & { type: string } {
  return Object.assign(new Error(message), { type });
}

function isPeerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PEER_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function isRoomNamespace(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= MAX_ROOM_NAMESPACE_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDescription(value: unknown, expected: "offer" | "answer"): value is RTCSessionDescriptionInit {
  return !!value && typeof value === "object" && "type" in value && value.type === expected
    && "sdp" in value && typeof value.sdp === "string" && value.sdp.length > 0
    && value.sdp.length <= MAX_DESCRIPTION_CHARACTERS;
}

function isCandidate(value: unknown): value is RTCIceCandidateInit | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || !("candidate" in value)) return false;
  const candidate = value.candidate;
  return typeof candidate === "string" && candidate.length <= 8192
    && (!("sdpMid" in value) || value.sdpMid === null || typeof value.sdpMid === "string")
    && (!("sdpMLineIndex" in value) || value.sdpMLineIndex === null || Number.isInteger(value.sdpMLineIndex))
    && (!("usernameFragment" in value) || value.usernameFragment === null || typeof value.usernameFragment === "string");
}

function parseSignal(value: unknown, namespace: string): PrivateRtcSignal | null {
  if (typeof value !== "string" || value.length > MAX_SIGNAL_CHARACTERS) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const signal = parsed as Partial<PrivateRtcSignal>;
  if (signal.protocol !== SIGNAL_PROTOCOL || signal.namespace !== namespace || !isPeerId(signal.room)
    || !isPeerId(signal.to) || !isUuidLike(signal.from) || !isUuidLike(signal.connectionId)) return null;
  if (signal.type === "offer" && isDescription(signal.description, "offer")) return signal as PrivateRtcSignal;
  if (signal.type === "answer" && isDescription(signal.description, "answer")) return signal as PrivateRtcSignal;
  if (signal.type === "candidate" && isCandidate(signal.candidate)) return signal as PrivateRtcSignal;
  return null;
}

function bytesFrom(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function safeCount(value: number): number {
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

function candidateKey(candidate: RTCIceCandidateInit | null): string {
  return candidate === null ? "<end-of-candidates>" : JSON.stringify(candidate);
}

/**
 * Creates an opt-in, owner-preview-only factory. Its room namespace is never
 * stored, and its peer identity is newly generated for this tab on each page
 * load. PeerJS constructor options are deliberately ignored: the actual
 * RTCPeerConnection is always constructed with an empty ICE server list.
 */
export function createPrivateQaRtcTransportFactory(namespace: string): PeerTransportFactory & {
  snapshot(): PrivateQaTransportSnapshot;
  dispose(): void;
} {
  if (!isRoomNamespace(namespace)) {
    throw new TypeError("Private QA RTC room namespace must be 32-128 URL-safe random characters");
  }
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Private QA RTC requires crypto.randomUUID in this browser");
  }
  if (typeof globalThis.BroadcastChannel !== "function") {
    throw new Error("Private QA RTC requires BroadcastChannel in this browser");
  }
  if (typeof globalThis.RTCPeerConnection !== "function") {
    throw new Error("Private QA RTC requires RTCPeerConnection in this browser");
  }

  const tabId = globalThis.crypto.randomUUID();
  const channel = new BroadcastChannel(`${SIGNAL_CHANNEL_PREFIX}${namespace}`);
  const peers = new Set<PrivateQaPeer>();
  const retiredConnections = new Map<string, number>();
  let disposed = false;

  const postSignal = (signal: PrivateRtcSignal) => {
    if (disposed) throw new Error("Private QA RTC transport is disposed");
    const serialized = JSON.stringify(signal);
    if (serialized.length > MAX_SIGNAL_CHARACTERS) {
      throw new RangeError("Private QA RTC signaling message exceeds the configured bound");
    }
    channel.postMessage(serialized);
  };

  const onMessage = (event: MessageEvent<unknown>) => {
    const signal = parseSignal(event.data, namespace);
    if (!signal || signal.from === tabId || disposed) return;
    for (const peer of peers) peer.receiveSignal(signal);
  };
  channel.addEventListener("message", onMessage);

  const unregisterPeer = (peer: PrivateQaPeer) => {
    peers.delete(peer);
  };

  const factory = {
    create(id?: string, _options?: TransportPeerOptions): TransportPeer {
      if (disposed) throw new Error("Private QA RTC transport is disposed");
      if (id !== undefined && !isPeerId(id)) throw new TypeError("Private QA RTC peer ID is invalid");
      if (peers.size >= 8) throw new Error("Private QA RTC tab peer limit reached");
      if (id !== undefined && [...peers].some((peer) => !peer.destroyed && peer.advertisedId === id)) {
        throw new Error("Private QA RTC peer ID is already active in this tab");
      }
      const peer = new PrivateQaPeer({
        tabId,
        id,
        namespace,
        retiredConnections,
        postSignal,
        unregisterPeer,
      });
      peers.add(peer);
      peer.openOnNextTurn();
      return peer;
    },
    getRtcConfiguration(): RTCConfiguration {
      return { iceServers: [] };
    },
    snapshot(): PrivateQaTransportSnapshot {
      return {
        transport: "private-broadcastchannel-webrtc",
        iceServers: [],
        signaling: "same-origin-broadcastchannel-sdp-ice-only",
        peers: [...peers].map((peer) => peer.snapshot()),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const peer of [...peers]) peer.destroy();
      retiredConnections.clear();
      channel.removeEventListener("message", onMessage);
      channel.close();
    },
  };
  return factory;
}

interface PrivateQaPeerOptions {
  tabId: string;
  id?: string;
  namespace: string;
  retiredConnections: Map<string, number>;
  postSignal: (signal: PrivateRtcSignal) => void;
  unregisterPeer: (peer: PrivateQaPeer) => void;
}

class PrivateQaPeer implements TransportPeer {
  readonly id: string;
  destroyed = false;
  disconnected = false;
  readonly tabId: string;
  readonly namespace: string;
  readonly advertisedId: string | null;
  private readonly postSignal: (signal: PrivateRtcSignal) => void;
  private readonly unregisterPeer: (peer: PrivateQaPeer) => void;
  private readonly handlers = new Map<EventName<PeerEvents>, Set<StoredHandler>>();
  private readonly onceWrappers = new Map<EventName<PeerEvents>, Map<StoredHandler, Set<StoredHandler>>>();
  private readonly connections = new Map<string, PrivateQaConnection>();
  private readonly retiredConnections: Map<string, number>;
  private openEmitted = false;

  constructor(options: PrivateQaPeerOptions) {
    this.tabId = options.tabId;
    this.id = options.id ?? options.tabId;
    this.advertisedId = options.id ?? null;
    this.namespace = options.namespace;
    this.retiredConnections = options.retiredConnections;
    this.postSignal = options.postSignal;
    this.unregisterPeer = options.unregisterPeer;
  }

  openOnNextTurn(): void {
    queueMicrotask(() => {
      if (this.destroyed || this.openEmitted) return;
      this.openEmitted = true;
      this.emit("open");
    });
  }

  connect(peerId: string, options: TransportConnectOptions): TransportConnection {
    if (this.destroyed) throw new Error("Private QA RTC peer is closed");
    if (!isPeerId(peerId)) throw new TypeError("Private QA RTC target peer ID is invalid");
    if (options.serialization !== "binary") {
      throw new TypeError("Private QA RTC only supports the game's binary wire format");
    }
    if (this.connections.size >= MAX_CONNECTIONS_PER_PEER) {
      throw new Error("Private QA RTC supports one active connection per tab peer");
    }
    const connectionId = globalThis.crypto.randomUUID();
    const connection = new PrivateQaConnection({
      owner: this,
      namespace: this.namespace,
      room: peerId,
      remotePeer: peerId,
      remoteTabId: null,
      connectionId,
      signalAddress: peerId,
      postSignal: this.postSignal,
      onClose: () => this.connectionClosed(connectionId),
    });
    this.connections.set(connectionId, connection);
    void connection.startOffer().catch((error: unknown) => connection.fail(error));
    return connection;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const connection of [...this.connections.values()]) connection.close();
    this.connections.clear();
    this.unregisterPeer(this);
    this.emit("close");
    this.handlers.clear();
    this.onceWrappers.clear();
  }

  reconnect(): void {
    // This isolated QA transport deliberately has no signaling reconnect path.
    // Existing game recovery remains unproven and outside this transport's scope.
  }

  receiveSignal(signal: PrivateRtcSignal): void {
    if (this.destroyed || signal.from === this.tabId) return;
    this.pruneRetiredConnections();

    if (signal.type === "offer") {
      if (!this.advertisedId || signal.room !== this.advertisedId || signal.to !== this.advertisedId) return;
      if (this.retiredConnections.has(signal.connectionId)) return;
      if (this.connections.size >= MAX_CONNECTIONS_PER_PEER || this.connections.has(signal.connectionId)) return;
      if ([...this.connections.values()].some((connection) => connection.peer === signal.from)) return;
      const connection = new PrivateQaConnection({
        owner: this,
        namespace: this.namespace,
        room: signal.room,
        remotePeer: signal.from,
        remoteTabId: signal.from,
        connectionId: signal.connectionId,
        signalAddress: signal.from,
        postSignal: this.postSignal,
        onClose: () => this.connectionClosed(signal.connectionId),
      });
      this.connections.set(signal.connectionId, connection);
      this.emit("connection", connection);
      void connection.acceptOffer(signal.description).catch((error: unknown) => connection.fail(error));
      return;
    }

    if (signal.to !== this.tabId && signal.to !== this.advertisedId) return;
    const connection = this.connections.get(signal.connectionId);
    if (!connection || connection.closed || connection.room !== signal.room) return;
    connection.receiveSignal(signal);
  }

  snapshot(): PrivateQaPeerSnapshot {
    return {
      id: this.id,
      tabPeerId: this.tabId,
      destroyed: this.destroyed,
      connectionCount: this.connections.size,
      connections: [...this.connections.values()].map((connection) => connection.snapshot()),
    };
  }

  on<K extends EventName<PeerEvents>>(event: K, handler: EventHandler<PeerEvents, K>): this {
    return this.addHandler(event, handler);
  }
  once<K extends EventName<PeerEvents>>(event: K, handler: EventHandler<PeerEvents, K>): this {
    const original = handler as StoredHandler;
    const wrapped: StoredHandler = (...args) => {
      this.removeOnceWrapper(event, original, wrapped);
      original(...args);
    };
    this.addOnceWrapper(event, original, wrapped);
    return this.addHandler(event, wrapped as EventHandler<PeerEvents, K>);
  }
  off<K extends EventName<PeerEvents>>(event: K, handler: EventHandler<PeerEvents, K>): this {
    const original = handler as StoredHandler;
    this.handlers.get(event)?.delete(original);
    const wrappers = this.onceWrappers.get(event)?.get(original);
    if (wrappers) {
      for (const wrapper of wrappers) this.handlers.get(event)?.delete(wrapper);
      this.onceWrappers.get(event)?.delete(original);
      if (this.onceWrappers.get(event)?.size === 0) this.onceWrappers.delete(event);
    }
    return this;
  }

  private addHandler<K extends EventName<PeerEvents>>(event: K, handler: EventHandler<PeerEvents, K>): this {
    let handlers = this.handlers.get(event);
    if (!handlers) { handlers = new Set(); this.handlers.set(event, handlers); }
    handlers.add(handler as StoredHandler);
    return this;
  }

  private addOnceWrapper(event: EventName<PeerEvents>, original: StoredHandler, wrapper: StoredHandler): void {
    let byOriginal = this.onceWrappers.get(event);
    if (!byOriginal) { byOriginal = new Map(); this.onceWrappers.set(event, byOriginal); }
    let wrappers = byOriginal.get(original);
    if (!wrappers) { wrappers = new Set(); byOriginal.set(original, wrappers); }
    wrappers.add(wrapper);
  }

  private removeOnceWrapper(event: EventName<PeerEvents>, original: StoredHandler, wrapper: StoredHandler): void {
    this.handlers.get(event)?.delete(wrapper);
    const byOriginal = this.onceWrappers.get(event);
    const wrappers = byOriginal?.get(original);
    wrappers?.delete(wrapper);
    if (wrappers?.size === 0) byOriginal?.delete(original);
    if (byOriginal?.size === 0) this.onceWrappers.delete(event);
  }

  private emit<K extends EventName<PeerEvents>>(event: K, ...args: Parameters<PeerEvents[K]>): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      try { (handler as (...values: Parameters<PeerEvents[K]>) => void)(...args); }
      catch { /* Listener failures must not prevent other listeners from running. */ }
    }
  }

  private connectionClosed(connectionId: string): void {
    this.connections.delete(connectionId);
    this.pruneRetiredConnections();
    this.retiredConnections.set(connectionId, Date.now() + RETIRED_CONNECTION_TTL_MS);
    while (this.retiredConnections.size > MAX_RETIRED_CONNECTIONS) {
      const oldest = this.retiredConnections.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.retiredConnections.delete(oldest);
    }
  }

  private pruneRetiredConnections(): void {
    const now = Date.now();
    for (const [connectionId, expiresAt] of this.retiredConnections) {
      if (expiresAt <= now) this.retiredConnections.delete(connectionId);
    }
  }
}

interface PrivateQaConnectionOptions {
  owner: PrivateQaPeer;
  namespace: string;
  room: string;
  remotePeer: string;
  remoteTabId: string | null;
  connectionId: string;
  signalAddress: string;
  postSignal: (signal: PrivateRtcSignal) => void;
  onClose: () => void;
}

interface InboundMessageAssembly {
  sequence: number;
  totalBytes: number;
  partCount: number;
  nextPart: number;
  receivedBytes: number;
  parts: Uint8Array[];
  timer: ReturnType<typeof setTimeout>;
}

class PrivateQaConnection implements TransportConnection {
  readonly peer: string;
  readonly peerConnection: RTCPeerConnection;
  readonly connectionId: string;
  readonly room: string;
  readonly owner: PrivateQaPeer;
  private readonly namespace: string;
  private readonly signalAddress: string;
  private readonly postSignal: (signal: PrivateRtcSignal) => void;
  private readonly onClose: () => void;
  private readonly handlers = new Map<EventName<ConnectionEvents>, Set<StoredHandler>>();
  private readonly onceWrappers = new Map<EventName<ConnectionEvents>, Map<StoredHandler, Set<StoredHandler>>>();
  private readonly pendingCandidates: (RTCIceCandidateInit | null)[] = [];
  private readonly remoteCandidateKeys = new Set<string>();
  private readonly localCandidateKeys = new Set<string>();
  private localCandidates: (RTCIceCandidateInit | null)[] = [];
  private remoteTabId: string | null;
  private channel: RTCDataChannel | null = null;
  private closedState = false;
  private localSignalSent = false;
  private remoteDescriptionReady = false;
  private remoteDescriptionPending = false;
  private framesSent = 0;
  private bytesSent = 0;
  private framesReceived = 0;
  private bytesReceived = 0;
  private nextSendSequence = 1;
  private nextReceiveSequence = 1;
  private openEventEmitted = false;
  private setupTimer: ReturnType<typeof setTimeout>;
  private inboundAssembly: InboundMessageAssembly | null = null;
  private readonly onIceCandidate: (event: RTCPeerConnectionIceEvent) => void;
  private readonly onDataChannel: (event: RTCDataChannelEvent) => void;
  private readonly onConnectionState: () => void;

  constructor(options: PrivateQaConnectionOptions) {
    this.owner = options.owner;
    this.peer = options.remotePeer;
    this.namespace = options.namespace;
    this.room = options.room;
    this.remoteTabId = options.remoteTabId;
    this.connectionId = options.connectionId;
    this.signalAddress = options.signalAddress;
    this.postSignal = options.postSignal;
    this.onClose = options.onClose;
    // Never pass through the shared game's fetched STUN/TURN configuration.
    this.peerConnection = new RTCPeerConnection({ iceServers: [] });
    this.onIceCandidate = (event) => this.queueLocalCandidate(event.candidate?.toJSON() ?? null);
    this.onDataChannel = (event) => this.attachChannel(event.channel);
    this.onConnectionState = () => {
      const state = this.peerConnection.connectionState;
      if (state === "failed") this.fail(qaError("Private QA RTC connection failed"));
      else if (state === "closed") this.close();
    };
    this.peerConnection.addEventListener("icecandidate", this.onIceCandidate);
    this.peerConnection.addEventListener("datachannel", this.onDataChannel);
    this.peerConnection.addEventListener("connectionstatechange", this.onConnectionState);
    this.setupTimer = setTimeout(() => this.fail(new Error("Private QA RTC connection setup timed out")), CONNECTION_SETUP_TIMEOUT_MS);
  }

  get open(): boolean { return !this.closedState && this.channel?.readyState === "open"; }
  get dataChannel(): RTCDataChannel | null { return this.channel; }
  get closed(): boolean { return this.closedState; }

  async startOffer(): Promise<void> {
    if (this.closedState) return;
    const channel = this.peerConnection.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    this.attachChannel(channel);
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    const description = this.peerConnection.localDescription;
    if (!description || description.type !== "offer" || !description.sdp) {
      throw new Error("Private QA RTC browser did not create an SDP offer");
    }
    this.post({ type: "offer", description: { type: "offer", sdp: description.sdp }, to: this.signalAddress });
    this.localSignalSent = true;
    this.flushLocalCandidates();
  }

  async acceptOffer(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closedState) return;
    await this.peerConnection.setRemoteDescription(description);
    this.remoteDescriptionReady = true;
    await this.flushRemoteCandidates();
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    const local = this.peerConnection.localDescription;
    if (!local || local.type !== "answer" || !local.sdp) {
      throw new Error("Private QA RTC browser did not create an SDP answer");
    }
    this.post({ type: "answer", description: { type: "answer", sdp: local.sdp }, to: this.signalAddress });
    this.localSignalSent = true;
    this.flushLocalCandidates();
  }

  receiveSignal(signal: PrivateRtcSignal): void {
    if (this.closedState || signal.connectionId !== this.connectionId || signal.room !== this.room) return;
    if (signal.type === "answer") {
      if (this.remoteTabId !== null && signal.from !== this.remoteTabId) return;
      if (this.remoteDescriptionReady || this.remoteDescriptionPending || this.peerConnection.remoteDescription) return;
      this.remoteTabId = signal.from;
      this.remoteDescriptionPending = true;
      void this.peerConnection.setRemoteDescription(signal.description)
        .then(() => { this.remoteDescriptionPending = false; this.remoteDescriptionReady = true; return this.flushRemoteCandidates(); })
        .catch((error: unknown) => this.fail(error));
      return;
    }
    if (signal.type === "candidate") {
      if (this.remoteTabId !== null && signal.from !== this.remoteTabId) return;
      if (this.remoteTabId === null) this.remoteTabId = signal.from;
      const key = candidateKey(signal.candidate);
      if (this.remoteCandidateKeys.has(key)) return;
      if (this.remoteCandidateKeys.size >= MAX_CANDIDATES_PER_CONNECTION) {
        this.fail(new RangeError("Private QA RTC ICE candidate count exceeded its bound"));
        return;
      }
      this.remoteCandidateKeys.add(key);
      if (!this.remoteDescriptionReady) {
        if (this.pendingCandidates.length >= MAX_CANDIDATE_QUEUE) {
          this.fail(new RangeError("Private QA RTC ICE candidate queue exceeded its bound"));
          return;
        }
        this.pendingCandidates.push(signal.candidate);
      } else {
        void this.addRemoteCandidate(signal.candidate);
      }
    }
  }

  send(data: unknown): void {
    if (!this.open || !this.channel) throw new Error("Private QA RTC data channel is not open");
    const bytes = bytesFrom(data);
    if (!bytes) throw new TypeError("Private QA RTC only sends ArrayBuffer or typed-array game frames");
    const negotiatedMax = this.negotiatedMaxMessageSize();
    if (negotiatedMax === null) throw new Error("Private QA RTC negotiated SCTP max-message-size is unavailable");
    const frameLimit = Math.min(MAX_FRAME_BYTES, negotiatedMax);
    const payloadLimit = frameLimit - FRAME_HEADER_BYTES;
    if (payloadLimit <= 0) {
      throw new RangeError("Private QA RTC negotiated SCTP message limit is too small for the bounded frame header");
    }
    if (bytes.byteLength > MAX_LOGICAL_MESSAGE_BYTES) {
      throw new RangeError(`Private QA RTC logical message exceeds ${MAX_LOGICAL_MESSAGE_BYTES} bytes`);
    }
    const partCount = Math.max(1, Math.ceil(bytes.byteLength / payloadLimit));
    if (partCount > MAX_MESSAGE_PARTS) {
      throw new RangeError("Private QA RTC logical message requires too many bounded fragments");
    }
    const bufferedSize = bytes.byteLength + partCount * FRAME_HEADER_BYTES;
    if (this.channel.bufferedAmount + bufferedSize > MAX_BUFFERED_BYTES) {
      throw new RangeError("Private QA RTC buffered data would exceed the configured bound");
    }
    const sequence = this.nextSendSequence;
    this.nextSendSequence = (sequence + 1) >>> 0;
    if (this.nextSendSequence === 0) this.nextSendSequence = 1;
    try {
      for (let part = 0; part < partCount; part += 1) {
        const offset = part * payloadLimit;
        const payload = bytes.subarray(offset, Math.min(offset + payloadLimit, bytes.byteLength));
        const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
        const header = new DataView(frame.buffer);
        header.setUint32(0, FRAME_MAGIC);
        header.setUint32(4, sequence);
        header.setUint32(8, bytes.byteLength);
        header.setUint16(12, part);
        header.setUint16(14, partCount);
        frame.set(payload, FRAME_HEADER_BYTES);
        this.channel.send(frame);
      }
    } catch {
      this.fail(new Error("Private QA RTC data-channel send failed"));
      throw new Error("Private QA RTC data-channel send failed");
    }
    this.framesSent = safeCount(this.framesSent + 1);
    this.bytesSent = safeCount(this.bytesSent + bytes.byteLength);
  }

  close(): void {
    if (this.closedState) return;
    this.closedState = true;
    clearTimeout(this.setupTimer);
    this.clearInboundAssembly();
    this.pendingCandidates.length = 0;
    this.localCandidates = [];
    this.remoteCandidateKeys.clear();
    this.localCandidateKeys.clear();
    this.peerConnection.removeEventListener("icecandidate", this.onIceCandidate);
    this.peerConnection.removeEventListener("datachannel", this.onDataChannel);
    this.peerConnection.removeEventListener("connectionstatechange", this.onConnectionState);
    this.detachChannel();
    try { this.channel?.close(); } catch { /* Dispose remaining resources. */ }
    try { this.peerConnection.close(); } catch { /* Dispose remaining resources. */ }
    this.onClose();
    this.emit("close");
    this.handlers.clear();
    this.onceWrappers.clear();
  }

  fail(_error: unknown): void {
    if (this.closedState) return;
    // Browser/WebRTC exceptions may quote fragments of a description. Never
    // forward those implementation messages into game logs or diagnostics.
    this.emit("error", qaError("Private QA RTC connection failed"));
    this.close();
  }

  snapshot(): PrivateQaConnectionSnapshot {
    const state = this.peerConnection;
    return {
      peer: this.peer,
      connectionState: state.connectionState,
      iceConnectionState: state.iceConnectionState,
      channelState: this.channel?.readyState ?? null,
      ordered: this.channel?.ordered ?? null,
      negotiatedMaxMessageSize: this.negotiatedMaxMessageSize(),
      maxLogicalMessageBytes: MAX_LOGICAL_MESSAGE_BYTES,
      framesSent: this.framesSent,
      bytesSent: this.bytesSent,
      framesReceived: this.framesReceived,
      bytesReceived: this.bytesReceived,
    };
  }

  on<K extends EventName<ConnectionEvents>>(event: K, handler: EventHandler<ConnectionEvents, K>): this {
    return this.addHandler(event, handler);
  }
  once<K extends EventName<ConnectionEvents>>(event: K, handler: EventHandler<ConnectionEvents, K>): this {
    const original = handler as StoredHandler;
    const wrapped: StoredHandler = (...args) => {
      this.removeOnceWrapper(event, original, wrapped);
      original(...args);
    };
    this.addOnceWrapper(event, original, wrapped);
    return this.addHandler(event, wrapped as EventHandler<ConnectionEvents, K>);
  }
  off<K extends EventName<ConnectionEvents>>(event: K, handler: EventHandler<ConnectionEvents, K>): this {
    const original = handler as StoredHandler;
    this.handlers.get(event)?.delete(original);
    const wrappers = this.onceWrappers.get(event)?.get(original);
    if (wrappers) {
      for (const wrapper of wrappers) this.handlers.get(event)?.delete(wrapper);
      this.onceWrappers.get(event)?.delete(original);
      if (this.onceWrappers.get(event)?.size === 0) this.onceWrappers.delete(event);
    }
    return this;
  }

  private addHandler<K extends EventName<ConnectionEvents>>(event: K, handler: EventHandler<ConnectionEvents, K>): this {
    let handlers = this.handlers.get(event);
    if (!handlers) { handlers = new Set(); this.handlers.set(event, handlers); }
    handlers.add(handler as StoredHandler);
    return this;
  }

  private addOnceWrapper(event: EventName<ConnectionEvents>, original: StoredHandler, wrapper: StoredHandler): void {
    let byOriginal = this.onceWrappers.get(event);
    if (!byOriginal) { byOriginal = new Map(); this.onceWrappers.set(event, byOriginal); }
    let wrappers = byOriginal.get(original);
    if (!wrappers) { wrappers = new Set(); byOriginal.set(original, wrappers); }
    wrappers.add(wrapper);
  }

  private removeOnceWrapper(event: EventName<ConnectionEvents>, original: StoredHandler, wrapper: StoredHandler): void {
    this.handlers.get(event)?.delete(wrapper);
    const byOriginal = this.onceWrappers.get(event);
    const wrappers = byOriginal?.get(original);
    wrappers?.delete(wrapper);
    if (wrappers?.size === 0) byOriginal?.delete(original);
    if (byOriginal?.size === 0) this.onceWrappers.delete(event);
  }

  private emit<K extends EventName<ConnectionEvents>>(event: K, ...args: Parameters<ConnectionEvents[K]>): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      try { (handler as (...values: Parameters<ConnectionEvents[K]>) => void)(...args); }
      catch { /* Listener failures must not prevent other listeners from running. */ }
    }
  }

  private post(signal: Pick<PrivateRtcSignal, "type"> & Record<string, unknown> & { to: string }): void {
    if (this.closedState) return;
    const envelope = {
      protocol: SIGNAL_PROTOCOL,
      namespace: this.namespace,
      room: this.room,
      from: this.owner.tabId,
      connectionId: this.connectionId,
      ...signal,
    } as PrivateRtcSignal;
    try { this.postSignal(envelope); }
    catch (error) { this.fail(error); }
  }

  private queueLocalCandidate(candidate: RTCIceCandidateInit | null): void {
    if (this.closedState) return;
    const key = candidateKey(candidate);
    if (this.localCandidateKeys.has(key)) return;
    if (this.localCandidateKeys.size >= MAX_CANDIDATES_PER_CONNECTION) {
      this.fail(new RangeError("Private QA RTC local ICE candidate count exceeded its bound"));
      return;
    }
    this.localCandidateKeys.add(key);
    if (!this.localSignalSent) {
      if (this.localCandidates.length >= MAX_CANDIDATE_QUEUE) {
        this.fail(new RangeError("Private QA RTC local ICE candidate queue exceeded its bound"));
        return;
      }
      this.localCandidates.push(candidate);
      return;
    }
    this.post({ type: "candidate", candidate, to: this.signalAddress });
  }

  private flushLocalCandidates(): void {
    const candidates = this.localCandidates;
    this.localCandidates = [];
    for (const candidate of candidates) this.post({ type: "candidate", candidate, to: this.signalAddress });
  }

  private async flushRemoteCandidates(): Promise<void> {
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) await this.addRemoteCandidate(candidate);
  }

  private async addRemoteCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (this.closedState) return;
    try { await this.peerConnection.addIceCandidate(candidate); }
    catch (error) { this.fail(error); }
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (this.closedState) { try { channel.close(); } catch { /* best-effort */ } return; }
    if (this.channel && this.channel !== channel) {
      try { channel.close(); } catch { /* best-effort */ }
      this.fail(new Error("Private QA RTC received more than one data channel"));
      return;
    }
    if (channel.label !== DATA_CHANNEL_LABEL || channel.ordered !== true) {
      try { channel.close(); } catch { /* best-effort */ }
      this.fail(new Error("Private QA RTC requires its ordered binary game data channel"));
      return;
    }
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", this.onChannelOpen);
    channel.addEventListener("close", this.onChannelClose);
    channel.addEventListener("error", this.onChannelError);
    channel.addEventListener("message", this.onChannelMessage);
    if (channel.readyState === "open") this.onChannelOpen();
  }

  private readonly onChannelOpen = (): void => {
    if (this.closedState || this.openEventEmitted || this.channel?.readyState !== "open") return;
    this.openEventEmitted = true;
    clearTimeout(this.setupTimer);
    this.emit("open");
  };
  private readonly onChannelClose = (): void => { this.close(); };
  private readonly onChannelError = (): void => { this.fail(new Error("Private QA RTC data channel failed")); };
  private readonly onChannelMessage = (event: MessageEvent<unknown>): void => {
    if (this.closedState) return;
    const bytes = bytesFrom(event.data);
    if (!bytes) { this.fail(new TypeError("Private QA RTC received a non-binary game frame")); return; }
    if (bytes.byteLength > MAX_FRAME_BYTES) { this.fail(new RangeError("Private QA RTC received an oversized transport fragment")); return; }
    const message = this.acceptFragment(bytes);
    if (message === null) return;
    this.framesReceived = safeCount(this.framesReceived + 1);
    this.bytesReceived = safeCount(this.bytesReceived + message.byteLength);
    this.emit("data", message);
  };

  private acceptFragment(fragment: Uint8Array): Uint8Array | null {
    if (fragment.byteLength < FRAME_HEADER_BYTES) {
      this.fail(new TypeError("Private QA RTC fragment header is invalid"));
      return null;
    }
    const header = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    const magic = header.getUint32(0);
    const sequence = header.getUint32(4);
    const totalBytes = header.getUint32(8);
    const partIndex = header.getUint16(12);
    const partCount = header.getUint16(14);
    const payload = fragment.subarray(FRAME_HEADER_BYTES);
    if (magic !== FRAME_MAGIC || sequence === 0 || totalBytes > MAX_LOGICAL_MESSAGE_BYTES
      || partCount === 0 || partCount > MAX_MESSAGE_PARTS
      || (totalBytes === 0 ? partCount !== 1 : partCount > totalBytes)) {
      this.fail(new TypeError("Private QA RTC fragment metadata is invalid"));
      return null;
    }

    let assembly = this.inboundAssembly;
    if (assembly === null) {
      if (sequence !== this.nextReceiveSequence || partIndex !== 0) {
        this.fail(new TypeError("Private QA RTC fragment sequence is invalid"));
        return null;
      }
      assembly = {
        sequence,
        totalBytes,
        partCount,
        nextPart: 0,
        receivedBytes: 0,
        parts: [],
        timer: setTimeout(() => this.fail(new Error("Private QA RTC message reassembly timed out")), MESSAGE_REASSEMBLY_TIMEOUT_MS),
      };
      this.inboundAssembly = assembly;
    }
    if (assembly.sequence !== sequence || assembly.totalBytes !== totalBytes || assembly.partCount !== partCount
      || assembly.nextPart !== partIndex || (partIndex < partCount - 1 && payload.byteLength === 0)
      || payload.byteLength > MAX_FRAME_BYTES - FRAME_HEADER_BYTES
      || assembly.receivedBytes + payload.byteLength > assembly.totalBytes) {
      this.fail(new TypeError("Private QA RTC fragment order or size is invalid"));
      return null;
    }
    assembly.parts.push(payload);
    assembly.receivedBytes += payload.byteLength;
    assembly.nextPart += 1;
    if (assembly.nextPart !== assembly.partCount) return null;
    if (assembly.receivedBytes !== assembly.totalBytes) {
      this.fail(new TypeError("Private QA RTC reassembled message size is invalid"));
      return null;
    }

    clearTimeout(assembly.timer);
    this.inboundAssembly = null;
    this.nextReceiveSequence = (sequence + 1) >>> 0;
    if (this.nextReceiveSequence === 0) this.nextReceiveSequence = 1;
    const message = new Uint8Array(assembly.totalBytes);
    let offset = 0;
    for (const part of assembly.parts) {
      message.set(part, offset);
      offset += part.byteLength;
    }
    return message;
  }

  private clearInboundAssembly(): void {
    if (!this.inboundAssembly) return;
    clearTimeout(this.inboundAssembly.timer);
    this.inboundAssembly.parts.length = 0;
    this.inboundAssembly = null;
  }

  private detachChannel(): void {
    if (!this.channel) return;
    this.channel.removeEventListener("open", this.onChannelOpen);
    this.channel.removeEventListener("close", this.onChannelClose);
    this.channel.removeEventListener("error", this.onChannelError);
    this.channel.removeEventListener("message", this.onChannelMessage);
  }

  private negotiatedMaxMessageSize(): number | null {
    const value = this.peerConnection.sctp?.maxMessageSize;
    return typeof value === "number" && value > 0 && !Number.isNaN(value) ? Math.floor(value) : null;
  }
}
