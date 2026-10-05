import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const clientRoot = path.dirname(fileURLToPath(import.meta.url));
const disabledPeerJsId = "\0private-rtc-probe-peerjs-disabled";

export default defineConfig({
  root: clientRoot,
  base: "/",
  publicDir: false,
  plugins: [
    react(),
    {
      name: "private-rtc-probe-disable-peerjs",
      enforce: "pre",
      resolveId(source) {
        if (source === "peerjs") return disabledPeerJsId;
      },
      load(id) {
        if (id === disabledPeerJsId) {
          return 'export default class DisabledPeerJs { constructor() { throw new Error("PeerJS is disabled in the standalone private RTC probe"); } }';
        }
      },
    },
  ],
  build: {
    outDir: "dist-private-rtc-probe",
    emptyOutDir: true,
    manifest: true,
    modulePreload: { polyfill: false },
    target: "es2022",
    rollupOptions: {
      input: path.resolve(clientRoot, "qa/private-rtc-probe.html"),
    },
  },
});
