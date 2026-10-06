/** Metadata for the isolated A1/A2 entry, unrelated to any Phase transport. */
export interface HarnessBuildStamp {
  schema: 1;
  buildId: string;
  sourceHead: string | null;
  sourceSha256: string;
  sourceDirty: boolean | null;
  builtAt: string;
}

export interface HarnessManifest {
  stamp: HarnessBuildStamp;
  entry: { file: string; bytes: number; integrity: string };
  viteManifest: { file: ".vite/manifest.json"; sha256: string; entryKey: string };
}

declare const __QA_A1_A2_BUILD_STAMP__: HarnessBuildStamp | undefined;

export function embeddedBuildStamp(): HarnessBuildStamp | null {
  return typeof __QA_A1_A2_BUILD_STAMP__ === "undefined" ? null : { ...__QA_A1_A2_BUILD_STAMP__ };
}

export function readEmbeddedManifest(document: Document): HarnessManifest | null {
  try {
    const value = JSON.parse(document.getElementById("qa-runtime-manifest")?.textContent ?? "null") as HarnessManifest | null;
    const stamp = value?.stamp;
    if (!value || !stamp || stamp.schema !== 1 || !/^[a-f0-9-]{36}$/.test(stamp.buildId)
      || !/^[a-f0-9]{64}$/.test(stamp.sourceSha256)
      || !(stamp.sourceHead === null || /^[a-f0-9]{40}$/.test(stamp.sourceHead))
      || !(stamp.sourceDirty === null || typeof stamp.sourceDirty === "boolean")
      || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(stamp.builtAt)
      || !/^assets\/[A-Za-z0-9_-]+\.js$/.test(value.entry?.file)
      || !Number.isSafeInteger(value.entry.bytes) || value.entry.bytes < 0
      || !/^sha384-[A-Za-z0-9+/]{64}$/.test(value.entry.integrity)
      || value.viteManifest?.file !== ".vite/manifest.json"
      || value.viteManifest.entryKey !== "qa/private-rtc-capability.html"
      || !/^[a-f0-9]{64}$/.test(value.viteManifest.sha256)) return null;
    // Copy only the schema fields; arbitrary JSON keys never enter diagnostics.
    return {
      stamp: { schema: 1, buildId: stamp.buildId, sourceHead: stamp.sourceHead,
        sourceSha256: stamp.sourceSha256, sourceDirty: stamp.sourceDirty, builtAt: stamp.builtAt },
      entry: { file: value.entry.file, bytes: value.entry.bytes, integrity: value.entry.integrity },
      viteManifest: { file: ".vite/manifest.json", sha256: value.viteManifest.sha256, entryKey: value.viteManifest.entryKey },
    };
  } catch { return null; }
}
