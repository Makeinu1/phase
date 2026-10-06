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
const observationQueues: Array<() => Promise<void>> = [];
const contextGeneration = Number(sessionStorage.getItem("qa-observation-generation") ?? "0") + 1;
sessionStorage.setItem("qa-observation-generation", String(contextGeneration));
let driverStage = "unmarked", driverTeardown = false, providerSetupGeneration = 0;
const lifecycleEvents: Array<Record<string, unknown>> = [];
const observedConnections = new WeakSet<object>();
// These ordinals are observation counters, never PeerJS/session identities.
const connectionOrdinals = new WeakMap<object, number>();
const adapterOrdinals = new WeakMap<object, number>();
const sessionOrdinals = new WeakMap<object, number>();
const sessionConnections = new WeakMap<object, object>();
const sessionCreations = new WeakMap<object, number>();
let observationOrdinal = 0;
type OrdinaryStepAction = "MulliganDecision" | "DeclareAttackers" | "DeclareBlockers" | "SelectCards" | "PlayLand" | "PassPriority";
let ordinaryStepOrdinal = 0;
let ordinaryStep: {ordinal:number;startedAtUnixMs:number;phase:"entered"|"dispatch"|"completed"|"threw";
  actionKind:OrdinaryStepAction|null;dispatchAtUnixMs?:number;finishedAtUnixMs?:number} | null = null;
function visibleHandPoint(node: HTMLElement) {
  const r=node.getBoundingClientRect();
  const at=(dx:number,dy:number)=>{
    const x=r.x+r.width*dx,y=r.y+r.height*dy;
    if(x<0||y<0||x>=innerWidth||y>=innerHeight)return null;
    const hit=document.elementFromPoint(x,y);
    if(hit?.closest("[data-hand-card]")!==node)return null;
    const control=hit.closest('button,a,input,select,textarea,[role="button"]');
    if(control&&node.contains(control))return null;
    return{x,y};
  };
  // Preserve the existing nine probes before measuring exposed inset regions.
  for(const dx of [.5,.2,.8])for(const dy of [.1,.3,.6]){const p=at(dx,dy);if(p)return p;}
  for(const dx of [.05,.1,.35,.65,.9,.95])for(const dy of [.05,.15,.45,.75,.9,.95]){const p=at(dx,dy);if(p)return p;}
  return null;
}
function ordinalFor(map: WeakMap<object, number>, value: unknown) {
  if (!value || typeof value !== "object") return null;
  if (!map.has(value)) map.set(value, ++observationOrdinal);
  return map.get(value)!;
}
const repoSources = ["providers/GameProvider.tsx", "adapter/p2p-adapter.ts", "network/peer.ts", "network/connection.ts",
  "stores/gameStore.ts", "stores/multiplayerStore.ts", "game/sessionCleanup.ts", "pages/GamePage.tsx",
  "adapter/wasm-adapter.ts", "adapter/engine-worker-client.ts"];
const repoFunctions = ["P2PGuestAdapter.dispose", "P2PHostAdapter.dispose", "releaseHostEngineSession",
  "releasePrivateEngine", "setupP2P", "closeTransport", "onAbort", "dispose", "destroy", "close"];
