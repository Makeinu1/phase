import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSignalMessage, SignalDO } from "../src/signaling-do.ts";

const MAX_SIGNAL_BYTES = 65_536;

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeSocket.OPEN;
  sent = [];
  closeCalls = [];
  accepted = false;
  failNextSend = false;

  accept() {
    this.accepted = true;
  }

  send(value) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("fake send failure");
    }
    if (this.readyState !== FakeSocket.OPEN) throw new Error("fake socket is closed");
    this.sent.push(String(value));
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push({ code, reason });
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  fail() {
    this.dispatchEvent(new Event("error"));
  }

  message(value) {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

class FakeWebSocketPair {
  static pairs = [];

  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
    FakeWebSocketPair.pairs.push(this);
  }
}

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
  }
}

function guardedState() {
  return new Proxy(Object.create(null), {
    get(_target, key) {
      throw new Error("Unexpected Durable Object state access: " + String(key));
    },
  });
}

function request(roomId, peerId, role = "guest", options = {}) {
  const headers = options.upgrade === false ? {} : { Upgrade: "websocket" };
  return new Request(
    "https://worker.example/signal/" + roomId + "?peer=" + encodeURIComponent(peerId) + "&role=" + role,
    { method: options.method ?? "GET", headers },
  );
}

function messages(socket) {
  return socket.sent.map((frame) => JSON.parse(frame));
}

async function withPlatform(run) {
  const globalNames = ["WebSocket", "WebSocketPair", "Response", "fetch"];
  const previousGlobals = new Map(
    globalNames.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const previousDateNow = Object.getOwnPropertyDescriptor(Date, "now");
  let nowMs = 0;
  FakeWebSocketPair.pairs = [];

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  });
  Object.defineProperty(globalThis, "WebSocketPair", {
    configurable: true,
    writable: true,
    value: FakeWebSocketPair,
  });
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    writable: true,
    value: FakeResponse,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value() {
      throw new Error("Network access is forbidden in signaling tests");
    },
  });
  Object.defineProperty(Date, "now", {
    configurable: true,
    writable: true,
    value: () => nowMs,
  });

  const signal = new SignalDO(guardedState());
  const platform = {
    signal,
    pairs: FakeWebSocketPair.pairs,
    advance(ms) {
      nowMs += ms;
    },
    open(roomId, peerId, role = "guest") {
      const response = signal.fetch(request(roomId, peerId, role));
      const pair = FakeWebSocketPair.pairs.at(-1);
      return { response, client: pair?.[0], socket: pair?.[1] };
    },
  };

  try {
    return await run(platform);
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    if (previousDateNow) Object.defineProperty(Date, "now", previousDateNow);
    else delete Date.now;
  }
}

function offer(connectionId, overrides = {}) {
  return {
    type: "offer",
    connectionId,
    sdp: "v=0\r\n",
    ...overrides,
  };
}

function ice(connectionId, candidate = "candidate:1") {
  return {
    type: "ice",
    connectionId,
    candidate: { candidate },
  };
}

