/**
 * Autogenesis Orchestrator — coordinates the RSPL/SEPL self-evolution cycle
 * for ClawCode.
 *
 * Responsibilities:
 *  - Scans skill directories and registers skills in the ResourceRegistry
 *  - Spawns autogenesis-engine.py for the nightly Reflect/Select cycle
 *  - Reads pending proposals and applies them (with versioning + rollback)
 *  - Exposes status, history, and rollback to the MCP `autogenesis` tool
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { ResourceRegistry, type ResourceRecord } from "./resource-registry.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Proposal {
  id: string;
  hypothesis: {
    event_type: string;
    response_rate: number;
    occurrences: number;
    notified: number;
    target_skills: string[];
    hypothesis: string;
    severity: string;
  };
  skill_name: string;
  skill_path: string;
  proposed_addition: string;
  apply_mode: "append" | "replace";
  current_chars: number;
  status: "pending" | "applied" | "rejected";
  created_at: string;
  applied_at: string | null;
  applied_version: string | null;
}

export interface AutogenesisStatus {
  registeredResources: number;
  pendingProposals: number;
  appliedProposals: number;
  resources: Array<{
    name: string;
    type: string;
    currentVersion: string;
    updatedAt: string;
    trainable: boolean;
  }>;
  recentReports: string[];
}

export interface ApplyResult {
  success: boolean;
  version?: string;
  error?: string;
  skillName?: string;
}

// ---------------------------------------------------------------------------
// AutogenesisOrchestrator
// ---------------------------------------------------------------------------

export class AutogenesisOrchestrator {
  private registry: ResourceRegistry;
  private autogenesisDir: string;
  private pendingPath: string;
  private reportsDir: string;
  private pluginRoot: string;

  constructor(memoryDir: string, pluginRoot: string) {
    this.pluginRoot = pluginRoot;
    this.autogenesisDir = path.join(memoryDir, "autogenesis");
    this.pendingPath = path.join(this.autogenesisDir, "pending.json");
    this.reportsDir = path.join(this.autogenesisDir, "reports");
    fs.mkdirSync(this.autogenesisDir, { recursive: true });
    fs.mkdirSync(this.reportsDir, { recursive: true });
    this.registry = new ResourceRegistry(this.autogenesisDir);
  }

  // ---------------------------------------------------------------------------
  // Skill scanning & registration
  // ---------------------------------------------------------------------------

  /**
   * Walk the plugin skills directory and register every SKILL.md as a
   * trainable resource. Called once at startup.
   */
  scanAndRegisterSkills(): number {
    const skillsDir = path.join(this.pluginRoot, "skills");
    if (!fs.existsSync(skillsDir)) return 0;

    let registered = 0;
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;

      // Read frontmatter description if available
      let description = `Skill: ${entry.name}`;
      try {
        const raw = fs.readFileSync(skillMd, "utf-8");
        const descMatch = raw.match(/^description:\s*(.+)$/m);
        if (descMatch) description = descMatch[1].trim();
      } catch {
        // best-effort
      }

      this.registry.register({
        name: entry.name,
        type: "skill",
        path: skillMd,
        trainable: true,
        description,
        metadata: { skillsDir },
      });
      registered++;
    }
    return registered;
  }

  // ---------------------------------------------------------------------------
  // Reflect/Select cycle (Python engine)
  // ---------------------------------------------------------------------------

  /**
   * Spawn autogenesis-engine.py — identifies underperforming event types,
   * generates improvement proposals, writes them to pending.json.
   * Returns the engine's JSON output as a string.
   */
  runReflectCycle(memoryDir: string): string {
    const engineScript = path.join(this.pluginRoot, "lib", "autogenesis-engine.py");
    const skillDir = path.join(this.pluginRoot, "skills");

    if (!fs.existsSync(engineScript)) {
      return JSON.stringify({ error: "autogenesis-engine.py not found" });
    }

    // Prefer PYTHON env var, then "python", then "python3" as last resort
    const pythonBin = process.env.PYTHON ?? "python";

    try {
      return execFileSync(
        pythonBin,
        [engineScript, "--memory-dir", memoryDir, "--skill-dir", skillDir],
        { timeout: 30_000, encoding: "utf-8" }
      );
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Proposal management
  // ---------------------------------------------------------------------------

  getPendingProposals(): Proposal[] {
    return this.readPending().filter((p) => p.status === "pending");
  }

  getAllProposals(): Proposal[] {
    return this.readPending();
  }

  /**
   * Apply a pending proposal by ID.
   * Appends the proposed content addition to the skill file and versions it.
   */
  applyProposal(id: string): ApplyResult {
    const all = this.readPending();
    const proposal = all.find((p) => p.id === id);

    if (!proposal) {
      return { success: false, error: `Proposal '${id}' not found` };
    }
    if (proposal.status !== "pending") {
      return { success: false, error: `Proposal '${id}' is already ${proposal.status}` };
    }
    if (!fs.existsSync(proposal.skill_path)) {
      return { success: false, error: `Skill file not found: ${proposal.skill_path}` };
    }

    // Guard: skill_path must resolve inside pluginRoot/skills/ to prevent
    // a tampered pending.json from writing outside the skills directory.
    const resolvedPath = path.resolve(proposal.skill_path);
    const skillsRoot = path.resolve(this.pluginRoot, "skills");
    if (!resolvedPath.startsWith(skillsRoot + path.sep)) {
      return { success: false, error: "skill_path escapes skills directory — proposal rejected" };
    }

    const currentContent = fs.readFileSync(proposal.skill_path, "utf-8");
    let newContent: string;

    if (proposal.apply_mode === "append") {
      newContent = currentContent + proposal.proposed_addition;
    } else {
      newContent = proposal.proposed_addition;
    }

    // Ensure the skill is registered before applying
    const existing = this.registry.getResource(proposal.skill_name);
    if (!existing) {
      this.registry.register({
        name: proposal.skill_name,
        type: "skill",
        path: proposal.skill_path,
        trainable: true,
        description: `Skill: ${proposal.skill_name}`,
        metadata: {},
      });
    }

    const newVersion = this.registry.applyContent(
      proposal.skill_name,
      newContent,
      `Autogenesis: ${proposal.hypothesis.event_type} improvement (response_rate=${proposal.hypothesis.response_rate})`
    );

    if (!newVersion) {
      return { success: false, error: "Registry applyContent failed" };
    }

    // Update proposal status
    proposal.status = "applied";
    proposal.applied_at = new Date().toISOString();
    proposal.applied_version = newVersion;
    this.writePending(all);

    return { success: true, version: newVersion, skillName: proposal.skill_name };
  }

  /**
   * Reject a pending proposal (mark as rejected without applying).
   */
  rejectProposal(id: string): boolean {
    const all = this.readPending();
    const proposal = all.find((p) => p.id === id);
    if (!proposal || proposal.status !== "pending") return false;
    proposal.status = "rejected";
    this.writePending(all);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Versioning & rollback
  // ---------------------------------------------------------------------------

  rollback(skillName: string, toVersion: string): boolean {
    return this.registry.rollback(skillName, toVersion);
  }

  getHistory(skillName: string) {
    return this.registry.getHistory(skillName);
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  getStatus(): AutogenesisStatus {
    const resources = this.registry.listResources();
    const all = this.readPending();
    const pending = all.filter((p) => p.status === "pending").length;
    const applied = all.filter((p) => p.status === "applied").length;

    // Recent report files
    let recentReports: string[] = [];
    try {
      recentReports = fs
        .readdirSync(this.reportsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .slice(-3);
    } catch {
      // reports dir may not exist yet
    }

    return {
      registeredResources: resources.length,
      pendingProposals: pending,
      appliedProposals: applied,
      resources: resources.map((r) => ({
        name: r.name,
        type: r.type,
        currentVersion: r.currentVersion,
        updatedAt: r.updatedAt,
        trainable: r.trainable,
      })),
      recentReports,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private readPending(): Proposal[] {
    if (!fs.existsSync(this.pendingPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.pendingPath, "utf-8")) as Proposal[];
    } catch {
      return [];
    }
  }

  private writePending(proposals: Proposal[]): void {
    fs.writeFileSync(this.pendingPath, JSON.stringify(proposals, null, 2));
  }
}