function lifecycle(kind: string, conn?: TransportConnection, detail?: Record<string, string | boolean | number | null>) {
  try {
    if (lifecycleEvents.length >= 200) {
      if (!safeErrors.includes("lifecycle-observer-overflow")) safeErrors.push("lifecycle-observer-overflow");
      return;
    }
    // Raw stack strings remain in this call only. Emit recognized repository
    // filenames/function names/line numbers, never URLs, arguments or messages.
    const frames = (new Error().stack ?? "").split("\n").flatMap(frame => {
      const source = repoSources.find(name => frame.includes("/src/" + name));
      if (!source) return [];
      const suffix = frame.slice(frame.indexOf("/src/" + source) + source.length + 5);
      const at = suffix.match(/^(?:\?[^\s():]*)?:(\d+):(\d+)/);
      return [{ source, function: repoFunctions.find(name => frame.includes(name)) ?? null, line: at ? Number(at[1]) : null }];
    }).slice(0, 12);
    const g = useGameStore.getState();
    lifecycleEvents.push({ ordinal: lifecycleEvents.length + 1, atUnixMs: Date.now(), kind, contextGeneration,
      gameSessionGeneration: g.gameSessionGeneration, providerSetupGeneration, driverStage, driverTeardown,
      route: location.pathname.startsWith("/game/") ? "game" : "setup",
      adapterPresent: Boolean(g.adapter), snapshotPresent: Boolean(g.gameState), frames,
      ...(conn ? { connectionOrdinal: ordinalFor(connectionOrdinals, conn), connectionOpen: conn.open, channelState: conn.dataChannel?.readyState ?? null,
        peerConnectionState: conn.peerConnection?.connectionState ?? null } : {}),
      ...detail });
  } catch { safeErrors.push("lifecycle-observer-failed"); }
}
function observeMethod(target: object, method: string, kind: string, conn?: TransportConnection) {
  const object = target as Record<string, unknown>, original = object[method];
  if (typeof original !== "function") throw Error("native-observation-method-unavailable");
  object[method] = function(this: unknown, ...args: unknown[]) {
    lifecycle(kind, conn);
    // Exactly one native/original call with unchanged receiver and arguments.
    // No catch, delay, suppression or altered return/error behavior.
    return Reflect.apply(original, this, args);
  };
}
observeMethod(RTCPeerConnection.prototype, "close", "native-peer-connection-close-call");
observeMethod(RTCDataChannel.prototype, "close", "native-data-channel-close-call");
observeMethod(Worker.prototype, "terminate", "native-worker-terminate-call");
lifecycle("context-start");
useGameStore.subscribe((next, previous) => {
  if (next.adapter !== previous.adapter || Boolean(next.gameState) !== Boolean(previous.gameState)
    || next.gameSessionGeneration !== previous.gameSessionGeneration) lifecycle("game-store-session-change");
});
useSandboxUndoConsentStore.subscribe((next, previous) => {
  if (next.agreed !== previous.agreed) lifecycle(next.agreed ? "consent-on" : "consent-off");
});
window.addEventListener("pagehide", () => lifecycle("context-pagehide"));
import.meta.hot?.on("vite:beforeFullReload", () => lifecycle("vite-before-full-reload"));
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
  if (observedConnections.has(conn)) return;
  observedConnections.add(conn);
  observeMethod(conn, "close", "data-connection-close-call", conn);
  lifecycle("data-connection-observed", conn);
  let sent = Promise.resolve(), received = Promise.resolve();
  observationQueues.push(async () => { await Promise.all([sent, received]); });
  const capture = (direction: string, data: unknown) => {
    const atSend = blocked();
    const capturedAtUnixMs = Date.now();
    const run = async () => {
      try {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const message = await decodeWireMessage(bytes as Uint8Array);
        const m = message as unknown as { type: string; revision?: number; undoSync?: { undoId: string; revision: number; phase: string }; state?: GameState };
        if (m.type === "guest_deck" || m.type === "kick" || m.type === "game_setup") {
          lifecycle("wire-admission-type", conn, { direction, messageType: m.type, capturedAtUnixMs });
        }
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
    lifecycle("data-connection-open-event", conn);
  };
  if (conn.open) onOpen(); else conn.once("open", onOpen);
  // The unique-channel count above stays unchanged. Observe every emitted
  // open separately even when hostRoom consumes only the first notification.
  conn.on("open", () => lifecycle("data-connection-open-emission", conn));
  conn.on("close", () => lifecycle("data-connection-close-event", conn));
  conn.on("error", error => {
    safeErrors.push("data-connection-error");
    lifecycle("data-connection-error-event", conn, { errorKind: ["webrtc", "network", "not-open-yet", "serialization", "message-too-big"].includes(error.type ?? "") ? error.type! : "other" });
  });
}
installPeerTransportSelector(() => ({
  create(id) {
    // Actual operator-supported bootstrap seam, not a fake transport.
    const options = { host: "127.0.0.1", port: 9000, path: "/peerjs", secure: false, config: { iceServers: [] }, debug: 0 };
    const peer = id === undefined ? new Peer(options) : new Peer(id, options);
    observeMethod(peer, "destroy", "peer-destroy-call");
    lifecycle("peer-created");
    peer.on("open", () => { signalingOpened = true; lifecycle("peer-open-event"); });
    peer.on("close", () => lifecycle("peer-close-event"));
    peer.on("error", error => { safeErrors.push(["network", "peer-unavailable", "socket-error", "webrtc"].includes(error.type) ? error.type : "peer-error"); });
    peer.on("connection", conn => observe(conn as unknown as TransportConnection));
    const connect = peer.connect.bind(peer);
    peer.connect = (...args) => { const conn = connect(...args); observe(conn as unknown as TransportConnection); return conn; };
    return peer as unknown as TransportPeer;
  },
}));

let pre: GameState | undefined;
let preSeq = 0, castSeq = 0;
// Private target identity remains in this page; diagnostics emit only flags.
let pointerTarget: HTMLElement | undefined;
let pointerObjectId: number | undefined;
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
  noteAdmission(kind: string, connection?: unknown, adapter?: unknown, session?: unknown, seats?: unknown, gameStarted?: boolean) {
    try {
      if (!["peer-session-create", "host-new-connection", "host-guest-deck-first", "host-seat-check", "host-seat-joined",
        "host-seat-mutation", "host-start-request", "host-start-inner", "host-start-complete", "guest-initialize"].includes(kind)) {
        throw Error("unrecognized-admission-observation");
      }
      const conn = connection && typeof connection === "object" ? connection : undefined;
      const currentSession = session && typeof session === "object" ? session : undefined;
      if (conn && currentSession) sessionConnections.set(currentSession, conn);
      const linkedConn = conn ?? (currentSession ? sessionConnections.get(currentSession) : undefined);
      if (kind === "peer-session-create" && conn) sessionCreations.set(conn, (sessionCreations.get(conn) ?? 0) + 1);
      const counts: Record<string, number> = {};
      if (seats !== undefined) {
        if (!Array.isArray(seats)) throw Error("invalid-seat-observation");
        for (const type of ["HostHuman", "WaitingHuman", "JoinedHuman", "Ai"]) counts[type] = 0;
        for (const seat of seats) {
          if (!seat || !Object.prototype.hasOwnProperty.call(counts, seat.type)) throw Error("invalid-seat-kind-observation");
          counts[seat.type]++;
        }
      }
      lifecycle(kind, linkedConn as TransportConnection | undefined, {
        adapterOrdinal: ordinalFor(adapterOrdinals, adapter), sessionOrdinal: ordinalFor(sessionOrdinals, currentSession),
        sessionsCreatedForConnection: linkedConn ? sessionCreations.get(linkedConn) ?? 0 : null,
        ...(seats === undefined ? {} : { seatCount: (seats as unknown[]).length, waitingHumanSeats: counts.WaitingHuman,
          joinedHumanSeats: counts.JoinedHuman, aiSeats: counts.Ai, hostHumanSeats: counts.HostHuman }),
        ...(gameStarted === undefined ? {} : { gameStarted }),
      });
    } catch { safeErrors.push("lifecycle-observer-failed"); }
  },
  noteLifecycle(kind: string, signalAborted?: boolean) {
    if (!["p2p-provider-setup-start", "p2p-provider-effect-cleanup-enter", "p2p-provider-compensating-cleanup", "p2p-adapter-dispose-enter"].includes(kind)) {
      safeErrors.push("lifecycle-observer-failed"); return;
    }
    if (kind === "p2p-provider-setup-start") providerSetupGeneration++;
    lifecycle(kind, undefined, signalAborted === undefined ? undefined : { signalAborted });
  },
  noteSessionClose(reason: unknown, conn?: TransportConnection) {
    const reasons: Record<string, string> = { "Left game": "left-game", "Host session superseded": "host-superseded",
      "Removed by host": "removed", "Undecodable first message": "first-message-undecodable", "Protocol violation": "protocol-violation",
      "Wire protocol mismatch": "wire-protocol-mismatch", "Malformed P2P authority": "malformed-authority",
      "Host failed to add player": "add-player-failed", "Game in progress": "game-in-progress", "Lobby full": "lobby-full",
      "Deck validation failed": "deck-validation-failed", "Host initialization failed": "host-initialization-failed",
      "Wrong P2P session": "wrong-session", "Kicked": "kicked", "Unknown token": "unknown-token", "Not in grace": "not-in-grace",
      "Player departure is in progress": "departure-in-progress", "Reconnect already in progress": "reconnect-in-progress",
      "Player conceded": "player-conceded", "Undecodable frame during reconnect": "reconnect-frame-undecodable" };
    lifecycle("peer-session-close-enter", conn, { closeReasonCode: typeof reason === "string" && Object.prototype.hasOwnProperty.call(reasons, reason) ? reasons[reason] : "other" });
  },
  markDriverStage(next: string) { if (next !== driverStage) { driverStage = next; lifecycle("driver-stage"); } },
  markDriverTeardown() { driverTeardown = true; lifecycle("driver-teardown-marker"); },
  lifecycleSnapshot() { return { contextGeneration, driverStage, driverTeardown, events: [...lifecycleEvents] }; },
  async drainObservations() { await Promise.all(observationQueues.map(drain => drain())); },
  status() {
    const g = useGameStore.getState(), s = g.gameState;
    const w = s?.waiting_for;
    return { ready: Boolean(s && g.adapter), role, seat: getPlayerId(), route: location.pathname.startsWith("/game/") ? "game" : "setup",
      contextGeneration, gameSessionGeneration: g.gameSessionGeneration, localCommitSeq: g.lastCommittedSeq,
      waitingType: w?.type ?? null, mulliganPending: w?.type === "MulliganDecision" && w.data.pending.some(entry => entry.player === getPlayerId()),
      startingDicePending: useUiStore.getState().diceRoll?.context === "startingPlayer",
      signalingOpened, channelsOpened, nativeChannels, safeErrors: [...safeErrors], blocked: blocked(), agreed: useSandboxUndoConsentStore.getState().agreed,
      fullControl: useUiStore.getState().fullControl, fullControlApplied: s?.priority_passing_modes?.[getPlayerId()] === "FullControl",
      lastStateRevision, stackCount: s?.stack.length ?? 0, dispatchIdle: isDispatchIdle(),
      privateProjectionChecks, privateProjectionOk, wire: [...wire], ordinaryStep:ordinaryStep?{...ordinaryStep}:null };
  },
  roomCode() { return useMultiplayerStore.getState().hostGameCode; },
  async step() {
    const witness: NonNullable<typeof ordinaryStep> = {ordinal:++ordinaryStepOrdinal,startedAtUnixMs:Date.now(),phase:"entered",actionKind:null};
    ordinaryStep=witness;
    const dispatchWitness=(kind:OrdinaryStepAction) => {witness.phase="dispatch";witness.actionKind=kind;witness.dispatchAtUnixMs=Date.now();};
    try {
    if (!isDispatchIdle()) return "busy";
    const s = useGameStore.getState().gameState;
    if (!s || blocked()) return "waiting";
    const w = s.waiting_for;
    if (!w) return "waiting";
    const seat = getPlayerId();
    if (w.type === "MulliganDecision") {
      if (!w.data.pending.some(x => x.player === seat)) return "waiting";
      dispatchWitness("MulliganDecision"); await dispatchAction({ type: "MulliganDecision", data: { choice: { type: "Keep" } } }); return "keep";
    }
    if (w.type === "DeclareAttackers" && w.data.player === seat) {
      dispatchWitness("DeclareAttackers"); await dispatchAction({ type: "DeclareAttackers", data: { attacks: [] } }); return "attack-none";
    }
    if (w.type === "DeclareBlockers" && w.data.player === seat) {
      dispatchWitness("DeclareBlockers"); await dispatchAction({ type: "DeclareBlockers", data: { assignments: [] } }); return "block-none";
    }
    if (w.type === "DiscardToHandSize" && w.data.player === seat) {
      dispatchWitness("SelectCards"); await dispatchAction({ type: "SelectCards", data: { cards: w.data.cards.slice(0, w.data.count) } }); return "cleanup";
    }
    if (w.type !== "Priority" || w.data.player !== seat) return "waiting";
    const lands = s.battlefield.filter(id => s.objects[id].controller === 0 && s.objects[id].name === "Forest");
    const land = actions().find(a => a.type === "PlayLand");
    if (seat === 0 && lands.length < 2 && land) { dispatchWitness("PlayLand"); await dispatchAction(land); return "land"; }
    if (seat === 0 && lands.length === 2 && s.stack.length === 0 && ordinaryCast()) return "ready-to-cast";
    dispatchWitness("PassPriority"); await dispatchAction({ type: "PassPriority" }); return "pass";
    } catch (error) { witness.phase="threw"; throw error; }
    finally { if(witness.phase!=="threw")witness.phase="completed";witness.finishedAtUnixMs=Date.now(); }
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
      const point=visibleHandPoint(node);
      if(point){pointerTarget=node;pointerObjectId=Number(node.dataset.objectId);return point;}
    }
    return null;
  },
  lockedCardPoint() {
    // Read only the already chosen node. A disappearing or obscured target
    // cannot silently select another card during pointer readiness.
    if (!pointerTarget?.isConnected) return null;
    return visibleHandPoint(pointerTarget);
  },
  handPointerSnapshot(x: number, y: number) {
    const g = useGameStore.getState(), s = g.gameState;
    const hit = document.elementFromPoint(x, y)?.closest("[data-hand-card]");
    const r = pointerTarget?.getBoundingClientRect();
    // The fixed HandCard also highlights playable cards. Hover/drag animate
    // zIndex; neither value proves its component-local selection state.
    const highlightNode = pointerTarget?.firstElementChild;
    const inlineZIndex = pointerTarget?.style.zIndex ?? "";
    return { intendedNodeConnected: Boolean(pointerTarget?.isConnected), hitIntended: Boolean(hit && hit === pointerTarget),
      hitOtherHandCard: Boolean(hit && hit !== pointerTarget),
      intendedHighlightClassesPresent: Boolean(highlightNode?.classList.contains("ring-2") && highlightNode.classList.contains("ring-cyan-400")),
      intendedInlineZIndex: /^\d+$/.test(inlineZIndex) && Number.isFinite(Number(inlineZIndex)) ? Number(inlineZIndex) : null,
      intendedStillInHand: Boolean(s && pointerObjectId !== undefined && s.players[0].hand.includes(pointerObjectId)),
      intendedHasLegalCast: actions().some(a => a.type === "CastSpell" && a.data.object_id === pointerObjectId),
      intendedBounds: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
      engineWaiting: s?.waiting_for?.type ?? null, uiWaiting: g.waitingFor?.type ?? null, prioritySeat: s?.priority_player ?? null,
      committedSeq: g.lastCommittedSeq, commitAdvancedSinceManaSetup: g.lastCommittedSeq > preSeq,
      stackCount: s?.stack.length ?? 0, dispatchIdle: isDispatchIdle(), debugInteraction: useUiStore.getState().debugInteractionMode };
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
