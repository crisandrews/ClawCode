/* scope-exec-gate-bundle@338665798ddfd8f197b257755df465cf559e9c78e0f7792dd5b5230df406741f */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// lib/scope/exec-gate-hook-entry.ts
var import_node_fs7 = __toESM(require("node:fs"), 1);
var import_node_path7 = __toESM(require("node:path"), 1);

// lib/config.ts
var import_fs = __toESM(require("fs"), 1);
var import_path = __toESM(require("path"), 1);
var DEFAULT_CONFIG = {
  memory: {
    backend: "builtin",
    citations: "auto",
    builtin: {
      temporalDecay: true,
      halfLifeDays: 30,
      mmr: true,
      mmrLambda: 0.7
    }
  }
};
var CONFIG_FILENAME = "agent-config.json";
function loadConfig(pluginRoot) {
  const configPath = import_path.default.join(pluginRoot, CONFIG_FILENAME);
  try {
    const raw = import_fs.default.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      http: parsed.http ? { ...parsed.http } : void 0,
      voice: parsed.voice ? { ...parsed.voice } : void 0,
      memoryContext: parsed.memoryContext ? { ...parsed.memoryContext } : void 0,
      heartbeat: parsed.heartbeat ? { ...parsed.heartbeat } : void 0,
      dreaming: parsed.dreaming ? { ...parsed.dreaming } : void 0,
      memory: {
        ...DEFAULT_CONFIG.memory,
        ...parsed.memory,
        qmd: parsed.memory?.qmd ? { ...parsed.memory.qmd } : void 0,
        builtin: {
          ...DEFAULT_CONFIG.memory.builtin,
          ...parsed.memory?.builtin
        }
      },
      // Phase 3 — scope.* deep-merge. Absent block stays undefined
      // so detectScopeRuntime() short-circuits to anyArmed=false.
      scope: parsed.scope ? mergeScopeConfig(parsed.scope) : void 0
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
var VALID_MODES = /* @__PURE__ */ new Set(["off", "shadow", "enforce"]);
var VALID_IDENTITIES = /* @__PURE__ */ new Set([
  "auto",
  "owner",
  "guest"
]);
var VALID_BG_IDENTITIES = /* @__PURE__ */ new Set(["deny", "system-owner"]);
function coerceMode(v) {
  return typeof v === "string" && VALID_MODES.has(v) ? v : "off";
}
function coerceIdentity(v) {
  return typeof v === "string" && VALID_IDENTITIES.has(v) ? v : "auto";
}
function coerceBgIdentity(v) {
  return typeof v === "string" && VALID_BG_IDENTITIES.has(v) ? v : "deny";
}
function mergeScopeConfig(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const r = raw;
  const out = {};
  for (const channel of [
    "whatsapp",
    "telegram",
    "discord",
    "imessage",
    "webchat"
  ]) {
    const v = r[channel];
    if (!v || typeof v !== "object") continue;
    const cv = v;
    const merged = {
      mode: coerceMode(cv.mode),
      identity: coerceIdentity(cv.identity),
      background: {
        identity: coerceBgIdentity(
          cv.background?.identity
        )
      },
      // execGate is stored as the raw block (not coerced here) and
      // resolved at read time via `execGateConfigForChannel`. This
      // mirrors the read-scope mode handling: the merge layer keeps
      // user intent, and the resolver coerces fail-closed.
      ...cv.execGate !== void 0 ? { execGate: cv.execGate } : {}
    };
    if (channel === "whatsapp") {
      const w = v;
      const rawAccess = w.accessJsonPath;
      const accessJsonPath = typeof rawAccess === "string" ? rawAccess : "auto";
      const wa = {
        ...merged,
        accessJsonPath,
        cwdExactMatchOnly: typeof w.cwdExactMatchOnly === "boolean" ? w.cwdExactMatchOnly : false
      };
      out.whatsapp = wa;
    } else {
      out[channel] = merged;
    }
  }
  return Object.keys(out).length > 0 ? out : void 0;
}

// lib/scope/runtime.ts
var import_node_fs3 = __toESM(require("node:fs"), 1);
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path3 = __toESM(require("node:path"), 1);

// lib/channel-detector.ts
var import_fs2 = __toESM(require("fs"), 1);
var import_path2 = __toESM(require("path"), 1);
function detectWhatsappProjectDir(home, cwd, options = {}) {
  try {
    const f = import_path2.default.join(home, ".claude", "plugins", "installed_plugins.json");
    const data = JSON.parse(import_fs2.default.readFileSync(f, "utf8"));
    const entries = data?.plugins?.["whatsapp@claude-whatsapp"] ?? [];
    const exact = entries.find(
      (e) => e.scope === "local" && e.projectPath === cwd
    );
    if (exact?.projectPath) return exact.projectPath;
    if (options.cwdExactMatchOnly) return void 0;
    const firstLocal = entries.find(
      (e) => e.scope === "local" && e.projectPath
    );
    return firstLocal?.projectPath;
  } catch {
    return void 0;
  }
}

// lib/scope/index.ts
var registry = /* @__PURE__ */ new Map();
function registerScopeAdapter(adapter) {
  registry.set(adapter.channel, adapter);
}
function unregisterScopeAdapter(channel) {
  registry.delete(channel);
}

// lib/scope/whatsapp.ts
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);

// lib/scope/trust.ts
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var TRUST_DIR_REL = import_node_path.default.join(".claude", "agent", "scope-trust");
var TRUST_DIR_ENV = "CLAW_SCOPE_TRUST_DIR";
function trustDir() {
  const override = process.env[TRUST_DIR_ENV];
  if (override) return override;
  return import_node_path.default.join(import_node_os.default.homedir(), TRUST_DIR_REL);
}
function trustFilePath(channel, suffix = "owner") {
  return import_node_path.default.join(trustDir(), `${channel}-${suffix}`);
}
function isOwnerTrusted(channel, suffix = "owner") {
  const file = trustFilePath(channel, suffix);
  let stat;
  try {
    stat = import_node_fs.default.lstatSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === "win32") return true;
  const pUid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (typeof pUid !== "number") return true;
  if (stat.uid !== pUid) return false;
  if ((stat.mode & 63) !== 0) return false;
  return true;
}

// lib/scope/whatsapp.ts
function defaultAccess() {
  return { ownerJids: [], allowFrom: [], groups: {}, dms: {} };
}
function normalizeAccessWithMeta(raw) {
  const out = defaultAccess();
  if (!raw || typeof raw !== "object") {
    return { access: out, hasOwnerJidsField: false };
  }
  const r = raw;
  const hasOwnerJidsField = Object.prototype.hasOwnProperty.call(r, "ownerJids") && Array.isArray(r.ownerJids);
  if (Array.isArray(r.ownerJids))
    out.ownerJids = r.ownerJids.filter((s) => typeof s === "string");
  if (Array.isArray(r.allowFrom))
    out.allowFrom = r.allowFrom.filter((s) => typeof s === "string");
  if (r.groups && typeof r.groups === "object") {
    for (const [k, v] of Object.entries(r.groups)) {
      if (!v || typeof v !== "object") continue;
      const g = v;
      out.groups[k] = {};
      if (Array.isArray(g.historyScope)) {
        out.groups[k].historyScope = g.historyScope.filter(
          (s) => typeof s === "string"
        );
      } else if (g.historyScope === "own" || g.historyScope === "all") {
        out.groups[k].historyScope = g.historyScope;
      }
    }
  }
  if (r.dms && typeof r.dms === "object") {
    for (const [k, v] of Object.entries(r.dms)) {
      if (!v || typeof v !== "object") continue;
      const d = v;
      out.dms[k] = {};
      if (Array.isArray(d.historyScope)) {
        out.dms[k].historyScope = d.historyScope.filter(
          (s) => typeof s === "string"
        );
      } else if (d.historyScope === "own" || d.historyScope === "all") {
        out.dms[k].historyScope = d.historyScope;
      }
    }
  }
  return { access: out, hasOwnerJidsField };
}
var MISSING_GRACE_MS = 5 * 60 * 1e3;
function loadAccess(accessPath, cache) {
  let stat;
  try {
    stat = import_node_fs2.default.lstatSync(accessPath);
  } catch {
    const cached3 = cache.get(accessPath);
    if (!cached3) {
      return {
        access: null,
        hasOwnerJidsField: false,
        resolvable: false,
        lastKnownGood: false
      };
    }
    const now = Date.now();
    const missingSince = cached3.missingSince ?? now;
    if (now - missingSince >= MISSING_GRACE_MS) {
      return {
        access: null,
        hasOwnerJidsField: false,
        resolvable: false,
        lastKnownGood: false
      };
    }
    if (cached3.missingSince === void 0) {
      cache.set(accessPath, { ...cached3, missingSince: now });
    }
    return {
      access: cached3.access,
      hasOwnerJidsField: cached3.hasOwnerJidsField,
      resolvable: true,
      lastKnownGood: true
    };
  }
  const cached2 = cache.get(accessPath);
  if (cached2 && cached2.signature.mtimeMs === stat.mtimeMs && cached2.signature.size === stat.size && cached2.signature.ino === stat.ino && !cached2.staleParseFailure) {
    if (cached2.missingSince !== void 0) {
      cache.set(accessPath, { ...cached2, missingSince: void 0 });
    }
    return {
      access: cached2.access,
      hasOwnerJidsField: cached2.hasOwnerJidsField,
      resolvable: true,
      lastKnownGood: false
    };
  }
  let parsed;
  try {
    const raw = import_node_fs2.default.readFileSync(accessPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    if (cached2) {
      cache.set(accessPath, { ...cached2, staleParseFailure: true });
      return {
        access: cached2.access,
        hasOwnerJidsField: cached2.hasOwnerJidsField,
        resolvable: true,
        lastKnownGood: true
      };
    }
    return {
      access: null,
      hasOwnerJidsField: false,
      resolvable: false,
      lastKnownGood: false
    };
  }
  const { access, hasOwnerJidsField } = normalizeAccessWithMeta(parsed);
  cache.set(accessPath, {
    access,
    hasOwnerJidsField,
    signature: { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino },
    staleParseFailure: false
  });
  return { access, hasOwnerJidsField, resolvable: true, lastKnownGood: false };
}
var MARKER_FILENAME = ".last-inbound.json";
var MARKER_VERSION = 1;
var MARKER_TTL_MS = 6e4;
var CLOCK_SKEW_MS = 5e3;
function ownerMatchesProcess(uid) {
  if (process.platform === "win32") return true;
  const pUid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (typeof pUid !== "number") return true;
  return uid === pUid;
}
function loadInboundContext(channelDir, cache, now = Date.now()) {
  const markerPath = import_node_path2.default.join(channelDir, MARKER_FILENAME);
  const NOFOLLOW = typeof import_node_fs2.default.constants.O_NOFOLLOW === "number" ? import_node_fs2.default.constants.O_NOFOLLOW : 0;
  const NONBLOCK = typeof import_node_fs2.default.constants.O_NONBLOCK === "number" ? import_node_fs2.default.constants.O_NONBLOCK : 0;
  const flags = import_node_fs2.default.constants.O_RDONLY | NOFOLLOW | NONBLOCK;
  try {
    const lst = import_node_fs2.default.lstatSync(markerPath);
    if (!lst.isFile()) {
      cache.delete(markerPath);
      return null;
    }
  } catch {
    cache.delete(markerPath);
    return null;
  }
  let fd;
  try {
    fd = import_node_fs2.default.openSync(markerPath, flags);
  } catch {
    cache.delete(markerPath);
    return null;
  }
  try {
    const stat = import_node_fs2.default.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (!ownerMatchesProcess(stat.uid)) return null;
    if ((stat.mode & 63) !== 0) return null;
    const signature = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode
    };
    const cached2 = cache.get(markerPath);
    if (cached2 && cached2.signature.mtimeMs === signature.mtimeMs && cached2.signature.size === signature.size && cached2.signature.ino === signature.ino && cached2.signature.uid === signature.uid && cached2.signature.mode === signature.mode) {
      if (now - cached2.inbound.ts > MARKER_TTL_MS || cached2.inbound.ts > now + CLOCK_SKEW_MS) {
        return null;
      }
      return cached2.inbound;
    }
    const MAX_MARKER_BYTES = 4096;
    const cap = Math.min(stat.size, MAX_MARKER_BYTES);
    const buf = Buffer.alloc(cap);
    const read = import_node_fs2.default.readSync(fd, buf, 0, cap, 0);
    let parsed;
    try {
      parsed = JSON.parse(buf.subarray(0, read).toString("utf8"));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed;
    if (o.version !== MARKER_VERSION) return null;
    if (typeof o.chatId !== "string" || !o.chatId) return null;
    if (typeof o.senderId !== "string" || !o.senderId) return null;
    if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return null;
    if (now - o.ts > MARKER_TTL_MS) return null;
    if (o.ts > now + CLOCK_SKEW_MS) return null;
    const inbound = {
      chatId: o.chatId,
      senderId: o.senderId,
      ts: o.ts
    };
    cache.set(markerPath, { inbound, signature });
    return inbound;
  } finally {
    try {
      import_node_fs2.default.closeSync(fd);
    } catch {
    }
  }
}
function createWhatsappAdapter(options) {
  const accessCache = /* @__PURE__ */ new Map();
  const inboundCache = /* @__PURE__ */ new Map();
  const channelDir = import_node_path2.default.dirname(options.accessPath);
  const configuredIdentity = options.configuredIdentity ?? "auto";
  const isAutoDiscovered = options.isAutoDiscovered ?? false;
  const probe = loadAccess(options.accessPath, accessCache);
  if (!probe.resolvable) return null;
  const adapter = {
    channel: "whatsapp",
    /**
     * Per-chunk granularity stays off. canSee uses the same
     * allowedChatIds bulk decision; per-chunk would only be needed
     * if we wanted to apply different rules per provenance sub-
     * class (e.g. legacy_unprovenanced extras), which we don't.
     */
    requiresPerChunkCheck: false,
    canSee(provenance, context) {
      if (provenance.class.kind !== "channel") return true;
      if (provenance.class.sourceChannel !== "whatsapp") return true;
      const allowed = adapter.allowedChatIds(context);
      if (allowed === null) return true;
      if (allowed.length === 0) return false;
      if (provenance.sourceChatId === null) return false;
      return allowed.includes(provenance.sourceChatId);
    },
    allowedChatIds(context) {
      const { access, hasOwnerJidsField } = loadAccess(
        options.accessPath,
        accessCache
      );
      if (!access) return [];
      void loadInboundContext(channelDir, inboundCache);
      return resolveAllowed(
        context,
        access,
        hasOwnerJidsField,
        configuredIdentity,
        // Codex post-impl 2nd-pass CRITICAL: out-of-band trust file
        // gates the `identity = "owner"` (and background system-owner)
        // unlocks so the agent can't escalate via agent_config alone.
        isOwnerTrusted("whatsapp"),
        // Codex 3rd-pass CRITICAL 2: bootstrap fail-open only honored
        // for auto-discovered upstream paths.
        isAutoDiscovered
      );
    }
  };
  return adapter;
}
function resolveAllowed(context, access, hasOwnerJidsField, configuredIdentity, trusted, isAutoDiscovered) {
  if (context.kind === "foreground" && context.ownerBypass) return null;
  if (context.kind === "foreground" && configuredIdentity === "guest") {
    return [];
  }
  if (context.kind === "background") {
    if (context.identity === "system-owner" && trusted) return null;
    return [];
  }
  if (!hasOwnerJidsField) return [];
  if (access.ownerJids.length === 0) {
    if (isAutoDiscovered) return null;
    if (trusted) return null;
    return [];
  }
  if (configuredIdentity === "owner" && trusted) return null;
  if (context.kind === "foreground" && context.envelope) {
    return scopedAllowedChatsFromEnvelope(context.envelope, access);
  }
  return [];
}
function scopedAllowedChatsFromEnvelope(envelope, access) {
  if (access.ownerJids.includes(envelope.senderId)) return null;
  const isGroup = envelope.chatId.endsWith("@g.us");
  const rawScope = isGroup ? access.groups[envelope.chatId]?.historyScope : access.dms[envelope.chatId]?.historyScope;
  const scope = rawScope ?? "own";
  if (scope === "all") return null;
  const universe = /* @__PURE__ */ new Set([
    ...access.allowFrom,
    ...Object.keys(access.groups)
  ]);
  if (scope === "own") {
    return [.../* @__PURE__ */ new Set([envelope.chatId])].filter((id) => universe.has(id));
  }
  if (Array.isArray(scope)) {
    return [.../* @__PURE__ */ new Set([envelope.chatId, ...scope])].filter(
      (id) => universe.has(id)
    );
  }
  return [.../* @__PURE__ */ new Set([envelope.chatId])].filter((id) => universe.has(id));
}

// lib/scope/scoped-paths.ts
var NTFS_RESERVED_BASENAMES = /* @__PURE__ */ new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
]);

