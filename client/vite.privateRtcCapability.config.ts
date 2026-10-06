import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { createHarnessStamp, HARNESS_HTML, harnessIntegrityPlugin } from "./src/qa/harness/build";

const root = path.dirname(fileURLToPath(import.meta.url));
const stamp = createHarnessStamp(root);

export default defineConfig({
  root, base: "/", publicDir: false,
  define: { __QA_A1_A2_BUILD_STAMP__: JSON.stringify(stamp) },
  plugins: [harnessIntegrityPlugin(stamp)],
  build: {
    outDir: "dist-private-rtc-capability", emptyOutDir: true, manifest: true,
    modulePreload: { polyfill: false }, target: "es2022",
    rollupOptions: { input: path.resolve(root, HARNESS_HTML) },
  },
});