test("parser accepts only bounded canonical signaling envelopes", () => {
  const parsedOffer = parseSignalMessage(JSON.stringify(offer("conn_0001", {
    peer: "forged-peer",
    gameState: "must-not-forward",
  })));
  assert.deepEqual(parsedOffer, { type: "offer", connectionId: "conn_0001", sdp: "v=0\r\n" });

  const parsedIce = parseSignalMessage(JSON.stringify({
    type: "ice",
    connectionId: "conn_0002",
    candidate: {
      candidate: "",
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
      payload: "must-not-forward",
    },
    savedState: "must-not-forward",
  }));
  assert.deepEqual(parsedIce, {
    type: "ice",
    connectionId: "conn_0002",
    candidate: { candidate: "", sdpMid: null, sdpMLineIndex: null, usernameFragment: null },
  });

  for (const invalid of [
    null,
    [],
    { type: "game_action", payload: "secret" },
    { type: "offer", connectionId: "short", sdp: "v=0" },
    { type: "answer", connectionId: "conn_0003", sdp: "" },
    { type: "answer", connectionId: "conn_0003", sdp: 7 },
    { type: "ice", connectionId: "conn_0004", candidate: null },
    { type: "ice", connectionId: "conn_0004", candidate: [] },
    { type: "ice", connectionId: "conn_0004", candidate: { candidate: "c", sdpMid: 7 } },
    { type: "ice", connectionId: "conn_0004", candidate: { candidate: "c", sdpMLineIndex: -1 } },
    { type: "ice", connectionId: "conn_0004", candidate: { candidate: "c", usernameFragment: 4 } },
  ]) {
    assert.equal(parseSignalMessage(JSON.stringify(invalid)), null);
  }
  assert.equal(parseSignalMessage("not-json"), null);
  assert.equal(parseSignalMessage(new Uint8Array([123, 125])), null);

  const template = { type: "offer", connectionId: "conn_0005", sdp: "" };
  const overhead = new TextEncoder().encode(JSON.stringify(template)).byteLength;
  const atLimit = JSON.stringify({ ...template, sdp: "x".repeat(MAX_SIGNAL_BYTES - overhead) });
  assert.equal(new TextEncoder().encode(atLimit).byteLength, MAX_SIGNAL_BYTES);
  assert.notEqual(parseSignalMessage(atLimit), null);

  const multibyte = JSON.stringify({ ...template, sdp: "é".repeat(32_768) });
  assert.ok(multibyte.length < MAX_SIGNAL_BYTES);
  assert.ok(new TextEncoder().encode(multibyte).byteLength > MAX_SIGNAL_BYTES);
  assert.equal(parseSignalMessage(multibyte), null);
  assert.equal(parseSignalMessage(atLimit + " "), null);
});

test("four seats exchange only their own offer, answer, ICE, and explicit close", async () => {
  await withPlatform(({ open, signal }) => {
    const host = open("host_01", "host_01", "host");
    const guest1 = open("host_01", "guest_01");
    const guest2 = open("host_01", "guest_02");
    const guest3 = open("host_01", "guest_03");
    assert.deepEqual([host, guest1, guest2, guest3].map((peer) => peer.response.status), [101, 101, 101, 101]);
    assert.ok(host.socket.accepted && guest1.socket.accepted && guest2.socket.accepted && guest3.socket.accepted);
    for (const peer of [host, guest1, guest2, guest3]) {
      assert.deepEqual(messages(peer.socket), [{ type: "ready" }]);
    }

    guest1.socket.message(JSON.stringify(offer("conn_1001", {
      peer: "forged-host-route",
      gameState: "do-not-forward",
    })));
    guest2.socket.message(JSON.stringify(offer("conn_1002")));
    guest3.socket.message(JSON.stringify(offer("conn_1003")));
    const hostOffers = messages(host.socket).filter((message) => message.type === "offer");
    assert.deepEqual(hostOffers, [
      { type: "offer", connectionId: "conn_1001", sdp: "v=0\r\n", peer: "guest_01" },
      { type: "offer", connectionId: "conn_1002", sdp: "v=0\r\n", peer: "guest_02" },
      { type: "offer", connectionId: "conn_1003", sdp: "v=0\r\n", peer: "guest_03" },
    ]);

    host.socket.message(JSON.stringify({ type: "answer", connectionId: "conn_1001", sdp: "answer-1", peer: "forged" }));
    host.socket.message(JSON.stringify({ type: "answer", connectionId: "conn_1002", sdp: "answer-2" }));
    host.socket.message(JSON.stringify({ type: "answer", connectionId: "conn_1003", sdp: "answer-3" }));
    assert.deepEqual(messages(guest1.socket).at(-1), { type: "answer", connectionId: "conn_1001", sdp: "answer-1" });
    assert.deepEqual(messages(guest2.socket).at(-1), { type: "answer", connectionId: "conn_1002", sdp: "answer-2" });
    assert.deepEqual(messages(guest3.socket).at(-1), { type: "answer", connectionId: "conn_1003", sdp: "answer-3" });
    assert.equal(messages(guest1.socket).some((message) => message.connectionId === "conn_1002"), false);
    assert.equal(messages(guest2.socket).some((message) => message.connectionId === "conn_1003"), false);

    guest1.socket.message(JSON.stringify(ice("conn_1001", "candidate:guest")));
    host.socket.message(JSON.stringify(ice("conn_1001", "candidate:host")));
    assert.deepEqual(messages(host.socket).at(-1), {
      type: "ice",
      connectionId: "conn_1001",
      candidate: { candidate: "candidate:guest" },
      peer: "guest_01",
    });
    assert.deepEqual(messages(guest1.socket).at(-1), {
      type: "ice",
      connectionId: "conn_1001",
      candidate: { candidate: "candidate:host" },
    });
    assert.equal(messages(guest2.socket).some((message) => message.type === "ice"), false);
    assert.equal(signal.routes.size, 3);

    const hostCount = host.socket.sent.length;
    guest1.socket.message(JSON.stringify({ type: "close", connectionId: "conn_1001" }));
    guest1.socket.message(JSON.stringify({ type: "close", connectionId: "conn_1001" }));
    assert.equal(host.socket.sent.length, hostCount + 1);
    assert.deepEqual(messages(host.socket).at(-1), { type: "close", connectionId: "conn_1001" });
    assert.equal(signal.routes.size, 2);
    guest2.socket.message(JSON.stringify(ice("conn_1002", "candidate:still-live")));
    assert.equal(messages(host.socket).at(-1).connectionId, "conn_1002");
  });
});

