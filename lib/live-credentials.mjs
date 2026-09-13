import fs from "node:fs";
import path from "node:path";

const unavailable = () => new Error("Live credential is unavailable or unsafe; verify its managed file or token environment.");
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owned = stat => typeof process.getuid === "function" && stat.uid === process.getuid();
const validToken = value => typeof value === "string" && /^[\x21-\x7e]{32,4096}$/.test(value);

/** Read a local credential only. Never includes paths, input values or secrets in errors. */
export function readLiveToken(workspace, bridgeConfig = {}, env = process.env) {
  if (!bridgeConfig || typeof bridgeConfig !== "object" || Array.isArray(bridgeConfig)) throw unavailable();
  if (!Object.hasOwn(bridgeConfig, "tokenFile")) {
    const name = bridgeConfig.tokenEnv ?? "CLAWCODE_LIVE_TOKEN";
    if (typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name)) throw unavailable();
    const value = env[name];
    if (value === undefined || value === "") return undefined;
    if (!validToken(value)) throw unavailable();
    return value;
  }

  // An explicit file never falls back to a possibly stale environment value.
  // Resolve the workspace itself (e.g. macOS /var -> /private/var), then reject
  // symlinks in the managed directory and token rather than resolving them.
  let directoryFd;
  let tokenFd;
  try {
    const selected = bridgeConfig.tokenFile;
    if (typeof selected !== "string" || !path.isAbsolute(selected)) throw unavailable();
    const canonicalWorkspace = fs.realpathSync(workspace);
    const directory = path.join(canonicalWorkspace, ".clawcode-live");
    const tokenPath = path.join(directory, "bridge.token");
    const requested = path.resolve(selected);
    if (requested !== tokenPath && requested !== path.join(path.resolve(workspace), ".clawcode-live", "bridge.token")) throw unavailable();

    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !owned(directoryStat) || (directoryStat.mode & 0o7777) !== 0o700) throw unavailable();
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!sameFile(directoryStat, fs.fstatSync(directoryFd))) throw unavailable();
    const fileStat = fs.lstatSync(tokenPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || !owned(fileStat) || fileStat.nlink !== 1 || (fileStat.mode & 0o7777) !== 0o600 || fileStat.size > 4096) throw unavailable();
    tokenFd = fs.openSync(tokenPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!sameFile(fileStat, fs.fstatSync(tokenFd))) throw unavailable();
    const value = fs.readFileSync(tokenFd, "utf8");
    // Permit the single terminal newline used by normal secret-file writers;
    // whitespace inside the token, multiple lines and non-ASCII are invalid.
    const token = value.replace(/\r?\n$/, "");
    if (!validToken(token)) throw unavailable();
    const finalDirectory = fs.lstatSync(directory);
    const finalFile = fs.lstatSync(tokenPath);
    if (!sameFile(directoryStat, finalDirectory) || finalDirectory.isSymbolicLink() || (finalDirectory.mode & 0o7777) !== 0o700 ||
        !sameFile(fileStat, finalFile) || finalFile.isSymbolicLink() || finalFile.nlink !== 1 || (finalFile.mode & 0o7777) !== 0o600) throw unavailable();
    return token;
  } catch {
    throw unavailable();
  } finally {
    if (tokenFd !== undefined) fs.closeSync(tokenFd);
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
}
