import type { HarnessBuildStamp } from "./schema";
import { readEmbeddedManifest } from "./schema";

const INVENTORY_LIMIT = 64;
type ReadState = "unknown" | "unavailable" | "complete" | "read-failed";
type WorkerInfo = { scriptOriginPath: string | null; state: ServiceWorkerState | null };

function read<T>(get: () => T): T | null {
  try { return get(); } catch { return null; }
}

function presence(get: () => unknown, type: "function" | "object") {
  try { const value = get(); return value !== null && typeof value === type ? "present" : "absent"; }
  catch { return "unknown"; }
}

function originPath(url: string): string | null {
  try { const value = new URL(url); return value.origin + value.pathname; }
  catch { return null; }
}

function workerInfo(worker: ServiceWorker | null): WorkerInfo | null {
  if (!worker) return null;
  const states: readonly string[] = ["parsed", "installing", "installed", "activating", "activated", "redundant"];
  return { scriptOriginPath: originPath(worker.scriptURL), state: states.includes(worker.state) ? worker.state : null };
}

function workerIdentity(worker: ServiceWorker | null) {
  return worker ? { scriptUrl: worker.scriptURL, state: worker.state } : null;
}

/** Only the defined acceptance flag is recorded; other URL values may be secrets. */
export function pageIdentity(location: Location) {
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const accepted = fragment.getAll("qa-environment-accepted");
  return {
    origin: location.origin, path: location.pathname,
    flags: {
      environmentAccepted: accepted.length === 0 ? null : accepted.length === 1 && accepted[0] === "1" ? "1" : "unknown",
      queryFlagCount: [...query].length,
      fragmentFlagCount: [...fragment].length,
      unknownFlagCount: [...query].length + [...fragment].filter(([name]) => name !== "qa-environment-accepted").length,
      unknownFlagValues: "unknown",
    },
  };
}