// lib/scope/provenance.ts
var PROVENANCE_LRU_CAP = 1e4;
var REALPATH_LRU_CAP = 2048;
var LRU = class {
  cap;
  map = /* @__PURE__ */ new Map();
  constructor(cap) {
    this.cap = cap;
  }
  get(key) {
    const v = this.map.get(key);
    if (v === void 0) return void 0;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== void 0) this.map.delete(oldest);
    }
  }
  has(key) {
    return this.map.has(key);
  }
  clear() {
    this.map.clear();
  }
  size() {
    return this.map.size;
  }
};
var provenanceCache = new LRU(PROVENANCE_LRU_CAP);
var realpathCache = new LRU(REALPATH_LRU_CAP);

// lib/scope/runtime.ts
var ALL_KNOWN_SCOPE_CHANNELS = [
  "whatsapp",
  "telegram",
  "discord",
  "imessage",
  "webchat"
];
var RUNTIME_TTL_MS = 5e3;
var cached = null;
function detectScopeRuntime(config, workspaceRoot) {
  if (!config) {
    return { anyArmed: false, anyEnforceConfigured: false, channels: {} };
  }
  if (!config.scope) {
    purgeAllScopeAdapters();
    return { anyArmed: false, anyEnforceConfigured: false, channels: {} };
  }
  const baseCwd = workspaceRoot ?? process.cwd();
  const fingerprint = JSON.stringify({ scope: config.scope, baseCwd });
  const now = Date.now();
  if (cached && cached.configFingerprint === fingerprint && cached.expiresAt > now) {
    return cached.state;
  }
  const state = runDetection(config.scope, baseCwd);
  cached = {
    state,
    expiresAt: now + RUNTIME_TTL_MS,
    configFingerprint: fingerprint
  };
  return state;
}
function purgeAllScopeAdapters() {
  for (const ch of ALL_KNOWN_SCOPE_CHANNELS) {
    unregisterScopeAdapter(ch);
  }
}
function runDetection(scope, baseCwd) {
  const channels = {};
  if (scope.whatsapp) {
    channels.whatsapp = detectWhatsappArmed(scope.whatsapp, baseCwd);
  }
  for (const ch of ["telegram", "discord", "imessage", "webchat"]) {
    const cfg = scope[ch];
    if (!cfg) continue;
    channels[ch] = {
      mode: cfg.mode ?? "off",
      configured: true,
      adapterAvailable: false,
      governanceResolvable: false,
      armed: false,
      reason: "no adapter available for this channel yet"
    };
  }
  for (const ch of ALL_KNOWN_SCOPE_CHANNELS) {
    if (!channels[ch]?.armed) unregisterScopeAdapter(ch);
  }
  const anyArmed = Object.values(channels).some((c) => c?.armed);
  const anyEnforceConfigured = Object.values(channels).some(
    (c) => c?.mode === "enforce"
  );
  return { anyArmed, anyEnforceConfigured, channels };
}
function detectWhatsappArmed(cfg, baseCwd) {
  const mode = cfg.mode ?? "off";
  if (mode === "off") {
    return {
      mode: "off",
      configured: true,
      adapterAvailable: false,
      governanceResolvable: false,
      armed: false,
      reason: "mode is off"
    };
  }
  const accessPathResult = resolveAccessPath(cfg, baseCwd);
  if (!accessPathResult || !import_node_fs3.default.existsSync(accessPathResult.accessPath)) {
    return {
      mode,
      configured: true,
      adapterAvailable: false,
      governanceResolvable: false,
      armed: false,
      reason: "access.json not resolvable"
    };
  }
  const adapter = createWhatsappAdapter({
    accessPath: accessPathResult.accessPath,
    configuredIdentity: cfg.identity ?? "auto",
    // Codex 3rd-pass CRITICAL 2: bootstrap fail-open is only safe for
    // auto-discovered upstream governance. When the user (or a
    // prompt-injected agent) has set `accessJsonPath` to a custom
    // location, treat `ownerJids: []` as "malformed" rather than
    // "intentional bootstrap" — so an attacker can't point us at
    // agent-config.json (or any other writable file) and forge a
    // bootstrap-mode unlock.
    isAutoDiscovered: accessPathResult.isAutoDiscovered
  });
  if (!adapter) {
    return {
      mode,
      configured: true,
      adapterAvailable: false,
      governanceResolvable: false,
      armed: false,
      reason: "adapter could not resolve governance"
    };
  }
  registerScopeAdapter(adapter);
  return {
    mode,
    configured: true,
    adapterAvailable: true,
    governanceResolvable: true,
    armed: mode !== "off"
  };
}
function resolveAccessPath(cfg, baseCwd) {
  if (cfg.accessJsonPath && cfg.accessJsonPath !== "auto") {
    return { accessPath: cfg.accessJsonPath, isAutoDiscovered: false };
  }
  const home = import_node_os2.default.homedir();
  const projectDir = detectWhatsappProjectDir(home, baseCwd, {
    cwdExactMatchOnly: cfg.cwdExactMatchOnly === true
  });
  if (projectDir) {
    return {
      accessPath: import_node_path3.default.join(projectDir, ".whatsapp", "access.json"),
      isAutoDiscovered: true
    };
  }
  return {
    accessPath: import_node_path3.default.join(home, ".claude", "channels", "whatsapp", "access.json"),
    isAutoDiscovered: true
  };
}
function resolveWhatsappChannelDir(config, workspaceRoot) {
  const cfg = config?.scope?.whatsapp;
  if (!cfg || cfg.mode === "off") return null;
  const baseCwd = workspaceRoot ?? process.cwd();
  const result = resolveAccessPath(cfg, baseCwd);
  if (!result) return null;
  return import_node_path3.default.dirname(result.accessPath);
}
function discoverAllChannelGovernanceDirs(config, workspaceRoot) {
  const out = [];
  const cfgWa = config?.scope?.whatsapp;
  const baseCwd = workspaceRoot;
  const tryAdd = (cfg) => {
    try {
      const result = resolveAccessPath(cfg, baseCwd);
      if (!result) return;
      const dir = import_node_path3.default.dirname(result.accessPath);
      try {
        if (!import_node_fs3.default.existsSync(dir)) return;
      } catch {
        return;
      }
      out.push(dir);
    } catch {
    }
  };
  if (cfgWa) {
    tryAdd(cfgWa);
  } else {
    tryAdd({});
  }
  return Array.from(new Set(out));
}

