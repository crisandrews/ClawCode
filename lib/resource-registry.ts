/**
 * Resource Registry — RSPL (Resource Substrate Protocol Layer) for ClawCode.
 *
 * Treats skills as protocol-registered resources with explicit state,
 * lifecycle, and version lineage. Every modification is tracked and
 * reversible via rollback.
 *
 * Storage layout under <autogenesisDir>/:
 *   registry.json         — active resource records
 *   versions/<name>/      — per-resource version directory
 *     history.json        — ordered list of VersionEntry (metadata only)
 *     v1.0.0.md           — full content snapshot for rollback
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResourceType = "skill" | "prompt" | "config" | "agent";

export interface ResourceRecord {
  name: string;
  type: ResourceType;
  path: string;
  currentVersion: string;
  trainable: boolean;
  description: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface VersionEntry {
  version: string;
  contentHash: string;
  contentPreview: string;
  ts: string;
  reason: string;
  parentVersion: string | null;
  committed: boolean;
}

interface RegistryData {
  schemaVersion: number;
  resources: Record<string, ResourceRecord>;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// ResourceRegistry
// ---------------------------------------------------------------------------

export class ResourceRegistry {
  private registryPath: string;
  private versionsDir: string;
  private data: RegistryData;

  constructor(autogenesisDir: string) {
    fs.mkdirSync(autogenesisDir, { recursive: true });
    this.registryPath = path.join(autogenesisDir, "registry.json");
    this.versionsDir = path.join(autogenesisDir, "versions");
    fs.mkdirSync(this.versionsDir, { recursive: true });
    this.data = this.load();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Register a resource. No-op if already registered. */
  register(
    record: Omit<ResourceRecord, "currentVersion" | "createdAt" | "updatedAt">
  ): void {
    this.assertSafe(record.name, "name");
    if (this.data.resources[record.name]) return;

    const content = fs.existsSync(record.path)
      ? fs.readFileSync(record.path, "utf-8")
      : "";
    const initialVersion = "1.0.0";
    this.persistVersion(record.name, initialVersion, content, "Initial registration", null);

    this.data.resources[record.name] = {
      ...record,
      currentVersion: initialVersion,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  /**
   * Take a snapshot of the current on-disk content, bumping patch version.
   * Returns the new version string, or null if resource not found.
   */
  snapshot(name: string, reason: string): string | null {
    const resource = this.data.resources[name];
    if (!resource || !fs.existsSync(resource.path)) return null;

    const content = fs.readFileSync(resource.path, "utf-8");
    const newVersion = this.bumpPatch(resource.currentVersion);
    this.persistVersion(name, newVersion, content, reason, resource.currentVersion);
    resource.currentVersion = newVersion;
    resource.updatedAt = new Date().toISOString();
    this.save();
    return newVersion;
  }

  /**
   * Write newContent to the resource file and record the version.
   * Returns new version string or null on failure.
   */
  applyContent(name: string, newContent: string, reason: string): string | null {
    const resource = this.data.resources[name];
    if (!resource) return null;

    const newVersion = this.bumpPatch(resource.currentVersion);
    this.persistVersion(name, newVersion, newContent, reason, resource.currentVersion);
    fs.writeFileSync(resource.path, newContent, "utf-8");
    resource.currentVersion = newVersion;
    resource.updatedAt = new Date().toISOString();
    this.save();
    return newVersion;
  }

  /**
   * Restore file to a previous version. Returns true on success.
   */
  rollback(name: string, toVersion: string): boolean {
    this.assertSafe(name, "name");
    this.assertSafe(toVersion, "version");
    const resource = this.data.resources[name];
    if (!resource) return false;

    const snapshotPath = path.join(this.versionsDir, name, `${toVersion}.md`);
    if (!fs.existsSync(snapshotPath)) return false;

    const content = fs.readFileSync(snapshotPath, "utf-8");
    fs.writeFileSync(resource.path, content, "utf-8");
    resource.currentVersion = toVersion;
    resource.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /** Full version history for a resource. */
  getHistory(name: string): VersionEntry[] {
    this.assertSafe(name, "name");
    const metaPath = path.join(this.versionsDir, name, "history.json");
    if (!fs.existsSync(metaPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as VersionEntry[];
    } catch {
      return [];
    }
  }

  getResource(name: string): ResourceRecord | null {
    return this.data.resources[name] ?? null;
  }

  listResources(): ResourceRecord[] {
    return Object.values(this.data.resources);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Reject names/versions that could escape the versions directory. */
  private assertSafe(value: string, field: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error(`Invalid ${field}: "${value}" — only [A-Za-z0-9._-] allowed`);
    }
  }

  private load(): RegistryData {
    if (fs.existsSync(this.registryPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.registryPath, "utf-8")) as RegistryData;
      } catch {
        // corrupt — start fresh
      }
    }
    return { schemaVersion: 1, resources: {}, updatedAt: new Date().toISOString() };
  }

  private save(): void {
    this.data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.registryPath, JSON.stringify(this.data, null, 2));
  }

  private bumpPatch(version: string): string {
    const parts = version.split(".").map((s) => {
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    });
    while (parts.length < 3) parts.push(0);
    parts[2] += 1;
    return parts.join(".");
  }

  private contentHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  }

  private persistVersion(
    name: string,
    version: string,
    content: string,
    reason: string,
    parent: string | null
  ): void {
    const dir = path.join(this.versionsDir, name);
    fs.mkdirSync(dir, { recursive: true });

    // Full content snapshot for rollback
    fs.writeFileSync(path.join(dir, `${version}.md`), content, "utf-8");

    // Append to history metadata
    const metaPath = path.join(dir, "history.json");
    const history: VersionEntry[] = fs.existsSync(metaPath)
      ? (JSON.parse(fs.readFileSync(metaPath, "utf-8")) as VersionEntry[])
      : [];

    history.push({
      version,
      contentHash: this.contentHash(content),
      contentPreview: content.slice(0, 200).replace(/\n/g, " ") + (content.length > 200 ? "…" : ""),
      ts: new Date().toISOString(),
      reason,
      parentVersion: parent,
      committed: true,
    });

    fs.writeFileSync(metaPath, JSON.stringify(history, null, 2));
  }
}
