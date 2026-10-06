// One real Vite DEV / component / private-Worker close check in Fork CI.
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const [client, wasm, fixture, evidence] = process.argv.slice(2).map(value => path.resolve(value));
const frontendSha = "ea16547c3694999c6b991cfbcbcd8180a0d6fb1a";
const engineSha = "e10955dc5977f1ba7c65cb1518cb8f4b1679fe92";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-C", client, ...args], { encoding: "utf8" }).trim();
await mkdir(evidence, { recursive: true });
assert(git("rev-parse", "HEAD") === frontendSha, "frontend pin differs");
git("diff", "--exit-code");
const manifestBytes = await readFile(path.join(wasm, "manifest.json"));
assert(hash(manifestBytes) === "f2681c2c2ba8e13dde7a6f5e65f461b3fc9957ce7769d339c3bde6250c152659", "engine manifest differs");
const manifest = JSON.parse(manifestBytes);
assert(manifest.source_sha === engineSha, "engine source differs");
assert(hash(await readFile(path.join(client, "pnpm-lock.yaml"))) === manifest.input_sha256["client/pnpm-lock.yaml"], "frontend dependency lock differs");
const runtimeHashes = {};
for (const name of ["engine_wasm.js", "engine_wasm_bg.wasm"]) {
  runtimeHashes[name] = hash(await readFile(path.join(wasm, name)));
  assert(runtimeHashes[name] === manifest.files[name].sha256, "engine runtime file differs");
  await copyFile(path.join(wasm, name), path.join(client, "src/wasm", name));
}
const harness = path.join(path.dirname(fileURLToPath(import.meta.url)), "undo-f-single-host-ui.tsx");
await copyFile(harness, path.join(client, "src/qa-single-host.tsx"));
await copyFile(fixture, path.join(client, "public/qa-host-card-data.json"));
await writeFile(path.join(client, "qa-single-host.html"), '<!doctype html><meta charset="utf-8"><title>Single host Undo CI</title><div id="root"></div><script type="module" src="/src/qa-single-host.tsx"></script>');
await writeFile(path.join(client, "vite.single-host-ui.config.ts"), `import base from './vite.config';
import {defineConfig} from 'vite';
export default defineConfig(async env=>{const config=typeof base==='function'?await base(env):base;
return {...config,optimizeDeps:{...config.optimizeDeps,entries:['qa-single-host.html']}};});`);
const result = { frontendSha, engineSha, workflowSha: process.env.GITHUB_SHA,
  runtimeHashes, cardFixtureSha256: hash(await readFile(fixture)), harnessSha256: hash(await readFile(harness)),
  scope: "existing consent/Undo components + real P2P host/Worker; guest-free AI fixture",
  positiveRestore: "NOT RUN", fullBoardUx: "NOT RUN", twoSeatSync: "NOT RUN", memoryReclamation: "NOT RUN" };