test("validates room path and IDs, and protects duplicate and fifth-seat incumbents", async () => {
  await withPlatform(({ open, signal, pairs }) => {
    const host = open("host_02", "host_02", "host");
    const guest1 = open("host_02", "guest_11");
    const guest2 = open("host_02", "guest_12");
    const guest3 = open("host_02", "guest_13");
    guest1.socket.message(JSON.stringify(offer("conn_2001")));
    assert.equal(signal.routes.size, 1);
    const pairCount = pairs.length;

    assert.equal(signal.fetch(request("host_02", "host_02", "host")).status, 409);
    assert.equal(signal.fetch(request("host_02", "guest_11")).status, 409);
    assert.equal(signal.fetch(request("host_02", "guest_14")).status, 429);
    assert.equal(signal.fetch(request("host_02", "guest_14", "guest", { upgrade: false })).status, 404);
    assert.equal(signal.fetch(request("host_02", "guest_14", "guest", { method: "POST" })).status, 404);
    assert.equal(pairs.length, pairCount);
    assert.equal(host.socket.readyState, FakeSocket.OPEN);
    assert.equal(guest1.socket.readyState, FakeSocket.OPEN);
    assert.equal(guest2.socket.readyState, FakeSocket.OPEN);
    assert.equal(guest3.socket.readyState, FakeSocket.OPEN);
    assert.equal(signal.routes.size, 1);

    assert.equal(signal.fetch(request("host_02/extra", "guest_15")).status, 400);
    assert.equal(signal.fetch(request("host_02", "wrong_host", "host")).status, 400);
    assert.equal(signal.fetch(request("host_02", "bad/id")).status, 400);
    assert.equal(signal.fetch(request("host_03", "host_03", "host")).status, 409);
    assert.equal(signal.fetch(request("host_02", "host_02")).status, 409);
    assert.equal(pairs.length, pairCount);
  });
});