// lib/scope/exec-gate.ts
var import_node_crypto = __toESM(require("node:crypto"), 1);
var import_node_fs6 = __toESM(require("node:fs"), 1);
var import_node_path6 = __toESM(require("node:path"), 1);

// lib/scope/envelope.ts
var import_fs3 = __toESM(require("fs"), 1);
var import_path3 = __toESM(require("path"), 1);
var ENVELOPE_DIR_NAME = ".request-envelopes";
var ENVELOPE_VERSION = 1;
var ENVELOPE_TTL_MS = 6e4;
var ENVELOPE_CLOCK_SKEW_TOLERANCE_MS = 5e3;
var ENVELOPE_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;
var ENVELOPE_MAX_BYTES = 1024;
var ENVELOPE_LRU_CONSUMED_TOKENS_CAP = 256;
var EnvelopeReader = class {
  cache = /* @__PURE__ */ new Map();
  /**
   * Resolve+validate envelope payload for the given token under the given
   * channel directory. Returns null on any failure (independence-preserving:
   * absent channel-dir → null, expired → null, etc.). Callers in `enforce`
   * mode MUST map null → guest `[]` allowlist.
   */
  load(channelDir, token, now = Date.now()) {
    if (typeof token !== "string") return null;
    if (!ENVELOPE_TOKEN_REGEX.test(token)) return null;
    const cached2 = this.cache.get(token);
    if (cached2) {
      if (now - cached2.firstSeenMs <= ENVELOPE_TTL_MS) {
        if (now - cached2.payload.ts <= ENVELOPE_TTL_MS && cached2.payload.ts <= now + ENVELOPE_CLOCK_SKEW_TOLERANCE_MS) {
          this.cache.delete(token);
          this.cache.set(token, cached2);
          return cached2.payload;
        }
      }
      this.cache.delete(token);
    }
    const envelopeDir = import_path3.default.join(channelDir, ENVELOPE_DIR_NAME);
    const filePath = import_path3.default.join(envelopeDir, `${token}.json`);
    let dirSt;
    try {
      dirSt = import_fs3.default.lstatSync(envelopeDir);
    } catch {
      return null;
    }
    if (dirSt.isSymbolicLink()) return null;
    if (!dirSt.isDirectory()) return null;
    if (!this.ownerMatches(dirSt.uid)) return null;
    if ((dirSt.mode & 63) !== 0) return null;
    let lst;
    try {
      lst = import_fs3.default.lstatSync(filePath);
    } catch {
      return null;
    }
    if (!lst.isFile()) return null;
    const NOFOLLOW = typeof import_fs3.default.constants.O_NOFOLLOW === "number" ? import_fs3.default.constants.O_NOFOLLOW : 0;
    const NONBLOCK = typeof import_fs3.default.constants.O_NONBLOCK === "number" ? import_fs3.default.constants.O_NONBLOCK : 0;
    const flags = import_fs3.default.constants.O_RDONLY | NOFOLLOW | NONBLOCK;
    let fd;
    try {
      fd = import_fs3.default.openSync(filePath, flags);
    } catch {
      return null;
    }
    try {
      const stat = import_fs3.default.fstatSync(fd);
      if (!stat.isFile()) return null;
      if (!this.ownerMatches(stat.uid)) return null;
      if ((stat.mode & 63) !== 0) return null;
      if (stat.size > ENVELOPE_MAX_BYTES) return null;
      if (stat.size <= 0) return null;
      const buf = Buffer.alloc(stat.size);
      const read = import_fs3.default.readSync(fd, buf, 0, stat.size, 0);
      if (read !== stat.size) return null;
      let raw;
      try {
        raw = buf.subarray(0, read).toString("utf8");
      } catch {
        return null;
      }
      const parsed = this.parseAndValidate(raw, token, now);
      if (!parsed) return null;
      try {
        const realFile = import_fs3.default.realpathSync.native(filePath);
        const realDir = import_fs3.default.realpathSync.native(envelopeDir);
        const expectedPrefix = realDir + import_path3.default.sep;
        if (realFile !== import_path3.default.join(realDir, `${token}.json`) && !realFile.startsWith(expectedPrefix)) {
          return null;
        }
        if (realFile.length <= realDir.length || !realFile.startsWith(expectedPrefix)) {
          return null;
        }
      } catch {
        return null;
      }
      this.recordConsumed(token, parsed, now);
      return parsed;
    } finally {
      try {
        import_fs3.default.closeSync(fd);
      } catch {
      }
    }
  }
  /**
   * Pure parser/validator. Exposed for tier1 testing of the validation
   * matrix without touching the filesystem.
   */
  parseAndValidate(raw, filenameToken, now = Date.now()) {
    if (!ENVELOPE_TOKEN_REGEX.test(filenameToken)) return null;
    if (raw.length > ENVELOPE_MAX_BYTES) return null;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const o = obj;
    if (o.version !== ENVELOPE_VERSION) return null;
    if (typeof o.token !== "string" || o.token !== filenameToken) return null;
    if (typeof o.chatId !== "string" || !o.chatId) return null;
    if (typeof o.senderId !== "string" || !o.senderId) return null;
    if (typeof o.ts !== "number" || !Number.isFinite(o.ts) || o.ts <= 0)
      return null;
    if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt))
      return null;
    if (o.expiresAt !== o.ts + ENVELOPE_TTL_MS) return null;
    if (now - o.ts > ENVELOPE_TTL_MS) return null;
    if (o.ts > now + ENVELOPE_CLOCK_SKEW_TOLERANCE_MS) return null;
    return {
      version: o.version,
      token: o.token,
      chatId: o.chatId,
      senderId: o.senderId,
      ts: o.ts,
      expiresAt: o.expiresAt
    };
  }
  ownerMatches(uid) {
    const procUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (procUid === null) return true;
    return uid === procUid;
  }
  recordConsumed(token, payload, now) {
    if (this.cache.size >= ENVELOPE_LRU_CONSUMED_TOKENS_CAP) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== void 0) this.cache.delete(oldestKey);
    }
    this.cache.set(token, { payload, firstSeenMs: now });
  }
  /** Test hook: clear the LRU cache. */
  clearCache() {
    this.cache.clear();
  }
  /** Test hook: inspect cache size. */
  cacheSize() {
    return this.cache.size;
  }
};

