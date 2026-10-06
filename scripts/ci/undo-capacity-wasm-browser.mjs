// One bounded real-WASM functional run in standard Chrome module Worker; no UI/RTC claim.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const directory = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
await mkdir(evidence, { recursive: true });
const executable = ["google-chrome", "chromium", "chromium-browser"]
  .map(name => spawnSync("which", [name], { encoding: "utf8" }).stdout?.trim())
  .find(Boolean);
assert(executable, "no installed Chromium executable; do not substitute a stub");
const versionProbe = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10000, maxBuffer: 16384 });
const launch = { executable, realpath: await realpath(executable),
  version: { status: versionProbe.status, signal: versionProbe.signal, error: versionProbe.error?.message,
    stdout: versionProbe.stdout?.slice(-6000), stderr: versionProbe.stderr?.slice(-6000) } };
const expected = ["host_precast_undo_status", "enable_host_precast_undo", "restore_host_precast_undo", "disable_host_precast_undo"];
const worker = `import init, * as engine from '/engine_wasm.js';
import { runFunctional } from '/undo-capacity-wasm-functional.mjs';
try { await init();
  const response = await fetch('/fixture.json');
  if (!response.ok) throw Error('fixture');
  postMessage({runtime:'Chrome module Worker', realWasmInitialized:true,
    ...runFunctional(engine, await response.text())});
} catch { postMessage({pass:false,stage:'initialize',failedCheck:'worker-initialization-error'}); }`;
const html = `<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>
const result = document.querySelector('#result');
const capabilities = {secureContext:isSecureContext, webAssembly:typeof WebAssembly==='object',
 moduleWorker:typeof Worker==='function', rtcApi:typeof RTCPeerConnection==='function'};
try { const worker = new Worker('/probe-worker.js',{type:'module'});
 worker.onmessage = event => { result.textContent=JSON.stringify({...capabilities,...event.data}); worker.terminate(); };
 worker.onerror = event => { result.textContent=JSON.stringify({pass:false,failedCheck:"worker-runtime-error"}); };
} catch(error) { result.textContent=JSON.stringify({pass:false,failedCheck:"worker-creation-error"}); }
</script>`;
const server = http.createServer((request, response) => {
  if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end(html); return; }
  if (request.url === "/probe-worker.js") { response.setHeader("Content-Type", "text/javascript"); response.end(worker); return; }
  if (request.url === "/undo-capacity-wasm-functional.mjs" || request.url === "/fixture.json") {
    response.setHeader("Content-Type", request.url.endsWith(".json") ? "application/json" : "text/javascript");
    const file = request.url === "/fixture.json" ? process.argv[4]
      : new URL("./undo-capacity-wasm-functional.mjs", import.meta.url);
    const stream = createReadStream(file);
    stream.on("error", () => response.destroy()); stream.pipe(response); return;
  }
  const name = request.url?.slice(1);
  if (!["engine_wasm.js", "engine_wasm_bg.wasm"].includes(name)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
  const stream = createReadStream(path.join(directory, name));
  stream.on("error", () => response.destroy());
  stream.pipe(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(path.join(process.env.RUNNER_TEMP, "undo-capacity-chrome-"));
const args = ["--headless", "--disable-gpu", "--disable-background-networking",
  "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"];
const chrome = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
Object.assign(launch, { args, pid: chrome.pid, startupDeadlineMs: 10000 });
let diagnostic = "";
let stdout = "";
let spawnError;
let exit;
let activePort;
let endpointSource;
let failure;
let observed;
chrome.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes).slice(-6000); });
chrome.stdout.on("data", bytes => { stdout = (stdout + bytes).slice(-6000); });
chrome.on("error", error => { spawnError = error.message; });
chrome.on("exit", (code, signal) => { exit = { code, signal }; });
async function readActivePort() {
  try { activePort = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).slice(0,4096); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Chromium writes the ephemeral port and browser path into this fresh profile.
  const match = activePort?.match(/^(\d+)\r?\n(\/devtools\/browser\/[A-Za-z0-9-]+)\r?\n?$/);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return;
  return `ws://127.0.0.1:${match[1]}${match[2]}`;
}
let socket;
let serial = 0;
const pending = new Map();
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
try {
  let endpoint;
  for (let attempt = 0; attempt < 100 && !endpoint; attempt++) {
    assert(!spawnError && chrome.exitCode === null && chrome.signalCode === null, "Chromium exited or failed before the probe");
    endpoint = diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/)?.[1];
    if (endpoint) endpointSource = "stderr";
    else { endpoint = await readActivePort(); if (endpoint) endpointSource = "DevToolsActivePort"; }
    if (!endpoint) await pause(100);
  }
  assert(endpoint, "Chromium did not expose its local DevTools endpoint");
  socket = new WebSocket(endpoint);
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const version = await call("Browser.getVersion");
  const target = await call("Target.createTarget", { url: `http://127.0.0.1:${server.address().port}/` });
  const { sessionId } = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  for (let attempt = 0; attempt < 360 && !observed; attempt++) {
    const evaluation = await call("Runtime.evaluate", { expression: "document.querySelector('#result')?.textContent || ''", returnByValue: true }, sessionId);
    if (evaluation.result.value) observed = JSON.parse(evaluation.result.value); else await pause(500);
  }
  assert(observed?.pass && observed.secureContext && observed.webAssembly && observed.moduleWorker,
    `browser engine/worker probe failed: ${JSON.stringify(observed)}`);
  const result = { browser: version.product, ...observed, scope: "verified real engine in a local module Worker",
    undoRestore: "PASS", appUiViteDevGate: "NOT RUN", twoSeatRtc: "NOT RUN", iphoneSafari: "NOT RUN" };
  await writeFile(path.join(evidence, "chromium-worker-functional.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  await call("Browser.close").catch(() => {});
} catch (error) {
  failure = "browser-functional-or-launch-failure";
  await writeFile(path.join(evidence, "chromium-worker-functional.json"), JSON.stringify({
    pass: false, scope: "verified real engine in a local module Worker", failure, observed: observed ?? null,
    undoRestore: "NOT RUN", appUiViteDevGate: "NOT RUN", twoSeatRtc: "NOT RUN", iphoneSafari: "NOT RUN",
  }, null, 2) + "\n");
  process.exitCode = 1;
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close(); server.close();
  const beforeCleanup = { exitCode: chrome.exitCode, signalCode: chrome.signalCode, exit, spawnError };
  await readActivePort().catch(error => { launch.portFileError = error.message; });
  chrome.kill("SIGTERM");
  for (let attempt = 0; attempt < 20 && !exit && !spawnError; attempt++) await pause(100);
  await writeFile(path.join(evidence, "chromium-launch.json"), JSON.stringify({ ...launch, beforeCleanup,
    afterCleanup: { exitCode: chrome.exitCode, signalCode: chrome.signalCode, exit, spawnError },
    DevToolsActivePort: activePort ?? null, endpointSource: endpointSource ?? null, failure: failure ?? null }, null, 2) + "\n");
  await writeFile(path.join(evidence, "chromium.stdout.log"), stdout);
  await writeFile(path.join(evidence, "chromium.stderr.log"), diagnostic);
}
