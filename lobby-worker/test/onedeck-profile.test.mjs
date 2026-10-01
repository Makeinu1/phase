import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import { createOneDeckProfileHandler } from "../src/onedeck-profile.ts";

const allowedOrigin = "https://onedeck-play.pages.dev";
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = () => {
    throw new Error("Offline OneDeck profile tests must not make outbound requests");
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

function request(path, { method = "GET", upgrade, origin, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (upgrade !== undefined) requestHeaders.set("Upgrade", upgrade);
  if (origin !== undefined) requestHeaders.set("Origin", origin);
  return new Request(`https://worker.example${path}`, { method, headers: requestHeaders });
}

function makeHarness(options = {}) {
  const origins = Object.hasOwn(options, "origins") ? options.origins : allowedOrigin;
  const signalAvailable = options.signalAvailable ?? true;
  const sharedCalls = [];
  const namespaceCalls = { names: [], ids: [], gets: [], requests: [] };
  const idsByName = new Map();
  const sharedResponse = new Response("shared response");
  const signalResponse = new Response("signal response");
  const ctx = { marker: "execution context" };

  const namespace = {
    idFromName(name) {
      namespaceCalls.names.push(name);
      if (!idsByName.has(name)) idsByName.set(name, { name });
      return idsByName.get(name);
    },
    get(id) {
      namespaceCalls.gets.push(id);
      return {
        fetch(originalRequest) {
          namespaceCalls.requests.push(originalRequest);
          return Promise.resolve(signalResponse);
        },
      };
    },
  };
  const lobbyCalls = [];
  const env = {
    ALLOWED_ORIGINS: origins,
    SIGNAL: signalAvailable ? namespace : undefined,
    LOBBY: {
      idFromName(name) {
        lobbyCalls.push(["idFromName", name]);
        return name;
      },
      get(id) {
        lobbyCalls.push(["get", id]);
        return { fetch: (originalRequest) => Promise.resolve(originalRequest) };
      },
    },
  };
  const sharedFetch = async (...args) => {
    sharedCalls.push(args);
    return sharedResponse;
  };

  return {
    ctx,
    env,
    handler: createOneDeckProfileHandler(sharedFetch),
    lobbyCalls,
    namespaceCalls,
    sharedCalls,
    sharedResponse,
    signalResponse,
  };
}

test("health, lobby WebSocket, and TURN routes delegate the original request once", async () => {
  const cases = [
    request("/"),
    request("/ws?room=one", { upgrade: "WebSocket", origin: allowedOrigin }),
    request("/turn-credentials?source=onedeck", { origin: allowedOrigin }),
    request("/turn-credentials", { method: "OPTIONS", origin: allowedOrigin }),
  ];

  for (const originalRequest of cases) {
    const harness = makeHarness();
    const response = await harness.handler(originalRequest, harness.env, harness.ctx);
    assert.strictEqual(response, harness.sharedResponse);
    assert.equal(harness.sharedCalls.length, 1);
    assert.strictEqual(harness.sharedCalls[0][0], originalRequest);
    assert.strictEqual(harness.sharedCalls[0][1], harness.env);
    assert.strictEqual(harness.sharedCalls[0][2], harness.ctx);
    assert.deepEqual(harness.namespaceCalls.names, []);
    assert.deepEqual(harness.lobbyCalls, []);
  }
});

test("signal requests use only the host ID and preserve Request/Response identity", async () => {
  const harness = makeHarness();
  const requests = [
    request("/signal/host_01?peer=guest_01&role=host", { upgrade: "websocket", origin: allowedOrigin }),
    request("/signal/host_01?peer=guest_02&role=guest", { upgrade: "websocket", origin: allowedOrigin }),
    request("/signal/host_02?peer=guest_01&role=guest", { upgrade: "websocket", origin: allowedOrigin }),
    request("/signal/a?peer=guest_03&role=guest", { upgrade: "websocket", origin: allowedOrigin }),
    request(`/signal/${"z".repeat(128)}?peer=guest_04&role=guest`, { upgrade: "websocket", origin: allowedOrigin }),
  ];

  const responses = [];
  for (const originalRequest of requests) {
    responses.push(await harness.handler(originalRequest, harness.env, harness.ctx));
  }

  assert.ok(responses.every((response) => response === harness.signalResponse));
  assert.deepEqual(harness.namespaceCalls.names, ["host_01", "host_01", "host_02", "a", "z".repeat(128)]);
  assert.strictEqual(harness.namespaceCalls.gets[0], harness.namespaceCalls.gets[1]);
  assert.notStrictEqual(harness.namespaceCalls.gets[1], harness.namespaceCalls.gets[2]);
  assert.notStrictEqual(harness.namespaceCalls.gets[2], harness.namespaceCalls.gets[3]);
  assert.notStrictEqual(harness.namespaceCalls.gets[3], harness.namespaceCalls.gets[4]);
  assert.deepEqual(harness.namespaceCalls.requests, requests);
  assert.ok(harness.namespaceCalls.requests.every((seen, index) => seen === requests[index]));
  assert.equal(harness.sharedCalls.length, 0);
  assert.deepEqual(harness.lobbyCalls, []);
});

test("missing SIGNAL fails closed without delegating or touching a namespace", async () => {
  const harness = makeHarness({ signalAvailable: false });
  const response = await harness.handler(
    request("/signal/host_01", { upgrade: "websocket", origin: allowedOrigin }),
    harness.env,
    harness.ctx,
  );

  assert.equal(response.status, 503);
  assert.equal(harness.sharedCalls.length, 0);
  assert.deepEqual(harness.namespaceCalls.names, []);
  assert.deepEqual(harness.lobbyCalls, []);
});

test("invalid methods, paths, upgrades, IDs, and origins are rejected before dispatch", async () => {
  const rejected = [
    { request: request("/", { upgrade: "websocket", origin: allowedOrigin }) },
    { request: request("/", { method: "POST" }) },
    { request: request("/ws") },
    { request: request("/ws", { upgrade: "h2c", origin: allowedOrigin }) },
    { request: request("/ws", { method: "POST", upgrade: "websocket", origin: allowedOrigin }) },
    { request: request("/ws", { upgrade: "websocket" }) },
    { request: request("/ws", { upgrade: "websocket", origin: "null" }) },
    { request: request("/ws", { upgrade: "websocket", origin: "https://evil.example" }) },
    { request: request("/ws", { upgrade: "websocket", origin: `${allowedOrigin}/` }) },
    { request: request("/ws", { upgrade: "websocket", origin: allowedOrigin }), origins: undefined },
    { request: request("/ws", { upgrade: "websocket", origin: allowedOrigin }), origins: "" },
    { request: request("/ws", { upgrade: "websocket", origin: allowedOrigin }), origins: "*" },
    { request: request("/ws", { upgrade: "websocket", origin: allowedOrigin }), origins: `${allowedOrigin},*` },
    { request: request("/turn-credentials", { origin: undefined }) },
    { request: request("/turn-credentials", { origin: "null" }) },
    { request: request("/turn-credentials", { method: "OPTIONS", origin: "https://evil.example" }) },
    { request: request("/turn-credentials", { origin: allowedOrigin }), origins: "*" },
    { request: request("/turn-credentials", { origin: allowedOrigin }), origins: undefined },
    { request: request("/turn-credentials", { method: "POST", origin: allowedOrigin }) },
    { request: request("/turn-credentials", { upgrade: "websocket", origin: allowedOrigin }) },
    { request: request("/signal") },
    { request: request("/signal/") },
    { request: request("/signal/host/peer", { upgrade: "websocket", origin: allowedOrigin }) },
    { request: request(`/signal/${"a".repeat(129)}`, { upgrade: "websocket", origin: allowedOrigin }) },
    { request: request("/signal/host%2Fpeer", { upgrade: "websocket", origin: allowedOrigin }) },
    { request: request("/signal/%68ost", { upgrade: "websocket", origin: allowedOrigin }) },
    { request: request("/signal/invalid!", { upgrade: "websocket", origin: allowedOrigin }) },
    { request: request("/signal/é", { upgrade: "websocket", origin: allowedOrigin }) },
    { request: request("/signal/host_01", { upgrade: "websocket" }) },
    { request: request("/signal/host_01", { method: "POST", upgrade: "websocket", origin: allowedOrigin }) },
    ...[
      "/import-deck",
      "/telemetry",
      "/servers",
      "/servers/announce",
      "/servers/metrics",
      "/stats",
      "/signaling/host_01",
      "/unknown",
    ].map((path) => ({ request: request(path) })),
  ];

  for (const item of rejected) {
    const harness = makeHarness({ origins: item.origins });
    const response = await harness.handler(item.request, harness.env, harness.ctx);
    assert.equal(response.status, 404, item.request.url);
    assert.equal(harness.sharedCalls.length, 0, item.request.url);
    assert.deepEqual(harness.namespaceCalls.names, [], item.request.url);
    assert.deepEqual(harness.lobbyCalls, [], item.request.url);
  }
});

test("the isolated Wrangler profile preserves build inputs and local binding/migration boundaries", async () => {
  const config = await readFile(new URL("../wrangler.onedeck.toml", import.meta.url), "utf8");
  const wrapper = await readFile(new URL("../src/onedeck.ts", import.meta.url), "utf8");

  assert.match(config, /^name = "onedeck-lobby"$/m);
  assert.match(config, /^main = "src\/onedeck\.ts"$/m);
  assert.match(config, /^compatibility_date = "2026-05-01"$/m);

  const build = config.match(/^\[build\]\ncommand = "([^"]+)"\nwatch_dir = \[([\s\S]*?)^\]/m);
  assert.ok(build, "isolated config must keep its broker-WASM build/watch inputs");
  assert.equal(build[1], "bash ../scripts/build-broker-wasm.sh release");
  const watchInputs = [...build[2].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  for (const required of [
    "broker-wasm/src",
    "broker-wasm/Cargo.toml",
    "broker-wasm/Cargo.lock",
    "broker-wasm/.cargo/config.toml",
    "../crates/lobby-broker/src",
    "../crates/lobby-broker/Cargo.toml",
    "../crates/engine/src",
    "../crates/engine/Cargo.toml",
    "../Cargo.toml",
    "../.cargo/config.toml",
    "../scripts/build-broker-wasm.sh",
  ]) {
    assert.ok(watchInputs.includes(required), `missing WASM watch input ${required}`);
  }

  const bindings = [...config.matchAll(/^\[\[durable_objects\.bindings\]\]\nname = "([^"]+)"\nclass_name = "([^"]+)"$/gm)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(bindings, [["LOBBY", "LobbyDO"], ["SIGNAL", "SignalDO"]]);

  const migrations = [...config.matchAll(/^\[\[migrations\]\]\ntag = "([^"]+)"\nnew_sqlite_classes = \["([^"]+)"\]$/gm)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(migrations, [["onedeck-v1", "LobbyDO"], ["onedeck-v2", "SignalDO"]]);

  assert.match(config, /^name = "TURN_LIMIT"\nnamespace_id = "1007"\nsimple = \{ limit = 30, period = 60 \}$/m);
  assert.match(config, /^TURN_TTL_SECONDS = "86400"$/m);
  assert.match(config, /^ALLOWED_ORIGINS = "https:\/\/onedeck-play\.pages\.dev"$/m);
  assert.match(config, /account-wide uniqueness remains a deployment-review check\./);
  assert.match(config, /Origin filtering narrows exposure only; it is not\n# authentication or a cost cap\./);
  assert.match(config, /TTL is preparation for the shared TURN handler, not a validated credential\n# lifetime or spend control\./);
  assert.doesNotMatch(config, /^\s*\[\[(?:routes|services|analytics_engine_datasets|kv_namespaces)\]\]/m);
  assert.doesNotMatch(config, /^\s*namespace_id = "(?:1005|1006)"$/m);
  assert.doesNotMatch(config, /^\s*(?:account_id|TURN_KEY_ID|TURN_KEY_API_TOKEN|api_token)\s*=/im);
  assert.doesNotMatch(config, /^\s*(?:script_name|service)\s*=/im);

  assert.match(wrapper, /type SharedEnv = Parameters<typeof handler\.fetch>\[1\];/);
  assert.match(wrapper, /export \{ LobbyDO \};/);
  assert.match(wrapper, /export \{ SignalDO \};/);
  assert.match(wrapper, /handler\.fetch\(request, env, ctx\)/);
  assert.doesNotMatch(wrapper, /type Env\s*\}\s*from "\.\/index"/);
});
