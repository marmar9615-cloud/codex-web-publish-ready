// Codex Web — JSON-RPC bridge to the Rust `codex app-server`.
//
// The gateway is a transparent JSON-RPC 2.0 proxy. Every WebSocket frame is a
// canonical app-server-protocol message; the gateway only adds HTTP helpers for
// session bookkeeping, auth, uploads, and workdir file serving.

import express from "express";
import cookieParser from "cookie-parser";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.PORT ?? "5000", 10);
const HOST = "0.0.0.0";
const PUBLIC_DIR = join(__dirname, "public");
const WORKDIR_ROOT = resolve(
  process.env.CODEX_WEB_WORKDIR_ROOT ?? join(__dirname, ".workdirs"),
);
const PROJECTS_ROOT = resolve(
  process.env.CODEX_WEB_PROJECTS_ROOT ?? join(dirname(WORKDIR_ROOT), "projects"),
);
const SHARES_ROOT = resolve(
  process.env.CODEX_WEB_SHARES_ROOT ?? join(dirname(WORKDIR_ROOT), "shares"),
);
const CODEX_BIN = process.env.CODEX_BIN ?? "";
const IS_PROD = process.env.NODE_ENV === "production";
const PROJECT_METADATA_FILE = ".codex-project.json";
const PROJECT_SECRETS_FILE = ".codex-secrets.enc";
const PROJECT_INTERNAL_EXCLUDES = [
  PROJECT_METADATA_FILE,
  PROJECT_SECRETS_FILE,
  ".codex/",
  ".uploads/",
];
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const SHIP_OUTPUT_LIMIT = 12_000;
const GITHUB_API_ROOT = "https://api.github.com";
const TERMINAL_REPLAY_RING_SIZE = 400;
const SHARE_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const SHARE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const DB_ROW_LIMIT = 50;
const MOBILE_OUTPUT_LIMIT = 24_000;
const MOBILE_POLLABLE_STATUSES = new Set(["starting", "running", "stopping"]);
const EXPO_CONFIG_FILES = [
  "app.json",
  "app.config.js",
  "app.config.ts",
  "app.config.mjs",
  "app.config.cjs",
];

const CHATGPT_ISSUER = (
  process.env.CODEX_CHATGPT_ISSUER ?? "https://auth.openai.com"
).replace(/\/+$/, "");
const CHATGPT_CLIENT_ID =
  process.env.CODEX_CHATGPT_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_ACCOUNTS_API = `${CHATGPT_ISSUER}/api/accounts`;
const CHATGPT_DEVICE_REDIRECT_URI = `${CHATGPT_ISSUER}/deviceauth/callback`;

mkdirSync(WORKDIR_ROOT, { recursive: true });
mkdirSync(PROJECTS_ROOT, { recursive: true });
mkdirSync(SHARES_ROOT, { recursive: true });

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

function ensureWorkdirScaffold(workdir) {
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(workdir, ".uploads"), { recursive: true });
}

function makeSession(id) {
  const workdir = join(WORKDIR_ROOT, id);
  ensureWorkdirScaffold(workdir);
  return {
    id,
    apiKey: undefined,
    oauth: undefined,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    defaultWorkdir: workdir,
    workdir,
    activeProjectSlug: null,
    activePreviewPort: null,
    threads: new Map(),
    activeThreadId: undefined,
    backend: null,
    terminal: null,
    mobile: null,
  };
}

const REPLAY_RING_SIZE = 500;
const BACKEND_IDLE_MS = 5 * 60 * 1000;
const STDERR_TAIL_BYTES = 1024;
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const PREVIEW_URL_TTL_SECONDS = 15 * 60;
const FILE_SIGNING_SECRET =
  process.env.CODEX_WEB_FILE_SIGNING_SECRET ?? randomBytes(32).toString("hex");
const SHARE_SIGNING_SECRET =
  process.env.CODEX_WEB_SHARE_SIGNING_SECRET ??
  process.env.CODEX_WEB_SECRETS_KEY ??
  randomBytes(32).toString("hex");
const MEMORY_DOC_FILENAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

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

function isSupportedDatabasePath(filePath) {
  return [".db", ".db3", ".sqlite", ".sqlite3"].includes(
    extname(String(filePath ?? "")).toLowerCase(),
  );
}

function quoteSqlIdentifier(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

async function runSqliteJson(filePath, sql) {
  const result = await runProcess("sqlite3", ["-json", filePath, sql], {
    timeoutMs: 10_000,
  });
  if (!result.ok) {
    throw new Error(
      truncateOutput(
        result.stderr || result.stdout || "sqlite3 query failed",
        2_000,
      ),
    );
  }
  const text = String(result.stdout ?? "").trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`sqlite3 returned unreadable JSON: ${error.message}`);
  }
}

function shareRecordPath(recordId) {
  return join(SHARES_ROOT, `${recordId}.json`);
}

function clampShareTtl(ttl) {
  const parsed = Number.parseInt(String(ttl ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SHARE_DEFAULT_TTL_SECONDS;
  }
  return Math.min(SHARE_MAX_TTL_SECONDS, Math.max(60, parsed));
}

function signShareToken(recordId, expiresAt) {
  return createHmac("sha256", SHARE_SIGNING_SECRET)
    .update(`${recordId}:${expiresAt}`)
    .digest("hex");
}

function buildShareToken(recordId, expiresAt) {
  const signature = signShareToken(recordId, expiresAt);
  return `${recordId}.${expiresAt}.${signature}`;
}

function parseShareToken(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [recordId, expiresAt, signature] = parts;
  if (!recordId || !expiresAt || !signature) return null;
  const expected = signShareToken(recordId, expiresAt);
  try {
    if (
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex"),
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const expiresAtSeconds = Number.parseInt(expiresAt, 10);
  if (!Number.isFinite(expiresAtSeconds)) return null;
  return {
    recordId,
    expiresAt: expiresAtSeconds,
  };
}

function readShareRecord(token) {
  const parsed = parseShareToken(token);
  if (!parsed) return { error: "invalid share token", status: 404 };
  if (parsed.expiresAt < Math.floor(Date.now() / 1000)) {
    try {
      rmSync(shareRecordPath(parsed.recordId), { force: true });
    } catch {}
    return { error: "share link expired", status: 410 };
  }
  const path = shareRecordPath(parsed.recordId);
  if (!existsSync(path)) return { error: "share not found", status: 404 };
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (
      record.recordId !== parsed.recordId ||
      Number.parseInt(String(record.expiresAt ?? ""), 10) !== parsed.expiresAt
    ) {
      return { error: "share token mismatch", status: 404 };
    }
    return { record };
  } catch {
    return { error: "share payload unreadable", status: 500 };
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

app.get("/s/:token", (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "share.html"));
});

app.get("/api/whoami", (req, res) => {
  const session = getOrCreateSession(req, res);
  const activeProject = activeProjectSummary(session);
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
    activeProjectSlug: activeProject?.slug ?? null,
    activeProjectName: activeProject?.name ?? null,
    backend: backendState(),
    realBinaryConfigured: hasRealBackendConfigured(),
    workdir: session.workdir,
  });
});

