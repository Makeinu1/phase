/**
 * The isolated OneDeck HTTP surface. Keep admission and routing here so the
 * profile can be exercised without importing the shared Worker or its WASM.
 */

type SignalNamespace = Pick<DurableObjectNamespace, "idFromName" | "get">;

export interface OneDeckProfileEnv {
  ALLOWED_ORIGINS?: string;
  SIGNAL?: SignalNamespace;
}

export type SharedFetch<Env extends OneDeckProfileEnv> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

type Route = { kind: "shared" } | { kind: "signal"; hostPeerId: string };

const SIGNAL_PATH = /^\/signal\/([A-Za-z0-9_-]{1,128})$/;

function hasUpgradeAttempt(request: Request): boolean {
  if (request.headers.has("Upgrade")) return true;
  return (request.headers.get("Connection") ?? "")
    .split(",")
    .some((value) => value.trim().toLowerCase() === "upgrade");
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.trim().toLowerCase() === "websocket";
}

function hasAllowedOrigin(request: Request, configuredOrigins: string | undefined): boolean {
  if (typeof configuredOrigins !== "string" || configuredOrigins.trim() === "") return false;

  const origins = configuredOrigins.split(",").map((origin) => origin.trim());
  if (origins.some((origin) => origin === "" || origin.includes("*"))) return false;

  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin === null || requestOrigin === "" || requestOrigin === "null") return false;

  // Match the serialized Origin exactly. This is browser exposure filtering,
  // not authentication or a cost cap.
  return origins.includes(requestOrigin);
}

function admittedRoute(request: Request, configuredOrigins: string | undefined): Route | null {
  const { pathname } = new URL(request.url);

  if (pathname === "/" && request.method === "GET" && !hasUpgradeAttempt(request)) {
    return { kind: "shared" };
  }

  if (
    pathname === "/ws"
    && request.method === "GET"
    && isWebSocketUpgrade(request)
    && hasAllowedOrigin(request, configuredOrigins)
  ) {
    return { kind: "shared" };
  }

  if (pathname === "/turn-credentials" && (request.method === "GET" || request.method === "OPTIONS")) {
    if (!hasUpgradeAttempt(request) && hasAllowedOrigin(request, configuredOrigins)) {
      return { kind: "shared" };
    }
  }

  if (request.method === "GET" && isWebSocketUpgrade(request) && hasAllowedOrigin(request, configuredOrigins)) {
    const match = SIGNAL_PATH.exec(pathname);
    if (match) return { kind: "signal", hostPeerId: match[1] };
  }

  return null;
}

/** Wrap the shared Worker fetch once behind the isolated OneDeck allowlist. */
export function createOneDeckProfileHandler<Env extends OneDeckProfileEnv>(
  sharedFetch: SharedFetch<Env>,
): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> {
  return async (request, env, ctx) => {
    const route = admittedRoute(request, env.ALLOWED_ORIGINS);
    if (route === null) return new Response("Not found", { status: 404 });

    if (route.kind === "signal") {
      const signal = env.SIGNAL;
      if (!signal) return new Response("Signal service unavailable", { status: 503 });

      const id = signal.idFromName(route.hostPeerId);
      return signal.get(id).fetch(request);
    }

    return sharedFetch(request, env, ctx);
  };
}
