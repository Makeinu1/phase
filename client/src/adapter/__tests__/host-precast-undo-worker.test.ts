import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// RPC plumbing fixtures only; native tests separately exercise the reducers.
const wasm = vi.hoisted(() => ({
  disable_host_precast_undo: vi.fn(),
  host_precast_undo_status: vi.fn(),
  enable_host_precast_undo: vi.fn(),
  restore_host_precast_undo: vi.fn(),
  initialize_multiplayer_host_game: vi.fn(),
  initialize_game: vi.fn(),
  resume_multiplayer_host_state: vi.fn(),
  load_card_database: vi.fn(),
  set_multiplayer_mode: vi.fn(),
  clear_game_state: vi.fn(),
  get_game_state: vi.fn(),
  get_legal_actions_js: vi.fn(),
}));
vi.mock("@wasm/engine", () => ({ default: vi.fn(), ...wasm }));

const armed = { binding: "9.2.7", enabled: true, phase: "Armed", receipt: "18446744073709551615" };
const consumed = { ...armed, phase: "Consumed" };
const state = { state_revision: 4 };
const legalResult = { actions: [], autoPassRecommended: false };
let hostSelf: { postMessage: ReturnType<typeof vi.fn>; onmessage: ((e: unknown) => Promise<void>) | null };
let requestId = 0;
async function send(data: Record<string, unknown>) {
  const id = ++requestId;
  await hostSelf.onmessage!({ data: { ...data, id } });
  return hostSelf.postMessage.mock.calls.find(([reply]) => reply.id === id)?.[0];
}
async function install(ownerKey = "A") {
  expect((await send({ type: "initializeMultiplayerHostGame", ownerKey, seed: 1, deckData: null })).type).toBe("result");
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  requestId = 0;
  wasm.initialize_multiplayer_host_game.mockReturnValue({ events: [], log_entries: [] });
  wasm.initialize_game.mockReturnValue({ events: [], log_entries: [] });
  wasm.host_precast_undo_status.mockReturnValue(armed);
  wasm.enable_host_precast_undo.mockReturnValue(armed);
  wasm.restore_host_precast_undo.mockReturnValue(consumed);
  wasm.get_game_state.mockReturnValue(state);
  wasm.get_legal_actions_js.mockReturnValue(legalResult);
  hostSelf = { postMessage: vi.fn(), onmessage: null };
  vi.stubGlobal("self", hostSelf);
  vi.stubGlobal("__CARD_DATA_URL__", "https://fixture.invalid/card-data.json");
  await import("../engine-worker");
});
afterEach(() => vi.unstubAllGlobals());

