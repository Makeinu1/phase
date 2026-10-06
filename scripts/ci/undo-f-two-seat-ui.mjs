// One bounded full-App host-cast case. No real-time retry or fake guest/ACK.
import assert from "node:assert/strict";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { copyFile, readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const [client, wasm, draft, fixture, serverPackages, evidence] = process.argv.slice(2).map(x => path.resolve(x));
const frontendSha = "03b13eccaa6823ed41a0832044c33fb1821187e9";
const engineSha = "e10955dc5977f1ba7c65cb1518cb8f4b1679fe92";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hostForm = "document.querySelector('button[aria-label=Format]')?.closest('form')";
const hostSubmit = `(${hostForm})?.querySelector('button[type=submit]')`;
// Only fixed public control names and validity flags leave the page. Never
// serialize arbitrary text, input values, deck identity, or a DOM node.
const setupControls = `(()=>{const f=${hostForm};if(!f)return {formPresent:false};
const names=['Host Game','Host P2P Game','Opening...','You host (P2P)','Server hosts','Back','2','Limited'];
const controls=[...f.querySelectorAll('button,input,select')].map(n=>({
tag:n.tagName,type:n.getAttribute('type'),name:names.includes(n.textContent.trim())?n.textContent.trim():null,
disabled:Boolean(n.disabled),ariaDisabled:n.getAttribute('aria-disabled')==='true',required:Boolean(n.required),
valid:n.validity?.valid??null,valueMissing:n.validity?.valueMissing??null,badInput:n.validity?.badInput??null,
rangeUnderflow:n.validity?.rangeUnderflow??null,rangeOverflow:n.validity?.rangeOverflow??null}));
const b=f.querySelector('button[type=submit]'),title=b?.getAttribute('title')??'';
return {formPresent:true,formatLimited:f.querySelector('button[aria-label=Format]')?.textContent.trim()==='Limited',
submitPresent:Boolean(b),submitDisabled:Boolean(b?.disabled),submitAriaDisabled:b?.getAttribute('aria-disabled')==='true',
submitLabel:b?.textContent.trim()==='Host P2P Game'?'Host P2P Game':b?.textContent.trim()==='Host Game'?'Host Game':'other',
submitTitlePresent:Boolean(title),submitReason:/checking/i.test(title)?'checking':/not legal/i.test(title)?'illegal':title?'other':null,controls};})()`;
// DEV-only call-entry probes preserve every original statement. They expose
// the caller before PeerSession's asynchronous channel-disposal queue loses it.
const qaProbe = "(window as unknown as {__twoSeatQa?:{noteLifecycle:(kind:string,aborted?:boolean)=>void;noteSessionClose:(reason:unknown)=>void}}).__twoSeatQa";
const lifecycleProbes = [
  { source: "/src/network/peer.ts", anchor: 'close(reason = "Left game") {', count: 1, note: `${qaProbe}?.noteSessionClose(reason);` },
  { source: "/src/adapter/p2p-adapter.ts", anchor: "dispose(): void {", count: 3, note: `${qaProbe}?.noteLifecycle("p2p-adapter-dispose-enter");` },
  { source: "/src/providers/GameProvider.tsx", anchor: "const setupP2P = async () => {", count: 1, note: `${qaProbe}?.noteLifecycle("p2p-provider-setup-start",signal.aborted);` },
  { source: "/src/providers/GameProvider.tsx", anchor: "return () => {\n        ac.abort();", count: 1,
    before: true, note: `${qaProbe}?.noteLifecycle("p2p-provider-effect-cleanup-enter",signal.aborted);` },
  { source: "/src/providers/GameProvider.tsx", anchor: "} catch (err) {\n          // Compensating teardown", count: 1,
    before: true, note: `${qaProbe}?.noteLifecycle("p2p-provider-compensating-cleanup",signal.aborted);` },
];
const git = (...args) => execFileSync("git", ["-C", client, ...args], { encoding: "utf8" }).trim();
await mkdir(evidence, { recursive: true });
const result = { frontendSha, engineSha, workflowSha: process.env.GITHUB_SHA,
  scope: "real full App + isolated contexts + loopback PeerJS/native RTC; one host cast; pointer Undo",
  stagesPassed: [],
  guestCast: "NOT RUN", safari: "NOT RUN", memoryReclamation: "NOT RUN" };
let stage = "verify-inputs", category = "setup";
let vite, chrome, server, socket;
const pages = {};
let viteLog = "", chromeErr = "";
let serial = 0;
const pending = new Map();
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error("CDP timeout")); }, 15000);
  pending.set(id, { resolve, reject, timer, method });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await pause(100);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
