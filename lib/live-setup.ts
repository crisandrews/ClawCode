/** Local setup only. No plugin installation, service changes or model calls. */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { detectChannels, type DetectionOptions } from "./channel-detector.ts";
import { readLiveToken } from "./live-credentials.mjs";
import { withLiveChannel } from "./service-generator.ts";
export { readLiveToken } from "./live-credentials.mjs";

type ObjectValue = Record<string, any>;
export interface LiveSetupOptions {
  enabled?: boolean;
  bridgePort?: number;
  webPort?: number;
  maxConcurrent?: number;
  /** Exact argv from the existing launch; never a shell command to parse. */
  extraArgs?: string[];
  liveChannelTarget?: string;
}
export interface LiveSetupRuntime {
  /** Supplied by the host that performed native Channels verification. */
  channelVerified?: boolean;
  listenerActive?: boolean;
  bridgePort?: number;
  /** Raw liveBridge config captured when THIS runtime started, not hot-reloaded. */
  activeConfig?: Record<string, unknown>;
  /** Read-only detector overrides, useful for isolated tests. */
  detection?: DetectionOptions;
  env?: NodeJS.ProcessEnv;
}
export interface LiveSetupStatus {
  workspace: string;
  configured: boolean;
  enabled: boolean;
  credential: "missing" | "environment" | "file";
  managed: boolean;
  bridgePort: number;
  webPort: number;
  bridgeListener: "listening" | "not_listening" | "unknown";
  webListener: "listening" | "not_listening" | "unknown";
  channelVerified: boolean | null;
  runtimeActive: boolean | null;
  restartPending: boolean;
  configurationMatchesRuntime: boolean | null;
  /** A TCP listener is never proof of the process or native session identity. */
  listenerIdentity: "unverified";
}
export interface LiveSetupPlan {
  version: 1;
  workspace: string;
  fingerprint: string;
  options: Required<Pick<LiveSetupOptions, "enabled" | "bridgePort" | "webPort" | "maxConcurrent" | "liveChannelTarget">> & Pick<LiveSetupOptions, "extraArgs">;
  paths: { config: string; tokenFile: string; envFile: string };
  status: LiveSetupStatus;
  preflight: Pick<LiveSetupStatus, "bridgePort" | "webPort" | "bridgeListener" | "webListener">;
  changes: string[];
  blockers: string[];
  warnings: string[];
  commands: { apply: string; marketplace: string; install: string; configure: string; launch: string };
  pluginConfig: { connect_session: false; web_port: number; env_file: string };
  launch: { executable: "claude"; args: string[]; env: Record<string, string>; unsetEnv: string[]; argumentsConfirmed: boolean; command: string };
  restartRequired: true;
  appliesServices: false;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const ownUid = () => process.getuid?.();
const noFollow = fs.constants.O_NOFOLLOW ?? 0;
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quote = (arg: string) => `'${arg.replace(/'/g, `'"'"'`)}'`;
const command = (args: string[]) => args.map(quote).join(" ");

function workspacePath(workspace: string): string {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error("An explicit absolute workspace is required");
  let result: string;
  try { result = fs.realpathSync(workspace); } catch { throw new Error("Workspace does not exist"); }
  if (!fs.statSync(result).isDirectory()) throw new Error("Workspace is not a directory");
  return result;
}
function pathsFor(workspace: string) {
  const directory = path.join(workspace, ".clawcode-live");
  return { config: path.join(workspace, "agent-config.json"), directory,
    tokenFile: path.join(directory, "bridge.token"), envFile: path.join(directory, "claude-live.env"),
    owner: path.join(directory, "setup-owner.json"), lock: path.join(directory, "setup.lock") };
}
function statIfExists(filename: string): fs.Stats | undefined {
  try { return fs.lstatSync(filename); } catch (e: any) { if (e.code === "ENOENT") return; throw new Error("Cannot inspect setup path"); }
}
function safeDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (ownUid() !== undefined && stat.uid !== ownUid())) {
    throw new Error("Setup directory must be a private, owned directory (0700), not a symlink");
  }
}
function safeFileStat(stat: fs.Stats, privateFile: boolean): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (ownUid() !== undefined && stat.uid !== ownUid())
    || (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0) {
    throw new Error(privateFile ? "Secret/setup file must be private (0600), owned and not linked" : "Config must be an owned regular file without group/world write permission");
  }
  if (stat.size > 1024 * 1024) throw new Error("Setup file exceeds the size limit");
}
/** Validate before reading: never read a symlink, shared inode or public secret. */
function readFile(filename: string, privateFile: boolean): string {
  const before = fs.lstatSync(filename); safeFileStat(before, privateFile);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | noFollow);
  try {
    const actual = fs.fstatSync(fd); safeFileStat(actual, privateFile);
    if (actual.ino !== before.ino || actual.dev !== before.dev) throw new Error("Setup file changed while reading");
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}
function configAt(workspace: string) {
  const filename = pathsFor(workspace).config;
  if (!statIfExists(filename)) return { value: {} as ObjectValue, raw: "", exists: false };
  const raw = readFile(filename, false);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("agent-config.json is invalid JSON; no setup files were changed"); }
  if (!object(value) || (value.liveBridge !== undefined && !object(value.liveBridge))
    || (value.liveBridge?.leaderPolicy !== undefined && !object(value.liveBridge.leaderPolicy))) {
    throw new Error("agent-config.json and liveBridge/leaderPolicy must be objects");
  }
  return { value, raw, exists: true };
}
interface Owner { version: 1; workspace: string; tokenFile: string; envFile: string; tokenDigest: string; }
function inspectFiles(workspace: string) {
  const paths = pathsFor(workspace);
  let owner: Owner | undefined;
  let ownerRaw = "", envRaw = "";
  if (statIfExists(paths.directory)) safeDirectory(paths.directory);
  if (statIfExists(paths.owner)) {
    ownerRaw = readFile(paths.owner, true);
    try { owner = JSON.parse(ownerRaw); } catch { throw new Error("Setup ownership record is invalid"); }
    if (!owner || owner.version !== 1 || owner.workspace !== workspace || owner.tokenFile !== paths.tokenFile || owner.envFile !== paths.envFile) {
      throw new Error("Setup ownership does not match this workspace; no files will be replaced");
    }
  }
  const tokenExists = !!statIfExists(paths.tokenFile), envExists = !!statIfExists(paths.envFile);
  if (!owner && (tokenExists || envExists)) throw new Error("Unowned setup files already exist; refusing to replace credentials");
  if (owner && (!tokenExists || !envExists)) throw new Error("Owned setup is incomplete; review it before applying a new plan");
  if (tokenExists && sha(readLiveToken(workspace, { tokenFile: paths.tokenFile })!) !== owner?.tokenDigest) throw new Error("Owned credential changed; refusing unsafe replacement");
  if (envExists) envRaw = readFile(paths.envFile, true);
  return { paths, owner, ownerRaw, envRaw };
}
function numberOption(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || (result as number) < min || (result as number) > max) throw new Error(`Invalid ${name}`);
  return result as number;
}
function normalize(options: LiveSetupOptions, config: ObjectValue, envRaw: string): LiveSetupPlan["options"] {
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") throw new Error("enabled must be a boolean");
  const bridgePort = numberOption(options.bridgePort, config.liveBridge?.port ?? 18791, 1024, 65535, "bridgePort");
  const storedWeb = /^# web_port=(\d+)$/m.exec(envRaw)?.[1];
  const webPort = numberOption(options.webPort, config.liveBridge?.webPort ?? (storedWeb ? Number(storedWeb) : 3210), 1024, 65535, "webPort");
  if (webPort === bridgePort) throw new Error("Bridge and web ports must differ");
  const maxConcurrent = numberOption(options.maxConcurrent, config.liveBridge?.leaderPolicy?.maxConcurrent ?? 3, 1, 100, "maxConcurrent");
  const liveChannelTarget = options.liveChannelTarget ?? config.liveBridge?.channelTarget ?? "plugin:agent@clawcode";
  if (!/^(?:plugin:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+|server:[A-Za-z0-9._-]+)$/.test(liveChannelTarget)) throw new Error("Invalid Live channel target");
  if (liveChannelTarget === "plugin:claude-live@claude-live") throw new Error("The Live channel target must identify ClawCode, not a second ClaudeLive host");
  if (options.extraArgs !== undefined && (!Array.isArray(options.extraArgs) || options.extraArgs.length > 128
    || options.extraArgs.some(arg => typeof arg !== "string" || arg.length > 4096 || /[\0\r\n]/.test(arg)))) throw new Error("extraArgs must be a bounded argv array without control characters");
  if (options.extraArgs?.some(arg => arg.includes("plugin:claude-live@claude-live"))) throw new Error("Do not enable a second ClaudeLive host channel alongside ClawCode Live");
  return { enabled: options.enabled ?? true, bridgePort, webPort, maxConcurrent, liveChannelTarget, ...(options.extraArgs === undefined ? {} : { extraArgs: [...options.extraArgs] }) };
}
function fingerprint(workspace: string, raw: string, exists: boolean, files: ReturnType<typeof inspectFiles>, options: LiveSetupPlan["options"], credential?: string) {
  // Opaque digests only; neither raw config nor secret bytes leave this module.
  return sha(JSON.stringify({ workspace, config: sha(`${exists}:${raw}`), owner: sha(files.ownerRaw), env: sha(files.envRaw), credential: options.enabled ? sha(credential ?? "") : undefined, options }));
}
async function listener(port: number): Promise<LiveSetupStatus["bridgeListener"]> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (status: LiveSetupStatus["bridgeListener"]) => { socket.destroy(); resolve(status); };
    socket.setTimeout(300, () => done("unknown"));
    socket.once("connect", () => done("listening"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED" ? "not_listening" : "unknown"));
  });
}
async function statusFor(workspace: string, config: ObjectValue, files: ReturnType<typeof inspectFiles>, options: LiveSetupPlan["options"], runtime: LiveSetupRuntime): Promise<LiveSetupStatus> {
  const bridge = config.liveBridge ?? {};
  const token = readLiveToken(workspace, bridge, runtime.env);
  const [bridgeListener, webListener] = await Promise.all([listener(options.bridgePort), listener(options.webPort)]);
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const portMismatch = runtime.listenerActive === true && runtime.bridgePort !== undefined && runtime.bridgePort !== (bridge.port ?? 18791);
  const configurationMatchesRuntime = runtime.listenerActive === true && runtime.activeConfig
    ? !portMismatch && JSON.stringify(stable(runtime.activeConfig)) === JSON.stringify(stable(bridge))
    : portMismatch ? false : null;
  return { workspace, configured: !!config.liveBridge, enabled: bridge.enabled === true, credential: token ? (bridge.tokenFile ? "file" : "environment") : "missing",
    managed: !!files.owner, bridgePort: options.bridgePort, webPort: options.webPort, bridgeListener, webListener,
    channelVerified: runtime.listenerActive === true && configurationMatchesRuntime !== false ? runtime.channelVerified ?? null : null,
    runtimeActive: runtime.listenerActive ?? null, configurationMatchesRuntime,
    restartPending: (runtime.listenerActive !== undefined && runtime.listenerActive !== (bridge.enabled === true)) || configurationMatchesRuntime === false, listenerIdentity: "unverified" };
}
export async function getLiveSetupStatus(workspace: string, runtime: LiveSetupRuntime = {}): Promise<LiveSetupStatus> {
  const canonical = workspacePath(workspace), config = configAt(canonical), files = inspectFiles(canonical);
  return statusFor(canonical, config.value, files, normalize({}, config.value, files.envRaw), runtime);
}
function launchArgs(options: LiveSetupPlan["options"], workspace: string, runtime: LiveSetupRuntime): string[] {
  const args = [...(options.extraArgs ?? [])];
  for (const channel of options.extraArgs === undefined ? detectChannels({ ...runtime.detection, cwd: workspace }) : []) {
    if (!channel.osSupported || channel.installed !== "yes" || channel.authenticated !== "yes") continue;
    if (channel.kind === "development") args.push("--dangerously-load-development-channels", channel.pluginId);
    else if (channel.kind === "official") args.push("--channels", channel.pluginId);
  }
  return withLiveChannel(args, options.liveChannelTarget);
}
export async function createLiveSetupPlan(workspace: string, options: LiveSetupOptions = {}, runtime: LiveSetupRuntime = {}): Promise<LiveSetupPlan> {
  const canonical = workspacePath(workspace), config = configAt(canonical), files = inspectFiles(canonical);
  const normalized = normalize(options, config.value, files.envRaw);
  const status = await statusFor(canonical, config.value, files, normalize({}, config.value, files.envRaw), runtime);
  const [bridgeListener, webListener] = await Promise.all([
    normalized.bridgePort === status.bridgePort ? status.bridgeListener : listener(normalized.bridgePort),
    normalized.webPort === status.webPort ? status.webListener : listener(normalized.webPort),
  ]);
  const preflight = { bridgePort: normalized.bridgePort, webPort: normalized.webPort, bridgeListener, webListener };
  const credential = readLiveToken(canonical, config.value.liveBridge ?? {}, runtime.env);
  const id = fingerprint(canonical, config.raw, config.exists, files, normalized, credential);
  const blockers: string[] = [], warnings: string[] = [];
  const bridge = config.value.liveBridge ?? {};
  if (normalized.enabled) {
    if (credential && !/^[A-Za-z0-9_\-+/=.]{32,512}$/.test(credential)) blockers.push("Existing credential cannot be encoded safely in the managed environment file; preserve it and review migration explicitly.");
    if (bridge.tokenFile && bridge.tokenFile !== files.paths.tokenFile) blockers.push("Existing tokenFile is not owned by this setup; preserve it and review migration explicitly.");
    if (!files.owner && (bridge.enabled === true || bridge.tokenEnv !== undefined || bridge.tokenFile !== undefined) && status.credential === "missing") blockers.push("Existing Live credential is missing. Supply the configured environment credential before migration; setup will not rotate it.");
    if (!files.owner && preflight.bridgeListener === "listening" && bridge.port !== normalized.bridgePort) blockers.push("Requested bridge port is occupied by an unidentified listener. Choose a free port; setup will not stop it.");
    if (files.owner && (bridge.port ?? 18791) !== normalized.bridgePort && preflight.bridgeListener === "listening") blockers.push("The new bridge port is occupied by an unidentified listener.");
  }
  if (preflight.webListener !== "not_listening") warnings.push("Web port availability does not verify ownership. Check the existing ClaudeLive instance before launching or changing its port.");
  if (preflight.bridgeListener === "listening") warnings.push("The bridge listener was not authenticated by setup; saved configuration does not change an already running host.");
  if (options.extraArgs === undefined) warnings.push("Existing launch arguments were not supplied. Preserve the current session, permissions and channel arguments before relaunching; this is not a complete restart command.");
  if (bridge.leaderPolicy?.tools === "delegate_operations") warnings.push("Setup changes the leader tool policy to host_native so the ClawCode agent retains its existing native tools and scope guards.");
  const applyArgs = [path.join(toolRoot, "node_modules", ".bin", "tsx"), path.join(toolRoot, "scripts", "live-setup.ts"), "apply", "--workspace", canonical,
    "--expected-fingerprint", id, "--enabled", String(normalized.enabled), "--bridge-port", String(normalized.bridgePort), "--web-port", String(normalized.webPort), "--max-concurrent", String(normalized.maxConcurrent), "--live-channel-target", normalized.liveChannelTarget,
    ...(normalized.extraArgs === undefined ? [] : ["--", ...normalized.extraArgs])];
  const args = launchArgs(normalized, canonical, runtime);
  const launchEnv = { CLAUDE_CODE_FORK_SUBAGENT: "1", CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(normalized.maxConcurrent),
    CLAUDE_LIVE_HOST_BRIDGE: "0", CLAUDE_LIVE_PORT: String(normalized.webPort), CLAUDE_LIVE_ENV_FILE: files.paths.envFile };
  const unsetEnv = ["CLAUDE_LIVE_BRIDGE_URL", "CLAUDE_LIVE_BRIDGE_TOKEN", "CLAUDE_LIVE_DEFAULT_MODE"];
  const launchCommand = command(["env", ...unsetEnv.flatMap(key => ["-u", key]), ...Object.entries(launchEnv).map(([key, value]) => `${key}=${value}`), "claude", ...args]);
  return { version: 1, workspace: canonical, fingerprint: id, options: normalized,
    paths: { config: files.paths.config, tokenFile: files.paths.tokenFile, envFile: files.paths.envFile }, status, preflight, blockers, warnings,
    changes: normalized.enabled ? ["Merge only liveBridge in agent-config.json: enabled, observed hooks, chosen port and host_native leader policy.", "Create or reuse one private local credential and protected ClaudeLive environment file.", "Keep WhatsApp, permissions, memory, session state and all unrelated configuration unchanged."]
      : ["Set only liveBridge.enabled=false. Keep credentials, conversation state and all unrelated configuration unchanged.", "The running host changes only after its normal operator-controlled restart; setup does not stop it."],
    commands: { apply: command(applyArgs), marketplace: "claude plugin marketplace add crisandrews/ClaudeLive",
      install: command(["claude", "plugin", "install", "claude-live@claude-live", "--scope", "local"]),
      configure: "/plugin configure claude-live@claude-live", launch: launchCommand },
    pluginConfig: { connect_session: false, web_port: normalized.webPort, env_file: files.paths.envFile },
    launch: { executable: "claude", args, env: launchEnv, unsetEnv, argumentsConfirmed: options.extraArgs !== undefined, command: launchCommand },
    restartRequired: true, appliesServices: false };
}

