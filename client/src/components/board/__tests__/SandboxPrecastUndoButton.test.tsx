import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { P2PHostAdapter } from "../../../adapter/p2p-adapter";
import { useGameStore } from "../../../stores/gameStore";
import { useSandboxUndoConsentStore } from "../../../stores/sandboxUndoConsentStore";
import { SandboxUndoConsent } from "../../lobby/SandboxUndoConsent";
import { SandboxPrecastUndoButton } from "../SandboxPrecastUndoButton";
import type { GameState } from "../../../adapter/types";

beforeEach(() => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_PHASE_SANDBOX", "1");
  useSandboxUndoConsentStore.setState({ agreed: false });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); useGameStore.setState({ adapter: null }); });

describe("Sandbox pre-cast Undo chrome (fixture only)", () => {
  it("requires a checkbox action for local agreement", () => {
    render(<SandboxUndoConsent />);
    expect(useSandboxUndoConsentStore.getState().agreed).toBe(false);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(useSandboxUndoConsentStore.getState().agreed).toBe(true);
  });
  it("hides consent outside the Sandbox gate", () => {
    vi.stubEnv("VITE_PHASE_SANDBOX", "0");
    render(<SandboxUndoConsent />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("requests the limited host operation and isolates game keyboard shortcuts", async () => {
    const adapter = Object.create(P2PHostAdapter.prototype) as P2PHostAdapter;
    const restore = vi.fn(async () => undefined);
    adapter.isSandboxPrecastUndoConfigured = () => true;
    adapter.sandboxPrecastUndoAvailable = async () => true;
    adapter.restoreSandboxPrecastUndo = restore;
    useGameStore.setState({ adapter, gameId: "sandbox-button", gameState: { waiting_for: { type: "Priority", data: { player: 0 } } } as GameState });
    render(<SandboxPrecastUndoButton />);
    const button = screen.getByRole("button");
    await waitFor(() => { expect(button).not.toBeDisabled(); });
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    try {
      const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(shortcut).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      fireEvent.click(button);
      await waitFor(() => { expect(restore).toHaveBeenCalledOnce(); });
      expect(restore).toHaveBeenCalledWith(expect.any(Function));
    } finally { window.removeEventListener("keydown", shortcut); }
  });
});