test("deduplicates offers and answers, isolates owners, and closes before a fresh ID", async () => {
  await withPlatform(({ open, signal }) => {
    const host = open("host_03", "host_03", "host");
    const guest1 = open("host_03", "guest_21");
    const guest2 = open("host_03", "guest_22");
    const firstOffer = offer("conn_3001", { sdp: "first" });
    guest1.socket.message(JSON.stringify(firstOffer));
    guest1.socket.message(JSON.stringify(offer("conn_3001", { sdp: "duplicate" })));
    const afterFirst = host.socket.sent.length;

    guest2.socket.message(JSON.stringify(ice("conn_3001", "forged-cross-owner")));
    guest2.socket.message(JSON.stringify({ type: "close", connectionId: "conn_3001" }));
    guest2.socket.message(JSON.stringify(offer("conn_3001", { sdp: "cross-owner" })));
    assert.equal(host.socket.sent.length, afterFirst);
    assert.equal(signal.routes.size, 1);

    host.socket.message(JSON.stringify({ type: "answer", connectionId: "conn_3001", sdp: "answer-one" }));
    host.socket.message(JSON.stringify({ type: "answer", connectionId: "conn_3001", sdp: "answer-duplicate" }));
    assert.deepEqual(messages(guest1.socket).at(-1), {
      type: "answer",
      connectionId: "conn_3001",
      sdp: "answer-one",
    });
    assert.deepEqual(messages(guest2.socket), [{ type: "ready" }]);

    guest1.socket.message(JSON.stringify(offer("conn_3002", { sdp: "fresh" })));
    assert.deepEqual(messages(host.socket).slice(-2), [
      { type: "close", connectionId: "conn_3001" },
      { type: "offer", connectionId: "conn_3002", sdp: "fresh", peer: "guest_21" },
    ]);
    host.socket.message(JSON.stringify({ type: "answer", connectionId: "conn_3001", sdp: "stale" }));
    assert.equal(messages(guest1.socket).at(-1).connectionId, "conn_3001");
    host.socket.message(JSON.stringify({ type: "answer", connectionId: "conn_3002", sdp: "answer-two" }));
    assert.equal(messages(guest1.socket).at(-1).connectionId, "conn_3002");

    guest1.socket.message(JSON.stringify({ type: "close", connectionId: "conn_3002" }));
    const hostAfterClose = host.socket.sent.length;
    guest1.socket.message(JSON.stringify({ type: "close", connectionId: "conn_3002" }));
    host.socket.message(JSON.stringify({ type: "close", connectionId: "conn_3002" }));
    assert.equal(host.socket.sent.length, hostAfterClose);
    assert.equal(signal.routes.size, 0);
    assert.equal(signal.retiredConnectionIds.has("conn_3001"), true);
    assert.equal(signal.retiredConnectionIds.has("conn_3002"), true);
  });
});

test("host close removes a live route once and leaves other guest routes usable", async () => {
  await withPlatform(({ open, signal }) => {
    const host = open("host_14", "host_14", "host");
    const guest1 = open("host_14", "guest_101");
    const guest2 = open("host_14", "guest_102");
    guest1.socket.message(JSON.stringify(offer("conn_host_close")));
    guest2.socket.message(JSON.stringify(offer("conn_other_live")));
    const guest1Count = guest1.socket.sent.length;
    const guest2Count = guest2.socket.sent.length;

    host.socket.message(JSON.stringify({ type: "close", connectionId: "conn_host_close" }));
    assert.deepEqual(messages(guest1.socket).at(-1), {
      type: "close",
      connectionId: "conn_host_close",
    });
    assert.equal(guest1.socket.sent.length, guest1Count + 1);
    assert.equal(guest2.socket.sent.length, guest2Count);
    assert.equal(signal.routes.size, 1);

    host.socket.message(JSON.stringify({ type: "close", connectionId: "conn_host_close" }));
    guest1.socket.message(JSON.stringify(ice("conn_host_close", "retired")));
    assert.equal(guest1.socket.sent.length, guest1Count + 1);
    assert.equal(signal.routes.size, 1);

    guest2.socket.message(JSON.stringify(ice("conn_other_live", "still-live")));
    assert.deepEqual(messages(host.socket).at(-1), {
      type: "ice",
      connectionId: "conn_other_live",
      candidate: { candidate: "still-live" },
      peer: "guest_102",
    });
  });
});

test("counts duplicate and malformed frames before cleanup", async () => {
  await withPlatform(({ open, signal }) => {
    const host = open("host_13", "host_13", "host");
    const guest = open("host_13", "guest_91");
    guest.socket.message(JSON.stringify(offer("conn_count")));
    guest.socket.message(JSON.stringify(offer("conn_count", { sdp: "duplicate" })));
    assert.equal(signal.inboundFrames, 2);
    assert.equal(messages(host.socket).filter((message) => message.type === "offer").length, 1);

    guest.socket.message("{");
    assert.equal(signal.inboundFrames, 3);
    assert.equal(guest.socket.closeCalls.at(-1).code, 1003);
    assert.equal(signal.routes.size, 0);
    assert.equal(messages(host.socket).filter((message) => message.type === "close").length, 0);
  });
});