app.get("/api/db/inspect", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const filePath = resolvePathWithinSession(
    session,
    String(req.query.path ?? ""),
  );
  if (!filePath || !existsSync(filePath)) {
    res.status(404).json({ error: "database file not found" });
    return;
  }
  if (!isSupportedDatabasePath(filePath)) {
    res.status(400).json({ error: "only sqlite database files are supported" });
    return;
  }
  try {
    const tables = await runSqliteJson(
      filePath,
      `
        SELECT
          name,
          type
        FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name;
      `,
    );
    res.json({
      path: filePath,
      dialect: "sqlite",
      tables,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/db/table", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const filePath = resolvePathWithinSession(
    session,
    String(req.query.path ?? ""),
  );
  const table = String(req.query.table ?? "").trim();
  const limit = Math.max(
    1,
    Math.min(
      DB_ROW_LIMIT,
      Number.parseInt(String(req.query.limit ?? DB_ROW_LIMIT), 10) ||
        DB_ROW_LIMIT,
    ),
  );
  const offset = Math.max(
    0,
    Number.parseInt(String(req.query.offset ?? "0"), 10) || 0,
  );
  if (!filePath || !existsSync(filePath)) {
    res.status(404).json({ error: "database file not found" });
    return;
  }
  if (!isSupportedDatabasePath(filePath)) {
    res.status(400).json({ error: "only sqlite database files are supported" });
    return;
  }
  if (!table) {
    res.status(400).json({ error: "table name is required" });
    return;
  }
  const quotedTable = quoteSqlIdentifier(table);
  try {
    const [columns, rows, counts] = await Promise.all([
      runSqliteJson(filePath, `PRAGMA table_info(${quotedTable});`),
      runSqliteJson(
        filePath,
        `SELECT * FROM ${quotedTable} LIMIT ${limit} OFFSET ${offset};`,
      ),
      runSqliteJson(
        filePath,
        `SELECT COUNT(*) AS totalRows FROM ${quotedTable};`,
      ),
    ]);
    res.json({
      path: filePath,
      table,
      limit,
      offset,
      columns,
      rows,
      totalRows: counts[0]?.totalRows ?? null,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/threads/:threadId/share", sameOriginOnly, (req, res) => {
  getOrCreateSession(req, res);
  const threadId = String(req.params.threadId ?? "").trim();
  const mode = req.body?.mode === "edit" ? "edit" : "readonly";
  const ttl = clampShareTtl(req.body?.ttl);
  const thread = cloneJson(req.body?.thread);
  if (!threadId) {
    res.status(400).json({ error: "thread id is required" });
    return;
  }
  if (!thread || typeof thread !== "object") {
    res.status(400).json({ error: "thread snapshot is required" });
    return;
  }
  if (String(thread.id ?? "") !== threadId) {
    res.status(400).json({ error: "thread snapshot does not match requested id" });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttl;
  const recordId = randomUUID();
  const token = buildShareToken(recordId, expiresAt);
  const record = {
    recordId,
    token,
    mode,
    createdAt: now,
    expiresAt,
    thread,
  };
  writeFileSync(
    shareRecordPath(recordId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  const sharePath = `/s/${token}`;
  const shareUrl = `${req.protocol}://${req.get("host")}${sharePath}`;
  res.json({
    ok: true,
    token,
    sharePath,
    shareUrl,
    expiresAt,
    mode,
  });
});

app.get("/api/shares/:token", (req, res) => {
  const result = readShareRecord(req.params.token);
  if (!result.record) {
    res
      .status(result.status ?? 404)
      .json({ error: result.error ?? "share not found" });
    return;
  }
  res.json({
    mode: result.record.mode ?? "readonly",
    createdAt: result.record.createdAt ?? null,
    expiresAt: result.record.expiresAt ?? null,
    thread: result.record.thread ?? null,
  });
});

app.get("/api/projects", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  res.json({ projects: await listProjectsForSession(session) });
});

app.post("/api/projects", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const name = String(req.body?.name ?? "").trim();
  const slug = normalizeProjectSlug(req.body?.slug ?? name);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!slug || slug === "_scratch") {
    res.status(400).json({ error: "valid slug is required" });
    return;
  }
  const dir = projectDirForSlug(slug);
  if (existsSync(dir)) {
    res.status(409).json({ error: "project already exists" });
    return;
  }
  ensureWorkdirScaffold(dir);
  const now = Date.now();
  const project = {
    slug,
    name,
    createdAt: now,
    updatedAt: now,
  };
  writeProjectMetadata(dir, project);
  res.status(201).json({
    project: serializeProject(session, project, dir),
  });
});

app.post("/api/projects/:slug/activate", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const project = activateProjectForSession(session, slug);
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  res.json({
    ok: true,
    project,
    workdir: session.workdir,
  });
});

app.delete("/api/projects/:slug", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  if (!slug || slug === "_scratch") {
    res.status(400).json({ error: "cannot delete scratch workspace" });
    return;
  }
  const dir = projectDirForSlug(slug);
  if (!existsSync(dir)) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  if (session.activeProjectSlug === slug) {
    activateProjectForSession(session, "_scratch");
  }
  rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

app.get("/api/projects/:slug/secrets", sameOriginOnly, (req, res) => {
  const slug = String(req.params.slug ?? "");
  if (!slug || slug === "_scratch") {
    res.status(400).json({ error: "named project required" });
    return;
  }
  const dir = projectDirForSlug(slug);
  if (!existsSync(dir)) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  const configured = Boolean(getProjectSecretsCipherKey());
  const secrets = configured ? readProjectSecrets(slug) : {};
  res.json({
    configured,
    keys: Object.keys(secrets).sort((left, right) => left.localeCompare(right)),
  });
});

app.post("/api/projects/:slug/secrets", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const key = String(req.body?.key ?? "").trim();
  const value = req.body?.value;
  if (!slug || slug === "_scratch") {
    res.status(400).json({ error: "named project required" });
    return;
  }
  if (!key) {
    res.status(400).json({ error: "secret key is required" });
    return;
  }
  if (!getProjectSecretsCipherKey()) {
    res.status(503).json({ error: "CODEX_WEB_SECRETS_KEY is not configured" });
    return;
  }
  const dir = projectDirForSlug(slug);
  if (!existsSync(dir)) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  const secrets = readProjectSecrets(slug);
  if (value == null || value === "") {
    delete secrets[key];
  } else {
    secrets[key] = String(value);
  }
  writeProjectSecrets(slug, secrets);
  if (session.activeProjectSlug === slug) {
    killBackend(session, `project secret updated:${slug}`);
  }
  res.json({
    ok: true,
    keys: Object.keys(secrets).sort((left, right) => left.localeCompare(right)),
  });
});

app.get("/api/github/repos", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.query.slug ?? session.activeProjectSlug ?? "");
  try {
    res.json(await listGitHubRepos(slug));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/projects/:slug/git/status", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const context = getProjectContext(session, slug);
  if (!context) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  try {
    res.json({
      status: await getProjectGitStatus(context.dir, slug),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/projects/:slug/git/clone", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const repo = String(req.body?.repo ?? "").trim();
  const branch = String(req.body?.branch ?? "").trim();
  const context = getProjectContext(session, slug);
  if (!context) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  if (!repo) {
    res.status(400).json({ error: "repo is required" });
    return;
  }
  if (!ensureCloneTargetReady(context.dir)) {
    res.status(409).json({
      error: "project already has files; create a fresh project before cloning",
    });
    return;
  }
  const repoRef = parseGitHubRepoReference(repo);
  const cloneUrl = repoRef?.cloneUrl ?? repo;
  const tempDir = join(PROJECTS_ROOT, `.clone-${slug}-${Date.now()}`);
  const cloneArgs = ["clone"];
  if (branch) cloneArgs.push("--branch", branch);
  cloneArgs.push(cloneUrl, tempDir);
  const result = await runGit(cloneArgs, {
    cwd: PROJECTS_ROOT,
    slug,
    repoHint: cloneUrl,
    timeoutMs: 20 * 60 * 1000,
  });
  if (!result.ok) {
    rmSync(tempDir, { recursive: true, force: true });
    res.status(502).json({
      error: truncateOutput(
        [result.stdout, result.stderr].filter(Boolean).join("\n"),
      ),
    });
    return;
  }
  try {
    moveDirectoryContents(tempDir, context.dir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  ensureWorkdirScaffold(context.dir);
  ensureProjectGitExclude(context.dir);
  updateProjectMetadata(slug, (current) => ({
    ...current,
    git: {
      ...(current.git ?? {}),
      repo: repoRef?.fullName ?? repo,
      defaultBranch: branch || current.git?.defaultBranch || null,
    },
  }));
  if (session.activeProjectSlug === slug) {
    killBackend(session, `git clone:${slug}`);
  }
  res.json({
    ok: true,
    status: await getProjectGitStatus(context.dir, slug),
  });
});

app.post("/api/projects/:slug/git/commit", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const message = String(req.body?.message ?? "").trim();
  const context = getProjectContext(session, slug);
  if (!context) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const status = await getProjectGitStatus(context.dir, slug);
  if (!status.connected) {
    res.status(409).json({ error: "clone a git repo into this project first" });
    return;
  }
  ensureProjectGitExclude(context.dir);
  const addResult = await runProcess(
    "git",
    [
      "add",
      "-A",
      "--",
      ".",
      `:(exclude)${PROJECT_METADATA_FILE}`,
      `:(exclude)${PROJECT_SECRETS_FILE}`,
      ":(exclude).codex",
      ":(exclude).uploads",
    ],
    {
      cwd: context.dir,
      env: { GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (!addResult.ok) {
    res.status(500).json({
      error: truncateOutput(addResult.stderr || addResult.stdout),
    });
    return;
  }
  const stagedStatus = await runProcess("git", ["status", "--porcelain"], {
    cwd: context.dir,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  if (!stagedStatus.stdout.trim()) {
    res.json({
      ok: true,
      noChanges: true,
      status: await getProjectGitStatus(context.dir, slug),
    });
    return;
  }
  const commitResult = await runProcess("git", ["commit", "-m", message], {
    cwd: context.dir,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  if (!commitResult.ok) {
    res.status(502).json({
      error: truncateOutput(
        [commitResult.stdout, commitResult.stderr].filter(Boolean).join("\n"),
      ),
    });
    return;
  }
  res.json({
    ok: true,
    output: truncateOutput(
      [commitResult.stdout, commitResult.stderr].filter(Boolean).join("\n"),
    ),
    status: await getProjectGitStatus(context.dir, slug),
  });
});

app.post("/api/projects/:slug/git/push", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const remote = String(req.body?.remote ?? "origin").trim() || "origin";
  const context = getProjectContext(session, slug);
  if (!context) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  const status = await getProjectGitStatus(context.dir, slug);
  if (!status.connected) {
    res.status(409).json({ error: "clone a git repo into this project first" });
    return;
  }
  const branch = String(req.body?.branch ?? status.branch ?? "").trim();
  if (!branch) {
    res.status(409).json({ error: "current branch is unavailable" });
    return;
  }
  const remoteUrlResult = await runProcess("git", ["remote", "get-url", remote], {
    cwd: context.dir,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  const repoHint = remoteUrlResult.ok ? remoteUrlResult.stdout.trim() : "";
  const pushResult = await runGit(
    ["push", "-u", remote, `HEAD:${branch}`],
    {
      cwd: context.dir,
      slug,
      repoHint,
      timeoutMs: 20 * 60 * 1000,
    },
  );
  if (!pushResult.ok) {
    res.status(502).json({
      error: truncateOutput(
        [pushResult.stdout, pushResult.stderr].filter(Boolean).join("\n"),
      ),
    });
    return;
  }
  res.json({
    ok: true,
    output: truncateOutput(
      [pushResult.stdout, pushResult.stderr].filter(Boolean).join("\n"),
    ),
    status: await getProjectGitStatus(context.dir, slug),
  });
});

app.post("/api/projects/:slug/git/pr", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const title = String(req.body?.title ?? "").trim();
  const body = String(req.body?.body ?? "").trim();
  const context = getProjectContext(session, slug);
  if (!context) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const status = await getProjectGitStatus(context.dir, slug);
  const repoRef = parseGitHubRepoReference(status.remoteUrl ?? "");
  if (!repoRef?.fullName) {
    res.status(409).json({ error: "origin remote is not a GitHub repository" });
    return;
  }
  if (!status.branch) {
    res.status(409).json({ error: "current branch is unavailable" });
    return;
  }
  try {
    const repo = await requestGitHub(slug, `/repos/${repoRef.fullName}`);
    const pull = await requestGitHub(slug, `/repos/${repoRef.fullName}/pulls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        body,
        head: status.branch,
        base: String(req.body?.base ?? repo.default_branch ?? "main"),
      }),
    });
    res.json({
      ok: true,
      pullRequest: {
        number: pull.number,
        url: pull.html_url,
        title: pull.title,
      },
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/projects/:slug/deploy/render", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const context = getProjectContext(session, slug);
  if (!context) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  res.json(loadRenderDeployState(slug));
});

app.post(
  "/api/projects/:slug/deploy/render/config",
  sameOriginOnly,
  (req, res) => {
    const session = getOrCreateSession(req, res);
    const slug = String(req.params.slug ?? "");
    const hookUrl = String(req.body?.syncHookUrl ?? "").trim();
    const context = getProjectContext(session, slug);
    if (!context) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    if (!getProjectSecretsCipherKey()) {
      res.status(503).json({ error: "CODEX_WEB_SECRETS_KEY is not configured" });
      return;
    }
    const secrets = readProjectSecrets(slug);
    if (hookUrl) {
      secrets.RENDER_SYNC_HOOK_URL = hookUrl;
    } else {
      delete secrets.RENDER_SYNC_HOOK_URL;
    }
    writeProjectSecrets(slug, secrets);
    res.json({
      ok: true,
      deploy: loadRenderDeployState(slug),
    });
  },
);

app.post(
  "/api/projects/:slug/deploy/render/trigger",
  sameOriginOnly,
  async (req, res) => {
    const session = getOrCreateSession(req, res);
    const slug = String(req.params.slug ?? "");
    const context = getProjectContext(session, slug);
    if (!context) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    try {
      res.json({
        ok: true,
        deploy: await triggerRenderSync(slug),
      });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  },
);

app.get("/api/projects/:slug/ship", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const context = getProjectContext(session, slug);
  if (!context) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  res.json({
    commands: detectProjectShipCommands(context.dir, slug),
    git: await getProjectGitStatus(context.dir, slug),
    deploy: loadRenderDeployState(slug),
  });
});

app.post("/api/projects/:slug/ship", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  const slug = String(req.params.slug ?? "");
  const context = getProjectContext(session, slug);
  if (!context) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  const testsCommand = String(req.body?.testsCommand ?? "").trim();
  const buildCommand = String(req.body?.buildCommand ?? "").trim();
  const commitMessage = String(req.body?.commitMessage ?? "").trim();
  const deployAfter = req.body?.deployAfter !== false;
  const steps = [];

  if (testsCommand) {
    const result = await runShell(testsCommand, { cwd: context.dir });
    steps.push(summarizeStep("tests", result, testsCommand));
    if (!result.ok) {
      res.status(200).json({ ok: false, steps });
      return;
    }
  }

  if (buildCommand) {
    const result = await runShell(buildCommand, { cwd: context.dir });
    steps.push(summarizeStep("build", result, buildCommand));
    if (!result.ok) {
      res.status(200).json({ ok: false, steps });
      return;
    }
  }

  const gitStatus = await getProjectGitStatus(context.dir, slug);
  if (gitStatus.connected) {
    ensureProjectGitExclude(context.dir);
    if (commitMessage) {
      const addResult = await runProcess(
        "git",
        [
          "add",
          "-A",
          "--",
          ".",
          `:(exclude)${PROJECT_METADATA_FILE}`,
          `:(exclude)${PROJECT_SECRETS_FILE}`,
          ":(exclude).codex",
          ":(exclude).uploads",
        ],
        {
          cwd: context.dir,
          env: { GIT_TERMINAL_PROMPT: "0" },
        },
      );
      steps.push(summarizeStep("git add", addResult, "git add -A"));
      if (!addResult.ok) {
        res.status(200).json({ ok: false, steps });
        return;
      }
      const stagedResult = await runProcess("git", ["status", "--porcelain"], {
        cwd: context.dir,
        env: { GIT_TERMINAL_PROMPT: "0" },
      });
      if (stagedResult.stdout.trim()) {
        const commitResult = await runProcess("git", ["commit", "-m", commitMessage], {
          cwd: context.dir,
          env: { GIT_TERMINAL_PROMPT: "0" },
        });
        steps.push(summarizeStep("commit", commitResult, `git commit -m "${commitMessage}"`));
        if (!commitResult.ok) {
          res.status(200).json({ ok: false, steps });
          return;
        }
      } else {
        steps.push({
          name: "commit",
          command: `git commit -m "${commitMessage}"`,
          ok: true,
          code: 0,
          timedOut: false,
          output: "No repo changes were staged, so commit was skipped.",
        });
      }
    }

    if (gitStatus.branch) {
      const remoteUrlResult = await runProcess("git", ["remote", "get-url", "origin"], {
        cwd: context.dir,
        env: { GIT_TERMINAL_PROMPT: "0" },
      });
      const pushResult = await runGit(
        ["push", "-u", "origin", `HEAD:${gitStatus.branch}`],
        {
          cwd: context.dir,
          slug,
          repoHint: remoteUrlResult.ok ? remoteUrlResult.stdout.trim() : "",
          timeoutMs: 20 * 60 * 1000,
        },
      );
      steps.push(
        summarizeStep(
          "push",
          pushResult,
          `git push -u origin HEAD:${gitStatus.branch}`,
        ),
      );
      if (!pushResult.ok) {
        res.status(200).json({ ok: false, steps });
        return;
      }
    }
  }

  if (deployAfter) {
    try {
      const deploy = await triggerRenderSync(slug);
      steps.push({
        name: "deploy",
        command: "Render sync hook",
        ok: Boolean(deploy.ok),
        code: deploy.status,
        timedOut: false,
        output: deploy.responseText,
      });
      if (!deploy.ok) {
        res.status(200).json({ ok: false, steps });
        return;
      }
    } catch (error) {
      steps.push({
        name: "deploy",
        command: "Render sync hook",
        ok: false,
        code: null,
        timedOut: false,
        output: error.message,
      });
      res.status(200).json({ ok: false, steps });
      return;
    }
  }

  res.json({
    ok: true,
    steps,
    git: await getProjectGitStatus(context.dir, slug),
    deploy: loadRenderDeployState(slug),
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
  killMobile(session, "logout", { clear: true });
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

app.get("/api/memories", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  const memoryDocs = discoverMemoryDocs(session);
  res.json({
    codexHome: join(session.workdir, ".codex"),
    workdir: session.workdir,
    projectRoot: findProjectRoot(session.workdir),
    items: memoryDocs,
  });
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

function isValidPreviewPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== PORT;
}

async function detectListeningPreviewPorts() {
  const result = await runProcess(
    "lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN"],
    { timeoutMs: 5_000 },
  );
  if (!result.ok && result.code !== 1) {
    throw new Error(result.stderr || "preview port detection failed");
  }
  const seen = new Set();
  const ports = [];
  for (const line of String(result.stdout ?? "").split(/\r?\n/).slice(1)) {
    const match = /^(\S+)\s+(\d+)\s+.*:(\d+)\s+\(LISTEN\)$/.exec(line.trim());
    if (!match) continue;
    const port = Number.parseInt(match[3], 10);
    if (!isValidPreviewPort(port) || seen.has(port)) continue;
    seen.add(port);
    ports.push({
      command: match[1],
      pid: Number.parseInt(match[2], 10),
      port,
    });
  }
  ports.sort((left, right) => left.port - right.port);
  return ports;
}

function rewritePreviewHtml(html, port) {
  const prefix = `/preview/${port}`;
  let rewritten = String(html ?? "");
  if (!/<base\b/i.test(rewritten)) {
    rewritten = rewritten.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="${prefix}/">`,
    );
  }
  return rewritten.replace(
    /\b(href|src|action)=("|')\/(?!\/)/gi,
    `$1=$2${prefix}/`,
  );
}

async function proxyPreviewRequest(session, req, res) {
  const port = Number.parseInt(String(req.params.port ?? ""), 10);
  if (!isValidPreviewPort(port)) {
    res.status(400).send("invalid preview port");
    return;
  }
  if (session.activePreviewPort !== port) {
    res.status(403).send("preview port is not active for this session");
    return;
  }

  const suffix = req.originalUrl.replace(/^\/preview\/\d+/, "") || "/";
  const upstreamUrl = `http://127.0.0.1:${port}${suffix}`;
  const headers = new Headers();
  const headerAllowlist = [
    "accept",
    "accept-language",
    "cache-control",
    "content-type",
    "pragma",
    "user-agent",
  ];
  for (const name of headerAllowlist) {
    const value = req.headers[name];
    if (typeof value === "string" && value) {
      headers.set(name, value);
    }
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      redirect: "manual",
    });
  } catch (error) {
    res.status(502).send(`preview unavailable: ${error.message}`);
    return;
  }

  const strippedHeaders = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "content-security-policy",
    "keep-alive",
    "transfer-encoding",
    "x-frame-options",
  ]);
  for (const [name, value] of upstream.headers) {
    const lowered = name.toLowerCase();
    if (strippedHeaders.has(lowered)) continue;
    if (lowered === "location" && value.startsWith("/")) {
      res.setHeader(name, `/preview/${port}${value}`);
      continue;
    }
    res.setHeader(name, value);
  }

  res.status(upstream.status);
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const html = await upstream.text();
    res.send(rewritePreviewHtml(html, port));
    return;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  res.send(body);
}

app.get("/api/preview/ports", sameOriginOnly, async (_req, res) => {
  try {
    const ports = await detectListeningPreviewPorts();
    res.json({ ports });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/preview/activate", sameOriginOnly, (req, res) => {
  const session = getOrCreateSession(req, res);
  const port = Number.parseInt(String(req.body?.port ?? ""), 10);
  if (!isValidPreviewPort(port)) {
    res.status(400).json({ error: "a preview port between 1024 and 65535 is required" });
    return;
  }
  session.activePreviewPort = port;
  res.json({
    port,
    previewBaseUrl: `/preview/${port}`,
  });
});

app.get("/preview/:port", (req, res) => {
  const session = getOrCreateSession(req, res);
  void proxyPreviewRequest(session, req, res);
});

app.get("/preview/:port/*", (req, res) => {
  const session = getOrCreateSession(req, res);
  void proxyPreviewRequest(session, req, res);
});

app.get("/api/mobile/status", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  try {
    res.json(await buildMobileStatus(session));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/mobile/start", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  try {
    await startMobilePreview(session);
    res.json(await buildMobileStatus(session));
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.post("/api/mobile/stop", sameOriginOnly, async (req, res) => {
  const session = getOrCreateSession(req, res);
  killMobile(session, "stop requested");
  res.json(await buildMobileStatus(session));
});

function trimMobileOutput(value) {
  const text = String(value ?? "");
  return text.length <= MOBILE_OUTPUT_LIMIT
    ? text
    : text.slice(-MOBILE_OUTPUT_LIMIT);
}

function detectExpoWorkspace(dir) {
  const packageJsonPath = join(dir, "package.json");
  const configPath =
    EXPO_CONFIG_FILES.map((fileName) => join(dir, fileName)).find((path) =>
      existsSync(path),
    ) ?? null;
  let packageJson = null;
  if (existsSync(packageJsonPath)) {
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch {}
  }
  const packageScripts = packageJson?.scripts ?? {};
  const packageHasExpo = Boolean(
    packageJson?.dependencies?.expo || packageJson?.devDependencies?.expo,
  );
  const startCommand =
    typeof packageScripts.start === "string" && packageScripts.start.trim()
      ? "npm run start -- --tunnel"
      : "npx expo start --tunnel";
  return {
    detected: Boolean(configPath || packageHasExpo),
    configPath,
    packageJsonPath: existsSync(packageJsonPath) ? packageJsonPath : null,
    startCommand,
  };
}

function updateMobileUrls(mobile, text) {
  const expoMatches = String(text).match(/\bexp:\/\/[^\s"'`<>()]+/g) ?? [];
  const expoUrl = expoMatches.at(-1) ?? mobile.expoUrl ?? "";
  if (expoUrl && expoUrl !== mobile.expoUrl) {
    mobile.expoUrl = expoUrl;
    void QRCode.toDataURL(expoUrl, {
      margin: 1,
      width: 192,
    })
      .then((dataUrl) => {
        if (mobile.expoUrl === expoUrl) {
          mobile.qrDataUrl = dataUrl;
        }
      })
      .catch(() => {});
  }
  const httpMatches = String(text).match(/\bhttps?:\/\/[^\s"'`<>()]+/g) ?? [];
  const dashboardUrl =
    httpMatches.find((value) => /expo\.dev|127\.0\.0\.1|localhost/.test(value)) ??
    httpMatches.at(-1) ??
    mobile.dashboardUrl ??
    "";
  if (dashboardUrl) {
    mobile.dashboardUrl = dashboardUrl;
  }
}

function serializeMobileState(session, detection) {
  const mobile = session.mobile;
  return {
    detected: detection.detected,
    configPath: detection.configPath,
    packageJsonPath: detection.packageJsonPath,
    startCommand: detection.startCommand,
    running: Boolean(mobile?.child && !mobile.child.killed),
    status: mobile?.status ?? "idle",
    command: mobile?.command ?? detection.startCommand,
    output: mobile?.output ?? "",
    expoUrl: mobile?.expoUrl ?? "",
    dashboardUrl: mobile?.dashboardUrl ?? "",
    qrDataUrl: mobile?.qrDataUrl ?? "",
    exitCode: mobile?.exitCode ?? null,
    signal: mobile?.signal ?? null,
  };
}

async function buildMobileStatus(session) {
  const detection = detectExpoWorkspace(session.workdir);
  return serializeMobileState(session, detection);
}

async function startMobilePreview(session) {
  const detection = detectExpoWorkspace(session.workdir);
  if (!detection.detected) {
    throw new Error("No Expo project was detected in the active workspace yet.");
  }
  killMobile(session, "restart requested");
  const shell = process.env.SHELL ?? "zsh";
  const env = {
    ...process.env,
    ...readProjectSecrets(session.activeProjectSlug),
    CODEX_HOME: join(session.workdir, ".codex"),
  };
  mkdirSync(env.CODEX_HOME, { recursive: true });
  let child;
  try {
    child = spawn(shell, ["-lc", detection.startCommand], {
      cwd: session.workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    throw new Error(`mobile preview failed to start: ${error.message}`);
  }
  const mobile = {
    child,
    cwd: session.workdir,
    command: detection.startCommand,
    status: "starting",
    output: "",
    expoUrl: "",
    dashboardUrl: "",
    qrDataUrl: "",
    exitCode: null,
    signal: null,
  };
  session.mobile = mobile;

  const onOutput = (chunk) => {
    const text = chunk.toString("utf8");
    mobile.output = trimMobileOutput(`${mobile.output}${text}`);
    updateMobileUrls(mobile, text);
    if (mobile.status === "starting") {
      mobile.status = "running";
    }
  };

  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);
  child.on("error", (error) => {
    mobile.status = "error";
    mobile.output = trimMobileOutput(`${mobile.output}\n${error.message}\n`);
  });
  child.on("exit", (code, signal) => {
    mobile.child = null;
    mobile.exitCode = code;
    mobile.signal = signal;
    if (mobile.status === "stopping") {
      mobile.status = "stopped";
      return;
    }
    mobile.status = code === 0 ? "exited" : "failed";
  });
}

function killMobile(session, reason, options = {}) {
  const mobile = session.mobile;
  if (!mobile) return;
  const child = mobile.child;
  if (child && !child.killed) {
    mobile.status = "stopping";
    mobile.output = trimMobileOutput(
      `${mobile.output}\n[codex-web] stopping mobile preview (${reason})\n`,
    );
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {}
    setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else if (!child.killed) {
          child.kill("SIGKILL");
        }
      } catch {}
    }, 1500).unref();
  }
  if (options.clear) {
    session.mobile = null;
  }
}

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

function normalizeProjectSlug(value) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || null;
}

function projectDirForSlug(slug) {
  return join(PROJECTS_ROOT, slug);
}

function projectMetadataPath(dir) {
  return join(dir, PROJECT_METADATA_FILE);
}

function readProjectMetadata(dir, slug) {
  const fallback = {
    slug,
    name: slug,
    createdAt: null,
    updatedAt: null,
  };
  try {
    const raw = readFileSync(projectMetadataPath(dir), "utf8");
    return {
      ...fallback,
      ...JSON.parse(raw),
      slug,
    };
  } catch {
    return fallback;
  }
}

function writeProjectMetadata(dir, project) {
  writeFileSync(
    projectMetadataPath(dir),
    `${JSON.stringify(project, null, 2)}\n`,
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function updateProjectMetadata(slug, updater) {
  const dir = projectDirForSlug(slug);
  const current = readProjectMetadata(dir, slug);
  const next = updater(cloneJson(current)) ?? current;
  next.slug = slug;
  next.updatedAt = Date.now();
  writeProjectMetadata(dir, next);
  return next;
}

function serializeProject(session, project, dir, options = {}) {
  return {
    slug: project.slug,
    name: project.name,
    path: dir,
    active: session.activeProjectSlug === project.slug,
    system: Boolean(options.system),
    createdAt: project.createdAt ?? null,
    updatedAt: project.updatedAt ?? null,
  };
}

function getProjectContext(session, slug, options = {}) {
  const allowScratch = options.allowScratch === true;
  if (slug === "_scratch" && allowScratch) {
    ensureWorkdirScaffold(session.defaultWorkdir);
    return {
      slug,
      dir: session.defaultWorkdir,
      project: {
        slug,
        name: "Scratch workspace",
        createdAt: null,
        updatedAt: null,
      },
      system: true,
    };
  }
  if (!slug || slug === "_scratch") return null;
  const dir = projectDirForSlug(slug);
  if (!existsSync(dir)) return null;
  return {
    slug,
    dir,
    project: readProjectMetadata(dir, slug),
    system: false,
  };
}

async function listProjectsForSession(session) {
  const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true }).catch(
    () => [],
  );
  const projects = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = projectDirForSlug(entry.name);
      const project = readProjectMetadata(dir, entry.name);
      return serializeProject(session, project, dir);
    })
    .sort((left, right) =>
      String(left.name ?? left.slug).localeCompare(String(right.name ?? right.slug)),
    );
  return [
    {
      slug: "_scratch",
      name: "Scratch workspace",
      path: session.defaultWorkdir,
      active: !session.activeProjectSlug,
      system: true,
      createdAt: null,
      updatedAt: null,
    },
    ...projects,
  ];
}

function activeProjectSummary(session) {
  if (!session.activeProjectSlug) return null;
  const dir = projectDirForSlug(session.activeProjectSlug);
  if (!existsSync(dir)) return null;
  return serializeProject(
    session,
    readProjectMetadata(dir, session.activeProjectSlug),
    dir,
  );
}

function activateProjectForSession(session, slug) {
  if (!slug || slug === "_scratch") {
    session.activeProjectSlug = null;
    session.activePreviewPort = null;
    session.activeThreadId = undefined;
    session.workdir = session.defaultWorkdir;
    ensureWorkdirScaffold(session.workdir);
    killMobile(session, "workspace switched", { clear: true });
    killTerminal(session, "workspace switched");
    killBackend(session, "workspace switched");
    return {
      slug: "_scratch",
      name: "Scratch workspace",
      path: session.workdir,
      active: true,
      system: true,
      createdAt: null,
      updatedAt: null,
    };
  }
  const dir = projectDirForSlug(slug);
  if (!existsSync(dir)) return null;
  const project = readProjectMetadata(dir, slug);
  session.activeProjectSlug = slug;
  session.activePreviewPort = null;
  session.activeThreadId = undefined;
  session.workdir = dir;
  ensureWorkdirScaffold(session.workdir);
  killMobile(session, `workspace switched:${slug}`, { clear: true });
  killTerminal(session, `workspace switched:${slug}`);
  killBackend(session, `workspace switched:${slug}`);
  return serializeProject(session, project, dir);
}

function projectSecretsPath(slug) {
  return join(projectDirForSlug(slug), PROJECT_SECRETS_FILE);
}

function getProjectSecretValue(slug, key) {
  if (!slug) return process.env[key] ?? null;
  const secrets = readProjectSecrets(slug);
  return secrets[key] ?? process.env[key] ?? null;
}

function getGitHubToken(slug) {
  return (
    getProjectSecretValue(slug, "GITHUB_TOKEN") ??
    getProjectSecretValue(slug, "GH_TOKEN") ??
    process.env.CODEX_WEB_GITHUB_TOKEN ??
    null
  );
}

function getRenderSyncHookUrl(slug) {
  return (
    getProjectSecretValue(slug, "RENDER_SYNC_HOOK_URL") ??
    getProjectSecretValue(slug, "RENDER_DEPLOY_HOOK_URL") ??
    process.env.CODEX_WEB_RENDER_SYNC_HOOK_URL ??
    null
  );
}

function redactHookUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "configured";
  }
}

function truncateOutput(text, limit = SHIP_OUTPUT_LIMIT) {
  const value = String(text ?? "");
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n…truncated…`;
}

function runProcess(command, args, options = {}) {
  const cwd = options.cwd ?? __dirname;
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 1500).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        signal: null,
        stdout,
        stderr: stderr || error.message,
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function runShell(command, options = {}) {
  const shell = process.env.SHELL ?? "zsh";
  return runProcess(shell, ["-lc", command], options);
}

function parseGitHubRepoReference(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const shortMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  if (shortMatch) {
    const fullName = `${shortMatch[1]}/${shortMatch[2]}`;
    return {
      owner: shortMatch[1],
      name: shortMatch[2],
      fullName,
      cloneUrl: `https://github.com/${fullName}.git`,
      htmlUrl: `https://github.com/${fullName}`,
    };
  }
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
  if (sshMatch) {
    const fullName = `${sshMatch[1]}/${sshMatch[2]}`;
    return {
      owner: sshMatch[1],
      name: sshMatch[2],
      fullName,
      cloneUrl: `https://github.com/${fullName}.git`,
      htmlUrl: `https://github.com/${fullName}`,
    };
  }
  try {
    const url = new URL(raw);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) return null;
    const owner = parts[0];
    const name = parts[1].replace(/\.git$/, "");
    const fullName = `${owner}/${name}`;
    return {
      owner,
      name,
      fullName,
      cloneUrl: `https://github.com/${fullName}.git`,
      htmlUrl: `https://github.com/${fullName}`,
    };
  } catch {
    return null;
  }
}

function githubAuthConfigArg(token) {
  return `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

async function runGit(args, options = {}) {
  const repoRef = parseGitHubRepoReference(options.repoHint ?? "");
  const token = repoRef ? getGitHubToken(options.slug) : null;
  const gitArgs = token
    ? ["-c", githubAuthConfigArg(token), ...args]
    : [...args];
  return runProcess("git", gitArgs, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      ...(options.env ?? {}),
    },
  });
}

function ensureProjectGitExclude(dir) {
  const excludePath = join(dir, ".git", "info", "exclude");
  if (!existsSync(excludePath)) return;
  const current = readFileSync(excludePath, "utf8");
  let next = current;
  for (const entry of PROJECT_INTERNAL_EXCLUDES) {
    if (next.includes(entry)) continue;
    next += `${next.endsWith("\n") || next === "" ? "" : "\n"}${entry}\n`;
  }
  if (next !== current) {
    writeFileSync(excludePath, next);
  }
}

function parseGitStatusSummary(line) {
  const match =
    /^## (?<branch>[^. ]+)(?:\.\.\.(?<tracking>[^\s]+))?(?: \[(?<detail>[^\]]+)\])?/.exec(
      String(line ?? "").trim(),
    );
  if (!match?.groups) {
    return {
      branch: null,
      tracking: null,
      ahead: 0,
      behind: 0,
    };
  }
  const detail = match.groups.detail ?? "";
  const aheadMatch = /ahead (\d+)/.exec(detail);
  const behindMatch = /behind (\d+)/.exec(detail);
  return {
    branch: match.groups.branch ?? null,
    tracking: match.groups.tracking ?? null,
    ahead: Number.parseInt(aheadMatch?.[1] ?? "0", 10),
    behind: Number.parseInt(behindMatch?.[1] ?? "0", 10),
  };
}

function parseGitChangedFiles(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim() || line.slice(0, 2),
      path: line.slice(3).trim(),
    }));
}

async function getProjectGitStatus(dir, slug) {
  const repoCheck = await runProcess(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    {
      cwd: dir,
      env: { GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (!repoCheck.ok || repoCheck.stdout.trim() !== "true") {
    return {
      connected: false,
      branch: null,
      tracking: null,
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: [],
      remoteUrl: null,
      repoFullName: null,
      lastCommit: null,
    };
  }
  ensureProjectGitExclude(dir);
  const [statusResult, remoteResult, lastCommitResult] = await Promise.all([
    runProcess("git", ["status", "--short", "--branch"], {
      cwd: dir,
      env: { GIT_TERMINAL_PROMPT: "0" },
    }),
    runProcess("git", ["remote", "get-url", "origin"], {
      cwd: dir,
      env: { GIT_TERMINAL_PROMPT: "0" },
    }),
    runProcess("git", ["log", "-1", "--pretty=%h %s"], {
      cwd: dir,
      env: { GIT_TERMINAL_PROMPT: "0" },
    }),
  ]);
  const lines = String(statusResult.stdout ?? "").split(/\r?\n/).filter(Boolean);
  const summary = parseGitStatusSummary(lines[0] ?? "");
  const remoteUrl = remoteResult.ok ? remoteResult.stdout.trim() : null;
  return {
    connected: true,
    ...summary,
    dirty: lines.length > 1,
    changedFiles: parseGitChangedFiles(statusResult.stdout),
    remoteUrl,
    repoFullName: parseGitHubRepoReference(remoteUrl)?.fullName ?? null,
    lastCommit: lastCommitResult.ok ? lastCommitResult.stdout.trim() : null,
    tokenConfigured: Boolean(getGitHubToken(slug)),
  };
}

function ensureCloneTargetReady(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => !PROJECT_INTERNAL_EXCLUDES.includes(`${entry.name}/`) && !PROJECT_INTERNAL_EXCLUDES.includes(entry.name),
  );
  return entries.length === 0;
}

function moveDirectoryContents(sourceDir, destDir) {
  for (const name of readdirSync(sourceDir)) {
    renameSync(join(sourceDir, name), join(destDir, name));
  }
}

async function requestGitHub(slug, path, options = {}) {
  const token = getGitHubToken(slug);
  if (!token) throw new Error("Configure GITHUB_TOKEN in project secrets first.");
  const response = await fetch(`${GITHUB_API_ROOT}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "codex-web",
      ...(options.headers ?? {}),
    },
    body: options.body,
  });
  const text = await response.text();
  const data = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message ?? `GitHub request failed (${response.status})`);
  }
  return data;
}

async function listGitHubRepos(slug) {
  if (!getGitHubToken(slug)) {
    return {
      configured: false,
      repos: [],
    };
  }
  const data = await requestGitHub(
    slug,
    "/user/repos?sort=updated&per_page=24&affiliation=owner,collaborator,organization_member",
  );
  return {
    configured: true,
    repos: Array.isArray(data)
      ? data.map((repo) => ({
          id: repo.id,
          fullName: repo.full_name,
          private: Boolean(repo.private),
          defaultBranch: repo.default_branch ?? null,
          htmlUrl: repo.html_url,
        }))
      : [],
  };
}

function loadRenderDeployState(slug) {
  const project = readProjectMetadata(projectDirForSlug(slug), slug);
  const lastDeploy = project.deploy?.render ?? {};
  const hookUrl = getRenderSyncHookUrl(slug);
  return {
    configured: Boolean(hookUrl),
    hookLabel: redactHookUrl(hookUrl),
    lastDeploy: {
      lastTriggeredAt: lastDeploy.lastTriggeredAt ?? null,
      lastStatus: lastDeploy.lastStatus ?? null,
      lastOk: lastDeploy.lastOk ?? null,
      lastResponseText: lastDeploy.lastResponseText ?? null,
    },
  };
}

async function triggerRenderSync(slug) {
  const hookUrl = getRenderSyncHookUrl(slug);
  if (!hookUrl) {
    throw new Error("Configure RENDER_SYNC_HOOK_URL in project secrets first.");
  }
  const response = await fetch(hookUrl);
  const text = await response.text();
  const project = updateProjectMetadata(slug, (current) => ({
    ...current,
    deploy: {
      ...(current.deploy ?? {}),
      render: {
        lastTriggeredAt: Date.now(),
        lastStatus: response.status,
        lastOk: response.ok,
        lastResponseText: truncateOutput(text, 1500),
      },
    },
  }));
  return {
    ok: response.ok,
    status: response.status,
    responseText: truncateOutput(text, 1500),
    deploy: project.deploy?.render ?? null,
  };
}

function detectProjectShipCommands(dir, slug) {
  const project = readProjectMetadata(dir, slug);
  const configured = project.ship ?? {};
  const packageJsonPath = join(dir, "package.json");
  if (configured.testsCommand || configured.buildCommand) {
    return {
      testsCommand: configured.testsCommand ?? "",
      buildCommand: configured.buildCommand ?? "",
      source: "saved",
    };
  }
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      return {
        testsCommand: pkg.scripts?.test ? "npm test" : "",
        buildCommand: pkg.scripts?.build ? "npm run build" : "",
        source: "package.json",
      };
    } catch {}
  }
  if (existsSync(join(dir, "Cargo.toml"))) {
    return {
      testsCommand: "cargo test",
      buildCommand: "cargo build",
      source: "Cargo.toml",
    };
  }
  if (existsSync(join(dir, "pytest.ini")) || existsSync(join(dir, "pyproject.toml"))) {
    return {
      testsCommand: "pytest",
      buildCommand: "",
      source: "pytest",
    };
  }
  return {
    testsCommand: "",
    buildCommand: "",
    source: "none",
  };
}

function summarizeStep(name, result, command) {
  return {
    name,
    command,
    ok: Boolean(result.ok),
    code: result.code,
    timedOut: Boolean(result.timedOut),
    output: truncateOutput(
      [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    ),
  };
}

function getProjectSecretsCipherKey() {
  const secret = process.env.CODEX_WEB_SECRETS_KEY ?? "";
  if (!secret) return null;
  return createHash("sha256").update(secret).digest();
}

function readProjectSecrets(slug) {
  if (!slug) return {};
  const cipherKey = getProjectSecretsCipherKey();
  if (!cipherKey) return {};
  const filePath = projectSecretsPath(slug);
  if (!existsSync(filePath)) return {};
  try {
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    const iv = Buffer.from(payload.iv ?? "", "base64");
    const ciphertext = Buffer.from(payload.ciphertext ?? "", "base64");
    const tag = Buffer.from(payload.tag ?? "", "base64");
    const decipher = createDecipheriv("aes-256-gcm", cipherKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn("[codex-web] failed to read project secrets:", error.message);
    return {};
  }
}

function writeProjectSecrets(slug, secrets) {
  const cipherKey = getProjectSecretsCipherKey();
  if (!cipherKey) {
    throw new Error("CODEX_WEB_SECRETS_KEY is not configured");
  }
  const dir = projectDirForSlug(slug);
  ensureWorkdirScaffold(dir);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const payload = {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  writeFileSync(projectSecretsPath(slug), `${JSON.stringify(payload, null, 2)}\n`);
}

function findProjectRoot(startDir) {
  let cursor = startDir;
  while (cursor && cursor !== dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    cursor = dirname(cursor);
  }
  return startDir;
}

function readMemoryPreview(filePath) {
  try {
    const text = readFileSync(filePath, "utf8").trim();
    const preview = text.replace(/\s+/g, " ").slice(0, 220);
    return preview.length < text.length ? `${preview}…` : preview;
  } catch {
    return "";
  }
}

function discoverMemoryDocs(session) {
  const items = [];
  const seen = new Set();
  const codexHome = join(session.workdir, ".codex");
  const pushDoc = (path, scope) => {
    if (!existsSync(path) || seen.has(path)) return;
    seen.add(path);
    items.push({
      path,
      fileName: basename(path),
      scope,
      preview: readMemoryPreview(path),
    });
  };

  for (const fileName of MEMORY_DOC_FILENAMES) {
    pushDoc(join(codexHome, fileName), "session");
  }

  const root = findProjectRoot(session.workdir);
  const dirs = [];
  let cursor = session.workdir;
  while (cursor) {
    dirs.push(cursor);
    if (cursor === root || cursor === dirname(cursor)) break;
    cursor = dirname(cursor);
  }
  dirs.reverse();

  for (const dir of dirs) {
    const scope = dir === session.workdir ? "workspace" : "project";
    for (const fileName of MEMORY_DOC_FILENAMES) {
      pushDoc(join(dir, fileName), scope);
    }
  }

  return items;
}

function terminalStatusFrame(state, extra = {}) {
  return {
    type: "status",
    state,
    ...extra,
  };
}

function buildTerminalSpawn(shellPath) {
  return {
    command: shellPath,
    args: ["-l"],
  };
}

function sendTerminalFrame(session, frame) {
  const terminal = session.terminal;
  if (!terminal) return;
  const payload = JSON.stringify(frame);
  terminal.outFrames.push(payload);
  if (terminal.outFrames.length > TERMINAL_REPLAY_RING_SIZE) {
    terminal.outFrames.shift();
  }
  if (
    terminal.attachedWs &&
    terminal.attachedWs.readyState === terminal.attachedWs.OPEN
  ) {
    try {
      terminal.attachedWs.send(payload);
    } catch {}
  }
}

function ensureTerminal(session, options = {}) {
  if (options.restart) {
    killTerminal(session, "restart");
  }
  if (session.terminal?.child && !session.terminal.child.killed) {
    return session.terminal;
  }

  const shellPath =
    process.env.SHELL ??
    (existsSync("/bin/zsh")
      ? "/bin/zsh"
      : existsSync("/bin/bash")
        ? "/bin/bash"
        : "sh");
  const codexHome = join(session.workdir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const env = {
    ...process.env,
    ...readProjectSecrets(session.activeProjectSlug),
    CODEX_HOME: codexHome,
    TERM: process.env.TERM ?? "xterm-256color",
  };
  const spawnConfig = buildTerminalSpawn(shellPath);

  let child;
  try {
    child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: session.workdir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    console.error("[codex-web] failed to spawn terminal:", error.message);
    return null;
  }

  const terminal = {
    child,
    attachedWs: null,
    outFrames: [],
    cwd: session.workdir,
    shellPath,
  };
  session.terminal = terminal;

  sendTerminalFrame(
    session,
    terminalStatusFrame("running", {
      cwd: session.workdir,
      shell: shellPath,
    }),
  );

  const onOutput = (stream, chunk) => {
    sendTerminalFrame(session, {
      type: "output",
      stream,
      dataBase64: Buffer.from(chunk).toString("base64"),
    });
  };

  child.stdout.on("data", (chunk) => onOutput("stdout", chunk));
  child.stderr.on("data", (chunk) => onOutput("stderr", chunk));
  child.on("error", (error) => {
    sendTerminalFrame(
      session,
      terminalStatusFrame("error", { message: error.message }),
    );
    session.terminal = null;
  });
  child.on("exit", (code, signal) => {
    sendTerminalFrame(
      session,
      terminalStatusFrame("exited", {
        code,
        signal,
      }),
    );
    if (session.terminal === terminal) {
      session.terminal = null;
    }
  });

  return terminal;
}

function killTerminal(session, reason) {
  const terminal = session.terminal;
  if (!terminal) return;
  const child = terminal.child;
  if (child && !child.killed) {
    process.stderr.write(
      `[codex-web] killing terminal (${reason}) for session ${session.id.slice(0, 8)}\n`,
    );
    try {
      child.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {}
    }, 1500).unref();
  }
  session.terminal = null;
}

function attachTerminalWs(session, ws) {
  const terminal = ensureTerminal(session);
  if (!terminal) {
    try {
      ws.close(4503, "terminal unavailable");
    } catch {}
    return;
  }
  if (terminal.attachedWs && terminal.attachedWs !== ws) {
    try {
      terminal.attachedWs.close(4000, "superseded");
    } catch {}
  }
  terminal.attachedWs = ws;
  for (const frame of terminal.outFrames) {
    try {
      ws.send(frame);
    } catch {}
  }
  ws.on("message", (raw) => onTerminalWsMessage(session, terminal, raw));
  ws.on("close", () => detachTerminalWs(terminal, ws));
  ws.on("error", () => detachTerminalWs(terminal, ws));
}

function detachTerminalWs(terminal, ws) {
  if (terminal.attachedWs === ws) {
    terminal.attachedWs = null;
  }
}

function onTerminalWsMessage(session, terminal, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;
  if (message.type === "input") {
    try {
      terminal.child.stdin.write(String(message.data ?? ""));
    } catch {}
    return;
  }
  if (message.type === "interrupt") {
    try {
      terminal.child.stdin.write("\u0003");
    } catch {}
    return;
  }
  if (message.type === "restart") {
    killTerminal(session, "restart requested");
    ensureTerminal(session);
  }
}

// -------- WebSocket: JSON-RPC pass-through --------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const termWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (!origin) {
    socket.destroy();
    return;
  }
  try {
    const url = new URL(origin);
    if (url.host !== req.headers.host) {
      socket.destroy();
      return;
    }
  } catch {
    socket.destroy();
    return;
  }

  let pathname = "";
  try {
    pathname = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  } catch {
    socket.destroy();
    return;
  }

  const target = pathname === "/ws" ? wss : pathname === "/ws/term" ? termWss : null;
  if (!target) {
    socket.destroy();
    return;
  }

  target.handleUpgrade(req, socket, head, (ws) => {
    target.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const session = getSessionFromCookie(req.headers.cookie);
  if (!session) {
    ws.close(4401, "no session");
    return;
  }
  attachWs(session, ws);
});

termWss.on("connection", (ws, req) => {
  const session = getSessionFromCookie(req.headers.cookie);
  if (!session) {
    ws.close(4401, "no session");
    return;
  }
  attachTerminalWs(session, ws);
});

// ---------- per-session backend lifecycle ----------

function ensureBackend(session) {
  if (session.backend?.child && !session.backend.child.killed)
    return session.backend;
  if (!hasRealBackendConfigured()) return null;

  const codexHome = join(session.workdir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const env = {
    ...process.env,
    ...readProjectSecrets(session.activeProjectSlug),
    CODEX_HOME: codexHome,
  };

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
