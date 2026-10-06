import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runFunctional } from "./undo-capacity-wasm-functional.mjs";
try {
  const directory = path.resolve(process.argv[2]);
  const engine = await import(pathToFileURL(path.join(directory, "engine_wasm.js")));
  const bytes = await readFile(path.join(directory, "engine_wasm_bg.wasm"));
  const module = await WebAssembly.compile(bytes);
  const expected = ["host_precast_undo_status", "enable_host_precast_undo", "restore_host_precast_undo", "disable_host_precast_undo"];
  const binaryExports = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
  const types = await readFile(path.join(directory, "engine_wasm.d.ts"), "utf8");
  for (const name of expected) {
    assert(binaryExports.has(name) && typeof engine[name] === "function");
    assert(types.includes(`export function ${name}(`));
  }

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
  await engine.default({ module_or_path: module });
  const result = runFunctional(engine, await readFile(process.argv[3], "utf8"));
  console.log(JSON.stringify({ runtime: "Node", minPages, stackGuard: "existing >=200 pages discriminant; linker argv checked separately", ...result }));
  if (!result.pass) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ pass: false, stage: "initialize", failedCheck: "node-initialization-error" }));
  process.exitCode = 1;
}
