/**
 * wacli bridge — read-only access to WhatsApp conversations via the wacli CLI.
 *
 * This is a READ-ONLY module. It NEVER sends messages. It wraps the wacli CLI
 * to list chats, read messages, and search conversations across one or more
 * WhatsApp sessions (stores).
 *
 * Completely independent of the existing channel-detector system — channels
 * handle Claude Code's WhatsApp plugin lifecycle; this module reads the local
 * wacli database for context.
 */

import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WacliStore {
  name: string;
  path: string;
}

export interface WacliChat {
  JID: string;
  Kind: string;
  Name: string;
  LastMessageTS: string;
}

export interface WacliMessage {
  ChatJID: string;
  ChatName: string;
  MsgID: string;
  SenderJID: string;
  Timestamp: string;
  FromMe: boolean;
  Text: string;
  DisplayText: string;
  MediaType: string;
}

export interface WacliConfig {
  /** Path to the wacli binary. Default: "wacli" (from PATH). */
  binary?: string;
  /** WhatsApp stores to read from. Each has a name and path. */
  stores: WacliStore[];
  /** Command timeout in seconds. Default: 30. */
  timeoutSecs?: number;
}

// ---------------------------------------------------------------------------
// CLI wrapper (read-only)
// ---------------------------------------------------------------------------

export class WacliBridge {
  private binary: string;
  private stores: WacliStore[];
  private timeoutMs: number;

  constructor(config: WacliConfig) {
    this.binary = config.binary || "wacli";
    this.stores = config.stores;
    this.timeoutMs = (config.timeoutSecs || 30) * 1000;
  }

