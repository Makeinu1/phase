// One finite normal-Worker browser campaign. Reuse verified existing WASM; no compiler.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const [candidateArg, payloadArg, evidenceArg] = process.argv.slice(2);
const candidate = path.resolve(candidateArg), payload = path.resolve(payloadArg), evidence = path.resolve(evidenceArg);
await mkdir(evidence, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const originalGlue = await readFile(path.join(payload, 'engine_wasm.js'));
assert.equal(digest(originalGlue), 'cc3e67a1e4cf930a9107826aa676ee9b36a16494c92887897ec881251cc0ea6a');
assert.equal(digest(await readFile(path.join(payload, 'engine_wasm_bg.wasm'))), '1861c7d90af448a1c98d17bcd42e9dc6ad41f317a05afe2ec1cc13e4de2e450f');
assert.match(originalGlue.toString(), /let wasm;/);
const observedGlue = originalGlue.toString() + '\n// QA numeric byte length only; no state/memory reads.\nglobalThis.__qaWasmBytes = () => wasm?.memory?.buffer.byteLength ?? 0;\n';
const runtime = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'history-adapter-runtime-'));
const client = path.join(runtime, 'client');
await cp(path.join(candidate, 'client'), client, { recursive: true, filter: p => !['node_modules', '.git', 'coverage', 'dist'].includes(path.basename(p)) });
await symlink(path.join(candidate, 'client/node_modules'), path.join(client, 'node_modules'), 'dir');
await cp(path.join(candidate, 'data-files.json'), path.join(runtime, 'data-files.json'));
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
await cp(path.join(scriptDir, 'undo-history-browser.mjs'), path.join(client, 'qa-history-adapter.mjs'));
await cp(path.join(scriptDir, 'undo-history-comparator.mjs'), path.join(client, 'qa-history-comparator.mjs'));
await mkdir(path.join(client, 'src/wasm'), { recursive: true });
await writeFile(path.join(client, 'src/wasm/engine_wasm.js'), observedGlue);
await cp(path.join(payload, 'engine_wasm_bg.wasm'), path.join(client, 'src/wasm/engine_wasm_bg.wasm'));
await mkdir(path.join(client, 'public'), { recursive: true });
const fixture = await readFile(path.join(candidate, 'scripts/fixtures/undo-history/official-history-cards-b0.json'));
assert.equal(digest(fixture), '1849fbe675e2e5acac2b32e6f96fd8d4e2d67a8c426138452d32cb0db4f494db');
await writeFile(path.join(client, 'public/qa-history-cards.json'), fixture);
process.env.CARD_DATA_URL = '/qa-history-cards.json'; process.env.ENGINE_WASM_URL = '';
process.env.TELEMETRY_URL = ''; process.env.SUPABASE_URL = ''; process.env.SUPABASE_ANON_KEY = '';
process.env.MULTIPLAYER_SERVER_URL = 'ws://127.0.0.1:9';
const { createServer } = await import(pathToFileURL(path.join(candidate, 'client/node_modules/vite/dist/node/index.js')));
const vite = await createServer({ root: client, configFile: path.join(client, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{ name: 'isolated-history-QA-entry', transformIndexHtml: () => '<!doctype html><title>isolated history QA</title><script type="module" src="/qa-history-adapter.mjs"></script>' }],
});
await vite.listen();
const executable = ['google-chrome', 'chromium', 'chromium-browser'].map(x => spawnSync('which', [x], { encoding: 'utf8' }).stdout?.trim()).find(Boolean);
assert(executable, 'installed Chromium required');
const profile = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'history-adapter-chrome-'));
const args = ['--headless', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
const chrome = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', socket, serial = 0, pageSession, targetWorker, failure;
const pending = new Map(), heaps = [];
chrome.stderr.on('data', b => { stderr = (stderr + b).slice(-6000); });
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
    assert(chrome.exitCode === null, 'Chromium launch exited; do not bypass sandbox');
    const port = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    const match = port.match(/^(\d+)\r?\n(\/devtools\/browser\/[A-Za-z0-9-]+)/); if (match) endpoint = `ws://127.0.0.1:${match[1]}${match[2]}`;
    if (!endpoint) await pause(100);
  }
  assert(endpoint, 'Chromium local CDP unavailable'); socket = new WebSocket(endpoint);
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data), request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); clearTimeout(request.timer); if (msg.error) request.reject(Error(msg.error.message)); else request.resolve(msg.result); }
    if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'worker' && msg.params.targetInfo.url.includes('engine-worker')) targetWorker = msg.params.sessionId;
    if (msg.method === 'Target.detachedFromTarget' && msg.params.sessionId === targetWorker) targetWorker = null;
  });
  await new Promise((yes, no) => { socket.addEventListener('open', yes, { once: true }); socket.addEventListener('error', no, { once: true }); });
  const version = await call('Browser.getVersion');
  const target = await call('Target.createTarget', { url: 'about:blank' });
  pageSession = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);
  await call('Page.navigate', { url: `http://127.0.0.1:${vite.httpServer.address().port}/` }, pageSession);
  let ready = false;
  for (let n = 0; n < 120 && !ready; n++) { ready = await evaluate('typeof globalThis.__qaStart === "function"'); if (!ready) await pause(250); }
  assert(ready, 'QA module failed to load (no fallback/stub)'); await evaluate('globalThis.__qaStart(); true');
  const started = performance.now(); let result, lastProgress;
  while (performance.now() - started < 230000) {
    const observed = await evaluate('({result:globalThis.__qaResult,heap:globalThis.__qaHeapStage,progress:globalThis.__qaProgress})');
    if (observed.progress && JSON.stringify(observed.progress) !== lastProgress) { lastProgress = JSON.stringify(observed.progress); await writeFile(path.join(evidence, 'browser-progress.json'), lastProgress + '\n'); }
    if (observed.heap) {
      const samples = [];
      for (let round = 1; round <= 3; round++) {
        await call('HeapProfiler.collectGarbage', {}, pageSession);
        if (targetWorker) await call('HeapProfiler.collectGarbage', {}, targetWorker);
        const mainHeap = await call('Runtime.getHeapUsage', {}, pageSession);
        const workerHeap = targetWorker ? await call('Runtime.getHeapUsage', {}, targetWorker) : null;
        const wasmMemoryBytes = targetWorker ? await evaluate('globalThis.__qaWasmBytes?.() ?? null', targetWorker) : null;
        samples.push({ round, mainHeap, workerHeap, wasmMemoryBytes });
      }
      heaps.push({ label: observed.heap, gc: 'CDP collectGarbage main+attached Worker; three rounds; no reclamation guarantee', samples });
      await writeFile(path.join(evidence, 'browser-heaps.json'), JSON.stringify({ heaps, peakChromeTreeRssBytes, nodeMemory: process.memoryUsage(), peakNodeRssBytes: process.resourceUsage().maxRSS * 1024 }, null, 2) + '\n');
      await evaluate('globalThis.__qaContinue(); true');
    }
    if (observed.result) { result = observed.result; break; }
    await pause(250);
  }
  assert(result, 'finite browser campaign deadline');
  await writeFile(path.join(evidence, 'browser-result.json'), JSON.stringify({ ...result, browser: version.product,
    sourceSha: 'e10955dc5977f1ba7c65cb1518cb8f4b1679fe92', candidateSha: process.env.GITHUB_SHA,
    bindingOriginalSha256: digest(originalGlue), bindingNumericObserverSha256: digest(observedGlue),
    fixtureSha256: digest(fixture), peakChromeTreeRssBytes, peakNodeRssBytes: process.resourceUsage().maxRSS * 1024,
    heapScope: 'single headless Chromium on Ubuntu; UTF8/main JS/Worker JS/WASM allocated region/process peak separated; not product limit or free guarantee',
    heaps,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ pass: result.pass, stage: result.stage, checks: result.checks, failure: result.failure }));
  assert(result.pass, 'real adapter campaign failed; preserve evidence'); await call('Browser.close').catch(() => {});
} catch (e) {
  failure = String(e); await writeFile(path.join(evidence, 'driver-failure.json'), JSON.stringify({ failure, stderr: stderr.slice(-3000) }, null, 2) + '\n'); throw e;
} finally {
  clearInterval(rssSampler); for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close(); await vite.close();
  if (chrome.exitCode === null) { chrome.kill('SIGTERM'); for (let n = 0; n < 50 && chrome.exitCode === null; n++) await pause(100); if (chrome.exitCode === null) chrome.kill('SIGKILL'); }
  await writeFile(path.join(evidence, 'runtime-provenance.json'), JSON.stringify({ candidateSha: process.env.GITHUB_SHA, executable, executablePath: await realpath(executable), args, runtimeIsolation: true, noRustBuild: true, sourceAndCandidateCheckoutsNotModified: true, failure, peakChromeTreeRssBytes }, null, 2) + '\n');
}
