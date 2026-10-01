/**
 * Ephemeral WebRTC signaling rendezvous for one host and up to three guests.
 *
 * This Durable Object relays only bounded SDP/ICE envelopes. Once the
 * RTCDataChannel opens, game bytes bypass it. It deliberately has no storage,
 * alarm, fetch, account, or telemetry calls.
 */

const MAX_SIGNAL_BYTES = 65_536;
const MAX_CONNECTION_IDS = 64;
const MAX_INBOUND_FRAMES = 2_000;
const MAX_GUESTS = 3;
const MAX_SEATS = MAX_GUESTS + 1;
const SOCKET_FRAMES_PER_SECOND = 10;
const SOCKET_BURST = 20;
const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/u;
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const SIGNAL_PATH_PREFIX = "/signal/";

type SignalMessage =
  | { type: "offer"; connectionId: string; sdp: string }
  | { type: "answer"; connectionId: string; sdp: string }
  | { type: "ice"; connectionId: string; candidate: IceCandidate }
  | { type: "close"; connectionId: string };

interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface SignalPeer {
  role: "host" | "guest";
  peerId: string;
  socket: WebSocket;
  tokens: number;
  rateUpdatedAt: number;
}

interface SignalRoute {
  connectionId: string;
  host: SignalPeer;
  guest: SignalPeer;
  offerForwarded: boolean;
  answerForwarded: boolean;
}

type SendResult = "sent" | "oversize" | "failed" | "stale";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalIceCandidate(value: unknown): IceCandidate | null {
  if (!isRecord(value) || typeof value.candidate !== "string") return null;

  const candidate: IceCandidate = { candidate: value.candidate };
  if (hasOwn(value, "sdpMid")) {
    if (typeof value.sdpMid !== "string" && value.sdpMid !== null) return null;
    candidate.sdpMid = value.sdpMid;
  }
  if (hasOwn(value, "sdpMLineIndex")) {
    if (
      value.sdpMLineIndex !== null
      && (typeof value.sdpMLineIndex !== "number"
        || !Number.isSafeInteger(value.sdpMLineIndex)
        || value.sdpMLineIndex < 0)
    ) return null;
    candidate.sdpMLineIndex = value.sdpMLineIndex as number | null;
  }
  if (hasOwn(value, "usernameFragment")) {
    if (typeof value.usernameFragment !== "string" && value.usernameFragment !== null) return null;
    candidate.usernameFragment = value.usernameFragment;
  }
  return candidate;
}

/** Parse the only message union accepted from a socket and discard all extras. */
export function parseSignalMessage(raw: unknown): SignalMessage | null {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_SIGNAL_BYTES) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_SIGNAL_BYTES) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const type = value.type;
  const connectionId = value.connectionId;
  if (
    (type !== "offer" && type !== "answer" && type !== "ice" && type !== "close")
    || typeof connectionId !== "string"
    || !CONNECTION_ID_RE.test(connectionId)
  ) return null;

  if (type === "offer" || type === "answer") {
    if (typeof value.sdp !== "string" || value.sdp.length === 0) return null;
    return { type, connectionId, sdp: value.sdp };
  }
  if (type === "ice") {
    const candidate = canonicalIceCandidate(value.candidate);
    return candidate ? { type, connectionId, candidate } : null;
  }
  return { type: "close", connectionId };
}

/** A room is bound to the first successfully registered path and never reset. */
export class SignalDO {
  private readonly sockets = new Map<WebSocket, SignalPeer>();
  private readonly peersById = new Map<string, SignalPeer>();
  private readonly routes = new Map<string, SignalRoute>();
  private readonly retiredConnectionIds = new Set<string>();
  private roomHostPeerId: string | null = null;
  private host: SignalPeer | null = null;
  private inboundFrames = 0;
  private exhausted = false;

  constructor(_state: DurableObjectState) {
    // No Durable Object storage is read or written; all signaling is ephemeral.
  }

  fetch(request: Request): Response {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }

    const url = new URL(request.url);
    const roomHostPeerId = this.roomIdFromPath(url.pathname);
    const peerId = url.searchParams.get("peer");
    const role = url.searchParams.get("role");
    if (
      roomHostPeerId === null
      || !peerId
      || !PEER_ID_RE.test(peerId)
      || (role !== "host" && role !== "guest")
      || (role === "host" && peerId !== roomHostPeerId)
    ) return new Response("Bad signaling request", { status: 400 });

