import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = resolve(process.argv[2]);
const expected = ["host_precast_undo_status", "enable_host_precast_undo", "restore_host_precast_undo", "disable_host_precast_undo"];
const types = await readFile(resolve(directory, "engine_wasm.d.ts"), "utf8");
const signatures = [
  "export function host_precast_undo_status(): any;",
  "export function enable_host_precast_undo(binding: string): any;",
  "export function restore_host_precast_undo(binding: string, receipt: string): any;",
  "export function disable_host_precast_undo(): void;",
];
for (const signature of signatures) assert(types.includes(signature), `missing generated signature: ${signature}`);
const bytes = await readFile(resolve(directory, "engine_wasm_bg.wasm"));
const module = await WebAssembly.compile(bytes);
const exports = new Set(WebAssembly.Module.exports(module).filter((entry) => entry.kind === "function").map((entry) => entry.name));
for (const name of expected) assert(exports.has(name), `missing binary export: ${name}`);

let offset = 8;
function leb() {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    assert(offset < bytes.length && shift < 35, "invalid WASM LEB");
    byte = bytes[offset++];
    result |= (byte & 127) << shift;
    shift += 7;
  } while (byte & 128);
  return result >>> 0;
}
let minPages;
while (offset < bytes.length) {
  const id = bytes[offset++];
  const length = leb();
  const end = offset + length;
  assert(end <= bytes.length);
  if (id === 5) {
    assert.equal(leb(), 1, "expected one owned memory");
    leb();
    minPages = leb();
    break;
  }
  offset = end;
}
assert(minPages >= 200, "existing stack-memory guard failed");
const bindings = await import(pathToFileURL(resolve(directory, "engine_wasm.js")));
for (const name of expected) assert.equal(typeof bindings[name], "function");
await bindings.default({ module_or_path: module });
console.log(JSON.stringify({ generatedSignatures: expected, initializedRealWasm: true, minPages,
  stackGuard: "existing >=200 pages discriminant; linker argv separately preserves 16777216 bytes",
  undoBehavior: "NOT RUN", browser: "NOT RUN", rtc: "NOT RUN" }));
