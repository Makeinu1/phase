import { describe, expect, it, vi } from "vitest";
import {
  captureTrustedCheckpointString,
  releaseTrustedCheckpointString,
  restoreTrustedCheckpointString,
  type TrustedCheckpointString,
} from "../trustedCheckpointString";

describe("opaque trusted checkpoint strings", () => {
  it("preserves exact raw bytes, unsafe integers, whitespace and UTF-8 byte accounting", async () => {
    const raw = ' { "u64":18446744073709551615,"u128":340282366920938463463374607431768211455,"name":"森🌳" }\n';
    const exportPersistenceState = vi.fn().mockResolvedValue(raw);
    const restoreTrustedState = vi.fn().mockResolvedValue(undefined);
    const checkpoint = await captureTrustedCheckpointString({ exportPersistenceState });
    expect(checkpoint.bytes).toBe(new TextEncoder().encode(raw).byteLength);
    expect(checkpoint.bytes).toBeGreaterThan(raw.length);
    expect(Object.keys(checkpoint)).toEqual(["bytes"]);
    await restoreTrustedCheckpointString({ restoreTrustedState }, checkpoint);
    expect(restoreTrustedState).toHaveBeenCalledExactlyOnceWith(raw);
    releaseTrustedCheckpointString(checkpoint);
    await expect(restoreTrustedCheckpointString({ restoreTrustedState }, checkpoint)).rejects.toThrow("released");
    expect(restoreTrustedState).toHaveBeenCalledTimes(1);
  });

  it("cannot promote a state/projection/reconstructed string or forged token", async () => {
    const restoreTrustedState = vi.fn();
    for (const forged of [{ bytes: 2 }, { state: {} }, "{}", JSON.stringify({ state: {} })]) {
      await expect(restoreTrustedCheckpointString({ restoreTrustedState }, forged as TrustedCheckpointString)).rejects.toThrow("Unknown");
    }
    expect(restoreTrustedState).not.toHaveBeenCalled();
  });

  it("fails explicitly for missing capability, export failure or empty export", async () => {
    await expect(captureTrustedCheckpointString({})).rejects.toThrow("unavailable");
    await expect(captureTrustedCheckpointString({ exportPersistenceState: vi.fn().mockRejectedValue(new Error("export failed")) })).rejects.toThrow("export failed");
    await expect(captureTrustedCheckpointString({ exportPersistenceState: vi.fn().mockResolvedValue("") })).rejects.toThrow("Empty");
    const checkpoint = await captureTrustedCheckpointString({ exportPersistenceState: vi.fn().mockResolvedValue("{}") });
    await expect(restoreTrustedCheckpointString({}, checkpoint)).rejects.toThrow("unavailable");
    releaseTrustedCheckpointString(checkpoint);
  });
});
