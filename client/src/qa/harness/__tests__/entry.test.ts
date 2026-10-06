import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreflightSnapshot } from "../preflight";

const mocks = vi.hoisted(() => ({
  start: vi.fn(), create: vi.fn(), cancel: vi.fn(),
}));
vi.mock("../preflight", () => ({ createPreflight: mocks.create }));
vi.mock("../capabilityControl", () => ({ startCapabilityControl: mocks.start }));
vi.mock("../schema", () => ({ embeddedBuildStamp: () => null }));

function setupSnapshot(): PreflightSnapshot {
  const stamp = { schema: 1 as const, buildId: "11111111-1111-4111-8111-111111111111", sourceHead: "a".repeat(40),
    sourceSha256: "b".repeat(64), sourceDirty: false, builtAt: "2026-10-05T00:00:00.000Z" };
  const identity = { origin: "https://private.example", path: "/qa/private-rtc-capability.html",
    flags: { environmentAccepted: "1", queryFlagCount: 0, fragmentFlagCount: 1, unknownFlagCount: 0, unknownFlagValues: "unknown" } };
  return {
    runtimeStamp: stamp,
    manifest: { stamp, entry: { file: "assets/control-test.js", bytes: 100, integrity: "sha384-" + "A".repeat(64) },
      viteManifest: { file: ".vite/manifest.json", sha256: "d".repeat(64), entryKey: "qa/private-rtc-capability.html" } },
    script: { runtimeOriginPath: "https://private.example/assets/control-test.js", documentOriginPath: "https://private.example/assets/control-test.js",
      documentIntegrity: "sha384-" + "A".repeat(64), documentScriptMatchesRuntime: true, manifestFileMatchesRuntime: true,
      stampMatches: true, integrityMatches: true, integrityEnforcement: "unknown", executedBundleContentHash: "unknown", laterRefetchPerformed: false },
    initialIdentity: structuredClone(identity), currentIdentity: structuredClone(identity), secureContext: true,
    apiPresence: { RTCPeerConnection: "present", RTCDataChannel: "present", BroadcastChannel: "absent",
      cryptoSubtleDigest: "present", serviceWorker: "present", cacheStorage: "present" },
    browser: { userAgent: "unit-test-browser", platform: "unit-test", languages: ["en"], hardwareConcurrency: 2, userAgentHighEntropyInformation: "unknown" },
    serviceWorkers: { state: "complete", controller: { scriptOriginPath: "https://private.example/sw.js", state: "activated" },
      identitySha256: "c".repeat(64), hashMeaning: "SHA-256 of observed worker URLs/scopes/states; not worker content hashes",
      registrationCount: 2, capturedAtMs: 100, truncated: false,
      registrations: ["/", "/other/"].map((scope) => ({ scopeOriginPath: "https://private.example" + scope, active: null, waiting: null, installing: null })),
      scope: "Same-origin registrations visible to this document; storage partition identity unknown" },
    cacheInventory: { state: "complete", count: 2, capturedAtMs: 100, truncated: false, nameSha256: ["a".repeat(64), "b".repeat(64)],
      scope: "CacheStorage names visible to this origin/document; storage partition identity unknown",
      hashMeaning: "SHA-256 of cache names only; not cache content hashes", contentInventory: "unknown" },
    drift: { controllerChanges: 0, navigationEvents: 0, locationChanged: false },
  };
}

