/** A2 uses native WebRTC only. No Phase, factory, signaling adapter, or storage. */
const PAYLOAD_BYTES = 32;
const LIMIT_MS = 30_000;
const CANDIDATE_LIMIT = 256;
type Result = "running" | "pass" | "timeout" | "cancelled" | "api-unavailable" | "operation-failed" | "unexpected-data" | "resource-limit" | "connection-failed";
type Stage = "create-connections" | "create-channel" | "create-offer" | "set-local-offer" | "set-remote-offer" | "create-answer" | "set-local-answer" | "set-remote-answer" | "waiting-for-channels" | "exchange-bytes";
type ExchangeEvent = "handlers-attached" | "open" | "send-payload" | "send-ack" | "receive-payload" | "receive-ack";

function fixedBytes(side: number, acknowledgement: boolean): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: PAYLOAD_BYTES }, (_, index) => (index + side * 64 + (acknowledgement ? 128 : 0)) & 255);
}

function matches(data: unknown, expected: Uint8Array): boolean {
  if (!(data instanceof ArrayBuffer) || data.byteLength !== PAYLOAD_BYTES) return false;
  const bytes = new Uint8Array(data);
  return expected.every((value, index) => bytes[index] === value);
}

function nativeState<T extends string>(get: () => unknown, allowed: readonly T[]): T | null {
  try { const value = get(); for (const state of allowed) if (value === state) return state; }
  catch { /* Inaccessible state stays unknown. */ }
  return null;
}

