import { create } from "zustand";

export function isSandboxUndoEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_PHASE_SANDBOX === "1";
}

/** One connection attempt's explicit consent. Never persisted or restored. */
export const useSandboxUndoConsentStore = create<{ agreed: boolean; setAgreed: (agreed: boolean) => void }>((set) => ({
  agreed: false,
  setAgreed: (agreed) => set({ agreed: isSandboxUndoEnabled() && agreed }),
}));

export function takeSandboxUndoConsent(): boolean {
  const agreed = isSandboxUndoEnabled() && useSandboxUndoConsentStore.getState().agreed;
  useSandboxUndoConsentStore.setState({ agreed: false });
  return agreed;
}
