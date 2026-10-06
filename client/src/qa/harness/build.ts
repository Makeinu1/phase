import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, Rollup } from "vite";
import type { HarnessBuildStamp, HarnessManifest } from "./schema";

export const HARNESS_HTML = "qa/private-rtc-capability.html";
export const HARNESS_INPUTS = [
  HARNESS_HTML, "src/qa/harness/schema.ts", "src/qa/harness/preflight.ts",
  "src/qa/harness/capabilityControl.ts", "src/qa/harness/entry.ts", "src/qa/harness/runGate.ts", "src/qa/harness/build.ts",
  "vite.privateRtcCapability.config.ts", "package.json", "pnpm-lock.yaml",
].sort();

export function createHarnessStamp(root: string): HarnessBuildStamp {
  const digest = createHash("sha256");
  for (const name of HARNESS_INPUTS) digest.update(name).update("\0").update(readFileSync(path.join(root, name))).update("\0");
  let sourceHead: string | null = null;
  let sourceDirty: boolean | null = null;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[a-f0-9]{40}$/.test(head)) sourceHead = head;
    sourceDirty = !!execFileSync("git", ["status", "--porcelain", "--", ...HARNESS_INPUTS], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { /* An exported source tree can have no git identity. */ }
  return { schema: 1, buildId: randomUUID(), sourceHead, sourceSha256: digest.digest("hex"), sourceDirty, builtAt: new Date().toISOString() };
}

/** Runs after Vite's normal HTML/manifest hooks; no loader or later bundle fetch. */
export function sealHarnessBundle(bundle: Rollup.OutputBundle, stamp: HarnessBuildStamp): HarnessManifest {
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  const entry = chunks[0];
  const html = bundle[HARNESS_HTML];
  const vite = bundle[".vite/manifest.json"];
  if (chunks.length !== 1 || !entry || !entry.isEntry || entry.imports.length || entry.dynamicImports.length
    || !html || html.type !== "asset" || typeof html.source !== "string"
    || !vite || vite.type !== "asset" || typeof vite.source !== "string") throw new Error("A1/A2 requires one self-contained entry and a Vite manifest");
  const viteEntry = (JSON.parse(vite.source) as Record<string, { file?: string }>)[HARNESS_HTML];
  if (viteEntry?.file !== entry.fileName) throw new Error("A1/A2 entry does not match the Vite manifest");
  const manifest: HarnessManifest = {
    stamp,
    entry: { file: entry.fileName, bytes: Buffer.byteLength(entry.code), integrity: "sha384-" + createHash("sha384").update(entry.code).digest("base64") },
    viteManifest: { file: ".vite/manifest.json", sha256: createHash("sha256").update(vite.source).digest("hex"), entryKey: HARNESS_HTML },
  };
  let matched = 0;
  html.source = html.source.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag: string, src: string) => {
    if (src !== "/" + entry.fileName) return tag;
    matched += 1;
    const normalized = tag.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, "");
    return normalized.replace(/<script\b/, `<script integrity="${manifest.entry.integrity}" crossorigin="anonymous"`);
  });
  if (matched !== 1 || !html.source.includes("</head>")) throw new Error("A1/A2 requires one exact entry script in its HTML");
  const json = JSON.stringify(manifest).replace(/</g, "\\u003c");
  html.source = html.source.replace("</head>", `<script id="qa-runtime-manifest" type="application/json">${json}</script></head>`);
  return manifest;
}

export function harnessIntegrityPlugin(stamp: HarnessBuildStamp): Plugin {
  return {
    name: "qa-a1-a2-entry-integrity", apply: "build", enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const manifest = sealHarnessBundle(bundle, stamp);
        this.emitFile({ type: "asset", fileName: "qa/private-rtc-capability.manifest.json", source: JSON.stringify(manifest, null, 2) + "\n" });
      },
    },
  };
}
