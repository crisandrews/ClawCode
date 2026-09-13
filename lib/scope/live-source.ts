import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EnvelopeReader, ENVELOPE_DIR_NAME, ENVELOPE_TOKEN_REGEX } from "./envelope.ts";
import { normalizeAccessWithMeta } from "./whatsapp.ts";

export interface WhatsappLiveCandidate {
  id: string; sourceChannel: "whatsapp"; occurredAt: string; label: string;
}
export interface WhatsappLiveProvenance {
  sourceChannel: "whatsapp"; sourceInputId: string; ownerVerified: true;
}

/** Source provenance only. This NEVER grants memory scope, tool permissions,
 * owner identity to an MCP caller, or authority to send a WhatsApp message.
 * The host must expose selection through its authenticated owner HTTP route.
 * Upstream envelopes identify a dispatch, not its message text or message ID.
 */
export function createWhatsappLiveSources(options: {
  workspace: string;
  channelDirectory: () => string | null;
  now?: () => number;
}) {
  const candidates = new Map<string, { token: string; channelDir: string; occurredAt: string }>();
  const clock = options.now ?? Date.now;
  const canonicalWorkspace = fs.realpathSync(options.workspace);

  function verified(channelDir: string, token: string) {
    // Fresh reader on every operation: removing/revoking an envelope must not
    // survive in the memory tool's bounded-reuse cache during confirmation.
    const envelope = new EnvelopeReader().load(channelDir, token, clock());
    if (!envelope) return null;
    const accessPath = path.join(channelDir, "access.json");
    let fd: number | undefined;
    try {
      const lst = fs.lstatSync(accessPath);
      if (!lst.isFile() || lst.isSymbolicLink()) return null;
      fd = fs.openSync(accessPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0) return null;
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
      const { access, hasOwnerJidsField } = normalizeAccessWithMeta(JSON.parse(fs.readFileSync(fd, "utf8")));
      if (!hasOwnerJidsField || !access.ownerJids.includes(envelope.senderId)) return null;
      const id = createHash("sha256").update(JSON.stringify([canonicalWorkspace, fs.realpathSync(channelDir), token, envelope.chatId, envelope.senderId, envelope.ts])).digest("hex");
      return { id, occurredAt: new Date(envelope.ts).toISOString() };
    } catch { return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  function list(): WhatsappLiveCandidate[] {
    candidates.clear();
    let channelDir: string | null;
    try { channelDir = options.channelDirectory(); } catch { return []; }
    if (!channelDir) return [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(channelDir, ENVELOPE_DIR_NAME), { withFileTypes: true }); }
    catch { return []; }
    const result: WhatsappLiveCandidate[] = [];
    // The TTL bounds useful candidates. Cap work as well: this endpoint must
    // not scan an unbounded message archive. No message bodies are opened.
    for (const entry of entries.slice(-1000)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const token = entry.name.slice(0, -5);
      if (!ENVELOPE_TOKEN_REGEX.test(token)) continue;
      const source = verified(channelDir, token);
      if (!source) continue;
      candidates.set(source.id, { token, channelDir, occurredAt: source.occurredAt });
      result.push({ ...source, sourceChannel: "whatsapp", label: "Mensaje reciente del propietario" });
    }
    return result.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 20);
  }

  function resolve(candidateId: string): WhatsappLiveProvenance | null {
    const candidate = candidates.get(candidateId);
    if (!candidate) return null;
    let currentDir: string | null;
    try { currentDir = options.channelDirectory(); } catch { return null; }
    if (!currentDir || path.resolve(currentDir) !== path.resolve(candidate.channelDir)) return null;
    const source = verified(currentDir, candidate.token);
    if (!source || source.id !== candidateId) { candidates.delete(candidateId); return null; }
    return { sourceChannel: "whatsapp", sourceInputId: source.id, ownerVerified: true };
  }
  return { list, resolve };
}