test("orphan offers are closed, retired, and never resurrected when the host returns", async () => {
  await withPlatform(({ open, signal }) => {
    const guest = open("host_04", "guest_31");
    guest.socket.message(JSON.stringify(offer("orphan_01")));
    assert.deepEqual(messages(guest.socket).at(-1), { type: "close", connectionId: "orphan_01" });
    assert.equal(signal.routes.size, 0);
    assert.equal(signal.retiredConnectionIds.has("orphan_01"), true);

    const host = open("host_04", "host_04", "host");
    const hostCount = host.socket.sent.length;
    guest.socket.message(JSON.stringify(offer("orphan_01")));
    assert.equal(host.socket.sent.length, hostCount);
    assert.equal(signal.routes.size, 0);

    guest.socket.message(JSON.stringify(offer("fresh_001")));
    assert.deepEqual(messages(host.socket).at(-1), {
      type: "offer",
      connectionId: "fresh_001",
      sdp: "v=0\r\n",
      peer: "guest_31",
    });
    assert.equal(signal.routes.size, 1);
  });
});

test("signaling loss removes routes without closing established channels or redialing", async () => {
  await withPlatform(({ open, signal }) => {
    const host1 = open("host_05", "host_05", "host");
    const guests = [open("host_05", "guest_41"), open("host_05", "guest_42"), open("host_05", "guest_43")];
    guests.forEach((guest, index) => guest.socket.message(JSON.stringify(offer("conn_40" + index))));
    assert.equal(signal.routes.size, 3);
    const guestCountsBeforeLoss = guests.map((guest) => guest.socket.sent.length);

    assert.equal(open("host_05", "host_05", "host").response.status, 409);
    host1.socket.drop();
    assert.equal(signal.routes.size, 0);
    assert.deepEqual(guests.map((guest) => guest.socket.sent.length), guestCountsBeforeLoss);

    const host2 = open("host_05", "host_05", "host");
    for (let index = 0; index < guests.length; index += 1) {
      host2.socket.message(JSON.stringify({ type: "answer", connectionId: "conn_40" + index, sdp: "stale" }));
    }
    assert.deepEqual(messages(host2.socket), [{ type: "ready" }]);
    assert.deepEqual(guests.map((guest) => guest.socket.sent.length), guestCountsBeforeLoss);

    guests.forEach((guest) => guest.socket.drop());
    host1.socket.drop();
    guests[0].socket.drop();
    assert.equal(signal.sockets.size, 1);
    assert.equal(signal.peersById.get("host_05").socket, host2.socket);

    const reconnected = [open("host_05", "guest_41"), open("host_05", "guest_42"), open("host_05", "guest_43")];
    assert.deepEqual(reconnected.map((guest) => guest.response.status), [101, 101, 101]);
    host1.socket.drop();
    guests[0].socket.drop();
    guests[1].socket.fail();
    assert.equal(signal.sockets.size, 4);
    assert.equal(signal.routes.size, 0);
    assert.equal(signal.peersById.get("guest_41").socket, reconnected[0].socket);
    assert.equal(signal.peersById.get("guest_42").socket, reconnected[1].socket);

    host2.socket.drop();
    reconnected.forEach((guest) => guest.socket.drop());
    assert.equal(signal.sockets.size, 0);
    assert.equal(signal.routes.size, 0);

    const host3 = open("host_05", "host_05", "host");
    const simultaneous = [open("host_05", "guest_41"), open("host_05", "guest_42"), open("host_05", "guest_43")];
    assert.deepEqual([host3, ...simultaneous].map((peer) => peer.response.status), [101, 101, 101, 101]);
    assert.equal(signal.routes.size, 0);
    host2.socket.drop();
    reconnected.forEach((guest) => guest.socket.drop());
    assert.equal(signal.sockets.size, 4);
    assert.equal(signal.peersById.get("host_05").socket, host3.socket);
    simultaneous.forEach((guest) => guest.socket.drop());
    host3.socket.drop();
    assert.equal(signal.sockets.size, 0);
    assert.equal(signal.routes.size, 0);
  });
});