export function createPreflight(window: Window & typeof globalThis, runtimeUrl: string, stamp: HarnessBuildStamp | null) {
  const initialIdentity = pageIdentity(window.location);
  const initialHref = window.location.href; // Compare privately; never expose query/fragment values.
  const manifest = readEmbeddedManifest(window.document);
  const scripts = [...window.document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')];
  const matchingScripts = scripts.filter((script) => script.src === runtimeUrl);
  const script = matchingScripts.length === 1 ? matchingScripts[0] : null;
  const entryUrl = manifest ? new URL("/" + manifest.entry.file, window.location.origin).href : null;
  const state = {
    runtimeStamp: stamp,
    manifest,
    script: {
      runtimeOriginPath: originPath(runtimeUrl),
      documentOriginPath: script ? originPath(script.src) : null,
      documentIntegrity: script && /^sha384-[A-Za-z0-9+/]{64}$/.test(script.integrity) ? script.integrity : null,
      documentScriptMatchesRuntime: scripts.length === 1 && !!script,
      manifestFileMatchesRuntime: entryUrl === null ? null : entryUrl === runtimeUrl,
      stampMatches: manifest && stamp ? Object.keys(manifest.stamp).every((key) =>
        manifest.stamp[key as keyof HarnessBuildStamp] === stamp[key as keyof HarnessBuildStamp]) : null,
      integrityMatches: manifest && script ? manifest.entry.integrity === script.integrity : null,
      integrityEnforcement: "unknown", executedBundleContentHash: "unknown", laterRefetchPerformed: false,
    },
    initialIdentity,
    secureContext: read(() => typeof window.isSecureContext === "boolean" ? window.isSecureContext : null),
    apiPresence: {
      RTCPeerConnection: presence(() => window.RTCPeerConnection, "function"),
      RTCDataChannel: presence(() => window.RTCDataChannel, "function"),
      BroadcastChannel: presence(() => window.BroadcastChannel, "function"),
      cryptoSubtleDigest: presence(() => window.crypto?.subtle?.digest, "function"),
      serviceWorker: presence(() => window.navigator.serviceWorker, "object"),
      cacheStorage: presence(() => window.caches, "object"),
    },
    browser: {
      userAgent: read(() => window.navigator.userAgent.slice(0, 512) || null),
      platform: read(() => window.navigator.platform.slice(0, 64) || null),
      languages: read(() => [...window.navigator.languages].slice(0, 16).map((value) => value.slice(0, 64))),
      hardwareConcurrency: read(() => window.navigator.hardwareConcurrency || null),
      userAgentHighEntropyInformation: "unknown",
    },
    serviceWorkers: {
      state: "unknown" as ReadState, controller: null as WorkerInfo | null,
      identitySha256: null as string | null,
      hashMeaning: "SHA-256 of observed worker URLs/scopes/states; not worker content hashes",
      registrationCount: null as number | null, capturedAtMs: null as number | null, truncated: false,
      registrations: [] as { scopeOriginPath: string | null; active: WorkerInfo | null; waiting: WorkerInfo | null; installing: WorkerInfo | null }[],
      scope: "Same-origin registrations visible to this document; storage partition identity unknown",
    },
    cacheInventory: {
      state: "unknown" as ReadState, count: null as number | null, capturedAtMs: null as number | null, truncated: false, nameSha256: [] as string[],
      scope: "CacheStorage names visible to this origin/document; storage partition identity unknown",
      hashMeaning: "SHA-256 of cache names only; not cache content hashes", contentInventory: "unknown",
    },
    drift: { controllerChanges: 0, navigationEvents: 0, locationChanged: false },
  };
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const listen = (target: EventTarget, name: string, handler: EventListener) => {
    target.addEventListener(name, handler);
    cleanups.push(() => target.removeEventListener(name, handler));
  };
  const noteNavigation = () => { state.drift.navigationEvents += 1; };
  for (const name of ["popstate", "hashchange", "pagehide", "beforeunload"]) listen(window, name, noteNavigation);
  listen(window, "pageshow", (event) => { if ((event as PageTransitionEvent).persisted) noteNavigation(); });
  const ready = Promise.all([
    (async () => {
      try {
        if (!("serviceWorker" in window.navigator)) { state.serviceWorkers.state = "unavailable"; return; }
        const container = window.navigator.serviceWorker;
        state.serviceWorkers.controller = workerInfo(container.controller);
        listen(container, "controllerchange", () => {
          state.drift.controllerChanges += 1;
          state.serviceWorkers.identitySha256 = null;
          try { state.serviceWorkers.controller = workerInfo(container.controller); }
          catch { state.serviceWorkers.controller = null; }
        });
        const registrations = await container.getRegistrations();
        if (disposed) return;
        const controller = container.controller;
        const controllerRevision = state.drift.controllerChanges;
        state.serviceWorkers.controller = workerInfo(controller);
        state.serviceWorkers.registrationCount = registrations.length;
        state.serviceWorkers.capturedAtMs = Date.now();
        state.serviceWorkers.truncated = registrations.length > INVENTORY_LIMIT;
        state.serviceWorkers.registrations = registrations.slice(0, INVENTORY_LIMIT).map((registration) => ({
          scopeOriginPath: originPath(registration.scope), active: workerInfo(registration.active),
          waiting: workerInfo(registration.waiting), installing: workerInfo(registration.installing),
        }));
        // Full URLs stay private. This digest detects query/scope changes too.
        const identities = registrations.slice(0, INVENTORY_LIMIT).map((registration) => ({
          scope: registration.scope, active: workerIdentity(registration.active),
          waiting: workerIdentity(registration.waiting), installing: workerIdentity(registration.installing),
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
          controller: workerIdentity(controller), registrations: identities,
        })));
        if (disposed) return;
        if (container.controller !== controller && state.drift.controllerChanges === controllerRevision) {
          state.drift.controllerChanges += 1;
        }
        if (state.drift.controllerChanges === controllerRevision) {
          state.serviceWorkers.identitySha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        }
        state.serviceWorkers.state = "complete";
      } catch { if (!disposed) state.serviceWorkers.state = "read-failed"; }
    })(),
    (async () => {
      try {
        if (!("caches" in window)) { state.cacheInventory.state = "unavailable"; return; }
        const names = await window.caches.keys();
        if (disposed) return;
        state.cacheInventory.count = names.length;
        state.cacheInventory.capturedAtMs = Date.now();
        state.cacheInventory.truncated = names.length > INVENTORY_LIMIT;
        if (typeof window.crypto?.subtle?.digest !== "function") { state.cacheInventory.state = "read-failed"; return; }
        const hashes = await Promise.all(names.slice(0, INVENTORY_LIMIT).map(async (name) => {
          const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
          return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        }));
        if (disposed) return;
        state.cacheInventory.nameSha256 = hashes.sort();
        state.cacheInventory.state = "complete";
      } catch { if (!disposed) state.cacheInventory.state = "read-failed"; }
    })(),
  ]).then(() => {});
  return {
    ready,
    snapshot() {
      state.drift.locationChanged ||= window.location.href !== initialHref;
      return structuredClone({ ...state, currentIdentity: pageIdentity(window.location) });
    },
    dispose() { disposed = true; for (const cleanup of cleanups.splice(0)) cleanup(); },
  };
}

export type PreflightSnapshot = ReturnType<ReturnType<typeof createPreflight>["snapshot"]>;
