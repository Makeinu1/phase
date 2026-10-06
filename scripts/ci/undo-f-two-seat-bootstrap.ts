// CI bootstrap only: mount the real App with real loopback PeerJS/native RTC.
import Peer from "peerjs";
import { installPeerTransportSelector, type TransportConnection, type TransportPeer } from "./network/transport";
import { decodeWireMessage } from "./network/protocol";
import { useGameStore } from "./stores/gameStore";
import { useUiStore } from "./stores/uiStore";
import { usePreferencesStore } from "./stores/preferencesStore";
import { useMultiplayerStore } from "./stores/multiplayerStore";
import { FORMAT_REGISTRY } from "./data/formatRegistry";
import { dispatchAction, isDispatchIdle } from "./game/dispatch";
import { getPlayerId } from "./hooks/usePlayerId";
import { serializeSavedDeck } from "./services/savedDeckProjection";
import { useSandboxUndoConsentStore } from "./stores/sandboxUndoConsentStore";
import type { GameAction, GameState } from "./adapter/types";

const role = sessionStorage.getItem("qa-seat");
if (role !== "host" && role !== "guest") throw Error("QA seat missing");
const deckName = role === "host" ? "QA Host" : "QA Guest";
localStorage.setItem("phase-deck:" + deckName, serializeSavedDeck({
  main: role === "host" ? [{ name: "Forest", count: 32 }, { name: "Grizzly Bears", count: 8 }] : [{ name: "Forest", count: 40 }], sideboard: [],
}, "Limited", null));
localStorage.setItem("phase-active-deck", deckName);
localStorage.setItem("phase-feeds-initialized", "true");
usePreferencesStore.getState().setNativeEngineEnabled(false);
usePreferencesStore.getState().setLanguage("en");
useMultiplayerStore.getState().setFormatConfig(FORMAT_REGISTRY.find(x => x.format === "Limited")!.default_config);

type WireObservation = { type: string; direction: string; phase?: string; revision?: number; blocked: boolean; exactTransaction?: boolean };
const wire: WireObservation[] = [];
let channelsOpened = 0, nativeChannels = false, signalingOpened = false;
const safeErrors: string[] = [];
let privateProjectionChecks = 0, privateProjectionOk = true;
let undoIdentity: string | undefined;
let undoRevision: number | undefined;
let lastStateRevision = 0;
const blocked = () => Boolean((useGameStore.getState().adapter as unknown as { undoSyncInputBlocked?: boolean } | null)?.undoSyncInputBlocked);
function privacy(state: GameState) {
  // Rust emits this redacted serialized field; the public TS projection omits
  // its declaration. Missing is a failure, never synthesized as zero.
  const rng = state as GameState & { rng_word_pos?: number | string };
  const hidden = state.players[0].hand.map(id => state.objects[id]);
  return String(rng.rng_seed) === "0" && String(rng.rng_word_pos) === "0"
    && hidden.length > 0
    && hidden.every(x => x && x.name === "Hidden Card" && x.card_id === 0 && !x.display_visible_to_viewer
      && !x.printed_ref && !x.token_image_ref && !x.token_rules_text && !x.token_art
      && Object.values(x.card_types).every(types => types.length === 0)
      && x.abilities.length === 0 && x.keywords.length === 0);
}
function observe(conn: TransportConnection) {
  let sent = Promise.resolve(), received = Promise.resolve();
  const capture = (direction: string, data: unknown) => {
    const atSend = blocked();
    const run = async () => {
      try {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const message = await decodeWireMessage(bytes as Uint8Array);
        const m = message as unknown as { type: string; revision?: number; undoSync?: { undoId: string; revision: number; phase: string }; state?: GameState };
        if (m.type === "state_update" || m.type === "game_setup") {
          lastStateRevision = Math.max(lastStateRevision, m.revision ?? 0);
          if (role === "guest" && direction === "receive" && m.state) {
            privateProjectionChecks++; privateProjectionOk &&= privacy(m.state);
          }
        }
        if (m.undoSync) {
          if (undoIdentity === undefined) { undoIdentity = m.undoSync.undoId; undoRevision = m.undoSync.revision; }
          wire.push({ type: m.type, direction, phase: m.undoSync.phase, revision: m.revision,
            blocked: atSend, exactTransaction: undoIdentity === m.undoSync.undoId && undoRevision === m.undoSync.revision });
        }
      } catch { safeErrors.push("wire-observer-failed"); }
    };
    if (direction === "send") sent = sent.then(run); else received = received.then(run);
  };
  const send = conn.send.bind(conn);
  conn.send = data => { send(data); capture("send", data); };
  conn.on("data", data => capture("receive", data));
  const onOpen = () => {
    channelsOpened++;
    nativeChannels = conn.peerConnection instanceof RTCPeerConnection && conn.dataChannel instanceof RTCDataChannel && conn.dataChannel.ordered;
  };
  if (conn.open) onOpen(); else conn.once("open", onOpen);
  conn.on("error", () => { safeErrors.push("data-connection-error"); });
}
installPeerTransportSelector(() => ({
  create(id) {
    // Actual operator-supported bootstrap seam, not a fake transport.
    const options = { host: "127.0.0.1", port: 9000, path: "/peerjs", secure: false, config: { iceServers: [] }, debug: 0 };
    const peer = id === undefined ? new Peer(options) : new Peer(id, options);
    peer.on("open", () => { signalingOpened = true; });
    peer.on("error", error => { safeErrors.push(["network", "peer-unavailable", "socket-error", "webrtc"].includes(error.type) ? error.type : "peer-error"); });
    peer.on("connection", conn => observe(conn as unknown as TransportConnection));
    const connect = peer.connect.bind(peer);
    peer.connect = (...args) => { const conn = connect(...args); observe(conn as unknown as TransportConnection); return conn; };
    return peer as unknown as TransportPeer;
  },
}));