function writeExclusive(filename: string, content: string): void {
  const fd = fs.openSync(filename, "wx", 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
  catch (error) { try { fs.unlinkSync(filename); } catch {} throw error; }
  finally { fs.closeSync(fd); }
}
function envContent(port: number, webPort: number, token: string) {
  if (!/^[A-Za-z0-9_\-+/=.]{32,512}$/.test(token)) throw new Error("Setup credential cannot be safely encoded in an environment file; preserve the existing credential and review migration");
  return `# Managed by ClawCode Live setup. Contains a private credential.\n# web_port=${webPort}\nCLAUDE_LIVE_BRIDGE_URL=http://127.0.0.1:${port}\nCLAUDE_LIVE_BRIDGE_TOKEN=${token}\nCLAUDE_LIVE_DEFAULT_MODE=external\n`;
}
/** Only the explicitly invoked local helper calls this mutating function. */
export async function applyLiveSetup(workspace: string, options: LiveSetupOptions & { expectedFingerprint: string }, runtime: LiveSetupRuntime = {}) {
  const plan = await createLiveSetupPlan(workspace, options, runtime);
  if (!options.expectedFingerprint || options.expectedFingerprint !== plan.fingerprint) throw new Error("Setup plan is stale; request a fresh plan before applying");
  if (plan.blockers.length) throw new Error(`Setup cannot be applied: ${plan.blockers.join(" ")}`);
  const paths = pathsFor(plan.workspace), created: string[] = [];
  let createdDirectory = false, lockOwned = false, committed = false;
  let previousEnv: string | undefined, envReplaced = false;
  const envTemp = path.join(paths.directory, `.setup-env-${randomUUID()}.tmp`);
  const configTemp = path.join(plan.workspace, `.agent-config-live-${randomUUID()}.tmp`);
  try {
    if (!statIfExists(paths.directory)) { fs.mkdirSync(paths.directory, { mode: 0o700 }); createdDirectory = true; }
    safeDirectory(paths.directory);
    writeExclusive(paths.lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() })); lockOwned = true;
    const config = configAt(plan.workspace), files = inspectFiles(plan.workspace);
    const credential = readLiveToken(plan.workspace, config.value.liveBridge ?? {}, runtime.env);
    if (fingerprint(plan.workspace, config.raw, config.exists, files, plan.options, credential) !== plan.fingerprint) throw new Error("Setup plan is stale; configuration changed before apply");
    const token = plan.options.enabled ? (files.owner ? readLiveToken(plan.workspace, { tokenFile: paths.tokenFile })! : credential ?? randomBytes(32).toString("base64url")) : "";
    const encodedEnv = plan.options.enabled ? envContent(plan.options.bridgePort, plan.options.webPort, token) : "";
    const next = { ...config.value, liveBridge: plan.options.enabled ? { ...config.value.liveBridge, enabled: true, port: plan.options.bridgePort, webPort: plan.options.webPort, observeHooks: true, tokenFile: paths.tokenFile, channelTarget: plan.options.liveChannelTarget,
      leaderPolicy: { ...config.value.liveBridge?.leaderPolicy, enabled: true, tools: "host_native", maxConcurrent: plan.options.maxConcurrent } } : { ...config.value.liveBridge, enabled: false } };
    if (plan.options.enabled) delete next.liveBridge.tokenEnv;
    const changed = JSON.stringify(next) !== JSON.stringify(config.value) || (plan.options.enabled && files.envRaw !== encodedEnv);
    if (plan.options.enabled && !files.owner) {
      writeExclusive(paths.tokenFile, `${token}\n`); created.push(paths.tokenFile);
      writeExclusive(paths.envFile, encodedEnv); created.push(paths.envFile);
      const owner: Owner = { version: 1, workspace: plan.workspace, tokenFile: paths.tokenFile, envFile: paths.envFile, tokenDigest: sha(token) };
      writeExclusive(paths.owner, JSON.stringify(owner, null, 2) + "\n"); created.push(paths.owner);
    } else if (plan.options.enabled && files.envRaw !== encodedEnv) {
      previousEnv = files.envRaw; writeExclusive(envTemp, encodedEnv); fs.renameSync(envTemp, paths.envFile); envReplaced = true;
    }
    if (JSON.stringify(next) !== JSON.stringify(config.value)) {
      writeExclusive(configTemp, JSON.stringify(next, null, 2) + "\n");
      // Check immediately before rename as well, including non-cooperating editors.
      const latest = configAt(plan.workspace);
      if (latest.exists !== config.exists || latest.raw !== config.raw) throw new Error("Config changed during setup; no config was replaced");
      fs.renameSync(configTemp, paths.config);
    }
    committed = true;
    return { applied: true, changed, workspace: plan.workspace, tokenFile: paths.tokenFile, envFile: paths.envFile,
      restartRequired: true, servicesStarted: false, pluginConfig: plan.pluginConfig, launch: plan.launch };
  } catch (error) {
    if (!committed) {
      if (envReplaced && previousEnv !== undefined) {
        try { writeExclusive(envTemp, previousEnv); fs.renameSync(envTemp, paths.envFile); }
        catch { throw new Error("Setup failed and environment rollback needs operator review; no service was started"); }
      }
      for (const filename of created.reverse()) { try { fs.unlinkSync(filename); } catch {} }
    }
    // Never interpolate filesystem errors: they may contain credential bytes.
    if (error instanceof Error && /(?:stale|changed|private|owned|symlink|linked|Setup)/i.test(error.message) && !error.message.includes("\n")) throw error;
    throw new Error("Setup failed; configuration was not activated and no service was started");
  } finally {
    for (const filename of [envTemp, configTemp]) { try { fs.unlinkSync(filename); } catch {} }
    if (lockOwned) { try { fs.unlinkSync(paths.lock); } catch {} }
    if (createdDirectory && (!committed || !plan.options.enabled)) { try { fs.rmdirSync(paths.directory); } catch {} }
  }
}
