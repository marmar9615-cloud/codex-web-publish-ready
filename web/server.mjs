// Codex Web — JSON-RPC bridge to the Rust `codex app-server`.
//
// The gateway is a transparent JSON-RPC 2.0 proxy. Every WebSocket frame is a
// canonical app-server-protocol message; the gateway only adds HTTP helpers for
// session bookkeeping, auth, uploads, and workdir file serving.

import express from "express";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.PORT ?? "5000", 10);
const HOST = "0.0.0.0";
const PUBLIC_DIR = join(__dirname, "public");
const WORKDIR_ROOT = resolve(
  process.env.CODEX_WEB_WORKDIR_ROOT ?? join(__dirname, ".workdirs"),
);
const CODEX_BIN = process.env.CODEX_BIN ?? "";
const IS_PROD = process.env.NODE_ENV === "production";

const CHATGPT_ISSUER = (
  process.env.CODEX_CHATGPT_ISSUER ?? "https://auth.openai.com"
).replace(/\/+$/, "");
const CHATGPT_CLIENT_ID =
  process.env.CODEX_CHATGPT_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_ACCOUNTS_API = `${CHATGPT_ISSUER}/api/accounts`;
const CHATGPT_DEVICE_REDIRECT_URI = `${CHATGPT_ISSUER}/deviceauth/callback`;

mkdirSync(WORKDIR_ROOT, { recursive: true });

// -------- session store (in-memory) --------
// session: {
//   id, apiKey?, oauth?, createdAt, lastSeenAt, workdir,
//   threads: Map<threadId, { id, name, preview, status, archived, lastActive }>,
//   activeThreadId?,
//   backend?: { child, buf, outFrames, stderrTail, attachedWs, idleTimer },
// }
const sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX = 1000;

setInterval(
  () => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - (s.lastSeenAt ?? s.createdAt) > SESSION_TTL_MS)
        sessions.delete(id);
    }
    if (sessions.size > SESSION_MAX) {
      const sorted = [...sessions.entries()].sort(
        (a, b) => (a[1].lastSeenAt ?? 0) - (b[1].lastSeenAt ?? 0),
      );
      while (sessions.size > SESSION_MAX) sessions.delete(sorted.shift()[0]);
    }
  },
  60 * 60 * 1000,
).unref();

function touchSession(s) {
  if (s) s.lastSeenAt = Date.now();
}

function makeSession(id) {
  const workdir = join(WORKDIR_ROOT, id);
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(workdir, ".uploads"), { recursive: true });
  return {
    id,
    apiKey: undefined,
    oauth: undefined,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    workdir,
    threads: new Map(),
    activeThreadId: undefined,
    backend: null,
  };
}

const REPLAY_RING_SIZE = 500;
const BACKEND_IDLE_MS = 5 * 60 * 1000;
const STDERR_TAIL_BYTES = 1024;
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const PREVIEW_URL_TTL_SECONDS = 15 * 60;
const FILE_SIGNING_SECRET =
  process.env.CODEX_WEB_FILE_SIGNING_SECRET ?? randomBytes(32).toString("hex");

function isSecureRequest(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (
    typeof forwardedProto === "string" &&
    forwardedProto.split(",")[0].trim() === "https"
  )
    return true;
  return Boolean(req.socket && req.socket.encrypted);
}

function getOrCreateSession(req, res) {
  let id = req.cookies?.codexsid;
  if (id && sessions.has(id)) {
    const existing = sessions.get(id);
    touchSession(existing);
    return existing;
  }
  id = randomUUID();
  const session = makeSession(id);
  sessions.set(id, session);
  res.cookie("codexsid", id, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req) || IS_PROD,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return session;
}

function getSessionFromCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = /(?:^|;\s*)codexsid=([^;]+)/.exec(cookieHeader);
  if (!match) return null;
  const session = sessions.get(match[1]) ?? null;
  touchSession(session);
  return session;
}

function sameOriginOnly(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const url = new URL(origin);
    if (url.host === req.headers.host) return next();
  } catch {}
  res.status(403).json({ error: "cross-origin request rejected" });
}

function hasRealBackendConfigured() {
  return Boolean(CODEX_BIN && existsSync(CODEX_BIN));
}

function backendState() {
  return hasRealBackendConfigured() ? "real" : "backendUnavailable";
}

