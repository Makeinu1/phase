import { createRoot, type Root } from "react-dom/client";
import "./privateRtcPanel.css";
import type { PrivateQaRtcBrowserApi } from "./privateRtcBootstrap";
import PrivateRtcPanel from "./privateRtcPanel";

const PANEL_ID = "phase-private-qa-rtc-panel";

export function mountPrivateQaRtcPanel(api: PrivateQaRtcBrowserApi): void {
  const container = document.createElement("div");
  container.id = PANEL_ID;
  document.body.append(container);
  const root: Root = createRoot(container);
  root.render(<PrivateRtcPanel api={api} />);
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    root.unmount();
    container.remove();
    window.removeEventListener("pagehide", onPageHide);
  };
  window.addEventListener("pagehide", onPageHide);
}