// lib/scope/protected-paths.ts
var import_node_fs4 = __toESM(require("node:fs"), 1);
var import_node_os3 = __toESM(require("node:os"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
function classifyProtectedPath(rawPath, opts) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  const home = opts.homeDir ?? import_node_os3.default.homedir();
  const platform = opts.platform ?? process.platform;
  const caseFold = platform === "darwin" || platform === "win32";
  let expanded = rawPath;
  if (expanded === "~") expanded = home;
  else if (expanded.startsWith("~/")) expanded = import_node_path4.default.join(home, expanded.slice(2));
  const absResolved = import_node_path4.default.resolve(opts.workspaceRoot, expanded);
  const abs = canonicalize(absResolved, caseFold);
  const specificFiles = [
    [import_node_path4.default.join(opts.pluginRoot, ".claude-plugin", "plugin.json"), "plugin-manifest"],
    [import_node_path4.default.join(opts.pluginRoot, ".mcp.json"), "plugin-mcp-config"],
    [import_node_path4.default.join(opts.workspaceRoot, ".mcp.json"), "workspace-mcp-config"],
    [import_node_path4.default.join(opts.workspaceRoot, "agent-config.json"), "workspace-agent-config"],
    [import_node_path4.default.join(opts.pluginRoot, "lib", "scope", "exec-gate.ts"), "exec-gate-source"],
    [import_node_path4.default.join(opts.pluginRoot, "lib", "scope", "exec-gate-hook-entry.ts"), "exec-gate-source"],
    [import_node_path4.default.join(opts.pluginRoot, "lib", "scope", "agent-config-guard.ts"), "agent-config-guard-source"],
    [import_node_path4.default.join(opts.pluginRoot, "lib", "scope", "protected-paths.ts"), "exec-gate-source"],
    [import_node_path4.default.join(opts.pluginRoot, "hooks", "hooks.json"), "plugin-hooks"],
    [import_node_path4.default.join(opts.pluginRoot, "hooks", "exec-gate-pretool.sh"), "plugin-hooks"],
    [import_node_path4.default.join(opts.pluginRoot, "dist", "exec-gate-resolver.cjs"), "exec-gate-source"]
  ];
  for (const cd of opts.channelDirs ?? []) {
    if (typeof cd !== "string" || cd.length === 0) continue;
    specificFiles.push([import_node_path4.default.join(cd, "access.json"), "channel-access-json"]);
  }
  for (const [target, reason] of specificFiles) {
    if (abs === canonicalize(target, caseFold)) {
      return { reason, matchedPrefix: target };
    }
  }
  const shellInitFiles = [
    import_node_path4.default.join(home, ".bashrc"),
    import_node_path4.default.join(home, ".bash_profile"),
    import_node_path4.default.join(home, ".profile"),
    import_node_path4.default.join(home, ".zshrc"),
    import_node_path4.default.join(home, ".zprofile"),
    import_node_path4.default.join(home, ".zshenv"),
    import_node_path4.default.join(home, ".config", "fish", "config.fish")
  ];
  for (const target of shellInitFiles) {
    if (abs === canonicalize(target, caseFold)) {
      return { reason: "shell-init", matchedPrefix: target };
    }
  }
  const dirRoots = [
    [import_node_path4.default.join(opts.pluginRoot, "hooks") + import_node_path4.default.sep, "plugin-hooks"],
    [import_node_path4.default.join(home, ".claude", "agent", "scope-trust") + import_node_path4.default.sep, "scope-trust-dir"],
    [import_node_path4.default.join(home, ".claude") + import_node_path4.default.sep, "claude-home"],
    [import_node_path4.default.join(home, ".ssh") + import_node_path4.default.sep, "ssh-dir"],
    [import_node_path4.default.join(home, ".aws") + import_node_path4.default.sep, "credential-dir"],
    [import_node_path4.default.join(home, ".gnupg") + import_node_path4.default.sep, "credential-dir"],
    [import_node_path4.default.join(home, ".kube") + import_node_path4.default.sep, "credential-dir"],
    [import_node_path4.default.join(home, ".docker") + import_node_path4.default.sep, "credential-dir"]
  ];
  if (platform === "darwin") {
    dirRoots.push([
      import_node_path4.default.join(home, "Library", "LaunchAgents") + import_node_path4.default.sep,
      "launch-agent"
    ]);
  }
  if (platform === "linux") {
    dirRoots.push([
      import_node_path4.default.join(home, ".config", "systemd", "user") + import_node_path4.default.sep,
      "systemd-user"
    ]);
  }
  dirRoots.sort((a, b) => b[0].length - a[0].length);
  const absWithSep = abs + import_node_path4.default.sep;
  for (const [prefix, reason] of dirRoots) {
    const canonicalRoot = canonicalize(prefix.slice(0, -1), caseFold);
    const canonicalRootWithSep = canonicalRoot + import_node_path4.default.sep;
    if (abs === canonicalRoot) {
      return { reason, matchedPrefix: prefix };
    }
    if (absWithSep.startsWith(canonicalRootWithSep)) {
      return { reason, matchedPrefix: prefix };
    }
  }
  return null;
}
function canonicalize(p, caseFold) {
  let cur = p;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = import_node_fs4.default.realpathSync.native(cur);
      const joined = tail.length === 0 ? real : import_node_path4.default.join(real, ...tail.reverse());
      return caseFold ? joined.toLowerCase() : joined;
    } catch {
      const parent = import_node_path4.default.dirname(cur);
      if (parent === cur) {
        return caseFold ? p.toLowerCase() : p;
      }
      tail.push(import_node_path4.default.basename(cur));
      cur = parent;
    }
  }
  return caseFold ? p.toLowerCase() : p;
}
var PROTECTED_PATH_TOOLS = /* @__PURE__ */ new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit"
]);
function extractToolPath(toolName, toolInput) {
  if (!PROTECTED_PATH_TOOLS.has(toolName)) return null;
  if (!toolInput || typeof toolInput !== "object") return null;
  const o = toolInput;
  if (toolName === "NotebookEdit") {
    if (typeof o.notebook_path === "string") return o.notebook_path;
    return null;
  }
  if (typeof o.file_path === "string") return o.file_path;
  return null;
}