function resolvePathWithinSession(session, candidatePath) {
  if (typeof candidatePath !== "string" || !candidatePath.trim()) return null;
  const resolved = resolve(
    candidatePath.startsWith("/")
      ? candidatePath
      : join(session.workdir, candidatePath),
  );
  const rel = relative(session.workdir, resolved);
  if (rel.startsWith("..") || rel === "") {
    return rel === "" ? resolved : null;
  }
  return resolved;
}

function signPreviewToken(sessionId, filePath, expires) {
  return createHmac("sha256", FILE_SIGNING_SECRET)
    .update(`${filePath}:${expires}:${sessionId}`)
    .digest("hex");
}

function buildSignedPreviewUrl(
  session,
  filePath,
  expires = Math.floor(Date.now() / 1000) + PREVIEW_URL_TTL_SECONDS,
) {
  const sig = signPreviewToken(session.id, filePath, expires);
  return `/api/workdir-file?path=${encodeURIComponent(filePath)}&expires=${expires}&sig=${sig}`;
}

function hasValidPreviewSignature(session, filePath, expires, sig) {
  if (!session || !filePath || !expires || !sig) return false;
  if (Number.parseInt(String(expires), 10) < Math.floor(Date.now() / 1000))
    return false;
  const expected = signPreviewToken(session.id, filePath, expires);
  try {
    return timingSafeEqual(
      Buffer.from(sig, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseChatgptClaims(idToken, fallbackAccessToken) {
  const claims =
    decodeJwtPayload(idToken) ?? decodeJwtPayload(fallbackAccessToken) ?? {};
  const profile = claims["https://api.openai.com/profile"] ?? {};
  const auth = claims["https://api.openai.com/auth"] ?? {};
  return {
    email: claims.email ?? profile.email ?? null,
    chatgptPlanType: auth.chatgpt_plan_type ?? null,
    chatgptAccountId: auth.chatgpt_account_id ?? null,
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? safeJsonParse(text) : null;
  return { response, data, text };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function requestDeviceCode() {
  const { response, data, text } = await requestJson(
    `${CHATGPT_ACCOUNTS_API}/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
    },
  );
  if (!response.ok) {
    throw new Error(
      (data?.error?.message ?? data?.message ?? text) ||
        `device code request failed with status ${response.status}`,
    );
  }
  return {
    deviceAuthId: data?.device_auth_id ?? data?.deviceAuthId,
    userCode: data?.user_code ?? data?.userCode,
    interval: Number.parseInt(String(data?.interval ?? "5"), 10) || 5,
    verificationUrl: `${CHATGPT_ISSUER}/codex/device`,
  };
}

async function pollForDeviceCode(deviceAuthId, userCode, intervalSeconds) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEVICE_CODE_TIMEOUT_MS) {
    const { response, data, text } = await requestJson(
      `${CHATGPT_ACCOUNTS_API}/deviceauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: deviceAuthId,
          user_code: userCode,
        }),
      },
    );
    if (response.ok) return data;
    if (response.status === 403 || response.status === 404) {
      await new Promise((resolveSleep) =>
        setTimeout(resolveSleep, intervalSeconds * 1000),
      );
      continue;
    }
    throw new Error(
      text || `device auth failed with status ${response.status}`,
    );
  }
  throw new Error("device auth timed out after 15 minutes");
}

async function exchangeCodeForTokens({
  authorization_code: authorizationCode,
  code_verifier: codeVerifier,
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: CHATGPT_DEVICE_REDIRECT_URI,
    client_id: CHATGPT_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const { response, data, text } = await requestJson(
    `${CHATGPT_ISSUER}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!response.ok) {
    throw new Error(
      (data?.error?.message ?? data?.message ?? text) ||
        `oauth token exchange failed with status ${response.status}`,
    );
  }
  return data;
}

async function refreshOauthTokens(refreshToken) {
  const { response, data, text } = await requestJson(
    `${CHATGPT_ISSUER}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CHATGPT_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
  );
  if (!response.ok) {
    const error = new Error(
      (data?.error?.message ?? data?.message ?? text) ||
        `token refresh failed with status ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

function applyOauthTokensToSession(
  session,
  { access_token: accessToken, refresh_token: refreshToken, id_token: idToken },
) {
  const claims = parseChatgptClaims(idToken, accessToken);
  session.apiKey = undefined;
  session.oauth = {
    ...(session.oauth ?? {}),
    pending: false,
    error: null,
    accessToken,
    refreshToken,
    idToken,
    email: claims.email,
    planType: claims.chatgptPlanType,
    chatgptAccountId: claims.chatgptAccountId,
    authMode: "chatgptAuthTokens",
    verificationUrl: null,
    userCode: null,
    loginStartedAt: null,
    deviceAuthId: null,
  };
}

function syncSessionAuthToBackend(session) {
  const backend = session.backend;
  if (!backend) return;
  if (session.apiKey) {
    writeChild(backend, {
      jsonrpc: "2.0",
      id: `gw-${randomUUID()}`,
      method: "account/login/start",
      params: { type: "apiKey", apiKey: session.apiKey },
    });
    return;
  }
  if (session.oauth?.accessToken && session.oauth?.chatgptAccountId) {
    writeChild(backend, {
      jsonrpc: "2.0",
      id: `gw-${randomUUID()}`,
      method: "account/login/start",
      params: {
        type: "chatgptAuthTokens",
        accessToken: session.oauth.accessToken,
        chatgptAccountId: session.oauth.chatgptAccountId,
        chatgptPlanType: session.oauth.planType ?? null,
      },
    });
  }
}

function startDeviceCodeLogin(session) {
  const existing = session.oauth;
  if (
    existing?.pending &&
    existing?.deviceAuthId &&
    existing?.verificationUrl &&
    existing?.userCode
  ) {
    return {
      verificationUrl: existing.verificationUrl,
      userCode: existing.userCode,
      expiresAt:
        (existing.loginStartedAt ?? Date.now()) + DEVICE_CODE_TIMEOUT_MS,
    };
  }
  return requestDeviceCode().then((deviceCode) => {
    session.oauth = {
      ...(session.oauth ?? {}),
      pending: true,
      error: null,
      verificationUrl: deviceCode.verificationUrl,
      userCode: deviceCode.userCode,
      deviceAuthId: deviceCode.deviceAuthId,
      interval: deviceCode.interval,
      loginStartedAt: Date.now(),
    };

    void pollForDeviceCode(
      deviceCode.deviceAuthId,
      deviceCode.userCode,
      deviceCode.interval,
    )
      .then(exchangeCodeForTokens)
      .then((tokens) => {
        if (session.oauth?.deviceAuthId !== deviceCode.deviceAuthId) return;
        applyOauthTokensToSession(session, tokens);
        syncSessionAuthToBackend(session);
      })
      .catch((err) => {
        if (session.oauth?.deviceAuthId !== deviceCode.deviceAuthId) return;
        session.oauth = {
          ...(session.oauth ?? {}),
          pending: false,
          error: err.message,
        };
      });

    return {
      verificationUrl: deviceCode.verificationUrl,
      userCode: deviceCode.userCode,
      expiresAt: Date.now() + DEVICE_CODE_TIMEOUT_MS,
    };
  });
}

// -------- HTTP --------
const app = express();
app.set("trust proxy", true);
app.use(cookieParser());
app.use(express.json({ limit: "25mb" }));
app.use((_req, res, next) => {
  if (!IS_PROD) res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/healthz", (_req, res) => {
  const ok = hasRealBackendConfigured();
  res.status(ok ? 200 : 503).json({
    ok,
    backend: backendState(),
    realBinaryConfigured: ok,
    workdirRoot: WORKDIR_ROOT,
  });
});

app.use(express.static(PUBLIC_DIR));

app.get("/api/whoami", (req, res) => {
  const session = getOrCreateSession(req, res);
  const hasOauth = Boolean(
    session.oauth?.accessToken ||
    session.oauth?.authMode === "chatgpt" ||
    session.oauth?.authMode === "chatgptAuthTokens",
  );
  res.json({
    sessionId: session.id,
    hasApiKey: Boolean(session.apiKey),
    hasOauth,
    oauthPending: Boolean(session.oauth?.pending),
    oauthError: session.oauth?.error ?? null,
    account: hasOauth
      ? {
          email: session.oauth?.email ?? null,
          planType: session.oauth?.planType ?? null,
          chatgptAccountId: session.oauth?.chatgptAccountId ?? null,
        }
      : null,
    authMethod: hasOauth
      ? (session.oauth?.authMode ?? "chatgpt")
      : session.apiKey
        ? "apikey"
        : null,
    backend: backendState(),
    realBinaryConfigured: hasRealBackendConfigured(),
    workdir: session.workdir,
  });
});

app.post("/api/login", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  const { apiKey } = req.body ?? {};
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    res.status(400).json({ error: "apiKey is required" });
    return;
  }
  session.apiKey = apiKey.trim();
  session.oauth = undefined;
  syncSessionAuthToBackend(session);
  res.json({ ok: true, backend: backendState() });
});

app.post("/api/logout", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  session.apiKey = undefined;
  session.oauth = undefined;
  killBackend(session, "logout");
  res.json({ ok: true });
});

app.post("/api/oauth/chatgpt/start", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  try {
    const login = await startDeviceCodeLogin(session);
    res.json({ ok: true, ...login });
  } catch (err) {
    session.oauth = {
      ...(session.oauth ?? {}),
      pending: false,
      error: err.message,
    };
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/oauth/chatgpt/refresh", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  if (!session.oauth?.refreshToken) {
    res.status(401).json({ error: "no refresh token available" });
    return;
  }
  try {
    const tokens = await refreshOauthTokens(session.oauth.refreshToken);
    applyOauthTokensToSession(session, tokens);
    syncSessionAuthToBackend(session);
    res.json({
      accessToken: session.oauth.accessToken,
      chatgptAccountId: session.oauth.chatgptAccountId,
      chatgptPlanType: session.oauth.planType ?? null,
    });
  } catch (err) {
    session.oauth = undefined;
    if (err.status === 401) killBackend(session, "oauth refresh failed");
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

app.get("/api/threads", (req, res) => {
  const session = getOrCreateSession(req, res);
  const threads = [...session.threads.values()].sort(
    (a, b) => b.lastActive - a.lastActive,
  );
  res.json({ threads });
});

app.post("/api/file-search", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const { query } = req.body ?? {};
  if (typeof query !== "string") {
    res.status(400).json({ error: "query required" });
    return;
  }
  res.json({ results: await searchWorkdir(session.workdir, query) });
});

app.post("/api/upload", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  const { name, mimeType, dataBase64 } = req.body ?? {};
  if (typeof dataBase64 !== "string" || !dataBase64) {
    res.status(400).json({ error: "dataBase64 is required" });
    return;
  }
  const uploadsDir = join(session.workdir, ".uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const safeExt =
    extname(String(name || "")).slice(0, 12) ||
    guessExtensionFromMime(mimeType);
  const filePath = join(uploadsDir, `${randomUUID()}${safeExt}`);
  writeFileSync(filePath, Buffer.from(dataBase64, "base64"));
  res.json({
    path: filePath,
    previewUrl: buildSignedPreviewUrl(session, filePath),
  });
});

app.get("/api/workdir-file/sign", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  const filePath = resolvePathWithinSession(
    session,
    String(req.query.path ?? ""),
  );
  if (!filePath || !existsSync(filePath)) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  res.json({ previewUrl: buildSignedPreviewUrl(session, filePath) });
});

app.get("/api/workdir-file", (req, res) => {
  const session = getOrCreateSession(req, res);
  const filePath = resolvePathWithinSession(
    session,
    String(req.query.path ?? ""),
  );
  const expires = String(req.query.expires ?? "");
  const sig = String(req.query.sig ?? "");
  if (!filePath || !existsSync(filePath)) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  if (!hasValidPreviewSignature(session, filePath, expires, sig)) {
    res.status(403).json({ error: "invalid or expired preview signature" });
    return;
  }
  res.sendFile(filePath);
});

function guessExtensionFromMime(mimeType) {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return "";
  }
}

async function searchWorkdir(root, query) {
  const results = [];
  const lower = query.toLowerCase();
  const limit = 25;
  async function walk(dir, relPrefix) {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (
        entry.name.toLowerCase().includes(lower) ||
        rel.toLowerCase().includes(lower)
      ) {
        results.push(rel);
      }
    }
  }
  await walk(root, "");
  return results;
}

// -------- WebSocket: JSON-RPC pass-through --------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

server.on("upgrade", (req) => {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const url = new URL(origin);
    if (url.host !== req.headers.host) req.destroy();
  } catch {
    req.destroy();
  }
});

wss.on("connection", (ws, req) => {
  const session = getSessionFromCookie(req.headers.cookie);
  if (!session) {
    ws.close(4401, "no session");
    return;
  }
  attachWs(session, ws);
});

// ---------- per-session backend lifecycle ----------

function ensureBackend(session) {
  if (session.backend?.child && !session.backend.child.killed)
    return session.backend;
  if (!hasRealBackendConfigured()) return null;

  const codexHome = join(session.workdir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const env = { ...process.env, CODEX_HOME: codexHome };

  let child;
  try {
    const base = basename(CODEX_BIN).toLowerCase();
    const args = base.includes("app-server") ? [] : ["app-server"];
    child = spawn(CODEX_BIN, args, {
      env,
      cwd: session.workdir,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    console.error("[codex-web] failed to spawn backend:", err.message);
    return null;
  }

  const backend = {
    child,
    buf: "",
    outFrames: [],
    stderrTail: "",
    attachedWs: null,
    idleTimer: null,
  };
  session.backend = backend;

  child.stdout.on("data", (chunk) => onChildData(session, chunk));
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    backend.stderrTail = (backend.stderrTail + text).slice(-STDERR_TAIL_BYTES);
    process.stderr.write(`[codex backend ${session.id.slice(0, 8)}] ${text}`);
  });
  child.on("exit", (code, signal) => {
    if (session.backend === backend) session.backend = null;
    if (backend.attachedWs) {
      const tail = (backend.stderrTail || "").replace(/\s+$/, "").slice(-80);
      const reason = `backend exited code=${code ?? "?"} signal=${signal ?? "?"}${tail ? ` :: ${tail}` : ""}`;
      try {
        backend.attachedWs.close(4502, reason.slice(0, 120));
      } catch {}
    }
  });
  child.on("error", (err) => {
    console.error("[codex-web] child error:", err.message);
    if (session.backend === backend) session.backend = null;
  });

  syncSessionAuthToBackend(session);
  return backend;
}

function killBackend(session, reason) {
  const backend = session.backend;
  if (!backend) return;
  if (backend.idleTimer) {
    clearTimeout(backend.idleTimer);
    backend.idleTimer = null;
  }
  const child = backend.child;
  if (child && !child.killed) {
    process.stderr.write(
      `[codex-web] killing backend (${reason}) for session ${session.id.slice(0, 8)}\n`,
    );
    try {
      child.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {}
    }, 3000).unref();
  }
  if (backend.attachedWs) {
    try {
      backend.attachedWs.close(4001, `backend recycled: ${reason}`);
    } catch {}
  }
  session.backend = null;
}

function attachWs(session, ws) {
  const backend = ensureBackend(session);
  if (!backend) {
    const reason = hasRealBackendConfigured()
      ? "spawn failed"
      : "backend unavailable: set CODEX_BIN";
    try {
      ws.close(4500, reason.slice(0, 120));
    } catch {}
    return;
  }
  if (backend.attachedWs && backend.attachedWs !== ws) {
    try {
      backend.attachedWs.close(4000, "superseded");
    } catch {}
  }
  backend.attachedWs = ws;
  if (backend.idleTimer) {
    clearTimeout(backend.idleTimer);
    backend.idleTimer = null;
  }
  for (const frame of backend.outFrames) {
    try {
      ws.send(frame);
    } catch {}
  }
  ws.on("message", (raw) => onWsMessage(session, backend, raw));
  ws.on("close", () => detachWs(session, backend, ws));
  ws.on("error", () => detachWs(session, backend, ws));
}

function detachWs(session, backend, ws) {
  if (backend.attachedWs !== ws) return;
  backend.attachedWs = null;
  if (backend.idleTimer) clearTimeout(backend.idleTimer);
  backend.idleTimer = setTimeout(() => {
    if (session.backend === backend && !backend.attachedWs) {
      killBackend(session, "idle");
    }
  }, BACKEND_IDLE_MS).unref();
}

function onChildData(session, chunk) {
  const backend = session.backend;
  if (!backend) return;
  backend.buf += chunk.toString("utf8");
  let newlineIndex;
  while ((newlineIndex = backend.buf.indexOf("\n")) >= 0) {
    const line = backend.buf.slice(0, newlineIndex).trim();
    backend.buf = backend.buf.slice(newlineIndex + 1);
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(
        `[codex backend ${session.id.slice(0, 8)} stdout] ${line}\n`,
      );
      continue;
    }
    if (!parsed || (parsed.jsonrpc !== "2.0" && parsed.jsonrpc !== undefined))
      continue;
    backend.outFrames.push(line);
    if (backend.outFrames.length > REPLAY_RING_SIZE) backend.outFrames.shift();
    if (
      backend.attachedWs &&
      backend.attachedWs.readyState === backend.attachedWs.OPEN
    ) {
      try {
        backend.attachedWs.send(line);
      } catch {}
    }
    observeForSession(session, parsed);
  }
}

function upsertThreadSnapshot(session, thread) {
  if (!thread?.id) return;
  const existing = session.threads.get(thread.id) ?? {
    id: thread.id,
    lastActive: Date.now(),
  };
  existing.id = thread.id;
  existing.name = thread.name ?? existing.name ?? thread.preview ?? thread.id;
  existing.preview = thread.preview ?? existing.preview ?? "";
  existing.status = thread.status ?? existing.status ?? "active";
  existing.archived = Boolean(thread.status === "archived");
  existing.lastActive = thread.updatedAt ? thread.updatedAt * 1000 : Date.now();
  session.threads.set(thread.id, existing);
}

function observeForSession(session, msg) {
  if (msg.method === "thread/started" && msg.params?.thread) {
    upsertThreadSnapshot(session, msg.params.thread);
    session.activeThreadId = msg.params.thread.id;
    if (session.backend) session.backend.outFrames = [];
    return;
  }
  if (
    msg.method === "thread/name/updated" ||
    msg.method === "thread/nameUpdated"
  ) {
    const threadId = msg.params?.threadId;
    const name = msg.params?.threadName ?? msg.params?.name;
    if (threadId && session.threads.has(threadId)) {
      const thread = session.threads.get(threadId);
      thread.name = name ?? thread.name;
      thread.lastActive = Date.now();
    }
    return;
  }
  if (msg.method === "thread/archived" || msg.method === "thread/unarchived") {
    const threadId = msg.params?.threadId;
    if (threadId && session.threads.has(threadId)) {
      const thread = session.threads.get(threadId);
      thread.archived = msg.method === "thread/archived";
      thread.status = thread.archived ? "archived" : "active";
      thread.lastActive = Date.now();
    }
    return;
  }
  if (msg.method === "account/updated") {
    const authMode = msg.params?.authMode ?? null;
    const planType = msg.params?.planType ?? null;
    if (authMode === "chatgpt" || authMode === "chatgptAuthTokens") {
      session.oauth = {
        ...(session.oauth ?? {}),
        pending: false,
        error: null,
        authMode,
        planType,
      };
    } else if (authMode === "apikey" || authMode === null) {
      session.oauth = undefined;
    }
  }
}

function onWsMessage(session, backend, raw) {
  if (!backend.child?.stdin || backend.child.stdin.destroyed) return;
  let text;
  try {
    text = raw.toString("utf8");
  } catch {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!parsed || parsed.jsonrpc !== "2.0") return;
  const activeId = parsed.params?.threadId ?? session.activeThreadId;
  if (parsed.method === "turn/start" && activeId) {
    const thread = session.threads.get(activeId);
    if (thread) {
      const prompt = (parsed.params?.input ?? [])
        .map((part) => part?.text ?? "")
        .join(" ")
        .trim();
      if (prompt && (!thread.name || thread.name === thread.id))
        thread.name = prompt.slice(0, 48);
      thread.lastActive = Date.now();
    }
  }
  try {
    backend.child.stdin.write(text + "\n");
  } catch {}
}

function writeChild(backend, obj) {
  if (!backend.child?.stdin || backend.child.stdin.destroyed) return;
  try {
    backend.child.stdin.write(`${JSON.stringify(obj)}\n`);
  } catch {}
}

server.listen(PORT, HOST, () => {
  console.log(`[codex-web] listening on http://${HOST}:${PORT}`);
  if (hasRealBackendConfigured()) {
    console.log(`[codex-web] codex binary: ${CODEX_BIN}`);
  } else {
    console.error(
      "[codex-web] CODEX_BIN is not set or does not point to a valid binary.",
    );
    console.error(
      "[codex-web] The web app now requires a real codex/codex-app-server backend.",
    );
  }
  console.log(`[codex-web] workdir root: ${WORKDIR_ROOT}`);
});
