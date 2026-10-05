import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeSandboxUndoConsent, useSandboxUndoConsentStore } from "../sandboxUndoConsentStore";

beforeEach(() => { useSandboxUndoConsentStore.setState({ agreed: false }); });
afterEach(() => { vi.unstubAllEnvs(); });
describe("Sandbox Undo connection consent", () => {
  it("is off without explicit agreement and is consumed by one attempt", () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_PHASE_SANDBOX", "1");
    expect(takeSandboxUndoConsent()).toBe(false);
    useSandboxUndoConsentStore.getState().setAgreed(true);
    expect(takeSandboxUndoConsent()).toBe(true);
    expect(takeSandboxUndoConsent()).toBe(false);
  });
  it.each([{ dev: false, flag: "1" }, { dev: true, flag: "0" }])("refuses consent outside the DEV Sandbox gate: $dev/$flag", ({ dev, flag }) => {
    vi.stubEnv("DEV", dev);
    vi.stubEnv("VITE_PHASE_SANDBOX", flag);
    useSandboxUndoConsentStore.getState().setAgreed(true);
    expect(takeSandboxUndoConsent()).toBe(false);
  });
});
