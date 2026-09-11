import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { LiveState } from "./live-types.ts";

/** Single writer, atomic durable checkpoint. No global ClawCode state or SQLite dependency. */
export class LiveStore {
  private readonly filename: string;
  private readonly lock: string;
  private readonly lease = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  private locked = false;
  constructor(readonly directory: string) {
    this.filename = path.join(directory, "state.json");
    this.lock = path.join(directory, "owner.lock");
  }
  acquire(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let fd: number;
    try { fd = fs.openSync(this.lock, "wx", 0o600); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      // Serialize stale-lock recovery. Never unlink a live owner's lock; a
      // reused PID conservatively needs operator review. If recovery itself
      // crashed, owner.recovery requires explicit operator cleanup.
      const recovery = path.join(this.directory, "owner.recovery");
      const recoveryFd = fs.openSync(recovery, "wx", 0o600);
      try {
        const owner = JSON.parse(fs.readFileSync(this.lock, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Invalid LiveBridge ownership record");
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (e: any) { if (e.code === "ESRCH") alive = false; }
        if (alive) throw new Error("LiveBridge already has a writer");
        fs.unlinkSync(this.lock);
        fd = fs.openSync(this.lock, "wx", 0o600);
      } finally { fs.closeSync(recoveryFd); fs.unlinkSync(recovery); }
    }
    this.locked = true;
    try { fs.writeFileSync(fd, this.lease); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  load(): LiveState | undefined {
    try { return JSON.parse(fs.readFileSync(this.filename, "utf8")); }
    catch (error: any) { if (error.code === "ENOENT") return undefined; throw new Error("LiveBridge state is corrupt; refusing to replace it"); }
  }
  save(state: LiveState): void {
    if (!this.locked) throw new Error("LiveBridge store is not owned");
    const encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new Error("LiveBridge durable state exceeds 32 MiB; archive it explicitly before starting another conversation");
    const temp = path.join(this.directory, `.state-${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, encoded); fs.fsyncSync(fd);
    } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.filename);
    const dir = fs.openSync(this.directory, "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  close(): void {
    if (!this.locked) return;
    try { if (fs.readFileSync(this.lock, "utf8") === this.lease) fs.unlinkSync(this.lock); }
    finally { this.locked = false; }
  }
}
