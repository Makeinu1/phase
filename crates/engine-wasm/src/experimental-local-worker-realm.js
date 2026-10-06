export function is_experimental_local_worker_realm() {
  return typeof DedicatedWorkerGlobalScope !== "undefined"
    && globalThis instanceof DedicatedWorkerGlobalScope;
}
