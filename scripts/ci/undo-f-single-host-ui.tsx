// CI-only component harness. A real host/Worker, no guest or Undo gate bypass.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import Peer from "peerjs";
import "./i18n";
import { SandboxUndoConsent } from "./components/lobby/SandboxUndoConsent";
import { SandboxPrecastUndoButton } from "./components/board/SandboxPrecastUndoButton";
import { takeSandboxUndoConsent, useSandboxUndoConsentStore } from "./stores/sandboxUndoConsentStore";
import { useGameStore } from "./stores/gameStore";
import { P2PHostAdapter } from "./adapter/p2p-adapter";
import type { TransportPeer } from "./network/transport";
import { FORMAT_REGISTRY } from "./data/formatRegistry";
import { getDiagnosticSources } from "./services/troubleshooting";

type WorkerObservation = { engine: boolean; terminated: boolean; requests: string[]; errors: number };
declare global {
  interface Window {
    __hostUiMonitor: { workers: WorkerObservation[] };
    __hostUiResult: Record<string, string | number | boolean>;
  }
}
window.__hostUiResult = { devGate: import.meta.env.DEV && import.meta.env.VITE_PHASE_SANDBOX === "1" };
const initialDiagnostics = getDiagnosticSources().engines.length;
window.__hostUiResult.initialDiagnostics = initialDiagnostics;
let guestConnections = 0;

function Harness() {
  const [stage, setStage] = useState("consent");
  const [host, setHost] = useState<P2PHostAdapter | null>(null);
  const agreed = useSandboxUndoConsentStore(s => s.agreed);
  const snapshotActive = useGameStore(s => s.gameState !== null);
  const start = async () => {
    setStage("starting");
    try {
      const format = FORMAT_REGISTRY.find(entry => entry.format === "Limited")!.default_config;
      // Real PeerJS, deliberately no signalling server/broker/remote guest.
      const peer = new Peer("qa-single-host", { host: "127.0.0.1", port: Number(location.port),
        path: "/unused-qa-peer", secure: false, config: { iceServers: [] } });
      peer.on("error", () => {});
      const adapter = new P2PHostAdapter({ player: { main_deck: Array(40).fill("Forest") } },
        peer as unknown as TransportPeer, handler => {
          const receive = (connection: Parameters<typeof handler>[0]) => { guestConnections++; handler(connection); };
          peer.on("connection", receive);
          return () => peer.off("connection", receive);
        }, 2, format);
      setHost(adapter);
      if (takeSandboxUndoConsent()) adapter.enableUndoSyncExperiment();
      await adapter.initialize();
      await adapter.applySeatMutation({ type: "SetKind", data: { seatIndex: 1, kind: {
        type: "Ai", data: { difficulty: "Medium", deck: { type: "DeckList", data: { main_deck: Array(40).fill("Forest"), sideboard: [], commander: [] } } },
      } } });
      useGameStore.getState().setGameMode("p2p-host");
      await useGameStore.getState().initGame("ci-single-host-ui", adapter, undefined, format, 2);
      const snapshot = await adapter.getSnapshot();
      window.__hostUiResult.realHostInitialized = snapshot.state.players.length === 2 && snapshot.state.waiting_for !== null;
      window.__hostUiResult.guestConnections = guestConnections;
      window.__hostUiResult.undoAvailable = await adapter.sandboxPrecastUndoAvailable();
      window.__hostUiResult.activeDiagnostics = getDiagnosticSources().engines.length;
      setStage("active");
    } catch (cause) {
      window.__hostUiResult.failedStage = "start-host";
      window.__hostUiResult.errorType = cause instanceof Error ? cause.name : "unknown";
      setStage("failed");
    }
  };
  const close = async () => {
    setStage("closing");
    try {
      await host!.terminateGame();
      // The existing reset also disposes: exercise that idempotent close path.
      useGameStore.getState().reset();
      window.__hostUiResult.displayCleared = useGameStore.getState().adapter === null && useGameStore.getState().gameState === null;
      window.__hostUiResult.diagnosticsCleared = getDiagnosticSources().engines.length === initialDiagnostics;
      setHost(null);
      setStage("closed");
    } catch (cause) {
      window.__hostUiResult.failedStage = "close-host";
      window.__hostUiResult.errorType = cause instanceof Error ? cause.name : "unknown";
      setStage("failed");
    }
  };
  return <main>
    <h1>Single-host Sandbox Undo component acceptance</h1>
    <p>Real WASM Worker / official small fixture / AI opponent / no connected guest.</p>
    <p>Positive restore, full board UX, two-seat sync and memory reclamation are NOT RUN.</p>
    <SandboxUndoConsent />
    <output id="consent-agreed">{String(agreed)}</output>
    <button id="start-host" disabled={!agreed || stage !== "consent"} onClick={() => { void start(); }}>Start host</button>
    <SandboxPrecastUndoButton />
    <button id="close-host" disabled={stage !== "active"} onClick={() => { void close(); }}>Close host</button>
    <output id="snapshot-active">{String(snapshotActive)}</output>
    <output id="status">{stage}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
