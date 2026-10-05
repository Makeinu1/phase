import "./polyfills/cryptoRandomUUID";
import { createRoot } from "react-dom/client";
// Self-hosted variable webfonts (served from node_modules by Vite — no Google
// CDN). Newsreader = serif display; JetBrains Mono = codes / tabular numbers.
import "@fontsource-variable/newsreader";
import "@fontsource-variable/jetbrains-mono";
// Mana/loyalty/counter iconography (Andrew Gioia's mana-font). The vendored
// mana.css ships legacy eot/woff/ttf/svg faces for "Mana" plus an unused
// "MPlantin" serif; the `trimManaFont` Vite plugin rewrites this import at build
// time to a single woff2-only "Mana" @font-face (see vite.config.ts) so only one
// 187 KB font is bundled here and in the Tauri app.
import "mana-font/css/mana.css";
import "./index.css";
import "./i18n"; // initialize i18next before any component renders
import { App } from "./App";
import { registerServiceWorker } from "./pwa/registerServiceWorker";
import { registerTauriUpdater } from "./pwa/tauriUpdater";
import { installChunkReloadHandler } from "./pwa/chunkReloadHandler";
import { installTauriExternalLinkHandler } from "./services/externalLinks";
import { importLegacyStorage, markRemoteLoadOk } from "./services/legacyMigration";
import { installTelemetry } from "./services/telemetryEvents";
import { initializeHostPlatform } from "./services/platform";
import { initializeConnectivity } from "./stores/connectivityStore";

function privateQaRtcNamespaceFromFragment(): string | null {
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(fragment).get("phase-qa-rtc");
}

async function installPrivateQaRtcBeforeRender(): Promise<void> {
  const namespace = privateQaRtcNamespaceFromFragment();
  if (namespace === null) return;

  try {
    const { installPrivateQaRtcTransport } = await import("./qa/privateRtcBootstrap");
    const api = installPrivateQaRtcTransport(namespace);
    const { mountPrivateQaRtcPanel } = await import("./qa/privateRtcPanelMount");
    mountPrivateQaRtcPanel(api);
  } catch (error) {
    // An explicit QA opt-in must fail closed. Do not continue into the app,
    // where the default PeerJS selector could otherwise create public traffic.
    const root = document.getElementById("root");
    if (root) {
      root.textContent = "Private QA RTC could not start. Remove #phase-qa-rtc=… to launch without QA mode.";
    }
    throw error;
  }
}

export async function bootstrap(): Promise<void> {
  // The optional selector must precede React effects and every game factory
  // selection. Without the explicit URL fragment, production stays untouched.
  await installPrivateQaRtcBeforeRender();

  await initializeHostPlatform();

  // Cloud-sync restores its Supabase session from an App effect, so migration
  // must finish before React mounts and that effect can observe localStorage.
  await importLegacyStorage();

  // Connectivity persistence intentionally hydrates after legacy migration and
  // before any React effect or background registration can own a network path.
  await initializeConnectivity();

  // StrictMode is scoped inside App.tsx instead of wrapping the root. P2P game
  // sessions own PeerJS resources whose cleanup is intentionally destructive, so
  // those routes opt out of dev-only StrictMode double-mounting.
  createRoot(document.getElementById("root")!).render(<App />);

  registerServiceWorker();
  registerTauriUpdater();
  installChunkReloadHandler();
  installTauriExternalLinkHandler();
  installTelemetry();

  // Wait for the initial app-shell render before unlocking offline navigation
  // from the bundled bootstrap page on subsequent launches.
  window.requestAnimationFrame(markRemoteLoadOk);
}

void bootstrap();