  /**
   * Check if wacli is available.
   */
  isAvailable(): boolean {
    try {
      execSync(`${this.binary} version`, {
        timeout: 5000,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all stores with their chat counts.
   */
  listStores(): Array<WacliStore & { chatCount: number; available: boolean }> {
    return this.stores.map((store) => {
      try {
        const chats = this.listChats(store.name);
        return { ...store, chatCount: chats.length, available: true };
      } catch {
        return { ...store, chatCount: 0, available: false };
      }
    });
  }

  /**
   * List chats from a specific store (or all stores).
   */
  listChats(storeName?: string): WacliChat[] {
    const stores = storeName
      ? this.stores.filter((s) => s.name === storeName)
      : this.stores;

    const allChats: WacliChat[] = [];
    for (const store of stores) {
      try {
        const result = this.exec(["chats", "list"], store.path);
        if (result.data && Array.isArray(result.data)) {
          for (const chat of result.data) {
            allChats.push({ ...chat, _store: store.name } as any);
          }
        }
      } catch {
        // Store unavailable — skip
      }
    }
    return allChats;
  }

  /**
   * List messages from a specific chat.
   */
  listMessages(
    chatJID: string,
    options?: {
      storeName?: string;
      limit?: number;
      after?: string;
      before?: string;
    }
  ): WacliMessage[] {
    const store = this.resolveStore(chatJID, options?.storeName);
    if (!store) return [];

    const args = ["messages", "list", "--chat", chatJID];
    if (options?.limit) args.push("--limit", String(options.limit));
    if (options?.after) args.push("--after", options.after);
    if (options?.before) args.push("--before", options.before);

    try {
      const result = this.exec(args, store.path);
      return result.data?.messages || [];
    } catch {
      return [];
    }
  }

  /**
   * Search messages across all stores (or a specific one).
   */
  searchMessages(
    query: string,
    options?: {
      storeName?: string;
      chatJID?: string;
      limit?: number;
      after?: string;
      before?: string;
    }
  ): Array<WacliMessage & { _store?: string }> {
    const stores = options?.storeName
      ? this.stores.filter((s) => s.name === options.storeName)
      : this.stores;

    const allResults: Array<WacliMessage & { _store?: string }> = [];
    for (const store of stores) {
      const args = ["messages", "search", query];
      if (options?.chatJID) args.push("--chat", options.chatJID);
      if (options?.limit) args.push("--limit", String(options.limit));
      if (options?.after) args.push("--after", options.after);
      if (options?.before) args.push("--before", options.before);

      try {
        const result = this.exec(args, store.path);
        const msgs = result.data?.messages || result.data || [];
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            allResults.push({ ...m, _store: store.name });
          }
        }
      } catch {
        // Store unavailable — skip
      }
    }
    return allResults;
  }

  /**
   * Get a single message by ID.
   */
  getMessage(msgID: string, storeName?: string): WacliMessage | null {
    const stores = storeName
      ? this.stores.filter((s) => s.name === storeName)
      : this.stores;

    for (const store of stores) {
      try {
        const result = this.exec(["messages", "show", msgID], store.path);
        if (result.data) return result.data;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Get context around a message (messages before and after).
   */
  getMessageContext(
    msgID: string,
    storeName?: string
  ): WacliMessage[] {
    const stores = storeName
      ? this.stores.filter((s) => s.name === storeName)
      : this.stores;

    for (const store of stores) {
      try {
        const result = this.exec(["messages", "context", msgID], store.path);
        return result.data?.messages || result.data || [];
      } catch {
        continue;
      }
    }
    return [];
  }

  /**
   * Format messages as readable text for context injection.
   */
  formatAsContext(messages: WacliMessage[], maxChars = 4000): string {
    if (messages.length === 0) return "(No messages found.)";

    const lines: string[] = [];
    let chars = 0;

    for (const m of messages) {
      const sender = m.FromMe ? "You" : (m.ChatName || m.SenderJID || "?");
      const text = m.Text || m.DisplayText || `[${m.MediaType || "media"}]`;
      const ts = m.Timestamp?.slice(0, 16).replace("T", " ") || "";
      const line = `[${ts}] ${sender}: ${text}`;

      if (chars + line.length > maxChars) {
        lines.push(`... (${messages.length - lines.length} more messages truncated)`);
        break;
      }
      lines.push(line);
      chars += line.length;
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private exec(args: string[], storePath: string): any {
    const cmd = `${this.binary} ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")} --json --store "${storePath}"`;

    const output = execSync(cmd, {
      timeout: this.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });

    const parsed = JSON.parse(output);
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return parsed;
  }

  private resolveStore(chatJID: string, preferredStore?: string): WacliStore | null {
    if (preferredStore) {
      return this.stores.find((s) => s.name === preferredStore) || null;
    }

    // Try each store until we find one that has this chat
    for (const store of this.stores) {
      try {
        const chats = this.listChats(store.name);
        if (chats.some((c) => c.JID === chatJID)) {
          return store;
        }
      } catch {
        continue;
      }
    }

    // Fall back to first store
    return this.stores[0] || null;
  }
}

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

export function resolveWacliConfig(workspace: string): WacliConfig | null {
  // Check agent-config.json first
  try {
    const configPath = path.join(workspace, "agent-config.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.wacli?.stores?.length > 0) {
      return {
        binary: parsed.wacli.binary || "wacli",
        stores: parsed.wacli.stores,
        timeoutSecs: parsed.wacli.timeoutSecs || 30,
      };
    }
  } catch {}

  // Auto-detect stores: scan home dir for .wacli* directories containing wacli.db
  const home = os.homedir();
  const autoStores: WacliStore[] = [];

  try {
    const entries = fs.readdirSync(home);
    for (const entry of entries) {
      if (!entry.startsWith(".wacli")) continue;
      const fullPath = path.join(home, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;
      if (!fs.existsSync(path.join(fullPath, "wacli.db"))) continue;
      // Derive name: ".wacli" → "default", ".wacli-foo" → "foo"
      const name = entry === ".wacli" ? "default" : entry.replace(/^\.wacli-/, "");
      autoStores.push({ name, path: fullPath });
    }
  } catch {}
  autoStores.sort((a, b) => a.name.localeCompare(b.name));

  if (autoStores.length === 0) return null;

  return { stores: autoStores };
}
