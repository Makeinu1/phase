import { installPrivateQaRtcTransport } from "./privateRtcBootstrap";
import { mountPrivateQaRtcPanel } from "./privateRtcPanelMount";

const status = document.getElementById("private-rtc-entry-status");
const secondTabLink = document.getElementById("private-rtc-second-tab") as HTMLAnchorElement | null;

function showFailure(message: string): void {
  if (status) status.textContent = message;
}

const fragment = window.location.hash.startsWith("#")
  ? window.location.hash.slice(1)
  : window.location.hash;
const namespace = new URLSearchParams(fragment).get("phase-qa-rtc");

if (namespace === null) {
  showFailure("Add a fresh random value as #phase-qa-rtc=<namespace> to this URL.");
} else {
  try {
    const api = installPrivateQaRtcTransport(namespace);
    mountPrivateQaRtcPanel(api);

    const secondTabUrl = new URL(window.location.href);
    secondTabUrl.hash = new URLSearchParams([["phase-qa-rtc", namespace]]).toString();
    if (!secondTabLink || secondTabUrl.origin !== window.location.origin) {
      throw new Error("Private RTC second-tab link could not be prepared");
    }
    secondTabLink.href = secondTabUrl.href;
    secondTabLink.target = "_blank";
    secondTabLink.rel = "noopener noreferrer";
    secondTabLink.referrerPolicy = "no-referrer";
    secondTabLink.textContent = secondTabUrl.href;
    if (status) status.textContent = "Use Create host in one tab and Create guest in the other.";
  } catch {
    showFailure("Private RTC probe could not start. Check this browser's required local APIs and the namespace.");
  }
}