describe("host PRE local worker boundary", () => {
  it("requires an installed owner before status or enable", async () => {
    expect((await send({ type: "hostPrecastUndoStatus", ownerKey: "A" })).type).toBe("error");
    expect((await send({ type: "enableHostPrecastUndo", ownerKey: "A", binding: armed.binding })).type).toBe("error");
    expect(wasm.host_precast_undo_status).not.toHaveBeenCalled();
    expect(wasm.enable_host_precast_undo).not.toHaveBeenCalled();
  });

  it("checks owner then restores and captures both snapshot parts in the same synchronous turn", async () => {
    await install();
    const order: string[] = [];
    wasm.restore_host_precast_undo.mockImplementation(() => { order.push("restore"); return consumed; });
    wasm.get_game_state.mockImplementation(() => { order.push("state"); return state; });
    wasm.get_legal_actions_js.mockImplementation(() => { order.push("legal"); return legalResult; });
    hostSelf.postMessage.mockImplementation(() => order.push("reply"));
    const bad = await send({ type: "restoreHostPrecastUndo", ownerKey: "B", binding: armed.binding, receipt: armed.receipt });
    expect(bad.type).toBe("error");
    expect(wasm.restore_host_precast_undo).not.toHaveBeenCalled();
    order.length = 0;
    const promise = send({ type: "restoreHostPrecastUndo", ownerKey: "A", binding: armed.binding, receipt: armed.receipt });
    expect(order).toEqual(["restore", "state", "legal", "reply"]);
    expect((await promise).data).toEqual({ status: consumed, snapshot: { state, legalResult } });
    expect(wasm.restore_host_precast_undo).toHaveBeenCalledWith(armed.binding, armed.receipt);
  });

  it("retains A's teardown lease after failed asynchronous DB loading; B and unowned reset cannot erase A", async () => {
    await install();
    let rejectFetch!: (error: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((_resolve, reject) => { rejectFetch = reject; })));
    const load = send({ type: "loadCardDbFromUrl" });
    expect(wasm.disable_host_precast_undo).toHaveBeenCalledTimes(2); // init + before fetch
    expect((await send({ type: "resetGame" })).type).toBe("result");
    await send({ type: "releaseHostSession", ownerKey: "B" });
    expect(wasm.clear_game_state).not.toHaveBeenCalled();
    rejectFetch(new Error("fixture fetch failed"));
    expect((await load).message).toContain("fixture fetch failed");
    await send({ type: "releaseHostSession", ownerKey: "A" });
    expect(wasm.set_multiplayer_mode).toHaveBeenCalledExactlyOnceWith(false);
    expect(wasm.clear_game_state).toHaveBeenCalledOnce();
  });

  it("disables again before DB installation when another handler enables during fetch", async () => {
    await install();
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })));
    const load = send({ type: "loadCardDbFromUrl" });
    await send({ type: "enableHostPrecastUndo", ownerKey: "A", binding: armed.binding });
    resolveFetch({ ok: true, text: async () => "fixture" });
    expect((await load).type).toBe("result");
    expect(wasm.disable_host_precast_undo).toHaveBeenCalledTimes(3);
    const calls = wasm.disable_host_precast_undo.mock.invocationCallOrder;
    expect(calls[2]).toBeGreaterThan(wasm.enable_host_precast_undo.mock.invocationCallOrder[0]);
    expect(calls[2]).toBeLessThan(wasm.load_card_database.mock.invocationCallOrder[0]);
    await send({ type: "releaseHostSession", ownerKey: "A" });
    expect(wasm.clear_game_state).toHaveBeenCalledOnce();
  });

  it("failed local and host replacement attempts preserve the installed release owner", async () => {
    await install();
    wasm.initialize_game.mockReturnValue({ error: true, engine_occupied: true });
    wasm.initialize_multiplayer_host_game.mockReturnValue({ error: true, engine_occupied: true });
    expect((await send({ type: "initializeGame", seed: 2, deckData: null })).type).toBe("error");
    expect((await send({ type: "initializeMultiplayerHostGame", ownerKey: "B", seed: 2, deckData: null })).type).toBe("error");
    await send({ type: "releaseHostSession", ownerKey: "B" });
    expect(wasm.clear_game_state).not.toHaveBeenCalled();
    await send({ type: "releaseHostSession", ownerKey: "A" });
    expect(wasm.clear_game_state).toHaveBeenCalledOnce();
  });

  it("stale A cannot release or restore B after a successful replacement", async () => {
    await install();
    await send({ type: "releaseHostSession", ownerKey: "A" });
    await install("B");
    wasm.clear_game_state.mockClear();
    await send({ type: "releaseHostSession", ownerKey: "A" });
    expect(wasm.clear_game_state).not.toHaveBeenCalled();
    expect((await send({ type: "restoreHostPrecastUndo", ownerKey: "A", binding: armed.binding, receipt: armed.receipt })).type).toBe("error");
    expect(wasm.restore_host_precast_undo).not.toHaveBeenCalled();
    await send({ type: "releaseHostSession", ownerKey: "B" });
    expect(wasm.clear_game_state).toHaveBeenCalledOnce();
  });

  it("reports a lost snapshot after restore without repeating the consumed restore", async () => {
    await install();
    wasm.get_game_state.mockReturnValue(null);
    const reply = await send({ type: "restoreHostPrecastUndo", ownerKey: "A", binding: armed.binding, receipt: armed.receipt });
    expect(reply.type).toBe("error");
    expect(reply.message).toContain("restored host snapshot unavailable");
    expect(wasm.restore_host_precast_undo).toHaveBeenCalledOnce();
  });
});
