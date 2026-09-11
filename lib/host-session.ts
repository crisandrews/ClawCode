import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function saveVerifiedHostSession(workspace: string, host: {
  generation: string; nativeSessionId?: string; bindingStatus: string;
}): void {
  if (host.bindingStatus !== "verified" || !host.nativeSessionId) return;
  const canonical = fs.realpathSync(workspace);
  const directory = path.join(canonical, ".clawcode-live");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Host registry directory must be private");
  const temp = path.join(directory, `.host-session-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ version: 1, workspace: canonical, nativeSessionId: host.nativeSessionId, generation: host.generation, writerPid: process.pid, observedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, path.join(directory, "host-session.json")); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}

/** Standalone function embedded in generated service wrappers. It intentionally
 * uses require internally so the emitted Node program needs no plugin files.
 * Output is one token: legacy, resume:<uuid>, or blocked:<reason>.
 */
export function hostResumeProbe(workspace: string, sessionsDirectory: string): string {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  let fd: number | undefined;
  try {
    const canonical = fs.realpathSync(workspace);
    const directory = path.join(canonical, ".clawcode-live");
    const filename = path.join(directory, "host-session.json");
    try { fs.lstatSync(filename); } catch (error: any) { if (error.code === "ENOENT") return "legacy"; throw error; }
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) return "blocked:untrusted-host-directory";
    const initial = fs.lstatSync(filename);
    if (!initial.isFile() || initial.isSymbolicLink()) return "blocked:untrusted-host-record";
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return "blocked:untrusted-host-record";
    const record = JSON.parse(fs.readFileSync(fd, "utf8"));
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (record.version !== 1 || record.workspace !== canonical || !uuid.test(record.nativeSessionId) || !uuid.test(record.generation) || !Number.isSafeInteger(record.writerPid) || record.writerPid < 1) return "blocked:invalid-host-record";
    try { process.kill(record.writerPid, 0); return "blocked:host-still-running"; }
    catch (error: any) { if (error.code !== "ESRCH") return "blocked:host-process-unknown"; }
    const transcript = fs.lstatSync(path.join(sessionsDirectory, `${record.nativeSessionId}.jsonl`));
    if (!transcript.isFile() || transcript.isSymbolicLink()) return "blocked:invalid-host-transcript";
    return `resume:${record.nativeSessionId}`;
  } catch { return "blocked:host-resume-unavailable"; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