function observer(state = setupSnapshot(), ready: Promise<void> = Promise.resolve()) {
  return { state, ready, snapshot: vi.fn(() => structuredClone(state)), dispose: vi.fn() };
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let initial: ReturnType<typeof observer>;
let current: ReturnType<typeof observer>;
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
const button = () => document.getElementById("qa-a2-run") as HTMLButtonElement;
function expectNoConnections() { expect(mocks.start).not.toHaveBeenCalled(); expect(RTCPeerConnection).not.toHaveBeenCalled(); }

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks();
  initial = observer(); current = observer();
  mocks.create.mockReset().mockReturnValueOnce(initial).mockReturnValueOnce(current);
  vi.stubGlobal("RTCPeerConnection", vi.fn(function () { return {}; }));
  mocks.start.mockImplementation(() => {
    new RTCPeerConnection({ iceServers: [] }); new RTCPeerConnection({ iceServers: [] });
    return { completion: new Promise(() => {}), snapshot: () => ({ result: "running" }), cancel: mocks.cancel };
  });
  document.body.innerHTML = '<pre id="qa-a1-output"></pre><pre id="qa-a2-output"></pre><button id="qa-a2-run" disabled>Run A2</button><p id="qa-harness-status"></p>';
});
afterEach(() => { window.dispatchEvent(new Event("pagehide")); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("A1/A2 separate deliberate execution gate (unit doubles only)", () => {
  it("shows SETUP without a flag or any connection; the flag is intent only", async () => {
    initial.state.initialIdentity.flags.environmentAccepted = null;
    initial.state.currentIdentity.flags.environmentAccepted = null;
    await import("../entry"); await settle();
    expect(button().disabled).toBe(true); button().click(); expectNoConnections();
    expect(document.getElementById("qa-a1-output")!.textContent).toContain('"setup"');
    expect(document.getElementById("qa-harness-status")!.textContent).toContain("intent only");
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("cannot start while SETUP is pending, even with initial-load intent", async () => {
    const pending = deferred(); initial.ready = pending.promise;
    await import("../entry"); await settle();
    expect(button().disabled).toBe(true); button().dispatchEvent(new Event("click")); expectNoConnections();
    pending.resolve(); await settle();
    expect(button().disabled).toBe(false); expectNoConnections();
  });

  const invalid: [string, (state: PreflightSnapshot) => void][] = [
    ["SW read-failed", (s) => { s.serviceWorkers.state = "read-failed"; }],
    ["SW unavailable", (s) => { s.serviceWorkers.state = "unavailable"; }],
    ["cache read-failed", (s) => { s.cacheInventory.state = "read-failed"; }],
    ["cache unavailable", (s) => { s.cacheInventory.state = "unavailable"; }],
    ["SW truncated", (s) => { s.serviceWorkers.truncated = true; }],
    ["cache truncated", (s) => { s.cacheInventory.truncated = true; }],
    ["SW identity unknown", (s) => { s.serviceWorkers.identitySha256 = null; }],
    ["artifact missing", (s) => { s.manifest = null; }],
    ["stamp missing", (s) => { s.runtimeStamp = null; }],
    ["required API unknown", (s) => { s.apiPresence.RTCPeerConnection = "unknown"; }],
    ["secure context unknown", (s) => { s.secureContext = null; }],
  ];
  for (const field of ["documentScriptMatchesRuntime", "manifestFileMatchesRuntime", "stampMatches", "integrityMatches"] as const) {
    invalid.push([`${field} false`, (s) => { s.script[field] = false; }]);
    if (field !== "documentScriptMatchesRuntime") invalid.push([`${field} null`, (s) => { s.script[field] = null; }]);
  }
  it.each(invalid)("blocks invalid SETUP: %s", async (_name, mutate) => {
    mutate(initial.state);
    await import("../entry"); await settle();
    expect(button().disabled).toBe(true); button().dispatchEvent(new Event("click"));
    expectNoConnections(); expect(mocks.create).toHaveBeenCalledOnce();
  });

  it.each(invalid)("blocks invalid before-run observations: %s", async (_name, mutate) => {
    mutate(current.state);
    await import("../entry"); await settle(); button().click(); await settle();
    expectNoConnections(); expect(button().disabled).toBe(true); expect(current.dispose).toHaveBeenCalled();
    button().dispatchEvent(new Event("click")); expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("rereads after click, waits with zero connections, then starts once on a match", async () => {
    const pending = deferred(); current.ready = pending.promise;
    current.state.serviceWorkers.capturedAtMs = 200; current.state.cacheInventory.capturedAtMs = 200;
    current.state.serviceWorkers.registrations.reverse(); current.state.cacheInventory.nameSha256.reverse();
    await import("../entry"); await settle(); expect(button().disabled).toBe(false); expectNoConnections();
    button().click(); expect(mocks.create).toHaveBeenCalledTimes(2); expectNoConnections(); expect(button().disabled).toBe(true);
    button().dispatchEvent(new Event("click")); expect(mocks.create).toHaveBeenCalledTimes(2);
    pending.resolve(); await settle();
    expect(mocks.start).toHaveBeenCalledOnce(); expect(RTCPeerConnection).toHaveBeenCalledTimes(2);
    expect(button().disabled).toBe(true); button().dispatchEvent(new Event("click")); expect(mocks.start).toHaveBeenCalledOnce();
    expect(current.dispose).toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(mocks.cancel).toHaveBeenCalledOnce(); expect(initial.dispose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each<[string, (state: PreflightSnapshot) => void]>([
    ["controller", (s) => { s.serviceWorkers.controller!.state = "installed"; }],
    ["worker full URL identity", (s) => { s.serviceWorkers.identitySha256 = "e".repeat(64); }],
    ["registration", (s) => { s.serviceWorkers.registrations[0].waiting = { scriptOriginPath: "https://private.example/sw-new.js", state: "installed" }; }],
    ["cache inventory", (s) => { s.cacheInventory.nameSha256[0] = "f".repeat(64); }],
    ["artifact", (s) => { s.runtimeStamp!.buildId = "22222222-2222-4222-8222-222222222222"; s.manifest!.stamp.buildId = s.runtimeStamp!.buildId; }],
    ["URL", (s) => { s.currentIdentity.path = "/other.html"; }],
    ["flags", (s) => { s.currentIdentity.flags.queryFlagCount = 1; }],
  ])("rejects a before-run SETUP mismatch: %s", async (_name, mutate) => {
    mutate(current.state);
    await import("../entry"); await settle(); button().click(); await settle();
    expectNoConnections(); expect(button().disabled).toBe(true);
    expect(document.getElementById("qa-harness-status")!.textContent).toContain("differed from SETUP");
  });

  it.each(["creation", "ready", "snapshot"])("contains a reobservation %s failure without exposing native errors", async (stage) => {
    const secret = "synthetic-private-ip-203.0.113.42-password-player-token";
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    if (stage === "creation") mocks.create.mockReset().mockReturnValueOnce(initial).mockImplementationOnce(() => { throw new Error(secret); });
    if (stage === "ready") current.ready = deferred().promise.then(() => {});
    if (stage === "snapshot") current.snapshot.mockImplementation(() => { throw new Error(secret); });
    await import("../entry"); await settle();
    if (stage === "ready") current.ready = Promise.reject(new Error(secret));
    button().click(); await settle();
    expectNoConnections(); expect(button().disabled).toBe(true);
    expect(document.body.textContent).not.toContain(secret);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["drift", "pagehide"])("does not start after a late read settles following %s", async (reason) => {
    const pending = deferred(); current.ready = pending.promise;
    await import("../entry"); await settle(); button().click();
    if (reason === "drift") { initial.state.drift.controllerChanges = 1; await vi.advanceTimersByTimeAsync(250); }
    else window.dispatchEvent(new Event("pagehide"));
    expect(current.dispose).toHaveBeenCalled(); expectNoConnections();
    pending.resolve(); await settle(); expectNoConnections();
  });

  it("records drift and disables/cancels further execution without changing settings", async () => {
    await import("../entry"); await settle(); button().click(); await settle();
    expect(mocks.start).toHaveBeenCalledOnce(); initial.state.drift.controllerChanges = 1;
    await vi.advanceTimersByTimeAsync(250);
    expect(button().disabled).toBe(true); expect(mocks.cancel).toHaveBeenCalled();
    expect(document.getElementById("qa-harness-status")!.textContent).toContain("drift observed");
    expect(mocks.start).toHaveBeenCalledOnce();
  });
});