async function markDriverTeardown() {
  if (result.driverTeardownAtUnixMs !== undefined) return;
  result.driverTeardownAtUnixMs = Date.now();
  for (const page of Object.values(pages)) {
    try { await page.evaluate("window.__twoSeatQa?.markDriverTeardown()"); } catch {}
  }
}
try {
  assert(git("rev-parse", "HEAD") === frontendSha, "frontend pin differs"); git("diff", "--exit-code");
  const raw = await readFile(path.join(wasm, "manifest.json")), manifest = JSON.parse(raw);
  assert(hash(raw) === "f2681c2c2ba8e13dde7a6f5e65f461b3fc9957ce7769d339c3bde6250c152659" && manifest.source_sha === engineSha, "engine manifest differs");
  assert(hash(await readFile(path.join(client, "pnpm-lock.yaml"))) === manifest.input_sha256["client/pnpm-lock.yaml"], "frontend lock differs");
  result.runtimeHashes = {};
  for (const name of ["engine_wasm.js", "engine_wasm_bg.wasm"]) {
    const digest = hash(await readFile(path.join(wasm, name))); assert(digest === manifest.files[name].sha256, "runtime file differs");
    result.runtimeHashes[name] = digest; await copyFile(path.join(wasm, name), path.join(client, "src/wasm", name));
  }
  const draftRaw = await readFile(path.join(draft, "manifest.json")), draftManifest = JSON.parse(draftRaw);
  result.draftManifestSha256 = hash(draftRaw);
  assert(result.draftManifestSha256 === "6a0043113fd25b7f2a0499ac570aabee51ea9e0ba74523309cc3f4e6fbb805a0" && draftManifest.source_sha === engineSha
    && draftManifest.workflow_sha === "eac6c9be9b1e0f1b9406506017c195f1107b6437", "draft producer manifest differs");
  assert(Object.keys(manifest.input_sha256).every(key => manifest.input_sha256[key] === draftManifest.input_sha256[key])
    && JSON.stringify(manifest.tool_versions) === JSON.stringify(draftManifest.tool_versions), "draft and engine compiled inputs differ");
  const draftFiles = ["draft_wasm.js", "draft_wasm.d.ts", "draft_wasm_bg.wasm", "draft_wasm_bg.wasm.d.ts", "package.json", "provenance.json"];
  assert(Object.keys(draftManifest.files).sort().join() === draftFiles.sort().join(), "draft file inventory differs");
  result.draftRuntimeHashes = {};
  for (const name of draftFiles) {
    const bytes = await readFile(path.join(draft, name)), digest = hash(bytes), expected = draftManifest.files[name];
    assert(bytes.length === expected.bytes && digest === expected.sha256, "draft paired file differs");
    result.draftRuntimeHashes[name] = digest;
    if (name === "draft_wasm.js" || name === "draft_wasm_bg.wasm") await copyFile(path.join(draft, name), path.join(client, "src/wasm", name));
  }
  await copyFile(path.join(draft, "manifest.json"), path.join(evidence, "draft-input-manifest.json"));
  await copyFile(path.join(draft, "provenance.json"), path.join(evidence, "draft-input-provenance.json"));
  const harness = path.join(path.dirname(fileURLToPath(import.meta.url)), "undo-f-two-seat-bootstrap.ts");
  result.harnessSha256 = hash(await readFile(harness)); result.fixtureSha256 = hash(await readFile(fixture));
  assert(result.fixtureSha256 === "4e3ca5348602f8f7ea762a27c36cfade8ed6fade547eefa279714dfd166cea66", "official fixture pin differs");
  await copyFile(harness, path.join(client, "src/qa-two-seat.ts"));
  await copyFile(fixture, path.join(client, "public/qa-host-card-data.json"));
  await writeFile(path.join(client, "vite.two-seat.config.ts"), `import base from './vite.config';import {defineConfig} from 'vite';
const probes=${JSON.stringify(lifecycleProbes)};
export default defineConfig(async env=>{const c=typeof base==='function'?await base(env):base;return {...c,
optimizeDeps:{...c.optimizeDeps,entries:['index.html'],include:[...(c.optimizeDeps?.include??[]),'idb']},plugins:[{name:'ci-app-bootstrap',enforce:'pre',
transformIndexHtml(html){return html.replace('/src/main.tsx','/src/qa-two-seat.ts');},transform(code,id){
for(const p of probes.filter(p=>id.split('?')[0].endsWith(p.source))){if(code.split(p.anchor).length-1!==p.count)throw Error('fixed lifecycle probe anchor differs');
const replacement=p.before?p.anchor.replace('{','{'+p.note):p.anchor+p.note;code=code.split(p.anchor).join(replacement);}return code;}},...c.plugins]};});`);
  result.lifecycleProbeScope = { nativeMethods: ["RTCPeerConnection.close", "RTCDataChannel.close", "Worker.terminate", "Peer.destroy", "DataConnection.close"],
    callEntries: lifecycleProbes.map(p => ({ source: p.source, expectedAnchors: p.count })), rawStackPersisted: false,
    nativeCallsSuppressed: false, fixedProductSourceChanged: false };
  const lock = JSON.parse(await readFile(path.join(serverPackages, "package-lock.json")));
  const pkg = lock.packages["node_modules/peer"];
  assert(pkg.version === "1.0.2" && pkg.integrity === "sha512-ZObVEhAaoskd3KuSxr5DJLM8QuqQW4w3i0MqrI8H7Bzz8DjRC3DjUg2XtQQGfdc36+8Xk+wIPT/tL5wE+KnIqg==", "PeerServer package pin differs");
  result.peerServer = { version: pkg.version, integrity: pkg.integrity, lockSha256: hash(await readFile(path.join(serverPackages, "package-lock.json"))), address: "127.0.0.1:9000" };
  await writeFile(path.join(serverPackages, "server.cjs"), `const {PeerServer}=require('peer');
PeerServer({host:'127.0.0.1',port:9000,path:'/peerjs',allow_discovery:false},()=>console.log('loopback-ready'));`);
  let serverReady = false;
  server = spawn(process.execPath, [path.join(serverPackages, "server.cjs")], { stdio: ["ignore", "pipe", "ignore"] });
  server.stdout.on("data", b => { if (String(b).includes("loopback-ready")) serverReady = true; });
  for (let i = 0; i < 100 && !serverReady && server.exitCode === null; i++) await pause(100);
  assert(serverReady, "loopback signaling server startup failed");
  const viteEnv = { ...process.env, VITE_PHASE_SANDBOX: "1", CARD_DATA_URL: "/qa-host-card-data.json", TELEMETRY_URL: "", SUPABASE_URL: "", SUPABASE_ANON_KEY: "",
    OFFICIAL_MULTIPLAYER_SERVER_URL: "ws://127.0.0.1:9/ws", DEFAULT_MULTIPLAYER_SERVER_URL: "ws://127.0.0.1:9/ws", TURN_CREDENTIALS_URL: "http://127.0.0.1:9/turn-credentials" };
  stage = "vite-dependency-preparation";
  // Complete the ordinary DEV prebundle before the real UI/consent lifecycle.
  const optimized = execFileSync(process.execPath, [path.join(client, "node_modules/vite/bin/vite.js"), "optimize", "--config", "vite.two-seat.config.ts", "--force"], {
    cwd: client, env: viteEnv, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
  });
  await writeFile(path.join(evidence, "two-seat-vite-dependency-preparation.log"), optimized);
  result.dependenciesPreparedBeforeUi = true;
  stage = "vite-start";
  vite = spawn(process.execPath, [path.join(client, "node_modules/vite/bin/vite.js"), "--config", "vite.two-seat.config.ts", "--host", "127.0.0.1", "--port", "5188", "--strictPort"], {
    cwd: client, env: viteEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [vite.stdout, vite.stderr]) stream.on("data", b => { viteLog = (viteLog + b).slice(-12000); });
  let ready = false;
  for (let i = 0; i < 300 && !ready && vite.exitCode === null; i++) {
    try { ready = (await fetch("http://127.0.0.1:5188/", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (!ready) await pause(100);
  }
  assert(ready, "Vite startup failed");
  stage = "chromium-start";
  const executable = "/usr/bin/google-chrome";
  result.browserVersion = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10000 }).stdout?.trim();
  const profile = await mkdtemp(path.join(process.env.RUNNER_TEMP, "undo-f-pair-chrome-"));
  chrome = spawn(executable, ["--headless", "--disable-gpu", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  chrome.stderr.on("data", b => { chromeErr = (chromeErr + b).slice(-12000); });
  let endpoint;
  for (let i = 0; i < 100 && !endpoint && chrome.exitCode === null; i++) {
    endpoint = chromeErr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/)?.[1];
    if (!endpoint) await pause(100);
  }
  assert(endpoint, "standard Chromium CDP unavailable");
  socket = new WebSocket(endpoint);
  socket.addEventListener("message", ({ data }) => {
    const m = JSON.parse(data), p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(Error("CDP command failed"), { qaCdpMethod: p.method, qaCdpErrorCode: m.error.code })); else p.resolve(m.result);
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  for (const role of ["host", "guest"]) {
    const context = await cdp("Target.createBrowserContext");
    const target = await cdp("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await cdp("Page.enable", {}, sessionId); await cdp("Network.enable", {}, sessionId);
    // Hermetic app HTTP resource policy. Actual PeerJS signaling uses loopback.
    await cdp("Network.setBlockedURLs", { urls: ["https://*", "wss://*"] }, sessionId);
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `sessionStorage.setItem('qa-seat',${JSON.stringify(role)});` }, sessionId);
    const evaluate = async expression => {
      const marked = `(()=>{window.__twoSeatQa?.markDriverStage(${JSON.stringify(stage)});return (${expression});})()`;
      const a = await cdp("Runtime.evaluate", { expression: marked, awaitPromise: true, returnByValue: true }, sessionId);
      assert(!a.exceptionDetails, "app operation failed"); return a.result.value;
    };
    const wait = async (expression, seconds = 30) => {
      // DOM readiness predicates stay inside the page. Serializing a React DOM
      // node by value traverses its cyclic fiber properties and fails in CDP.
      for (let i = 0; i < seconds * 10; i++) { if (await evaluate(`Boolean(${expression})`)) return; await pause(100); }
      throw Object.assign(Error("app stage deadline"), { qaDeadline: true });
    };
    const point = async (x, y, double = false) => {
      for (const clickCount of double ? [1, 2] : [1]) {
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount }, sessionId);
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount }, sessionId);
      }
    };
    const click = async expression => {
      const r = await evaluate(`(()=>{const n=${expression};if(!n||n.disabled)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
      assert(r, "app control not pointer-hittable"); await point(r.x, r.y);
    };
    const button = text => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
    const cropControl = async (expression, name) => {
      const clip = await evaluate(`(()=>{const n=${expression};if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()`);
      assert(clip && clip.width > 0 && clip.height > 0, "public control crop unavailable");
      const s = await cdp("Page.captureScreenshot", { format: "png", clip }, sessionId);
      await writeFile(path.join(evidence, name), Buffer.from(s.data, "base64"));
    };
    pages[role] = { evaluate, wait, click, point, button, cropControl, sessionId };
    await cdp("Page.navigate", { url: "http://127.0.0.1:5188/multiplayer" }, sessionId);
  }
  const { host, guest } = pages;
  stage = "full-app-startup";
  for (const page of [host, guest]) {
    await page.wait("window.__twoSeatQa && document.getElementById('root')?.childElementCount>0 && [...document.querySelectorAll('input[type=checkbox]')].some(n=>n.closest('label')?.textContent.includes('I agree that the host'))", 90);
  }
  result.stagesPassed.push("full-app-startup");
  stage = "app-direct-code-selection";
  for (const page of [host, guest]) {
    // The actual unreachable-lobby modal otherwise covers the consent input.
    await page.wait(`Boolean(${page.button("Use direct code")})`);
    await page.click(page.button("Use direct code"));
    await page.wait(`!(${page.button("Use direct code")})`);
  }
  result.stagesPassed.push("both-real-direct-code-choice");
  stage = "full-app-consent";
  for (const page of [host, guest]) {
    await page.wait("window.__twoSeatQa && [...document.querySelectorAll('input[type=checkbox]')].some(n=>n.closest('label')?.textContent.includes('I agree that the host'))", 90);
    const consent = "[...document.querySelectorAll('input[type=checkbox]')].find(n=>n.closest('label')?.textContent.includes('I agree that the host'))";
    assert(await page.evaluate(`!(${consent}).checked && !window.__twoSeatQa.status().agreed`), "consent not initially off");
    await page.click(consent); await page.wait("window.__twoSeatQa.status().agreed===true");
  }
  result.bothRealConsentChecked = true;
  result.stagesPassed.push("both-real-consent");
  stage = "host-open-form";
  await host.click(host.button("Host Game"));
  stage = "host-format-control";
  await host.wait("document.querySelector('button[aria-label=Format]')");
  await host.click("document.querySelector('button[aria-label=Format]')");
  stage = "host-format-selection";
  await host.wait("[...document.querySelectorAll('[role=option]')].some(n=>n.textContent.includes('Limited'))");
  await host.click("[...document.querySelectorAll('[role=option]')].find(n=>n.textContent.includes('Limited'))");
  stage = "host-p2p-selection";
  await host.click(host.button("You host (P2P)"));
  stage = "host-submit-room";
  result.hostSetupBeforeSubmit = await host.evaluate(setupControls);
  await host.wait(`(()=>{const b=${hostSubmit};return b&&b.textContent.trim()==='Host P2P Game'&&!b.disabled;})()`, 90);
  result.hostSetupAtSubmit = await host.evaluate(setupControls);
  await host.click(hostSubmit);
  result.stagesPassed.push("real-host-p2p-submit");
  stage = "host-continue-without-lobby";
  await host.wait(`Boolean(${host.button("Continue without lobby")})`);
  await host.click(host.button("Continue without lobby"));
  result.stagesPassed.push("real-host-without-lobby-choice");
  category = "communication"; stage = "loopback-signaling";
  await host.wait("window.__twoSeatQa.status().signalingOpened && window.__twoSeatQa.roomCode()", 45);
  const code = await host.evaluate("window.__twoSeatQa.roomCode()"); assert(/^[A-Z2-9]{5}$/.test(code), "actual direct room code unavailable");
  assert(!(await host.evaluate("window.__twoSeatQa.status().agreed")), "host consent was not consumed by original construction");
  result.hostConsentConsumedByConstruction = true;
  result.stagesPassed.push("real-host-loopback-signaling");
  category = "setup"; stage = "guest-direct-code-submit";
  await guest.click("document.querySelector('input[placeholder=" + JSON.stringify("Enter code or CODE@IP:PORT") + "]')");
  await cdp("Input.insertText", { text: code }, guest.sessionId);
  result.guestCodeInput = await guest.evaluate(`(()=>{const n=document.querySelector('input[placeholder="Enter code or CODE@IP:PORT"]');return {length:n?.value.length??0,matchesActualHostCode:n?.value===${JSON.stringify(code)}};})()`);
  assert(result.guestCodeInput.length === 5 && result.guestCodeInput.matchesActualHostCode, "guest real code input differs");
  await guest.wait(`(()=>{const b=${guest.button("Join")};return b&&!b.disabled;})()`);
  await guest.click(guest.button("Join"));
  // The original direct-code flow always opens MyDecks, even with an active
  // saved deck. Select the authorized own fixture through its real tile.
  stage = "guest-deck-selection";
  const guestDeck = "[...document.querySelectorAll('[role=button] p')].find(n=>n.textContent.trim()==='QA Guest')";
  await guest.wait(guestDeck);
  result.stagesPassed.push("real-guest-direct-code-submit");
  assert(await guest.evaluate("[...document.querySelectorAll('[role=button] p')].filter(n=>n.textContent.trim()==='QA Guest').length===1"), "guest fixture tile not unique");
  const beforeJoin = await guest.evaluate("window.__twoSeatQa.status()");
  assert(beforeJoin.agreed && !beforeJoin.signalingOpened, "guest consent not held before original join construction");
  await guest.click(guestDeck);
  result.stagesPassed.push("real-guest-deck-tile-choice");
  category = "communication"; stage = "guest-loopback-signaling";
  await guest.wait("window.__twoSeatQa.status().signalingOpened", 45);
  stage = "host-start-or-auto-start";
  // Auto-start is an existing host option. If off, use the actual host control.
  if (!(await host.evaluate("window.__twoSeatQa.status().ready"))) {
    const start = host.button("Start Game");
    await host.wait(`window.__twoSeatQa.status().ready || Boolean(${start})`);
    if (!(await host.evaluate("window.__twoSeatQa.status().ready"))) await host.click(start);
  }
  stage = "host-game-ready"; await host.wait("window.__twoSeatQa.status().ready", 90);
  stage = "guest-game-ready"; await guest.wait("window.__twoSeatQa.status().ready", 90);
  for (const [role, page] of Object.entries(pages)) {
    stage = role + "-native-channel-ready";
    await page.wait("window.__twoSeatQa.status().route==='game' && window.__twoSeatQa.status().nativeChannels");
    stage = role + "-full-control";
    const control = "[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Full Control Off')";
    await page.wait(`Boolean(${control})`);
    await page.click(control);
    await page.wait("window.__twoSeatQa.status().fullControl && window.__twoSeatQa.status().fullControlApplied");
    assert(!(await page.evaluate("window.__twoSeatQa.status().agreed")), "consent was not consumed");
  }
  assert((await host.evaluate("window.__twoSeatQa.status().seat")) === 0 && (await guest.evaluate("window.__twoSeatQa.status().seat")) === 1, "real seat assignment mismatch");
  result.realTwoSeatAppConnected = true;
  result.stagesPassed.push("real-two-seat-pairing");
  category = "setup"; stage = "ordinary-app-actions";
  let reached = false, steps = 0;
  for (; steps < 500; steps++) {
    const h = await host.evaluate("window.__twoSeatQa.step()");
    if (h === "ready-to-cast") { reached = true; break; }
    await guest.evaluate("window.__twoSeatQa.step()"); await pause(100);
  }
  assert(reached, "ordinary host cast not reached"); result.setupSteps = steps;
  assert(await host.evaluate("window.__twoSeatQa.prepareCast()"), "pre-floating semantic mana setup failed");
  result.stagesPassed.push("ordinary-app-actions");
  category = "product"; stage = "host-pointer-cast";
  const castPoint = await host.evaluate("window.__twoSeatQa.cardPoint()"); assert(castPoint, "Bears hand card pointer unavailable");
  await host.point(castPoint.x, castPoint.y, true);
  await host.wait("window.__twoSeatQa.status().stackCount===1", 30);
  assert(await host.evaluate("window.__twoSeatQa.recordCast()"), "real app cast snapshot missing");
  await guest.wait("window.__twoSeatQa.status().stackCount===1");
  const beforeRevision = await guest.evaluate("window.__twoSeatQa.status().lastStateRevision");
  result.stagesPassed.push("host-pointer-cast");
  const undo = host.button("Sandbox pre-cast Undo");
  await host.wait(`(()=>{const b=${undo};return b&&!b.disabled;})()`);
  await host.cropControl(undo, "host-armed-undo-control.png");
  stage = "host-pointer-undo";
  await host.click(undo);
  await host.wait("window.__twoSeatQa.restoreWitness()", 30);
  await guest.wait("window.__twoSeatQa.status().stackCount===0 && !window.__twoSeatQa.status().blocked", 30);
  await host.evaluate("window.__twoSeatQa.drainObservations()");
  await guest.evaluate("window.__twoSeatQa.drainObservations()");
  const h = await host.evaluate("window.__twoSeatQa.status()"), g = await guest.evaluate("window.__twoSeatQa.status()");
  assert(h.safeErrors.length === 0 && g.safeErrors.length === 0, "seat observation or transport errors present");
  assert(h.wire.filter(x => x.direction === "send" && x.type === "state_update").map(x => x.phase).join() === "adopted,released", "host phase ordering failed");
  assert(g.wire.filter(x => x.direction === "send" && x.type === "state_ack").map(x => x.phase).join() === "adopted,released", "guest exact ACK ordering failed");
  assert(h.wire.filter(x => x.direction === "receive" && x.type === "state_ack").map(x => x.phase).join() === "adopted,released"
    && g.wire.filter(x => x.direction === "receive" && x.type === "state_update").map(x => x.phase).join() === "adopted,released", "both phase deliveries were not observed");
  for (const phase of ["adopted", "released"]) {
    const hs = h.wire.find(x => x.direction === "send" && x.phase === phase);
    const hr = h.wire.find(x => x.direction === "receive" && x.phase === phase);
    const gs = g.wire.find(x => x.direction === "send" && x.phase === phase);
    const gr = g.wire.find(x => x.direction === "receive" && x.phase === phase);
    assert(hs.revision > beforeRevision && [hr, gs, gr].every(x => x.revision === hs.revision), "exact state revision ACK failed");
  }
  assert([...h.wire, ...g.wire].every(x => x.exactTransaction) && h.wire.filter(x => x.direction === "send").every(x => x.blocked) && g.wire.filter(x => x.direction === "send").every(x => x.blocked), "phase identity/input lock failed");
  assert(!h.blocked && !g.blocked && g.lastStateRevision > beforeRevision, "release/fresh P2P revision failed");
  assert(await host.evaluate("window.__twoSeatQa.publicState()") === await guest.evaluate("window.__twoSeatQa.publicState()"), "public board differs after restore");
  assert(g.privateProjectionChecks > 0 && g.privateProjectionOk && await guest.evaluate("window.__twoSeatQa.privacy()"), "guest projection privacy failed");
  result.restore = { host: h, guest: g, beforeRevision, publicBoardEqual: true, guestRedaction: true };
  result.stagesPassed.push("pointer-undo-exact-acks-restore-privacy");
  await host.cropControl(undo, "host-restored-undo-control.png");
  stage = "next-legal-pointer-cast";
  const nextPoint = await host.evaluate("window.__twoSeatQa.cardPoint()"); assert(nextPoint, "restored hand card pointer unavailable");
  await host.point(nextPoint.x, nextPoint.y, true);
  await host.wait("window.__twoSeatQa.status().stackCount===1"); await guest.wait("window.__twoSeatQa.status().stackCount===1");
  await host.evaluate("window.__twoSeatQa.drainObservations()");
  await guest.evaluate("window.__twoSeatQa.drainObservations()");
  const finalHost = await host.evaluate("window.__twoSeatQa.status()"), finalGuest = await guest.evaluate("window.__twoSeatQa.status()");
  assert(finalHost.safeErrors.length === 0 && finalGuest.safeErrors.length === 0, "seat observation or transport errors present before success");
  assert(!viteLog.includes("optimized dependencies changed. reloading"), "DEV dependency reload invalidated the UI lifecycle");
  result.stagesPassed.push("next-legal-pointer-cast");
  result.nextLegalCast = true; stage = "complete";
  result.lifecycleTimeline = { host: await host.evaluate("window.__twoSeatQa.lifecycleSnapshot()"), guest: await guest.evaluate("window.__twoSeatQa.lifecycleSnapshot()") };
  git("diff", "--exit-code");
  await markDriverTeardown();
  const closingHost = await host.evaluate("window.__twoSeatQa.status()"), closingGuest = await guest.evaluate("window.__twoSeatQa.status()");
  assert(closingHost.safeErrors.length === 0 && closingGuest.safeErrors.length === 0, "seat observation or transport errors present before driver teardown");
  result.pass = true;
  await cdp("Browser.close").catch(() => {});
} catch (cause) {
  result.pass = false; result.failureCategory = category;
  result.failure = cause instanceof assert.AssertionError ? cause.message : cause.qaDeadline ? "stage deadline" : "driver operation failed";
  if (cause.qaCdpMethod) result.cdpFailure = { method: cause.qaCdpMethod, code: cause.qaCdpErrorCode };
  result.lastObservation = {};
  result.lifecycleTimeline = {};
  for (const [role, page] of Object.entries(pages)) {
    try {
      await page.evaluate("window.__twoSeatQa?.drainObservations()");
      result.lastObservation[role] = await page.evaluate("window.__twoSeatQa?.status() ?? null");
      result.lifecycleTimeline[role] = await page.evaluate("window.__twoSeatQa?.lifecycleSnapshot() ?? null");
    } catch {}
  }
  result.publicUiChecks = {};
  for (const [role, page] of Object.entries(pages)) {
    try { result.publicUiChecks[role] = await page.evaluate(`(()=>{const c=[...document.querySelectorAll('input[type=checkbox]')].find(n=>n.closest('label')?.textContent.includes('I agree that the host'));return {rootMounted:Boolean(document.getElementById('root')?.childElementCount),consentRendered:Boolean(c),consentChecked:Boolean(c?.checked),directCodePrompt:[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Use direct code'),hostSetupRendered:Boolean(${hostForm}),joinInputRendered:Boolean(document.querySelector('input[placeholder="Enter code or CODE@IP:PORT"]')),guestFixtureTileRendered:[...document.querySelectorAll('[role=button] p')].some(n=>n.textContent.trim()==='QA Guest'),startGameRendered:[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Start Game')};})()`); } catch {}
  }
  result.publicFormChecks = {};
  for (const [role, page] of Object.entries(pages)) {
    try { result.publicFormChecks[role] = await page.evaluate(setupControls); } catch {}
  }
  const safeErrors = Object.values(result.lastObservation).flatMap(x => x?.safeErrors ?? []);
  if (safeErrors.some(x => ["wire-observer-failed", "lifecycle-observer-failed", "lifecycle-observer-overflow"].includes(x))) {
    result.failureCategory = "observation"; result.failureCode = "WIRE_OBSERVATION_INCOMPLETE";
  } else if (safeErrors.length > 0) {
    result.failureCategory = "communication"; result.failureCode = "REAL_TRANSPORT_ERROR";
  } else if (viteLog.includes('Failed to resolve import "@wasm/draft"')) {
    result.failureCode = "REAL_DRAFT_INPUT_MISSING";
  } else if (viteLog.includes("optimized dependencies changed. reloading")) {
    result.failureCategory = "setup"; result.failureCode = "DEV_DEPENDENCY_RELOAD";
  } else if (cause.message === "app control not pointer-hittable") {
    result.failureCategory = "setup"; result.failureCode = "APP_CONTROL_NOT_POINTER_HITTABLE";
  } else {
    result.failureCode = category.toUpperCase() + (cause.qaDeadline ? "_STAGE_DEADLINE" : "_ASSERTION_OR_DRIVER_FAILURE");
  }
  // Never serialize raw page exceptions, frames, hands, library, keys or receipts.
} finally {
  result.stage = stage; for (const p of pending.values()) clearTimeout(p.timer);
  await markDriverTeardown();
  socket?.close(); await stop(chrome); await stop(vite); await stop(server);
  await writeFile(path.join(evidence, "two-seat-ui-result.json"), JSON.stringify(result, null, 2) + "\n");
  await writeFile(path.join(evidence, "two-seat-vite.log"), viteLog);
  await writeFile(path.join(evidence, "two-seat-chromium.stderr.log"), chromeErr);
  console.log(JSON.stringify({ pass: result.pass, stage, category: result.failureCategory, failure: result.failure, frontendSha, engineSha }));
}
process.exitCode = result.pass ? 0 : 1;
