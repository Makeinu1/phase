import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = resolve(process.argv[2]);
const expected = ["init_panic_hook", "load_card_database", "start_quick_draft", "get_view"];
const types = await readFile(resolve(directory, "draft_wasm.d.ts"), "utf8");
for (const name of expected) assert(types.includes(`export function ${name}(`), "generated draft declaration missing");
const bytes = await readFile(resolve(directory, "draft_wasm_bg.wasm"));
const module = await WebAssembly.compile(bytes);
const exported = new Set(WebAssembly.Module.exports(module).map(x => x.name));
for (const name of expected) assert(exported.has(name), "generated draft binary export missing");

let offset = 8;
const leb = () => {
  let result = 0, shift = 0, byte;
  do {
    assert(offset < bytes.length && shift < 35, "invalid WASM LEB");
    byte = bytes[offset++]; result |= (byte & 127) << shift; shift += 7;
  } while (byte & 128);
  return result >>> 0;
};
let minPages;
while (offset < bytes.length) {
  const id = bytes[offset++], length = leb(), end = offset + length;
  assert(end <= bytes.length, "invalid WASM section");
  if (id === 5) { assert.equal(leb(), 1); leb(); minPages = leb(); break; }
  offset = end;
}
assert(minPages >= 200, "existing shadow-stack memory guard failed");
const bindings = await import(pathToFileURL(resolve(directory, "draft_wasm.js")));
for (const name of expected) assert.equal(typeof bindings[name], "function");
await bindings.default({ module_or_path: module });
bindings.init_panic_hook();
console.log(JSON.stringify({ realDraftPairInitialized: true, exports: expected, minPages, draftGameplay: "NOT RUN", engineWasmBuild: "NOT RUN" }));
