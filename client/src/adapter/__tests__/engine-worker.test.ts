import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// The worker module's top level only assigns `self.onmessage` and declares
// `cardDbLoaded`; `canonicalCardNames` and `get_card_face_data` are stubbed
// here. `default` stands in for the wasm-bindgen `init` the worker's own
// `init()` request case invokes.
const wasm = vi.hoisted(() => ({
  canonicalCardNames: vi.fn(),
  get_card_face_data: vi.fn(),
}));
vi.mock("@wasm/engine", () => ({ default: vi.fn(), ...wasm }));

describe("engine worker — canonicalCardNames request", () => {
  let fakeSelf: { postMessage: ReturnType<typeof vi.fn>; onmessage: unknown };

  beforeAll(async () => {
    fakeSelf = { postMessage: vi.fn(), onmessage: null };
    vi.stubGlobal("self", fakeSelf);
    await import("../engine-worker");
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("answers a canonical-name request with the engine's list", async () => {
    wasm.canonicalCardNames.mockReturnValue(["Revival // Revenge", null]);

    await (fakeSelf.onmessage as (e: unknown) => unknown)({
      data: { type: "canonicalCardNames", id: 1, names: ["Revival/Revenge", "Not A Card"] },
    });

    expect(wasm.canonicalCardNames).toHaveBeenCalledWith(["Revival/Revenge", "Not A Card"]);
    expect(wasm.get_card_face_data).not.toHaveBeenCalled();
    expect(fakeSelf.postMessage).toHaveBeenCalledWith({
      type: "result",
      id: 1,
      data: ["Revival // Revenge", null],
    });
  });
});


describe("experimental Local worker boundary", () => {
  let fakeSelf: { postMessage: ReturnType<typeof vi.fn>; onmessage: unknown };
  const bootstrap = vi.fn();
  const verify = vi.fn();
  beforeEach(async () => {
    vi.resetModules();
    bootstrap.mockReset().mockReturnValue({ events: [], log_entries: [] });
    verify.mockReset().mockReturnValue(0);
    vi.doMock("@wasm/engine", () => ({ default: vi.fn(), initialize_experimental_local_game: bootstrap, experimental_local_actor: verify }));
    fakeSelf = { postMessage: vi.fn(), onmessage: null };
    vi.stubGlobal("self", fakeSelf);
    await import("../engine-worker");
  });
  afterEach(() => vi.unstubAllGlobals());
  const send = (data: Record<string, unknown>) => (fakeSelf.onmessage as (e: unknown) => Promise<void>)({ data });
  it("forwards the valid fields and normalizes verification", async () => {
    const request = { seed: 42, deckData: null, formatConfig: null, matchConfig: null, playerCount: 2, firstPlayer: 0 };
    await send({ ...request, type: "initializeExperimentalLocalGame", id: 1 });
    expect(bootstrap).toHaveBeenCalledWith(request);
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "result", id: 1, data: { events: [], log_entries: [] } });
    await send({ type: "experimentalLocalActor", id: 2 });
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "result", id: 2, data: 0 });
    verify.mockReturnValue(1);
    await send({ type: "experimentalLocalActor", id: 3 });
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "result", id: 3, data: null });
  });
  it("refuses every extra field before WASM", async () => {
    for (const key of ["actor", "authenticatedActor", "owner", "session", "ticket", "enrollment", "worker", "unknown"]) {
      await send({ type: "initializeExperimentalLocalGame", id: 4, [key]: 0 });
      expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "error", id: 4, message: "Invalid experimental Local request" });
    }
    expect(bootstrap).not.toHaveBeenCalled();
    await send({ type: "initializeExperimentalLocalGame", id: 5, seed: 42 });
    expect(bootstrap).toHaveBeenCalledOnce();
  });
  it("retains the existing typed initialization refusal", async () => {
    bootstrap.mockReturnValue({ error: true, engine_occupied: true, reasons: ["occupied"] });
    await send({ type: "initializeExperimentalLocalGame", id: 6 });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "error", id: 6, message: "Finish or leave your current game before starting a new one.", engineOccupied: true });
    expect(fakeSelf.postMessage.mock.lastCall?.[0].message).not.toContain("occupied");
  });
  it("loads an off namespace and refuses bootstrap while verification is null", async () => {
    vi.resetModules();
    vi.doMock("@wasm/engine", () => ({ default: vi.fn(), initialize_experimental_local_game: undefined, experimental_local_actor: undefined }));
    await import("../engine-worker");
    await send({ type: "initializeExperimentalLocalGame", id: 7 });
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "error", id: 7, message: "Experimental Local bootstrap unavailable" });
    await send({ type: "experimentalLocalActor", id: 8 });
    expect(fakeSelf.postMessage).toHaveBeenLastCalledWith({ type: "result", id: 8, data: null });
  });
});
