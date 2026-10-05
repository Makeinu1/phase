import { useEffect, useRef, useState } from "react";
import type { TransportConnection, TransportPeer } from "../network/transport";
import type { PrivateQaRtcBrowserApi } from "./privateRtcBootstrap";

const PROBE_BYTES = 64 * 1024;

interface PanelPeer {
  peer: TransportPeer;
  role: "host" | "guest";
}

interface PanelConnection {
  connection: TransportConnection;
  openEvents: number;
}

function buildProbeBytes(): Uint8Array {
  const bytes = new Uint8Array(PROBE_BYTES);
  let value = 0x13579bdf;
  for (let index = 0; index < bytes.length; index += 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    bytes[index] = value & 0xff;
  }
  return bytes;
}

function exactMatch(actual: unknown, expected: Uint8Array): boolean {
  if (actual instanceof ArrayBuffer) {
    const bytes = new Uint8Array(actual);
    return bytes.byteLength === expected.byteLength && expected.every((byte, index) => bytes[index] === byte);
  }
  if (!ArrayBuffer.isView(actual)) return false;
  const bytes = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
  return bytes.byteLength === expected.byteLength && expected.every((byte, index) => bytes[index] === byte);
}

export default function PrivateRtcPanel({ api }: { api: PrivateQaRtcBrowserApi }) {
  const [peer, setPeer] = useState<PanelPeer | null>(null);
  const [peerReady, setPeerReady] = useState(false);
  const [peerCode, setPeerCode] = useState("");
  const [connection, setConnection] = useState<PanelConnection | null>(null);
  const [probeResult, setProbeResult] = useState("Not sent");
  const [failure, setFailure] = useState("");
  const [snapshotTick, setSnapshotTick] = useState(0);
  const expectedProbe = useRef<Uint8Array | null>(null);
  const peerRef = useRef<PanelPeer | null>(null);
  const connectionRef = useRef<PanelConnection | null>(null);
  const snapshot = api.snapshot();
  const liveConnections = snapshot.peers.flatMap((peerSnapshot, peerIndex) =>
    peerSnapshot.connections.map((connectionSnapshot, connectionIndex) => ({
      key: `${peerIndex}-${connectionIndex}`,
      label: `Transport peer ${peerIndex + 1}, connection ${connectionIndex + 1}`,
      connection: connectionSnapshot,
    })),
  );

  useEffect(() => {
    const timer = window.setInterval(() => setSnapshotTick((tick) => tick + 1), 300);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    // Keep the snapshot call in the render path so connection states and
    // counters stay current without logging any signaling or game data.
    void snapshotTick;
  }, [snapshotTick]);

  const reset = () => {
    const active = connectionRef.current;
    if (active) {
      try { active.connection.close(); } catch { /* Continue peer cleanup. */ }
    }
    const activePeer = peerRef.current;
    if (activePeer) {
      try { activePeer.peer.destroy(); } catch { /* Continue panel cleanup. */ }
    }
    peerRef.current = null;
    connectionRef.current = null;
    expectedProbe.current = null;
    setPeer(null);
    setPeerReady(false);
    setConnection(null);
    setPeerCode("");
    setProbeResult("Not sent");
    setFailure("");
  };

  const createPeer = (role: "host" | "guest") => {
    reset();
    try {
      const hostCode = role === "host"
        ? `qa-${crypto.randomUUID().replace(/-/g, "")}`
        : undefined;
      const created: PanelPeer = { peer: api.createProbePeer(hostCode), role };
      peerRef.current = created;
      setPeer(created);
      if (hostCode) setPeerCode(hostCode);
      created.peer.once("open", () => setPeerReady(true));
      created.peer.on("error", () => setFailure("Peer setup failed; reset and try again."));
      if (role === "host") {
        created.peer.on("connection", (incoming) => attachConnection(created, incoming, true));
      }
    } catch {
      setFailure("Private RTC peer could not be created.");
    }
  };

  const attachConnection = (owner: PanelPeer, conn: TransportConnection, echo: boolean) => {
    if (peerRef.current !== owner || connectionRef.current) {
      try { conn.close(); } catch { /* Reject any extra probe connection. */ }
      return;
    }
    const active: PanelConnection = { connection: conn, openEvents: 0 };
    connectionRef.current = active;
    setConnection(active);
    conn.on("open", () => {
      active.openEvents += 1;
      setConnection({ ...active });
    });
    conn.on("error", () => setFailure("Private RTC data channel failed; reset and try again."));
    conn.on("close", () => setConnection((current) => current?.connection === conn ? { ...active } : current));
    conn.on("data", (data) => {
      if (echo) {
        try { conn.send(data); }
        catch { setFailure("Private RTC echo failed; reset and try again."); }
        return;
      }
      const expected = expectedProbe.current;
      if (!expected) return;
      setProbeResult(exactMatch(data, expected) ? "Exact 64 KiB echo received" : "Echo did not match");
      expectedProbe.current = null;
    });
  };

  const connect = () => {
    if (!peer || peer.role !== "guest" || !peerReady || connectionRef.current) return;
    const target = peerCode.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(target)) {
      setFailure("Enter the host code shown in the other tab.");
      return;
    }
    try {
      const conn = peer.peer.connect(target, { serialization: "binary", reliable: true });
      attachConnection(peer, conn, false);
      setFailure("");
    } catch {
      setFailure("Private RTC connection could not start.");
    }
  };

  const sendProbe = () => {
    const conn = connectionRef.current?.connection;
    if (!conn?.open) return;
    const bytes = buildProbeBytes();
    expectedProbe.current = bytes;
    setProbeResult("Waiting for exact echo");
    try { conn.send(bytes); }
    catch { expectedProbe.current = null; setFailure("Probe send failed; reset and try again."); }
  };

  const activeSnapshot = peer
    ? snapshot.peers.find((item) => item.id === peer.peer.id)?.connections[0]
    : undefined;
  const channel = connection?.connection.dataChannel ?? null;
  const rtcConfiguration = connection?.connection.peerConnection?.getConfiguration();

  return (
    <aside aria-label="Private RTC QA probe" className="private-rtc-panel">
      <header className="private-rtc-panel__header">
        <strong>Private two tab RTC probe</strong>
        <button type="button" className="private-rtc-panel__button" onClick={reset}>Reset</button>
      </header>
      <p className="private-rtc-panel__muted">
        This panel uses only local BroadcastChannel signaling and RTC data. It does not start a game, lobby, or diagnostics request.
      </p>

      {!peer && (
        <div className="private-rtc-panel__button-row">
          <button type="button" className="private-rtc-panel__button" onClick={() => createPeer("host")}>Create host</button>
          <button type="button" className="private-rtc-panel__button" onClick={() => createPeer("guest")}>Create guest</button>
        </div>
      )}
      {peer && (
        <p role="status" className="private-rtc-panel__line">{peer.role === "host" ? "Host peer" : "Guest peer"}: {peerReady ? "ready" : "starting"}</p>
      )}
      {peer?.role === "host" && (
        <label className="private-rtc-panel__label">
          Host code to enter in the other tab
          <input aria-label="Host code" readOnly value={peerCode} className="private-rtc-panel__input" />
        </label>
      )}
      {peer?.role === "guest" && !connection && (
        <div className="private-rtc-panel__connect-row">
          <label className="private-rtc-panel__label">
            Host code
            <input aria-label="Host code" value={peerCode} onChange={(event) => setPeerCode(event.target.value)} className="private-rtc-panel__input" />
          </label>
          <button type="button" className="private-rtc-panel__button" disabled={!peerReady} onClick={connect}>Connect</button>
        </div>
      )}

      {connection && (
        <section aria-label="Private RTC connection status" className="private-rtc-panel__section">
          <p className="private-rtc-panel__line">ICE: {activeSnapshot?.iceConnectionState ?? "waiting"}</p>
          <p className="private-rtc-panel__line">Connection: {activeSnapshot?.connectionState ?? "waiting"}</p>
          <p className="private-rtc-panel__line">Data channel: {activeSnapshot?.channelState ?? "waiting"}; ordered: {activeSnapshot?.ordered === null || activeSnapshot?.ordered === undefined ? "unknown" : String(activeSnapshot.ordered)}</p>
          <p className="private-rtc-panel__line">Connection open events: {connection.openEvents}</p>
          <p className="private-rtc-panel__line">Frames sent/received: {activeSnapshot?.framesSent ?? 0}/{activeSnapshot?.framesReceived ?? 0}</p>
          <p className="private-rtc-panel__line">Bytes sent/received: {activeSnapshot?.bytesSent ?? 0}/{activeSnapshot?.bytesReceived ?? 0}</p>
          <p className="private-rtc-panel__line">Negotiated send limit: {activeSnapshot?.negotiatedMaxMessageSize ?? "waiting"}; supported message cap: {activeSnapshot?.maxLogicalMessageBytes ?? "waiting"} bytes</p>
          <p className="private-rtc-panel__line">Configured ICE servers: {rtcConfiguration?.iceServers?.length ?? "waiting"}</p>
          {peer?.role === "guest" && (
            <button type="button" className="private-rtc-panel__button" disabled={!channel || channel.readyState !== "open"} onClick={sendProbe}>
              Send 64 KiB binary probe
            </button>
          )}
          <p role="status" className="private-rtc-panel__line">Probe: {probeResult}</p>
        </section>
      )}
      <section aria-label="All private RTC transport connections" className="private-rtc-panel__section">
        <h3 className="private-rtc-panel__heading">Live transport connections ({liveConnections.length})</h3>
        {liveConnections.length === 0 ? (
          <p className="private-rtc-panel__line">None</p>
        ) : liveConnections.map(({ key, label, connection: live }) => (
          <div key={key} className="private-rtc-panel__connection">
            <p className="private-rtc-panel__line">{label}: ICE {live.iceConnectionState}, connection {live.connectionState}, channel {live.channelState ?? "waiting"}, ordered {String(live.ordered)}</p>
            <p className="private-rtc-panel__line">Frames sent/received {live.framesSent}/{live.framesReceived}; bytes sent/received {live.bytesSent}/{live.bytesReceived}</p>
          </div>
        ))}
      </section>
      {failure && <p role="alert" className="private-rtc-panel__error">{failure}</p>}
      <p className="private-rtc-panel__footer">
        Confirm ICE connected, ordered channel open, one open event, empty ICE server configuration, and exact probe echo before the separate game setup gate.
      </p>
    </aside>
  );
}