let pre: GameState | undefined;
let preSeq = 0, castSeq = 0;
const actions = () => {
  const g = useGameStore.getState();
  return [...g.legalActions, ...Object.values(g.legalActionsByObject).flat()] as GameAction[];
};
const ordinaryCast = () => {
  const state = useGameStore.getState().gameState;
  return actions().find(a => a.type === "CastSpell" && state?.objects[a.data.object_id]?.name === "Grizzly Bears");
};
const publicState = (s: GameState) => JSON.stringify({
  phase: s.phase, priority: s.priority_player, active: s.active_player, waiting: s.waiting_for,
  players: s.players.map(p => ({ life: p.life, mana: p.mana_pool, handCount: p.hand.length })),
  battlefield: s.battlefield.map(id => s.objects[id]), stack: s.stack,
});
const qa = {
  status() {
    const g = useGameStore.getState(), s = g.gameState;
    return { ready: Boolean(s && g.adapter), role, seat: getPlayerId(), route: location.pathname.startsWith("/game/") ? "game" : "setup",
      signalingOpened, channelsOpened, nativeChannels, safeErrors: [...safeErrors], blocked: blocked(), agreed: useSandboxUndoConsentStore.getState().agreed,
      fullControl: useUiStore.getState().fullControl, fullControlApplied: s?.priority_passing_modes?.[getPlayerId()] === "FullControl",
      lastStateRevision, stackCount: s?.stack.length ?? 0, dispatchIdle: isDispatchIdle(),
      privateProjectionChecks, privateProjectionOk, wire: [...wire] };
  },
  roomCode() { return useMultiplayerStore.getState().hostGameCode; },
  async step() {
    if (!isDispatchIdle()) return "busy";
    const s = useGameStore.getState().gameState;
    if (!s || blocked()) return "waiting";
    const w = s.waiting_for;
    if (!w) return "waiting";
    const seat = getPlayerId();
    if (w.type === "MulliganDecision") {
      if (!w.data.pending.some(x => x.player === seat)) return "waiting";
      await dispatchAction({ type: "MulliganDecision", data: { choice: { type: "Keep" } } }); return "keep";
    }
    if (w.type === "DeclareAttackers" && w.data.player === seat) {
      await dispatchAction({ type: "DeclareAttackers", data: { attacks: [] } }); return "attack-none";
    }
    if (w.type === "DeclareBlockers" && w.data.player === seat) {
      await dispatchAction({ type: "DeclareBlockers", data: { assignments: [] } }); return "block-none";
    }
    if (w.type === "DiscardToHandSize" && w.data.player === seat) {
      await dispatchAction({ type: "SelectCards", data: { cards: w.data.cards.slice(0, w.data.count) } }); return "cleanup";
    }
    if (w.type !== "Priority" || w.data.player !== seat) return "waiting";
    const lands = s.battlefield.filter(id => s.objects[id].controller === 0 && s.objects[id].name === "Forest");
    const land = actions().find(a => a.type === "PlayLand");
    if (seat === 0 && lands.length < 2 && land) { await dispatchAction(land); return "land"; }
    if (seat === 0 && lands.length === 2 && s.stack.length === 0 && ordinaryCast()) return "ready-to-cast";
    await dispatchAction({ type: "PassPriority" }); return "pass";
  },
  async prepareCast() {
    const mana = actions().find(a => a.type === "TapLandForMana");
    if (!mana || getPlayerId() !== 0) throw Error("semantic-mana-unavailable");
    await dispatchAction(mana);
    pre = structuredClone(useGameStore.getState().gameState!); preSeq = useGameStore.getState().lastCommittedSeq;
    return pre.stack.length === 0 && pre.players[0].mana_pool.mana.length === 1 && Boolean(ordinaryCast());
  },
  cardPoint() {
    const s = useGameStore.getState().gameState;
    for (const node of document.querySelectorAll<HTMLElement>("[data-player-hand] [data-hand-card][data-object-id]")) {
      if (s?.objects[Number(node.dataset.objectId)]?.name !== "Grizzly Bears") continue;
      const r = node.getBoundingClientRect();
      for (const dx of [.5, .2, .8]) for (const dy of [.1, .3, .6]) {
        const x = r.x + r.width * dx, y = r.y + r.height * dy;
        if (document.elementFromPoint(x, y)?.closest("[data-hand-card]") === node) return { x, y };
      }
    }
    return null;
  },
  recordCast() {
    const g = useGameStore.getState(); castSeq = g.lastCommittedSeq;
    return Boolean(pre && g.gameState?.stack.length === 1 && castSeq > preSeq);
  },
  restoreWitness() {
    const g = useGameStore.getState();
    return Boolean(pre && g.gameState && publicState(g.gameState) === publicState(pre)
      && JSON.stringify(g.gameState.players[0].hand) === JSON.stringify(pre.players[0].hand)
      && g.lastCommittedSeq > castSeq && !blocked());
  },
  publicState() { const s = useGameStore.getState().gameState; return s ? publicState(s) : null; },
  privacy() { const s = useGameStore.getState().gameState; return Boolean(s && privacy(s)); },
};
(window as unknown as { __twoSeatQa: typeof qa }).__twoSeatQa = qa;
// The real application renders /multiplayer and /game, not fixture components.
void import("./main");
