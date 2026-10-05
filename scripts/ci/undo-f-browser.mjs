// One bounded Chromium capability probe of the verified engine; no UI/Undo/RTC acceptance claim.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const directory = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
await mkdir(evidence, { recursive: true });
const executable = ["google-chrome", "chromium", "chromium-browser"].find(name => spawnSync("which", [name]).status === 0);
assert(executable, "no installed Chromium executable; do not substitute a stub");
const expected = ["host_precast_undo_status", "enable_host_precast_undo", "restore_host_precast_undo", "disable_host_precast_undo"];
const worker = `import init, * as engine from '/engine_wasm.js';
try { await init(); const ping = engine.ping();
  if (ping !== 'phase-rs engine ready') throw Error('real engine ping failed');
  const names = ${JSON.stringify(expected)};
  if (!names.every(name => typeof engine[name] === 'function')) throw Error('missing Undo export');
  postMessage({pass:true, realWasmInitialized:true, ping, exports:names});
} catch(error) { postMessage({pass:false,error:String(error)}); }`;
const html = `<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>
const result = document.querySelector('#result');
const capabilities = {secureContext:isSecureContext, webAssembly:typeof WebAssembly==='object',
 moduleWorker:typeof Worker==='function', rtcApi:typeof RTCPeerConnection==='function'};
try { const worker = new Worker('/probe-worker.js',{type:'module'});
 worker.onmessage = event => { result.textContent=JSON.stringify({...capabilities,...event.data}); worker.terminate(); };
 worker.onerror = event => { result.textContent=JSON.stringify({pass:false,error:event.message}); };
} catch(error) { result.textContent=JSON.stringify({pass:false,error:String(error)}); }
</script>`;
const server = http.createServer((request, response) => {
  if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end(html); return; }
  if (request.url === "/probe-worker.js") { response.setHeader("Content-Type", "text/javascript"); response.end(worker); return; }
  const name = request.url?.slice(1);
  if (!["engine_wasm.js", "engine_wasm_bg.wasm"].includes(name)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
  const stream = createReadStream(path.join(directory, name));
  stream.on("error", () => response.destroy());
  stream.pipe(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(path.join(process.env.RUNNER_TEMP, "undo-f-chrome-"));
const chrome = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-background-networking",
  "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
let diagnostic = "";
chrome.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes).slice(-6000); });
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
    assert(chrome.exitCode === null, "Chromium exited before the probe");
    endpoint = diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/)?.[1];
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
  let observed;
  for (let attempt = 0; attempt < 120 && !observed; attempt++) {
    const evaluation = await call("Runtime.evaluate", { expression: "document.querySelector('#result')?.textContent || ''", returnByValue: true }, sessionId);
    if (evaluation.result.value) observed = JSON.parse(evaluation.result.value); else await pause(500);
  }
  assert(observed?.pass && observed.secureContext && observed.webAssembly && observed.moduleWorker,
    `browser engine/worker probe failed: ${JSON.stringify(observed)}`);
  const result = { browser: version.product, ...observed, scope: "verified real engine in a local module Worker",
    undoRestore: "NOT RUN", appUiViteDevGate: "NOT RUN", twoSeatRtc: "NOT RUN", iphoneSafari: "NOT RUN" };
  await writeFile(path.join(evidence, "browser-capability.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  await call("Browser.close").catch(() => {});
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close(); chrome.kill("SIGTERM"); server.close();
  await writeFile(path.join(evidence, "chromium.stderr.log"), diagnostic);
}
