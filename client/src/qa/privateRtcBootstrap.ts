import { installPeerTransportSelector } from "../network/transport";
import type { TransportPeer } from "../network/transport";
import { createPrivateQaRtcTransportFactory } from "../network/privateQaRtcTransport";
import type { PrivateQaTransportSnapshot } from "../network/privateQaRtcTransport";

export interface PrivateQaRtcBrowserApi {
  /** Create a one-use probe peer. Supply a fresh host ID only on the host tab. */
  createProbePeer(hostRoomPeerId?: string): TransportPeer;
  /** Bounded states and byte counters only; never returns SDP, candidates, or IPs. */
  snapshot(): PrivateQaTransportSnapshot;
  dispose(): void;
}

declare global {
  interface Window {
    __PHASE_QA_PRIVATE_RTC__?: PrivateQaRtcBrowserApi;
  }
}

/**
 * Called only from main.tsx's explicit #phase-qa-rtc=... bootstrap gate. The
 * selector is installed before React renders, so every game connection in
 * this tab uses the private factory and never silently falls back to PeerJS.
 */
export function installPrivateQaRtcTransport(namespace: string): PrivateQaRtcBrowserApi {
  if (window.__PHASE_QA_PRIVATE_RTC__) {
    throw new Error("Private QA RTC transport is already installed in this tab");
  }
  const factory = createPrivateQaRtcTransportFactory(namespace);
  try { installPeerTransportSelector(() => factory); }
  catch (error) { factory.dispose(); throw error; }

  let disposed = false;
  let onPageHide: (event: PageTransitionEvent) => void = () => {};
  const api: PrivateQaRtcBrowserApi = {
    createProbePeer(hostRoomPeerId) {
      if (disposed) throw new Error("Private QA RTC transport is disposed");
      return factory.create(hostRoomPeerId, { config: { iceServers: [] } });
    },
    snapshot: () => factory.snapshot(),
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("pagehide", onPageHide);
      factory.dispose();
      if (window.__PHASE_QA_PRIVATE_RTC__ === api) delete window.__PHASE_QA_PRIVATE_RTC__;
    },
  };
  onPageHide = (event) => {
    // Keep the factory usable if the browser puts this page in the back/forward
    // cache. A final pagehide releases every BroadcastChannel and RTC listener.
    if (!event.persisted) api.dispose();
  };
  window.__PHASE_QA_PRIVATE_RTC__ = api;
  window.addEventListener("pagehide", onPageHide);
  return api;
}
