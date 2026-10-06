import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreflight, pageIdentity } from "../preflight";
import { readEmbeddedManifest } from "../schema";
import { requiredObservationsKnown, setupMatchesBeforeRun } from "../runGate";
import type { HarnessBuildStamp, HarnessManifest } from "../schema";

const stamp: HarnessBuildStamp = { schema: 1, buildId: "11111111-1111-4111-8111-111111111111",
  sourceHead: "a".repeat(40), sourceSha256: "b".repeat(64), sourceDirty: false, builtAt: "2026-10-05T00:00:00.000Z" };
const manifest: HarnessManifest = { stamp, entry: { file: "assets/control-test.js", bytes: 123, integrity: "sha384-" + "A".repeat(64) },
  viteManifest: { file: ".vite/manifest.json", sha256: "c".repeat(64), entryKey: "qa/private-rtc-capability.html" } };
const runtimeUrl = "https://private.example/assets/control-test.js";

function environment() {
  const doc = document.implementation.createHTMLDocument();
  const script = doc.createElement("script");
  script.type = "module"; script.src = runtimeUrl; script.integrity = manifest.entry.integrity;
  // A detached unit double supplies metadata; it cannot activate a module loader.
  Object.defineProperty(doc, "querySelectorAll", { value: () => [script] });
  const metadata = doc.createElement("script");
  metadata.id = "qa-runtime-manifest"; metadata.type = "application/json";
  metadata.textContent = JSON.stringify(manifest); doc.head.append(metadata);
  const container = Object.assign(new EventTarget(), {
    controller: { scriptURL: "https://private.example/sw.js?synthetic-private-token", state: "activated" },
    getRegistrations: vi.fn(async () => [{ scope: "https://private.example/", active: null, waiting: null, installing: null }]),
    register: vi.fn(),
  });
  const caches = { keys: vi.fn(async () => ["synthetic-private-cache-token"]), open: vi.fn(), delete: vi.fn() };
  const page = Object.assign(new EventTarget(), {
    location: new URL("https://private.example/qa/private-rtc-capability.html#qa-environment-accepted=1"),
    document: doc, isSecureContext: true, crypto: webcrypto, caches,
    navigator: { userAgent: "unit-test-browser", platform: "unit-test", languages: ["en"], hardwareConcurrency: 2, serviceWorker: container },
    RTCPeerConnection: vi.fn(), RTCDataChannel: vi.fn(), BroadcastChannel: vi.fn(), fetch: vi.fn(),
  });
  return { page: page as unknown as Window & typeof globalThis, container, caches, doc };
}

afterEach(() => vi.restoreAllMocks());

