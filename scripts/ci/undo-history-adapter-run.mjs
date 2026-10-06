// One finite normal-Worker browser campaign. Reuse verified existing WASM; no compiler.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { wasmMemoryRegions } from './undo-history-memory-cdp.mjs';

const [candidateArg, payloadArg, evidenceArg, mode] = process.argv.slice(2);
assert([undefined, '--selfcheck-only', '--browser-selfcheck-only', '--module-selfcheck-only'].includes(mode), 'unknown consumer mode');
const inputOnly = mode === '--selfcheck-only', browserOnly = mode === '--browser-selfcheck-only';
const moduleOnly = mode === '--module-selfcheck-only';
const localUi = process.env.F_LOCAL_UI === '1';
const candidate = path.resolve(candidateArg), payload = path.resolve(payloadArg), evidence = path.resolve(evidenceArg);
await mkdir(evidence, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let originalGlue, draftGlue, draftPayload, fixture;
const publicMethods = ['default', 'ping', 'initialize_game', 'load_card_database', 'submit_action', 'submit_interaction_js', 'export_game_state_json', 'restore_game_state', 'get_game_state', 'get_legal_actions_js'];
try {
  originalGlue = await readFile(path.join(payload, 'engine_wasm.js'));
  assert.equal(digest(originalGlue), 'cc3e67a1e4cf930a9107826aa676ee9b36a16494c92887897ec881251cc0ea6a');
  assert.equal(digest(await readFile(path.join(payload, 'engine_wasm_bg.wasm'))), '1861c7d90af448a1c98d17bcd42e9dc6ad41f317a05afe2ec1cc13e4de2e450f');
  const bindingModule = await import(pathToFileURL(path.join(payload, 'engine_wasm.js')));
  assert.ok(publicMethods.every(name => typeof bindingModule[name] === 'function'), 'verified binding public exports required by normal Worker');
  assert(process.env.F_DRAFT_PAYLOAD, 'verified same-source draft payload path required');
  draftPayload = path.resolve(process.env.F_DRAFT_PAYLOAD);
  draftGlue = await readFile(path.join(draftPayload, 'draft_wasm.js'));
  assert.equal(digest(draftGlue), '180692f1fea0ee3597f122101ce5fb20bac07030f38b4a7fbb0b3b3343c45181');
  assert.equal(digest(await readFile(path.join(draftPayload, 'draft_wasm_bg.wasm'))), '4ff0a533873042d3285147ff88800cb452b03ff69038e3b956aaf9f210367d63');
  const draftModule = await import(pathToFileURL(path.join(draftPayload, 'draft_wasm.js')));
  assert.equal(typeof draftModule.default, 'function', 'original draft binding initializer export');
  fixture = await readFile(path.join(candidate, 'scripts/fixtures/undo-history/official-history-cards-b0.json'));
  assert.equal(digest(fixture), '1849fbe675e2e5acac2b32e6f96fd8d4e2d67a8c426138452d32cb0db4f494db');
  await writeFile(path.join(evidence, 'input-public-exports.json'), JSON.stringify({ pass: true, candidateSha: process.env.GITHUB_SHA,
    bindingSha256: digest(originalGlue), draftBindingSha256: digest(draftGlue),
    draftWasmSha256: '4ff0a533873042d3285147ff88800cb452b03ff69038e3b956aaf9f210367d63', fixtureSha256: digest(fixture), publicMethods,
    inspectedWithoutInstantiation: true, bindingUnmodified: true }, null, 2) + '\n');
} catch (error) {
  await writeFile(path.join(evidence, 'input-public-exports.json'), JSON.stringify({ pass: false, stage: 'input-public-exports',
    candidateSha: process.env.GITHUB_SHA, failure: String(error).slice(0, 240), engineInstantiated: false }, null, 2) + '\n');
  throw error;
}
if (inputOnly) { console.log(JSON.stringify({ pass: true, stage: 'input-public-exports', noWasmInstantiation: true })); process.exit(0); }
let vite;
if (!browserOnly) {
const runtime = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'history-adapter-runtime-'));
const client = path.join(runtime, 'client');
await cp(path.join(candidate, 'client'), client, { recursive: true, filter: p => !['node_modules', '.git', 'coverage', 'dist'].includes(path.basename(p)) });
await symlink(path.join(candidate, 'client/node_modules'), path.join(client, 'node_modules'), 'dir');
await cp(path.join(candidate, 'data-files.json'), path.join(runtime, 'data-files.json'));
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
await cp(path.join(scriptDir, localUi ? 'undo-history-local-ui.mjs' : 'undo-history-browser.mjs'), path.join(client, 'qa-history-adapter.mjs'));
await cp(path.join(scriptDir, 'undo-history-comparator.mjs'), path.join(client, 'qa-history-comparator.mjs'));
await mkdir(path.join(client, 'src/wasm'), { recursive: true });
await writeFile(path.join(client, 'src/wasm/engine_wasm.js'), originalGlue);
await cp(path.join(payload, 'engine_wasm_bg.wasm'), path.join(client, 'src/wasm/engine_wasm_bg.wasm'));
await writeFile(path.join(client, 'src/wasm/draft_wasm.js'), draftGlue);
await cp(path.join(draftPayload, 'draft_wasm_bg.wasm'), path.join(client, 'src/wasm/draft_wasm_bg.wasm'));
await mkdir(path.join(client, 'public'), { recursive: true });
await writeFile(path.join(client, 'public/qa-history-cards.json'), fixture);
process.env.CARD_DATA_URL = '/qa-history-cards.json'; process.env.ENGINE_WASM_URL = '';
process.env.TELEMETRY_URL = ''; process.env.SUPABASE_URL = ''; process.env.SUPABASE_ANON_KEY = '';
process.env.MULTIPLAYER_SERVER_URL = 'ws://127.0.0.1:9';
if (localUi) process.env.VITE_PHASE_LOCAL_HISTORY = '1';
const { createServer } = await import(pathToFileURL(path.join(candidate, 'client/node_modules/vite/dist/node/index.js')));
vite = await createServer({ root: client, configFile: path.join(client, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{ name: 'isolated-history-QA-entry', transformIndexHtml: { order: 'pre', handler: () => '<!doctype html><title>isolated history QA</title><script type="module" src="/qa-history-adapter.mjs"></script>' } }],
});
await vite.listen();
}
const executable = ['google-chrome', 'chromium', 'chromium-browser'].map(x => spawnSync('which', [x], { encoding: 'utf8' }).stdout?.trim()).find(Boolean);
if (!executable) {
  await writeFile(path.join(evidence, 'browser-selfcheck.json'), JSON.stringify({ pass: false,
    stage: 'browser-executable', candidateSha: process.env.GITHUB_SHA, failure: 'installed Chromium required', phaseEngineStarted: false }, null, 2) + '\n');
  assert.fail('installed Chromium required');
}
const profile = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'history-adapter-chrome-'));
const args = ['--headless', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
const chrome = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', socket, serial = 0, pageSession, targetWorker, failure, spawnError, stage = 'browser-startup';
let moduleDiagnosticsActive = false, bootstrapEngineWorkerSeen = false;
const pending = new Map(), heaps = [], moduleErrors = [];
chrome.stderr.on('data', b => { stderr = (stderr + b).slice(-6000); });
chrome.on('error', error => { spawnError = String(error); });
function call(method, params = {}, sessionId, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(expression, sessionId = pageSession) {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, 20000);
  assert(!response.exceptionDetails, 'QA evaluation threw'); return response.result.value;
}
let peakChromeTreeRssBytes = 0;
const rssSampler = setInterval(() => {
  const rows = spawnSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 2000 }).stdout?.trim().split('\n').map(x => x.trim().split(/\s+/).map(Number)) ?? [];
  const owned = new Set([chrome.pid]); let changed = true;
  while (changed) { changed = false; for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; } }
  peakChromeTreeRssBytes = Math.max(peakChromeTreeRssBytes, rows.reduce((sum, [pid, , rss]) => sum + (owned.has(pid) ? rss * 1024 : 0), 0));
}, 1000);
try {
  let endpoint;
  for (let n = 0; n < 100 && !endpoint; n++) {
    assert(!spawnError && chrome.exitCode === null && chrome.signalCode === null, 'Chromium launch exited; do not bypass sandbox');
    const port = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    const match = port.match(/^(\d+)\r?\n(\/devtools\/browser\/[A-Za-z0-9-]+)/); if (match) endpoint = `ws://127.0.0.1:${match[1]}${match[2]}`;
    if (!endpoint) await pause(100);
  }
  assert(endpoint, 'Chromium local CDP unavailable'); socket = new WebSocket(endpoint);
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data), request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); clearTimeout(request.timer); if (msg.error) request.reject(Error(msg.error.message)); else request.resolve(msg.result); }
    if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'worker' && msg.params.targetInfo.url.includes('engine-worker')) {
      targetWorker = msg.params.sessionId;
      if (moduleDiagnosticsActive) bootstrapEngineWorkerSeen = true;
    }
    if (msg.method === 'Target.detachedFromTarget' && msg.params.sessionId === targetWorker) targetWorker = null;
    if (moduleDiagnosticsActive && msg.sessionId === pageSession && msg.method === 'Runtime.exceptionThrown') moduleErrors.push({ type: 'exception', message: String(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 300) });
    if (moduleDiagnosticsActive && msg.sessionId === pageSession && msg.method === 'Network.loadingFailed' && ['Script', 'Document'].includes(msg.params.type)) moduleErrors.push({ type: 'network', message: String(msg.params.errorText).slice(0, 200) });
    if (moduleDiagnosticsActive && msg.sessionId === pageSession && msg.method === 'Network.responseReceived' && ['Script', 'Document'].includes(msg.params.type) && msg.params.response.status >= 400) {
      const url = new URL(msg.params.response.url);
      if (url.hostname === '127.0.0.1') moduleErrors.push({ type: 'http', path: url.pathname, status: msg.params.response.status });
    }
    if (moduleErrors.length > 20) moduleErrors.shift();
  });
  await new Promise((yes, no) => { socket.addEventListener('open', yes, { once: true }); socket.addEventListener('error', no, { once: true }); });
  stage = 'browser-CDP-capability';
  const version = await call('Browser.getVersion');
  const target = await call('Target.createTarget', { url: 'about:blank' });
  pageSession = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  if (localUi) await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
  assert(!args.some(x => /no-sandbox|disable.*sandbox/.test(x)), 'browser sandbox must stay enabled');
  let listedRegions;
  await evaluate('globalThis.__qaSyntheticMemory = new WebAssembly.Memory({ initial: 1 }); true');
  try {
    listedRegions = await wasmMemoryRegions(call, pageSession);
    assert(listedRegions.regionBytes.includes(65536), 'synthetic one-page Memory must be enumerated');
  } finally {
    await evaluate('delete globalThis.__qaSyntheticMemory').catch(() => {});
  }
  await call('HeapProfiler.collectGarbage', {}, pageSession);
  const mainHeap = await call('Runtime.getHeapUsage', {}, pageSession);
  await writeFile(path.join(evidence, 'browser-selfcheck.json'), JSON.stringify({ pass: true,
    candidateSha: process.env.GITHUB_SHA, browser: version.product, executable, args,
    sandboxDisableFlags: false, phaseEngineStarted: false,
    syntheticMemoryCheck: { pages: 1, expectedBytes: 65536, referenceDeletionAttempted: true }, listedRegions, mainHeap }, null, 2) + '\n');
  if (!browserOnly) {
  stage = 'QA-module-load';
  moduleDiagnosticsActive = true;
  await call('Runtime.enable', {}, pageSession);
  await call('Network.enable', {}, pageSession);
  await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);
  await call('Page.navigate', { url: `http://127.0.0.1:${vite.httpServer.address().port}/` }, pageSession);
  let ready = false;
  for (let n = 0; n < 120 && !ready; n++) { ready = await evaluate('typeof globalThis.__qaStart === "function"'); if (!ready) await pause(250); }
  const devRuntimeDefines = await evaluate('({telemetryDisabled: typeof __TELEMETRY_URL__ !== "undefined" && __TELEMETRY_URL__ === "", cardFixture: typeof __CARD_DATA_URL__ !== "undefined" && __CARD_DATA_URL__ === "/qa-history-cards.json"})');
  moduleDiagnosticsActive = false;
  const modulePass = ready && moduleErrors.length === 0 && !bootstrapEngineWorkerSeen && devRuntimeDefines.telemetryDisabled && devRuntimeDefines.cardFixture;
  await writeFile(path.join(evidence, 'qa-module-selfcheck.json'), JSON.stringify({ pass: modulePass,
    candidateSha: process.env.GITHUB_SHA, mode, ready, moduleErrors, devRuntimeDefines, phaseEngineStarted: bootstrapEngineWorkerSeen ? 'unknown' : false,
    engineWorkerEverAttached: bootstrapEngineWorkerSeen, draftBindingUnmodified: true, draftBindingSha256: digest(draftGlue) }, null, 2) + '\n');
  assert(modulePass, 'QA module dependency selfcheck failed before campaign');
  if (moduleOnly) console.log(JSON.stringify({ pass: true, stage, phaseEngineStarted: false }));
  else {
  await evaluate('globalThis.__qaStart(); true');
  stage = 'actual-adapter-campaign';
  const started = performance.now(); let result, lastProgress;
  while (performance.now() - started < 230000) {
    const observed = await evaluate('({result:globalThis.__qaResult,heap:globalThis.__qaHeapStage,progress:globalThis.__qaProgress,ui:globalThis.__qaUiRequest})');
    if (observed.progress && JSON.stringify(observed.progress) !== lastProgress) { lastProgress = JSON.stringify(observed.progress); await writeFile(path.join(evidence, 'browser-progress.json'), lastProgress + '\n'); }
    if (observed.ui) {
      const { selector, double, screenshot } = observed.ui;
      const point = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) return null;
        element.scrollIntoView({block:'nearest'}); const r = element.getBoundingClientRect();
        for (const fx of [.5,.2,.8,.1,.9]) for (const fy of [.5,.2,.8,.1,.9]) {
          const x=r.left+r.width*fx,y=r.top+r.height*fy,hit=document.elementFromPoint(x,y);
          if (hit && (hit === element || element.contains(hit))) return {x,y};
        } return null;
      })()`);
      assert(point, 'existing enabled visible product control is clickable');
      if (screenshot) {
        assert(/^[a-z-]+$/.test(screenshot), 'fixed screenshot basename');
        const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, pageSession);
        await writeFile(path.join(evidence, `${screenshot}.png`), Buffer.from(capture.data, 'base64'));
      }
      await call('Input.dispatchMouseEvent', {type:'mouseMoved',...point}, pageSession);
      for (let count=1; count <= (double ? 2 : 1); count++) {
        await call('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',clickCount:count}, pageSession);
        await call('Input.dispatchMouseEvent', {type:'mouseReleased',...point,button:'left',clickCount:count}, pageSession);
      }
      await evaluate('globalThis.__qaUiRequest=null;globalThis.__qaUiClicked();true');
    }
    if (observed.heap) {
      const samples = [];
      for (let round = 1; round <= 3; round++) {
        await call('HeapProfiler.collectGarbage', {}, pageSession);
        if (targetWorker) await call('HeapProfiler.collectGarbage', {}, targetWorker);
        const mainHeap = await call('Runtime.getHeapUsage', {}, pageSession);
        const workerHeap = targetWorker ? await call('Runtime.getHeapUsage', {}, targetWorker) : null;
        const wasmAllocatedRegions = targetWorker ? await wasmMemoryRegions(call, targetWorker) : null;
        samples.push({ round, mainHeap, workerHeap, wasmAllocatedRegions });
      }
      heaps.push({ label: observed.heap, gc: 'CDP collectGarbage main+attached Worker; three rounds; no reclamation guarantee', samples });
      await writeFile(path.join(evidence, 'browser-heaps.json'), JSON.stringify({ heaps, peakChromeTreeRssBytes, nodeMemory: process.memoryUsage(), peakNodeRssBytes: process.resourceUsage().maxRSS * 1024 }, null, 2) + '\n');
      await evaluate('globalThis.__qaContinue(); true');
    }
    if (observed.result) { result = observed.result; break; }
    await pause(250);
  }
  assert(result, 'finite browser campaign deadline');
  if (localUi && !result.pass) {
    const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, pageSession);
    await writeFile(path.join(evidence, 'failure.png'), Buffer.from(capture.data, 'base64'));
  }
  await writeFile(path.join(evidence, 'browser-result.json'), JSON.stringify({ ...result, browser: version.product,
    sourceSha: 'e10955dc5977f1ba7c65cb1518cb8f4b1679fe92', candidateSha: process.env.GITHUB_SHA,
    bindingOriginalSha256: digest(originalGlue), bindingRuntimeSha256: digest(originalGlue), bindingUnmodified: true, publicMethods,
    draftBindingSha256: digest(draftGlue), draftBindingUnmodified: true,
    fixtureSha256: digest(fixture), peakChromeTreeRssBytes, peakNodeRssBytes: process.resourceUsage().maxRSS * 1024,
    localUi,
    heapScope: localUi ? 'No retained-heap campaign; process RSS sampled only' : 'single headless Chromium on Ubuntu; UTF8/main JS/Worker JS/WASM allocated region/process peak separated; not product limit or free guarantee',
    heaps,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ pass: result.pass, stage: result.stage, checks: result.checks, failure: result.failure }));
  assert(result.pass, 'real adapter campaign failed; preserve evidence');
  }
  } else console.log(JSON.stringify({ pass: true, stage: 'browser-CDP-capability', phaseEngineStarted: false }));
  await call('Browser.close').catch(() => {});
} catch (e) {
  failure = String(e);
  if (stage === 'browser-startup' || stage === 'browser-CDP-capability') {
    await writeFile(path.join(evidence, 'browser-selfcheck.json'), JSON.stringify({ pass: false,
      candidateSha: process.env.GITHUB_SHA, stage, failure, phaseEngineStarted: false, sandboxDisableFlags: false }, null, 2) + '\n');
  }
  await writeFile(path.join(evidence, 'driver-failure.json'), JSON.stringify({ failure, stage, spawnError, mode, moduleErrors, stderr: stderr.slice(-3000) }, null, 2) + '\n'); throw e;
} finally {
  clearInterval(rssSampler); for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close(); await vite?.close();
  if (chrome.exitCode === null) { chrome.kill('SIGTERM'); for (let n = 0; n < 50 && chrome.exitCode === null; n++) await pause(100); if (chrome.exitCode === null) chrome.kill('SIGKILL'); }
  await writeFile(path.join(evidence, 'runtime-provenance.json'), JSON.stringify({ candidateSha: process.env.GITHUB_SHA, executable, executablePath: await realpath(executable), args, mode, stage, runtimeIsolation: true, noRustBuild: true, sourceAndCandidateCheckoutsNotModified: true, failure, peakChromeTreeRssBytes }, null, 2) + '\n');
}