// lib/scope/exec-gate-shadow-log.ts
var import_node_fs5 = __toESM(require("node:fs"), 1);
var import_node_path5 = __toESM(require("node:path"), 1);
var SHADOW_LOG_MAX_BYTES = 1048576;
var SHADOW_LOG_LOCK_TIMEOUT_MS = 200;
var SHADOW_LOG_LOCK_POLL_MS = 5;
var SHADOW_LOG_STALE_LOCK_MS = 3e4;
var DEFAULT_FILE_NAME = ".execgate-shadow.jsonl";
function appendShadowEvent(event, opts) {
  const fileName = opts.fileName ?? DEFAULT_FILE_NAME;
  const logPath = import_node_path5.default.join(opts.logDir, fileName);
  const backupPath = `${logPath}.1`;
  const lockDir = import_node_path5.default.join(opts.logDir, `${fileName}.lock`);
  try {
    import_node_fs5.default.mkdirSync(opts.logDir, { recursive: true });
  } catch {
    return { ok: false, reason: "io-error" };
  }
  const lockAcquired = acquireLock(lockDir, SHADOW_LOG_LOCK_TIMEOUT_MS);
  if (!lockAcquired) return { ok: false, reason: "lock-timeout" };
  try {
    const NOFOLLOW = typeof import_node_fs5.default.constants.O_NOFOLLOW === "number" ? import_node_fs5.default.constants.O_NOFOLLOW : 0;
    const flags = import_node_fs5.default.constants.O_WRONLY | import_node_fs5.default.constants.O_APPEND | import_node_fs5.default.constants.O_CREAT | NOFOLLOW;
    let canonicalSt = null;
    try {
      canonicalSt = import_node_fs5.default.lstatSync(logPath);
    } catch {
      canonicalSt = null;
    }
    if (canonicalSt && canonicalSt.isSymbolicLink()) {
      return { ok: false, reason: "symlink" };
    }
    if (canonicalSt && !canonicalSt.isFile()) {
      return { ok: false, reason: "symlink" };
    }
    const line = JSON.stringify(event) + "\n";
    const currentSize = canonicalSt ? canonicalSt.size : 0;
    if (currentSize + line.length > SHADOW_LOG_MAX_BYTES) {
      try {
        if (currentSize > 0) {
          import_node_fs5.default.renameSync(logPath, backupPath);
        }
      } catch {
        try {
          import_node_fs5.default.unlinkSync(logPath);
        } catch {
        }
      }
    }
    let fd;
    try {
      fd = import_node_fs5.default.openSync(logPath, flags, 384);
    } catch (err) {
      const e = err;
      if (e.code === "ELOOP") return { ok: false, reason: "symlink" };
      return { ok: false, reason: "io-error" };
    }
    try {
      const st = import_node_fs5.default.fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: "symlink" };
      if (process.platform !== "win32" && typeof process.getuid === "function") {
        if (st.uid !== process.getuid()) return { ok: false, reason: "symlink" };
      }
      const buf = Buffer.from(line, "utf-8");
      import_node_fs5.default.writeSync(fd, buf, 0, buf.length);
      try {
        import_node_fs5.default.fchmodSync(fd, 384);
      } catch {
      }
    } catch {
      return { ok: false, reason: "io-error" };
    } finally {
      try {
        import_node_fs5.default.closeSync(fd);
      } catch {
      }
    }
  } finally {
    releaseLock(lockDir);
  }
  return { ok: true };
}
function acquireLock(lockDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      import_node_fs5.default.mkdirSync(lockDir);
      return true;
    } catch (err) {
      const e = err;
      if (e.code === "EEXIST") {
        try {
          const st = import_node_fs5.default.statSync(lockDir);
          if (Date.now() - st.mtimeMs > SHADOW_LOG_STALE_LOCK_MS) {
            try {
              import_node_fs5.default.rmdirSync(lockDir);
              continue;
            } catch {
            }
          }
        } catch {
        }
        const waitUntil = Date.now() + SHADOW_LOG_LOCK_POLL_MS;
        while (Date.now() < waitUntil) {
        }
        continue;
      }
      return false;
    }
  }
  return false;
}
function releaseLock(lockDir) {
  try {
    import_node_fs5.default.rmdirSync(lockDir);
  } catch {
  }
}