    if (this.roomHostPeerId !== null && this.roomHostPeerId !== roomHostPeerId) {
      return new Response("Signaling room mismatch", { status: 409 });
    }
    if (this.exhausted) return new Response("Signaling object exhausted", { status: 429 });
    if (role === "guest" && peerId === roomHostPeerId) {
      return new Response("Host identity is reserved", { status: 409 });
    }
    if (this.peersById.has(peerId) || (role === "host" && this.host !== null)) {
      return new Response("Peer identity already registered", { status: 409 });
    }
    if (this.sockets.size >= MAX_SEATS || this.guestCount() >= MAX_GUESTS && role === "guest") {
      return new Response("Signaling room is full", { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const now = Date.now();
    const peer: SignalPeer = {
      role,
      peerId,
      socket: server,
      tokens: SOCKET_BURST,
      rateUpdatedAt: now,
    };
    this.roomHostPeerId ??= roomHostPeerId;
    this.sockets.set(server, peer);
    this.peersById.set(peerId, peer);
    if (role === "host") this.host = peer;

    server.addEventListener("message", (event) => this.onMessage(peer, event.data));
    server.addEventListener("close", () => this.detachPeer(peer));
    server.addEventListener("error", () => this.detachPeer(peer));

    if (this.send(peer, { type: "ready" }) !== "sent") {
      this.closePeer(peer, 1011, "Could not send ready envelope");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private roomIdFromPath(pathname: string): string | null {
    if (!pathname.startsWith(SIGNAL_PATH_PREFIX)) return null;
    const peerId = pathname.slice(SIGNAL_PATH_PREFIX.length);
    return PEER_ID_RE.test(peerId) ? peerId : null;
  }

  private guestCount(): number {
    let count = 0;
    for (const peer of this.sockets.values()) {
      if (peer.role === "guest") count += 1;
    }
    return count;
  }

  private isCurrent(peer: SignalPeer): boolean {
    return this.sockets.get(peer.socket) === peer && this.peersById.get(peer.peerId) === peer;
  }

  private onMessage(sender: SignalPeer, raw: unknown): void {
    if (!this.isCurrent(sender)) return;

    if (this.inboundFrames >= MAX_INBOUND_FRAMES) {
      this.exhaustObject("Inbound frame limit reached");
      return;
    }
    this.inboundFrames += 1;

    if (!this.takeRateToken(sender)) {
      this.closePeer(sender, 1013, "Socket rate limit exceeded");
      return;
    }

    const message = parseSignalMessage(raw);
    if (!message) {
      this.closePeer(sender, 1003, "Invalid signaling frame");
      return;
    }

    if (sender.role === "guest") {
      if (message.type === "answer") {
        this.closePeer(sender, 1008, "Guest answers are not allowed");
      } else if (message.type === "offer") {
        this.onGuestOffer(sender, message);
      } else {
        this.onGuestRouteMessage(sender, message);
      }
      return;
    }

    if (message.type === "offer") {
      this.closePeer(sender, 1008, "Host offers are not allowed");
      return;
    }
    this.onHostRouteMessage(sender, message);
  }

  private takeRateToken(peer: SignalPeer): boolean {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - peer.rateUpdatedAt);
    peer.tokens = Math.min(SOCKET_BURST, peer.tokens + elapsedMs * SOCKET_FRAMES_PER_SECOND / 1_000);
    peer.rateUpdatedAt = Math.max(peer.rateUpdatedAt, now);
    if (peer.tokens < 1) return false;
    peer.tokens -= 1;
    return true;
  }

  private onGuestOffer(sender: SignalPeer, message: Extract<SignalMessage, { type: "offer" }>): void {
    const existing = this.routes.get(message.connectionId);
    if (existing) {
      // An ID belongs to exactly one socket generation. Duplicates and
      // cross-owner attempts never replace or mutate the incumbent route.
      return;
    }
    if (this.retiredConnectionIds.has(message.connectionId)) return;
    if (this.retiredConnectionIds.size >= MAX_CONNECTION_IDS) {
      this.exhaustObject("Connection ID ledger exhausted");
      return;
    }
    this.retiredConnectionIds.add(message.connectionId);

    const previousRoute = this.routeForGuest(sender);
    if (previousRoute) {
      // Delete before forwarding so a reentrant or repeated close cannot
      // forward twice. A fresh ID is a new dial, never a renegotiation.
      this.routes.delete(previousRoute.connectionId);
      this.send(previousRoute.host, { type: "close", connectionId: previousRoute.connectionId });
    }

    const host = this.host;
    if (!host || !this.isCurrent(host)) {
      this.send(sender, { type: "close", connectionId: message.connectionId });
      return;
    }

    const route: SignalRoute = {
      connectionId: message.connectionId,
      host,
      guest: sender,
      offerForwarded: false,
      answerForwarded: false,
    };
    this.routes.set(message.connectionId, route);
    const result = this.send(host, { ...message, peer: sender.peerId });
    if (result === "sent") {
      route.offerForwarded = true;
    } else if (result === "oversize") {
      this.closePeer(sender, 1009, "Forwarded signaling frame is too large");
    }
  }

  private onGuestRouteMessage(sender: SignalPeer, message: Exclude<SignalMessage, { type: "offer" | "answer" }>): void {
    const route = this.routes.get(message.connectionId);
    if (
      !route
      || route.guest !== sender
      || !route.offerForwarded
      || route.host !== this.host
      || !this.isCurrent(route.host)
    ) return;

    if (message.type === "close") {
      this.routes.delete(message.connectionId);
      this.send(route.host, message);
      return;
    }
    const result = this.send(route.host, { ...message, peer: sender.peerId });
    if (result === "oversize") this.closePeer(sender, 1009, "Forwarded signaling frame is too large");
  }

  private onHostRouteMessage(sender: SignalPeer, message: Exclude<SignalMessage, { type: "offer" }>): void {
    const route = this.routes.get(message.connectionId);
    if (
      !route
      || route.host !== sender
      || route.host !== this.host
      || !this.isCurrent(route.guest)
    ) return;

    if (message.type === "close") {
      this.routes.delete(message.connectionId);
      this.send(route.guest, message);
      return;
    }
    if (message.type === "answer") {
      if (route.answerForwarded) return;
      const result = this.send(route.guest, message);
      if (result === "sent") route.answerForwarded = true;
      else if (result === "oversize") this.closePeer(sender, 1009, "Forwarded signaling frame is too large");
      return;
    }
    const result = this.send(route.guest, message);
    if (result === "oversize") this.closePeer(sender, 1009, "Forwarded signaling frame is too large");
  }

  private routeForGuest(guest: SignalPeer): SignalRoute | undefined {
    for (const route of this.routes.values()) {
      if (route.guest === guest) return route;
    }
    return undefined;
  }

  private send(peer: SignalPeer, message: unknown): SendResult {
    if (!this.isCurrent(peer)) return "stale";
    if (peer.socket.readyState !== WebSocket.OPEN) {
      this.closePeer(peer, 1011, "Socket is not open");
      return "failed";
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch {
      this.closePeer(peer, 1011, "Could not encode signaling envelope");
      return "failed";
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_SIGNAL_BYTES) return "oversize";

    try {
      peer.socket.send(serialized);
      return "sent";
    } catch {
      this.closePeer(peer, 1011, "Socket send failed");
      return "failed";
    }
  }

  private detachPeer(peer: SignalPeer): void {
    if (!this.isCurrent(peer)) return;
    this.sockets.delete(peer.socket);
    if (this.peersById.get(peer.peerId) === peer) this.peersById.delete(peer.peerId);
    if (this.host === peer) this.host = null;

    // Losing signaling must not synthesize a data-channel close. Active
    // connection IDs stay retired, so a replacement socket cannot inherit or
    // resurrect the old generation's routes.
    for (const [connectionId, route] of this.routes) {
      if (route.host === peer || route.guest === peer) this.routes.delete(connectionId);
    }
  }

  private closePeer(peer: SignalPeer, code: number, reason: string): void {
    if (!this.isCurrent(peer)) return;
    this.detachPeer(peer);
    try {
      if (peer.socket.readyState === WebSocket.OPEN) peer.socket.close(code, reason);
    } catch {
      // Cleanup is complete even if the platform has already closed the socket.
    }
  }

  private exhaustObject(reason: string): void {
    if (this.exhausted) return;
    this.exhausted = true;
    this.routes.clear();
    for (const peer of Array.from(this.sockets.values())) {
      this.closePeer(peer, 1013, reason);
    }
  }
}
