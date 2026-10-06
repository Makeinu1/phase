import type { PreflightSnapshot } from "./preflight";

export function hasDrift(snapshot: PreflightSnapshot): boolean {
  return snapshot.drift.controllerChanges > 0 || snapshot.drift.navigationEvents > 0 || snapshot.drift.locationChanged;
}

/** Observation eligibility only. Neither this predicate nor a URL flag approves a run. */
export function requiredObservationsKnown(snapshot: PreflightSnapshot): boolean {
  const workers = snapshot.serviceWorkers;
  const caches = snapshot.cacheInventory;
  const workerKnown = (worker: typeof workers.controller) => worker === null || (worker.scriptOriginPath !== null && worker.state !== null);
  return snapshot.secureContext === true
    && ["RTCPeerConnection", "RTCDataChannel", "cryptoSubtleDigest", "serviceWorker", "cacheStorage"].every((key) =>
      snapshot.apiPresence[key as keyof typeof snapshot.apiPresence] === "present")
    && snapshot.runtimeStamp !== null && snapshot.manifest !== null
    && snapshot.script.documentScriptMatchesRuntime === true
    && snapshot.script.manifestFileMatchesRuntime === true
    && snapshot.script.stampMatches === true && snapshot.script.integrityMatches === true
    && workers.state === "complete" && workers.identitySha256 !== null && /^[a-f0-9]{64}$/.test(workers.identitySha256)
    && !workers.truncated && workers.registrationCount !== null && workers.registrationCount === workers.registrations.length
    && workerKnown(workers.controller) && workers.registrations.every((registration) => registration.scopeOriginPath !== null
      && workerKnown(registration.active) && workerKnown(registration.waiting) && workerKnown(registration.installing))
    && caches.state === "complete" && !caches.truncated && caches.count !== null && caches.count === caches.nameSha256.length
    && caches.nameSha256.every((name) => /^[a-f0-9]{64}$/.test(name));
}

function comparisonValues(snapshot: PreflightSnapshot) {
  // Capture timestamps describe different reads. Enumeration order is not identity.
  const { capturedAtMs: _workerTime, registrations, ...workers } = snapshot.serviceWorkers;
  const { capturedAtMs: _cacheTime, nameSha256, ...caches } = snapshot.cacheInventory;
  return {
    runtimeStamp: snapshot.runtimeStamp, manifest: snapshot.manifest, script: snapshot.script,
    identity: snapshot.currentIdentity, secureContext: snapshot.secureContext,
    apiPresence: snapshot.apiPresence, browser: snapshot.browser,
    workers: { ...workers, registrations: [...registrations].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) },
    caches: { ...caches, nameSha256: [...nameSha256].sort() },
  };
}

export function setupMatchesBeforeRun(setup: PreflightSnapshot, current: PreflightSnapshot): boolean {
  return requiredObservationsKnown(setup) && requiredObservationsKnown(current)
    && !hasDrift(setup) && !hasDrift(current)
    && setup.initialIdentity.flags.environmentAccepted === "1"
    && current.initialIdentity.flags.environmentAccepted === "1"
    && JSON.stringify(comparisonValues(setup)) === JSON.stringify(comparisonValues(current));
}