export function startCapabilityControl() {
  const startedAt = Date.now();
  let stoppedAt: number | null = null;
  let stage: Stage = "create-connections";
  let result: Result = "running";
  let exchangeStarted = false;
  // Fixed names/side numbers only. Send records API calls, not delivery proof.
  const exchangeEvents: { side: number; event: ExchangeEvent }[] = [];
  const cleanups: (() => void)[] = [];
  const sides = [0, 1].map(() => ({
    pc: null as RTCPeerConnection | null, channel: null as RTCDataChannel | null,
    remoteReady: false, queue: [] as (RTCIceCandidateInit | null)[], tail: Promise.resolve(),
    counts: { iceEvents: 0, localCandidates: 0, queuedCandidates: 0, applyingCandidates: 0, appliedCandidates: 0,
      openEvents: 0, messagesSent: 0, messagesReceived: 0, bytesSent: 0, bytesReceived: 0 },
    endOfCandidates: false, payloadReceived: false, acknowledgementReceived: false,
  }));
  const capture = () => ({
    stage, result, elapsedMs: Math.max(0, (stoppedAt ?? Date.now()) - startedAt),
    limitMs: LIMIT_MS, payloadBytes: PAYLOAD_BYTES, iceServerCount: 0,
    exchangeEvents: exchangeEvents.map((event) => ({ ...event })),
    sides: sides.map((side) => ({
      states: {
        connection: nativeState(() => side.pc?.connectionState, ["new", "connecting", "connected", "disconnected", "failed", "closed"]),
        ice: nativeState(() => side.pc?.iceConnectionState, ["new", "checking", "connected", "completed", "disconnected", "failed", "closed"]),
        gathering: nativeState(() => side.pc?.iceGatheringState, ["new", "gathering", "complete"]),
        signaling: nativeState(() => side.pc?.signalingState, ["stable", "have-local-offer", "have-remote-offer", "have-local-pranswer", "have-remote-pranswer", "closed"]),
        channel: nativeState(() => side.channel?.readyState, ["connecting", "open", "closing", "closed"]),
      },
      counts: { ...side.counts }, endOfCandidates: side.endOfCandidates,
      payloadReceived: side.payloadReceived, acknowledgementReceived: side.acknowledgementReceived,
    })),
  });
  type Snapshot = ReturnType<typeof capture>;
  let terminal: Snapshot | null = null;
  let resolveCompletion: (snapshot: Snapshot) => void = () => {};
  const completion = new Promise<Snapshot>((resolve) => { resolveCompletion = resolve; });
  const finish = (outcome: Result) => {
    if (result !== "running") return;
    result = outcome;
    stoppedAt = Date.now();
    terminal = capture(); // Preserve states before cleanup; never retain descriptions/candidate text.
    clearTimeout(deadline);
    for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* Cleanup must continue. */ } }
    for (const side of sides) {
      side.queue.length = 0;
      try { side.channel?.close(); } catch { /* Cleanup must continue. */ }
      try { side.pc?.close(); } catch { /* Cleanup must continue. */ }
      side.channel = null;
      side.pc = null;
    }
    resolveCompletion(structuredClone(terminal));
  };
  const deadline = setTimeout(() => finish("timeout"), LIMIT_MS);
  const record = (side: number, event: ExchangeEvent) => {
    if (exchangeEvents.length >= 16) { finish("resource-limit"); return false; }
    exchangeEvents.push({ side, event });
    return true;
  };
  const listen = (target: EventTarget, name: string, handler: EventListener) => {
    const guarded: EventListener = (event) => {
      if (result !== "running") return;
      try { handler(event); } catch { finish("operation-failed"); }
    };
    target.addEventListener(name, guarded);
    cleanups.push(() => target.removeEventListener(name, guarded));
  };
  const drain = (index: number) => {
    const side = sides[index];
    if (!side.remoteReady || result !== "running") return;
    for (const candidate of side.queue.splice(0)) {
      side.tail = side.tail.then(async () => {
        if (result !== "running" || !side.pc) return;
        const actual = candidate !== null && candidate.candidate !== "";
        if (actual) { side.counts.queuedCandidates -= 1; side.counts.applyingCandidates += 1; }
        try {
          await side.pc.addIceCandidate(candidate);
          if (result !== "running") return;
          if (actual) { side.counts.applyingCandidates -= 1; side.counts.appliedCandidates += 1; }
        } catch {
          if (result === "running" && actual) side.counts.applyingCandidates -= 1;
          finish("operation-failed");
        }
      });
    }
  };
  const send = (index: number, acknowledgement: boolean) => {
    if (result !== "running") return;
    const side = sides[index];
    if (!record(index, acknowledgement ? "send-ack" : "send-payload")) return;
    try {
      // ACK echoes the sender's payload identity, not this side's identity.
      side.channel!.send(fixedBytes(acknowledgement ? 1 - index : index, acknowledgement));
      side.counts.messagesSent += 1;
      side.counts.bytesSent += PAYLOAD_BYTES;
    } catch { finish("operation-failed"); }
  };
  const attach = (index: number, channel: RTCDataChannel) => {
    const side = sides[index];
    if (result !== "running" || side.channel) { try { channel.close(); } catch { /* No leak. */ } return; }
    side.channel = channel;
    channel.binaryType = "arraybuffer";
    const opened = () => {
      if (result !== "running" || side.counts.openEvents) return;
      side.counts.openEvents += 1;
      if (!record(index, "open")) return;
      // Receiver readyState can be open inside datachannel before its open event.
      // Both actual events also prove both sets of message handlers are installed.
      if (exchangeStarted || !sides.every((item) => item.counts.openEvents === 1 && item.channel?.readyState === "open")) return;
      exchangeStarted = true;
      stage = "exchange-bytes";
      for (let other = 0; other < sides.length; other += 1) send(other, false);
    };
    listen(channel, "open", opened);
    listen(channel, "error", () => finish("operation-failed"));
    listen(channel, "close", () => finish("connection-failed"));
    listen(channel, "message", (event) => {
      if (result !== "running") return;
      const data: unknown = (event as MessageEvent).data;
      side.counts.messagesReceived += 1;
      if (!exchangeStarted) { finish("unexpected-data"); return; }
      if (matches(data, fixedBytes(1 - index, false)) && !side.payloadReceived) {
        side.counts.bytesReceived += PAYLOAD_BYTES;
        side.payloadReceived = true;
        if (!record(index, "receive-payload")) return;
        send(index, true);
      } else if (matches(data, fixedBytes(index, true)) && !side.acknowledgementReceived) {
        side.counts.bytesReceived += PAYLOAD_BYTES;
        side.acknowledgementReceived = true;
        if (!record(index, "receive-ack")) return;
      } else { finish("unexpected-data"); return; }
      if (sides.every((item) => item.payloadReceived && item.acknowledgementReceived)) finish("pass");
    });
    record(index, "handlers-attached");
  };
  const negotiate = async () => {
    try {
      if (typeof RTCPeerConnection !== "function") { finish("api-unavailable"); return; }
      for (let index = 0; index < sides.length; index += 1) {
        const pc = new RTCPeerConnection({ iceServers: [] });
        sides[index].pc = pc;
        listen(pc, "connectionstatechange", () => {
          if (pc.connectionState === "failed" || pc.connectionState === "closed") finish("connection-failed");
        });
        listen(pc, "icecandidate", (event) => {
          if (result !== "running") return;
          const candidate = (event as RTCPeerConnectionIceEvent).candidate?.toJSON() ?? null;
          const actual = candidate !== null && candidate.candidate !== "";
          sides[index].counts.iceEvents += 1;
          if (actual) sides[index].counts.localCandidates += 1;
          else sides[index].endOfCandidates = true;
          const other = sides[1 - index];
          if (sides[index].counts.iceEvents > CANDIDATE_LIMIT || other.queue.length >= CANDIDATE_LIMIT) { finish("resource-limit"); return; }
          other.queue.push(candidate);
          if (actual) other.counts.queuedCandidates += 1;
          drain(1 - index);
        });
      }
      const left = sides[0].pc!;
      const right = sides[1].pc!;
      listen(right, "datachannel", (event) => attach(1, (event as RTCDataChannelEvent).channel));
      stage = "create-channel";
      attach(0, left.createDataChannel("qa-a2-capability", { ordered: true }));
      stage = "create-offer";
      const offer = await left.createOffer();
      if (result !== "running") return;
      stage = "set-local-offer";
      await left.setLocalDescription(offer);
      if (result !== "running") return;
      stage = "set-remote-offer";
      await right.setRemoteDescription(left.localDescription ?? offer);
      if (result !== "running") return;
      sides[1].remoteReady = true;
      drain(1);
      stage = "create-answer";
      const answer = await right.createAnswer();
      if (result !== "running") return;
      stage = "set-local-answer";
      await right.setLocalDescription(answer);
      if (result !== "running") return;
      stage = "set-remote-answer";
      await left.setRemoteDescription(right.localDescription ?? answer);
      if (result !== "running") return;
      sides[0].remoteReady = true;
      drain(0);
      if (!exchangeStarted) stage = "waiting-for-channels";
    } catch { finish("operation-failed"); }
  };
  void negotiate();
  return {
    completion,
    snapshot: () => structuredClone(terminal ?? capture()),
    cancel: () => finish("cancelled"),
  };
}