describe("A1 read-only preflight", () => {
  it("binds embedded metadata without refetching or creating connections/storage", async () => {
    const { page, container, caches } = environment();
    const preflight = createPreflight(page, runtimeUrl, stamp);
    await preflight.ready;
    const snapshot = preflight.snapshot();
    expect(snapshot.script).toMatchObject({ documentScriptMatchesRuntime: true, manifestFileMatchesRuntime: true,
      stampMatches: true, integrityMatches: true, laterRefetchPerformed: false, executedBundleContentHash: "unknown", integrityEnforcement: "unknown" });
    expect(snapshot.serviceWorkers).toMatchObject({ state: "complete", registrationCount: 1, controller: { scriptOriginPath: "https://private.example/sw.js", state: "activated" } });
    expect(snapshot.cacheInventory).toMatchObject({ state: "complete", count: 1, contentInventory: "unknown" });
    expect(snapshot.cacheInventory.nameSha256).toEqual(["643f533c936af2452f4f6ee237a50c7d5bc7718d9cd42d8373904480f58e3fe6"]);
    expect(snapshot.cacheInventory.hashMeaning).toContain("not cache content hashes");
    for (const mock of [page.RTCPeerConnection, page.BroadcastChannel, page.fetch, container.register, caches.open, caches.delete]) expect(mock).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-private");
    preflight.dispose();
  });

  it("keeps absent stamps unknown, reports mismatches, and strips arbitrary manifest fields", async () => {
    const { page, doc } = environment();
    const metadata = doc.getElementById("qa-runtime-manifest")!;
    metadata.textContent = JSON.stringify({ ...manifest, secret: "synthetic-player-token" });
    expect(JSON.stringify(readEmbeddedManifest(doc))).not.toContain("synthetic-player-token");
    const preflight = createPreflight(page, runtimeUrl, null);
    await preflight.ready;
    expect(preflight.snapshot().script.stampMatches).toBeNull();
    preflight.dispose();
    const mismatch = createPreflight(page, runtimeUrl + "?synthetic-private-token", { ...stamp, sourceSha256: "d".repeat(64) });
    await mismatch.ready;
    expect(mismatch.snapshot().script).toMatchObject({ documentScriptMatchesRuntime: false, manifestFileMatchesRuntime: false, stampMatches: false, integrityMatches: null });
    expect(JSON.stringify(mismatch.snapshot())).not.toContain("synthetic-private-token");
    mismatch.dispose();
    metadata.textContent = JSON.stringify({ ...manifest, entry: { ...manifest.entry, integrity: "synthetic-player-token" } });
    expect(readEmbeddedManifest(doc)).toBeNull();
  });

  it("records only the defined flag and never arbitrary URL values", () => {
    const location = new URL("https://private.example/qa/private-rtc-capability.html?token=synthetic-private-token#qa-environment-accepted=1&phase-qa-rtc=synthetic-private-room") as unknown as Location;
    expect(pageIdentity(location)).toEqual({ origin: "https://private.example", path: "/qa/private-rtc-capability.html",
      flags: { environmentAccepted: "1", queryFlagCount: 1, fragmentFlagCount: 2, unknownFlagCount: 2, unknownFlagValues: "unknown" } });
    expect(JSON.stringify(pageIdentity(location))).not.toContain("synthetic-private");
  });

  it("watches controller/navigation drift and removes listeners on disposal", async () => {
    const { page, container } = environment();
    const preflight = createPreflight(page, runtimeUrl, stamp);
    await preflight.ready;
    container.dispatchEvent(new Event("controllerchange"));
    page.dispatchEvent(new Event("popstate"));
    page.location.hash = "#other=synthetic-private-token";
    expect(preflight.snapshot().drift).toEqual({ controllerChanges: 1, navigationEvents: 1, locationChanged: true });
    preflight.dispose();
    container.dispatchEvent(new Event("controllerchange")); page.dispatchEvent(new Event("pagehide"));
    expect(preflight.snapshot().drift).toEqual({ controllerChanges: 1, navigationEvents: 1, locationChanged: true });
  });

  it("bounds inventories and suppresses read errors without exposing exception text", async () => {
    const { page, container, caches } = environment();
    container.getRegistrations.mockImplementation(async () => Array.from({ length: 70 }, () => ({ scope: "https://private.example/", active: null, waiting: null, installing: null })));
    caches.keys.mockRejectedValue(new Error("synthetic-private-ip-203.0.113.42-password-token"));
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const preflight = createPreflight(page, runtimeUrl, stamp);
    await preflight.ready;
    expect(preflight.snapshot().serviceWorkers).toMatchObject({ registrationCount: 70, truncated: true });
    expect(preflight.snapshot().serviceWorkers.registrations).toHaveLength(64);
    expect(preflight.snapshot().cacheInventory).toMatchObject({ state: "read-failed", count: null });
    expect(JSON.stringify(preflight.snapshot())).not.toContain("synthetic-private");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    preflight.dispose();
  });

  it("rereads registrations/caches and matches stable metadata despite timestamps/order", async () => {
    const { page, container, caches } = environment();
    const registrations = ["/", "/other/"].map((scope) => ({ scope: "https://private.example" + scope, active: null, waiting: null, installing: null }));
    container.getRegistrations.mockResolvedValue(registrations);
    caches.keys.mockResolvedValue(["synthetic-cache-one", "synthetic-cache-two"]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const first = createPreflight(page, runtimeUrl, stamp); await first.ready;
    const setup = first.snapshot(); first.dispose();
    expect(requiredObservationsKnown(setup)).toBe(true);
    container.getRegistrations.mockResolvedValue([...registrations].reverse());
    caches.keys.mockResolvedValue(["synthetic-cache-two", "synthetic-cache-one"]);
    clock.mockReturnValue(200);
    const second = createPreflight(page, runtimeUrl, stamp); await second.ready;
    const current = second.snapshot(); second.dispose();
    expect(container.getRegistrations).toHaveBeenCalledTimes(2); expect(caches.keys).toHaveBeenCalledTimes(2);
    expect(current.serviceWorkers.capturedAtMs).toBe(200);
    expect(setupMatchesBeforeRun(setup, current)).toBe(true);
    expect(page.RTCPeerConnection).not.toHaveBeenCalled();
  });

  it("detects a full worker URL change without exposing its private query", async () => {
    const { page, container } = environment();
    const first = createPreflight(page, runtimeUrl, stamp); await first.ready;
    const setup = first.snapshot(); first.dispose();
    container.controller.scriptURL = "https://private.example/sw.js?synthetic-private-new-token";
    const second = createPreflight(page, runtimeUrl, stamp); await second.ready;
    const current = second.snapshot(); second.dispose();
    expect(current.serviceWorkers.controller).toEqual(setup.serviceWorkers.controller);
    expect(current.serviceWorkers.identitySha256).not.toBe(setup.serviceWorkers.identitySha256);
    expect(setupMatchesBeforeRun(setup, current)).toBe(false);
    expect(JSON.stringify(current)).not.toContain("synthetic-private");
    expect(current.serviceWorkers.hashMeaning).toContain("not worker content hashes");
  });
});