test("send failures and repeated close/error callbacks clean only the current generation", async () => {
  await withPlatform(({ open, signal }) => {
    const host1 = open("host_06", "host_06", "host");
    const guest1 = open("host_06", "guest_51");
    guest1.socket.message(JSON.stringify(offer("conn_5001")));
    const guestCount = guest1.socket.sent.length;

    host1.socket.failNextSend = true;
    guest1.socket.message(JSON.stringify(ice("conn_5001", "send-fails")));
    assert.equal(signal.routes.size, 0);
    assert.equal(signal.sockets.has(host1.socket), false);
    assert.equal(signal.sockets.has(guest1.socket), true);
    assert.deepEqual(host1.socket.closeCalls.at(-1).code, 1011);
    assert.equal(guest1.socket.sent.length, guestCount);

    const host2 = open("host_06", "host_06", "host");
    host1.socket.drop();
    assert.equal(signal.peersById.get("host_06").socket, host2.socket);

    guest1.socket.message(JSON.stringify(offer("conn_5002")));
    assert.equal(signal.routes.size, 1);
    guest1.socket.fail();
    const hostCount = host2.socket.sent.length;
    guest1.socket.drop();
    assert.equal(signal.routes.size, 0);
    assert.equal(host2.socket.sent.length, hostCount);

    const guest2 = open("host_06", "guest_51");
    guest1.socket.fail();
    guest1.socket.drop();
    assert.equal(signal.peersById.get("guest_51").socket, guest2.socket);
    assert.equal(signal.sockets.size, 2);
  });
});

test("rejects an incoming frame whose injected guest peer would exceed the byte cap", async () => {
  await withPlatform(({ open, signal }) => {
    const host = open("host_07", "host_07", "host");
    const guest = open("host_07", "guest_61");
    const empty = JSON.stringify({ type: "offer", connectionId: "conn_size", sdp: "" });
    const sdp = "x".repeat(MAX_SIGNAL_BYTES - new TextEncoder().encode(empty).byteLength);
    const raw = JSON.stringify({ type: "offer", connectionId: "conn_size", sdp });
    assert.equal(new TextEncoder().encode(raw).byteLength, MAX_SIGNAL_BYTES);
    guest.socket.message(raw);

    assert.deepEqual(messages(host.socket), [{ type: "ready" }]);
    assert.equal(guest.socket.closeCalls.at(-1).code, 1009);
    assert.equal(signal.routes.size, 0);
    assert.equal(signal.retiredConnectionIds.has("conn_size"), true);
  });
});

test("enforces the 20-frame burst and refills at exactly 10 frames per second", async () => {
  await withPlatform(({ open, signal }) => {
    const host = open("host_08", "host_08", "host");
    const guest = open("host_08", "guest_71");
    const observer = open("host_08", "guest_72");
    observer.socket.message(JSON.stringify(offer("conn_9001")));
    for (let frame = 0; frame < 20; frame += 1) {
      guest.socket.message(JSON.stringify(ice("unknown_01")));
    }
    assert.equal(guest.socket.closeCalls.length, 0);
    guest.socket.message(JSON.stringify(ice("unknown_01")));
    assert.equal(guest.socket.closeCalls.at(-1).code, 1013);
    assert.equal(signal.sockets.size, 2);
    assert.equal(signal.routes.size, 1);
    assert.equal(signal.inboundFrames, 22);
    observer.socket.message(JSON.stringify(ice("conn_9001", "still-live")));
    assert.equal(messages(host.socket).at(-1).connectionId, "conn_9001");
    assert.equal(observer.socket.closeCalls.length, 0);
  });

  await withPlatform(({ open, advance }) => {
    const guest = open("host_09", "guest_73");
    for (let frame = 0; frame < 20; frame += 1) {
      guest.socket.message(JSON.stringify(ice("unknown_03")));
    }
    advance(99);
    guest.socket.message(JSON.stringify(ice("unknown_03")));
    assert.equal(guest.socket.closeCalls.at(-1).code, 1013);
  });

  await withPlatform(({ open, advance }) => {
    const guest = open("host_15", "guest_74");
    for (let frame = 0; frame < 20; frame += 1) {
      guest.socket.message(JSON.stringify(ice("unknown_05")));
    }
    advance(100);
    guest.socket.message(JSON.stringify(ice("unknown_05")));
    assert.equal(guest.socket.closeCalls.length, 0);
    guest.socket.message(JSON.stringify(ice("unknown_05")));
    assert.equal(guest.socket.closeCalls.at(-1).code, 1013);
  });

  await withPlatform(({ open, advance }) => {
    const guest = open("host_16", "guest_75");
    for (let frame = 0; frame < 20; frame += 1) {
      guest.socket.message(JSON.stringify(ice("unknown_06")));
    }
    advance(10_000);
    for (let frame = 0; frame < 20; frame += 1) {
      guest.socket.message(JSON.stringify(ice("unknown_06")));
    }
    assert.equal(guest.socket.closeCalls.length, 0);
    guest.socket.message(JSON.stringify(ice("unknown_06")));
    assert.equal(guest.socket.closeCalls.at(-1).code, 1013);
  });
});