// lib/scope/exec-gate.ts
var EXEC_GATE_HOOK_VERSION = 1;
var EXEC_GATE_DEFAULT_LOOKBACK_MS = 6e4;
var HARD_DENY_TOOLS_UNDER_ARMED = /* @__PURE__ */ new Set(["Bash", "Task"]);
var DEFAULT_DENYLIST_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  // MCP tool names use the prefix from `.mcp.json:mcpServers.<name>`.
  // ClawCode registers as `clawcode`; claude-whatsapp registers as `whatsapp`.
  "mcp__clawcode__agent_config",
  "mcp__clawcode__skill_install",
  "mcp__clawcode__skill_remove",
  "mcp__clawcode__dream"
];
var DEFAULT_ALLOWLIST_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "mcp__whatsapp__reply",
  "mcp__whatsapp__react",
  "mcp__clawcode__memory_search",
  "mcp__clawcode__memory_get",
  "mcp__clawcode__memory_context",
  "mcp__clawcode__voice_speak",
  "mcp__clawcode__voice_transcribe"
];
function resolve(input) {
  const now = input.now ?? Date.now();
  const reader = input.reader ?? new EnvelopeReader();
  const fsImpl = input.fsImpl ?? {
    readdirSync: (p) => import_node_fs6.default.readdirSync(p),
    statSync: (p) => import_node_fs6.default.statSync(p)
  };
  const effects = {
    isOwnerTrusted: input.effects?.isOwnerTrusted ?? isOwnerTrusted,
    recordShadow: input.effects?.recordShadow ?? ((event, logDir) => {
      try {
        appendShadowEvent(event, { logDir });
      } catch {
      }
    })
  };
  const toolPath = extractToolPath(input.toolName, input.toolInput);
  if (toolPath !== null) {
    const armedDirs = input.armed.map((a) => a.channelDir).filter((d) => typeof d === "string" && d.length > 0);
    const explicit = (input.protectedChannelDirs ?? []).filter(
      (d) => typeof d === "string" && d.length > 0
    );
    const channelDirs = Array.from(/* @__PURE__ */ new Set([...armedDirs, ...explicit]));
    const hit = classifyProtectedPath(toolPath, {
      pluginRoot: input.pluginRoot,
      workspaceRoot: input.workspaceRoot,
      channelDirs
    });
    if (hit) {
      return {
        decision: "block",
        reason: `exec-gate: write to protected path refused (${hit.reason})`,
        protectedPath: hit
      };
    }
  }
  const armedNonOff = input.armed.filter((c) => c.execGate.mode !== "off");
  if (armedNonOff.length === 0) {
    return { decision: "allow" };
  }
  const nonOwnerHits = [];
  for (const armed of armedNonOff) {
    if (armed.unresolved) {
      nonOwnerHits.push({
        armed,
        senderId: `__unresolved__:${armed.channel}`,
        envelopeCount: 0
      });
      continue;
    }
    const envelopes = scanEnvelopeWindow(
      armed.channelDir,
      armed.execGate.lookbackMs,
      now,
      reader,
      fsImpl
    );
    let firstNonOwnerSender = null;
    let count = 0;
    for (const env of envelopes) {
      if (!armed.ownerJids.includes(env.senderId)) {
        if (firstNonOwnerSender === null) firstNonOwnerSender = env.senderId;
        count++;
      }
    }
    if (firstNonOwnerSender !== null) {
      nonOwnerHits.push({ armed, senderId: firstNonOwnerSender, envelopeCount: count });
    }
  }
  if (nonOwnerHits.length === 0) {
    return { decision: "allow" };
  }
  const effectiveHits = nonOwnerHits.filter(
    (h) => !effects.isOwnerTrusted(h.armed.channel, "exec")
  );
  if (effectiveHits.length === 0) {
    return { decision: "allow" };
  }
  const inHardDeny = HARD_DENY_TOOLS_UNDER_ARMED.has(input.toolName);
  function wouldBlockUnder(h) {
    if (inHardDeny) return true;
    if (h.armed.execGate.policy === "denylist") {
      return h.armed.execGate.tools.includes(input.toolName);
    }
    return !h.armed.execGate.tools.includes(input.toolName);
  }
  const enforceHits = effectiveHits.filter((h) => h.armed.execGate.mode === "enforce");
  for (const h of enforceHits) {
    if (wouldBlockUnder(h)) {
      const senderHash = shortHash(h.senderId);
      return {
        decision: "block",
        reason: `exec-gate: ${input.toolName} blocked for non-owner inbound in window (${h.armed.channel}:${senderHash})`,
        channel: h.armed.channel,
        senderHash
      };
    }
  }
  const shadowHits = effectiveHits.filter((h) => h.armed.execGate.mode === "shadow");
  for (const h of shadowHits) {
    if (wouldBlockUnder(h)) {
      const senderHash = shortHash(h.senderId);
      const event = {
        ts: new Date(now).toISOString(),
        channel: h.armed.channel,
        senderHash,
        toolName: input.toolName,
        decision: "would-block",
        effectiveMode: "shadow",
        policy: h.armed.execGate.policy,
        expandedTools: [...h.armed.execGate.tools],
        hookVersion: EXEC_GATE_HOOK_VERSION,
        configHash: configHash(h.armed.execGate),
        lookbackMs: h.armed.execGate.lookbackMs,
        windowEnvelopeCount: h.envelopeCount
      };
      effects.recordShadow(event, input.memoryDir);
      return {
        decision: "shadow",
        reason: `exec-gate (shadow): ${input.toolName} would block for non-owner inbound in window (${h.armed.channel}:${senderHash})`,
        channel: h.armed.channel,
        senderHash
      };
    }
  }
  return { decision: "allow" };
}
function scanEnvelopeWindow(channelDir, lookbackMs, now, reader, fsImpl) {
  const envelopeDir = import_node_path6.default.join(channelDir, ENVELOPE_DIR_NAME);
  let entries;
  try {
    entries = fsImpl.readdirSync(envelopeDir);
  } catch {
    return [];
  }
  const cutoff = now - lookbackMs;
  const out = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const token = name.slice(0, -5);
    let st;
    try {
      st = fsImpl.statSync(import_node_path6.default.join(envelopeDir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs < cutoff) continue;
    const payload = reader.load(channelDir, token, now);
    if (payload) out.push(payload);
  }
  return out;
}
function shortHash(input) {
  return import_node_crypto.default.createHash("sha256").update(input).digest("hex").slice(0, 8);
}
function configHash(cfg) {
  const stable = JSON.stringify({
    mode: cfg.mode,
    policy: cfg.policy,
    tools: [...cfg.tools].sort(),
    lookbackMs: cfg.lookbackMs
  });
  return import_node_crypto.default.createHash("sha256").update(stable).digest("hex").slice(0, 16);
}
function coerceExecGateConfig(raw) {
  const enforceFallback = {
    mode: "enforce",
    policy: "denylist",
    tools: [...DEFAULT_DENYLIST_TOOLS],
    lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS
  };
  if (raw === void 0) {
    return {
      mode: "off",
      policy: "denylist",
      tools: [...DEFAULT_DENYLIST_TOOLS],
      lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return enforceFallback;
  }
  const r = raw;
  let invalid = false;
  let mode;
  if (r.mode === "off" || r.mode === "shadow" || r.mode === "enforce") {
    mode = r.mode;
  } else if (r.mode === void 0) {
    mode = "off";
  } else {
    invalid = true;
    mode = enforceFallback.mode;
  }
  let policy;
  if (r.policy === "denylist" || r.policy === "allowlist") {
    policy = r.policy;
  } else if (r.policy === void 0) {
    policy = "denylist";
  } else {
    invalid = true;
    policy = enforceFallback.policy;
  }
  let tools;
  if (Array.isArray(r.tools)) {
    if (r.tools.length === 0) {
      tools = policy === "allowlist" ? [...DEFAULT_ALLOWLIST_TOOLS] : [...DEFAULT_DENYLIST_TOOLS];
    } else {
      const cleaned = r.tools.filter((x) => typeof x === "string");
      if (cleaned.length === r.tools.length) {
        tools = cleaned;
      } else {
        invalid = true;
        tools = policy === "allowlist" ? [...DEFAULT_ALLOWLIST_TOOLS] : [...DEFAULT_DENYLIST_TOOLS];
      }
    }
  } else if (r.tools === void 0) {
    tools = policy === "allowlist" ? [...DEFAULT_ALLOWLIST_TOOLS] : [...DEFAULT_DENYLIST_TOOLS];
  } else {
    invalid = true;
    tools = policy === "allowlist" ? [...DEFAULT_ALLOWLIST_TOOLS] : [...DEFAULT_DENYLIST_TOOLS];
  }
  let lookbackMs;
  const LOOKBACK_MS_MAX = 9e12;
  if (typeof r.lookbackMs === "number" && Number.isFinite(r.lookbackMs) && r.lookbackMs > 0 && r.lookbackMs < LOOKBACK_MS_MAX) {
    lookbackMs = Math.floor(r.lookbackMs);
  } else if (r.lookbackMs === void 0) {
    lookbackMs = EXEC_GATE_DEFAULT_LOOKBACK_MS;
  } else {
    invalid = true;
    lookbackMs = EXEC_GATE_DEFAULT_LOOKBACK_MS;
  }
  if (invalid) {
    return enforceFallback;
  }
  return { mode, policy, tools, lookbackMs };
}
function execGateConfigForChannel(scope, channel) {
  const channelCfg = scope?.[channel];
  const raw = channelCfg?.execGate;
  return coerceExecGateConfig(raw);
}

// lib/scope/exec-gate-hook-entry.ts
async function main() {
  let stdin;
  try {
    stdin = await readStdin();
  } catch {
    return 0;
  }
  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return 0;
  }
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!toolName) return 0;
  const toolInput = payload.tool_input ?? {};
  const workspaceRoot = process.env.CLAUDE_PROJECT_DIR ?? (typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? import_node_path7.default.resolve(__dirname, "..", "..");
  const memoryDir = import_node_path7.default.join(workspaceRoot, "memory");
  const armed = [];
  const protectedChannelDirs = [];
  const accessCache = /* @__PURE__ */ new Map();
  const configResult = tryLoadConfig(workspaceRoot);
  if (configResult.ok) {
    const cfg = configResult.config;
    for (const channel of configResult.malformedChannels) {
      armed.push({
        channel,
        channelDir: "",
        ownerJids: [],
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: 6e4
        },
        unresolved: true
      });
    }
    if (cfg.scope) {
      let runtime = null;
      try {
        runtime = detectScopeRuntime(cfg, workspaceRoot);
      } catch {
        runtime = null;
      }
      const channelsToEnumerate = /* @__PURE__ */ new Set([
        ...Object.keys(runtime?.channels ?? {}),
        ...Object.keys(cfg.scope)
      ]);
      for (const channel of channelsToEnumerate) {
        let execGate;
        try {
          execGate = execGateConfigForChannel(cfg.scope, channel);
        } catch {
          armed.push({
            channel,
            channelDir: "",
            ownerJids: [],
            execGate: {
              mode: "enforce",
              policy: "denylist",
              tools: [...DEFAULT_DENYLIST_TOOLS],
              lookbackMs: 6e4
            },
            unresolved: true
          });
          continue;
        }
        if (execGate.mode === "off") continue;
        let channelDir = null;
        try {
          if (channel === "whatsapp") {
            channelDir = resolveWhatsappChannelDir(cfg, workspaceRoot);
          }
        } catch {
          channelDir = null;
        }
        if (!channelDir) {
          armed.push({
            channel,
            channelDir: "",
            ownerJids: [],
            execGate,
            unresolved: true
          });
          continue;
        }
        let access;
        try {
          access = loadAccess(import_node_path7.default.join(channelDir, "access.json"), accessCache);
        } catch {
          access = { resolvable: false, access: null };
        }
        if (!access.resolvable || !access.access) {
          armed.push({
            channel,
            channelDir,
            ownerJids: [],
            execGate,
            unresolved: true
          });
          continue;
        }
        armed.push({
          channel,
          channelDir,
          ownerJids: access.access.ownerJids ?? [],
          execGate
        });
      }
    }
  } else if (configResult.armPolicy === "fail-closed") {
    for (const channel of KNOWN_SCOPE_CHANNELS) {
      armed.push({
        channel,
        channelDir: "",
        ownerJids: [],
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: 6e4
        },
        unresolved: true
      });
    }
  }
  try {
    const cfgForDiscovery = configResult.ok ? configResult.config : void 0;
    const extraDirs = discoverAllChannelGovernanceDirs(
      cfgForDiscovery,
      workspaceRoot
    );
    for (const d of extraDirs) {
      if (!protectedChannelDirs.includes(d)) protectedChannelDirs.push(d);
    }
  } catch {
  }
  const decision = resolve({
    toolName,
    toolInput,
    pluginRoot,
    workspaceRoot,
    memoryDir,
    armed,
    protectedChannelDirs
  });
  if (decision.decision === "block") {
    process.stderr.write(decision.reason + "\n");
    return 2;
  }
  return 0;
}
var KNOWN_SCOPE_CHANNELS = [
  "whatsapp",
  "telegram",
  "discord",
  "imessage",
  "webchat"
];
function tryLoadConfig(workspaceRoot) {
  const configPath = import_node_path7.default.join(workspaceRoot, "agent-config.json");
  let exists = false;
  try {
    exists = import_node_fs7.default.existsSync(configPath);
  } catch {
    return { ok: false, armPolicy: "fail-closed" };
  }
  if (!exists) {
    return { ok: false, armPolicy: "noop" };
  }
  let rawJson;
  try {
    const raw = import_node_fs7.default.readFileSync(configPath, "utf-8");
    rawJson = JSON.parse(raw);
  } catch {
    return { ok: false, armPolicy: "fail-closed" };
  }
  const malformedChannels = [];
  const rawScope = rawJson?.scope;
  if (rawScope && typeof rawScope === "object" && !Array.isArray(rawScope)) {
    for (const channel of KNOWN_SCOPE_CHANNELS) {
      const v = rawScope[channel];
      if (v === void 0) continue;
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        malformedChannels.push(channel);
      }
    }
  }
  try {
    return {
      ok: true,
      config: loadConfig(workspaceRoot),
      malformedChannels
    };
  } catch {
    return { ok: false, armPolicy: "fail-closed" };
  }
}
async function readStdin() {
  const chunks = [];
  let total = 0;
  const MAX = 256 * 1024;
  return await new Promise((resolveProm, rejectProm) => {
    process.stdin.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX) {
        rejectProm(new Error("stdin too large"));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      resolveProm(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", rejectProm);
  });
}
main().then((code) => {
  process.exit(code);
}).catch(() => {
  process.exit(0);
});
setTimeout(() => {
  process.exit(0);
}, 5e3).unref();