let stage = "vite-start";
let vite, chrome, socket;
let viteLog = "", chromeOut = "", chromeErr = "";
let serial = 0;
const pending = new Map();
const createdWorkers = new Set(), destroyedWorkers = new Set();
const workerSessions = new Map(), detachedWorkerSessions = new Set();
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP request timeout")); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");
  for (let i = 0; i < 50 && process.exitCode === null && process.signalCode === null; i++) await pause(100);
  if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
}
try {
  vite = spawn(process.execPath, [path.join(client, "node_modules/vite/bin/vite.js"), "--config", "vite.single-host-ui.config.ts", "--host", "127.0.0.1", "--port", "5188", "--strictPort"], {
    cwd: client, env: { ...process.env, VITE_PHASE_SANDBOX: "1", CARD_DATA_URL: "/qa-host-card-data.json",
      TELEMETRY_URL: "", SUPABASE_URL: "", SUPABASE_ANON_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stdout.on("data", bytes => { viteLog = (viteLog + bytes).slice(-12000); });
  vite.stderr.on("data", bytes => { viteLog = (viteLog + bytes).slice(-12000); });
  let ready = false;
  for (let i = 0; i < 300 && !ready && vite.exitCode === null; i++) {
    try { ready = (await fetch("http://127.0.0.1:5188/qa-single-host.html", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (!ready) await pause(100);
  }
  assert(ready, "Vite did not start");
  stage = "chromium-start";
  const executable = "/usr/bin/google-chrome";
  result.browserVersion = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10000 }).stdout?.trim();
  const profile = await mkdtemp(path.join(process.env.RUNNER_TEMP, "undo-f-ui-chrome-"));
  const browserArgs = ["--headless", "--disable-gpu", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"];
  chrome = spawn(executable, browserArgs, { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stdout.on("data", bytes => { chromeOut = (chromeOut + bytes).slice(-12000); });
  chrome.stderr.on("data", bytes => { chromeErr = (chromeErr + bytes).slice(-12000); });
  let endpoint;
  for (let i = 0; i < 100 && !endpoint && chrome.exitCode === null && chrome.signalCode === null; i++) {
    endpoint = chromeErr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/)?.[1];
    if (!endpoint) {
      try {
        const port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/);
        if (/^\d+$/.test(port[0]) && port[1]?.startsWith("/devtools/browser/")) endpoint = `ws://127.0.0.1:${port[0]}${port[1]}`;
      } catch {}
    }
    if (!endpoint) await pause(100);
  }
  assert(endpoint, "standard Chromium did not open CDP");
  socket = new WebSocket(endpoint);
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") {
      const info = message.params.targetInfo;
      if (info.type === "worker" && info.url.includes("engine-worker")) createdWorkers.add(info.targetId);
    }
    if (message.method === "Target.targetDestroyed" && createdWorkers.has(message.params.targetId)) destroyedWorkers.add(message.params.targetId);
    if (message.method === "Target.attachedToTarget") {
      const info = message.params.targetInfo;
      if (info.type === "worker" && info.url.includes("engine-worker")) {
        createdWorkers.add(info.targetId);
        workerSessions.set(message.params.sessionId, info.targetId);
      }
    }
    if (message.method === "Target.detachedFromTarget" && workerSessions.has(message.params.sessionId)) detachedWorkerSessions.add(message.params.sessionId);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Object.assign(Error("CDP command failed"), { protocolCode: message.error.code })); else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  await call("Target.setDiscoverTargets", { discover: true });
  const target = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await call("Page.enable", {}, sessionId);
  // Dedicated Workers are page-related targets, not browser discovery events.
  await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  // Observation only: native Worker construction/postMessage/terminate still execute.
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__hostUiMonitor={workers:[]}; const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker { constructor(...args){ super(...args);
      const item={engine:String(args[0]).includes('engine-worker'),terminated:false,requests:[],errors:0};
      window.__hostUiMonitor.workers.push(item); this.addEventListener('error',()=>item.errors++);
      this.addEventListener('message',event=>{if(event.data?.type==='error')item.errors++;});
      this.postMessage=(...values)=>{if(typeof values[0]?.type==='string')item.requests.push(values[0].type);return NativeWorker.prototype.postMessage.apply(this,values);};
      this.terminate=()=>{item.terminated=true;return NativeWorker.prototype.terminate.call(this);};
    }};` }, sessionId);
  const evaluate = async expression => {
    const answer = await call("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    assert(!answer.exceptionDetails, "page evaluation failed");
    return answer.result.value;
  };
  const wait = async (expression, seconds = 20) => {
    for (let i = 0; i < seconds * 10; i++) {
      assert(await evaluate("document.querySelector('#status')?.textContent!=='failed'"), "UI harness operation failed");
      if (await evaluate(expression)) return;
      await pause(100);
    }
    throw Error("UI assertion deadline");
  };
  const click = async selector => {
    const rect = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...rect, button: "left", clickCount: 1 }, sessionId);
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...rect, button: "left", clickCount: 1 }, sessionId);
  };
  const screenshot = async name => {
    const shot = await call("Page.captureScreenshot", { format: "png" }, sessionId);
    await writeFile(path.join(evidence, name), Buffer.from(shot.data, "base64"));
  };
  stage = "consent-default-off";
  await call("Page.navigate", { url: "http://127.0.0.1:5188/qa-single-host.html" }, sessionId);
  await wait("document.querySelector('#status')?.textContent==='consent'");
  assert(await evaluate("window.__hostUiResult.devGate===true && document.querySelectorAll('input[type=checkbox]').length===1 && !document.querySelector('input[type=checkbox]').checked && document.querySelector('#start-host').disabled"), "consent default/gate failed");
  result.consentDefaultOff = true;
  await screenshot("consent-off.png");
  stage = "real-host-start";
  await click("input[type=checkbox]");
  await wait("document.querySelector('#consent-agreed').textContent==='true'");
  await click("#start-host");
  await wait("document.querySelector('#status')?.textContent==='active'", 120);
  const before = await evaluate("({ui:window.__hostUiResult,workers:window.__hostUiMonitor.workers})");
  result.beforeClose = before;
  const primary = before.workers.filter(worker => worker.engine);
  assert(before.ui.realHostInitialized && before.ui.guestConnections === 0 && before.ui.undoAvailable === false, "real guest-free host failed");
  assert(before.ui.activeDiagnostics > before.ui.initialDiagnostics, "live host diagnostics were not registered");
  assert(primary.length === 1 && !primary[0].terminated && primary[0].errors === 0 && primary[0].requests.includes("initializeMultiplayerHostGame"), "real private Worker unavailable");
  assert(!primary[0].requests.includes("enableHostPrecastUndo") && !primary[0].requests.includes("restoreHostPrecastUndo"), "Undo gate was bypassed");
  assert(await evaluate("!document.querySelector('input[type=checkbox]').checked && document.querySelector('#snapshot-active').textContent==='true' && [...document.querySelectorAll('button')].find(button=>button.textContent==='Sandbox pre-cast Undo')?.disabled===true"), "consent consumption/disabled Undo failed");
  result.consentConsumedOnce = true; result.guestAbsentUndoDisabled = true;
  assert(workerSessions.size === 1 && createdWorkers.size === 1, "real engine Worker CDP session unavailable");
  const workerTarget = [...createdWorkers][0];
  const liveTarget = await call("Target.getTargetInfo", { targetId: workerTarget });
  assert(liveTarget.targetInfo.type === "worker" && liveTarget.targetInfo.url.includes("engine-worker"), "engine Worker target not live before close");
  result.engineWorkerInspectableBeforeClose = true;
  await screenshot("host-undo-disabled.png");
  stage = "host-close";
  await click("#close-host");
  await wait("document.querySelector('#status')?.textContent==='closed'");
  const after = await evaluate("({ui:window.__hostUiResult,workers:window.__hostUiMonitor.workers})");
  result.afterClose = after;
  assert(after.ui.displayCleared && after.ui.diagnosticsCleared && after.workers.filter(worker => worker.engine && worker.terminated).length === 1, "close did not release Worker/display/diagnostics");
  assert(!after.workers.some(worker => worker.requests.includes("releaseHostSession")), "private close waited on a release RPC");
  assert(await evaluate("document.querySelector('#snapshot-active').textContent==='false' && ![...document.querySelectorAll('button')].some(button=>button.textContent==='Sandbox pre-cast Undo')"), "closed Undo display remains");
  // Never detach the Worker or close its page before checking actual disposal.
  for (let i = 0; i < 50 && detachedWorkerSessions.size !== 1; i++) await pause(100);
  let removedTargetCode;
  try { await call("Target.getTargetInfo", { targetId: workerTarget }); }
  catch (cause) { removedTargetCode = cause.protocolCode; }
  result.workerTargets = { created: createdWorkers.size, destroyedEvents: destroyedWorkers.size,
    detached: detachedWorkerSessions.size, removedTargetCode };
  assert(detachedWorkerSessions.size === 1 && removedTargetCode === -32602, "actual engine Worker target remains");
  result.hostClose = true; result.actualWorkerTargetDestroyed = true;
  await screenshot("host-closed.png");
  await call("Browser.close").catch(() => {});
  git("diff", "--exit-code");
  result.pass = true; stage = "complete";
} catch (cause) {
  result.pass = false;
  // No engine values, hidden zones, owner keys, bindings or receipts in errors.
  result.failure = cause instanceof assert.AssertionError ? cause.message : "driver operation failed";
} finally {
  result.stage = stage;
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close();
  await stop(chrome); await stop(vite);
  await writeFile(path.join(evidence, "vite.log"), viteLog);
  await writeFile(path.join(evidence, "chromium.stdout.log"), chromeOut);
  await writeFile(path.join(evidence, "chromium.stderr.log"), chromeErr);
  await writeFile(path.join(evidence, "single-host-ui-result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ pass: result.pass, stage, frontendSha, engineSha, scope: result.scope }));
}
process.exitCode = result.pass ? 0 : 1;
