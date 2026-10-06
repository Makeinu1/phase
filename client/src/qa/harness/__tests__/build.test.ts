// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Rollup } from "vite";
import { HARNESS_HTML, sealHarnessBundle } from "../build";
import type { HarnessBuildStamp } from "../schema";

const stamp: HarnessBuildStamp = { schema: 1, buildId: "11111111-1111-4111-8111-111111111111",
  sourceHead: "a".repeat(40), sourceSha256: "b".repeat(64), sourceDirty: false, builtAt: "2026-10-05T00:00:00.000Z" };

function bundle(): Rollup.OutputBundle {
  return {
    "assets/control-test.js": { type: "chunk", fileName: "assets/control-test.js", isEntry: true, imports: [], dynamicImports: [], code: "const test = 1;\n" },
    [HARNESS_HTML]: { type: "asset", fileName: HARNESS_HTML, source: '<head><script type="module" crossorigin src="/assets/control-test.js"></script></head><body></body>' },
    ".vite/manifest.json": { type: "asset", fileName: ".vite/manifest.json", source: JSON.stringify({ [HARNESS_HTML]: { file: "assets/control-test.js", isEntry: true } }) },
  } as unknown as Rollup.OutputBundle;
}

describe("A1 single-entry build metadata (unit fixture, no Vite build)", () => {
  it("adds standard SRI metadata and matching inline/build manifest records", () => {
    const output = bundle();
    const result = sealHarnessBundle(output, stamp);
    const expected = "sha384-" + createHash("sha384").update("const test = 1;\n").digest("base64");
    expect(result.entry).toEqual({ file: "assets/control-test.js", bytes: 16, integrity: expected });
    expect(result.stamp).toEqual(stamp);
    expect(result.viteManifest.sha256).toBe(createHash("sha256").update((output[".vite/manifest.json"] as Rollup.OutputAsset).source).digest("hex"));
    const html = (output[HARNESS_HTML] as Rollup.OutputAsset).source as string;
    expect(html).toContain(`integrity="${expected}"`);
    expect(html).toContain('crossorigin="anonymous"');
    expect(html.match(/\bcrossorigin\b/g)).toHaveLength(1);
    expect(html).toContain(`<script id="qa-runtime-manifest" type="application/json">${JSON.stringify(result)}</script>`);
  });

  it("rejects imported code, extra chunks, or a mismatched Vite entry", () => {
    const imported = bundle(); (imported["assets/control-test.js"] as Rollup.OutputChunk).imports = ["external.js"];
    expect(() => sealHarnessBundle(imported, stamp)).toThrow("one self-contained entry");
    const extra = bundle(); extra["assets/extra.js"] = { ...extra["assets/control-test.js"], fileName: "assets/extra.js" };
    expect(() => sealHarnessBundle(extra, stamp)).toThrow("one self-contained entry");
    const mismatch = bundle(); (mismatch[".vite/manifest.json"] as Rollup.OutputAsset).source = JSON.stringify({ [HARNESS_HTML]: { file: "other.js" } });
    expect(() => sealHarnessBundle(mismatch, stamp)).toThrow("does not match the Vite manifest");
  });
});
