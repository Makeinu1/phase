import type { EngineAdapter } from "../adapter/types";

declare const trustedCheckpoint: unique symbol;
export interface TrustedCheckpointString {
  readonly [trustedCheckpoint]: true;
  readonly bytes: number;
}

// Only the export entry point can mint a token. State/projection objects and
// JSON reconstructed by a caller cannot be promoted to restore authority.
const exports = new WeakMap<TrustedCheckpointString, string>();

export async function captureTrustedCheckpointString(
  adapter: Pick<EngineAdapter, "exportPersistenceState">,
): Promise<TrustedCheckpointString> {
  if (!adapter.exportPersistenceState) throw new Error("Trusted export unavailable");
  const json = await adapter.exportPersistenceState();
  if (typeof json !== "string" || json.length === 0) throw new Error("Empty trusted export");
  const token = Object.freeze({ bytes: new TextEncoder().encode(json).byteLength }) as TrustedCheckpointString;
  exports.set(token, json);
  return token;
}

export async function restoreTrustedCheckpointString(
  adapter: Pick<EngineAdapter, "restoreTrustedState">,
  checkpoint: TrustedCheckpointString,
  isCurrent?: () => boolean,
): Promise<void> {
  const json = exports.get(checkpoint);
  if (json === undefined) throw new Error("Unknown or released trusted checkpoint");
  if (!adapter.restoreTrustedState) throw new Error("Trusted restore unavailable");
  if (isCurrent) await adapter.restoreTrustedState(json, isCurrent);
  else await adapter.restoreTrustedState(json);
}

/** Drop the module's raw-string reference; retained token metadata has no authority. */
export function releaseTrustedCheckpointString(checkpoint: TrustedCheckpointString): void {
  exports.delete(checkpoint);
}