test("allows 2,000 inbound frames, then exhausts the object on the next frame", async () => {
  await withPlatform(({ open, signal }) => {
    const room = "host_10";
    const host = open(room, room, "host");
    const observer = open(room, "guest_observer");
    observer.socket.message(JSON.stringify(offer("conn_active")));
    for (let index = 0; index < 99; index += 1) {
      const guest = open(room, "guest_" + String(index).padStart(3, "0"));
      for (let frame = 0; frame < 20; frame += 1) {
        guest.socket.message(JSON.stringify(ice("unknown_04")));
      }
      assert.equal(guest.socket.closeCalls.length, 0);
      guest.socket.drop();
    }
    const finalGuest = open(room, "guest_final");
    for (let frame = 0; frame < 19; frame += 1) {
      finalGuest.socket.message(JSON.stringify(ice("unknown_04")));
    }
    assert.equal(signal.inboundFrames, 2_000);
    assert.equal(signal.sockets.size, 3);
    assert.equal(signal.routes.size, 1);
    assert.equal(signal.exhausted, false);

    finalGuest.socket.message(JSON.stringify(ice("unknown_04")));
    assert.equal(signal.exhausted, true);
    assert.equal(signal.sockets.size, 0);
    assert.equal(signal.routes.size, 0);
    assert.equal(host.socket.closeCalls.at(-1).code, 1013);
    assert.equal(observer.socket.closeCalls.at(-1).code, 1013);
    assert.equal(signal.fetch(request(room, "host_10", "host")).status, 429);
  });
});

test("counts orphan IDs in the bounded 64-ID ledger and refuses ID 65", async () => {
  await withPlatform(({ open, signal }) => {
    const room = "host_11";
    const observer = open(room, "guest_ledger_observer");
    let guest;
    for (let index = 0; index < 64; index += 1) {
      if (index % 20 === 0) guest = open(room, "guest_ledger_" + index);
      guest.socket.message(JSON.stringify(offer("orphan_" + String(index).padStart(4, "0"))));
      assert.deepEqual(messages(guest.socket).at(-1), {
        type: "close",
        connectionId: "orphan_" + String(index).padStart(4, "0"),
      });
      if (index % 20 === 19) guest.socket.drop();
    }
    assert.equal(signal.retiredConnectionIds.size, 64);
    assert.equal(signal.routes.size, 0);

    guest.socket.message(JSON.stringify(offer("orphan_0064")));
    assert.equal(signal.exhausted, true);
    assert.equal(signal.sockets.size, 0);
    assert.equal(observer.socket.closeCalls.at(-1).code, 1013);
    assert.equal(signal.fetch(request(room, "host_11", "host")).status, 429);
  });
});

test("all platform boundaries are fake and socket teardown leaves no routes or registrations", async () => {
  await withPlatform(({ open, signal }) => {
    const host = open("host_12", "host_12", "host");
    const guest = open("host_12", "guest_81");
    guest.socket.message(JSON.stringify(offer("conn_8001")));
    assert.equal(signal.routes.size, 1);

    guest.socket.drop();
    const hostCount = host.socket.sent.length;
    host.socket.drop();
    assert.equal(host.socket.sent.length, hostCount);
    assert.equal(signal.routes.size, 0);
    assert.equal(signal.sockets.size, 0);
    assert.equal(signal.peersById.size, 0);
  });
});
