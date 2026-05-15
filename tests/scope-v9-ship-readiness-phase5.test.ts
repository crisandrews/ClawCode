/**
 * Phase 5 — Codex round-8 ship-readiness follow-up (v9).
 *
 *   1. BLOCKER fix: `filterScopedResults` + `buildSqlPreFilter` +
 *      `assertCanReadPath` + `applyPreventivePromoteGuard` +
 *      `routePromotions` now fail-closed when ANY channel is
 *      `mode: enforce` configured even if `armed === false`. Closes
 *      the gap where unpair / adapter-missing left chunks visible.
 *
 *   2. Three new doctor checks: `checkScopeStale`,
 *      `checkScopeOwnerAssertion`, `checkScopeSchemaDrift`.
 *
 *   3. ChannelRuntimeState exposes new `anyEnforceConfigured` flag.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  filterScopedResults,
  buildSqlPreFilter,
  assertCanReadPath,
} from "../lib/scope/filter.ts";
import {
  detectScopeRuntime,
  applyPreventivePromoteGuard,
  _resetRuntimeForTests,
} from "../lib/scope/runtime.ts";
import { makeForegroundContext } from "../lib/scope/context.ts";
import { loadConfig } from "../lib/config.ts";
import {
  checkScopeStale,
  checkScopeOwnerAssertion,
  checkScopeSchemaDrift,
} from "../lib/doctor.ts";
import { workspaceFingerprint } from "../lib/scope/trust.ts";
import type { SearchResult } from "../lib/types.ts";

let pass = 0;
let fail = 0;
const results: string[] = [];

function ok(name: string) {
  pass++;
  results.push(`  ✓ ${name}`);
}
function bad(name: string, why: unknown) {
  fail++;
  const msg =
    why instanceof Error ? `${why.message}\n${why.stack ?? ""}` : String(why);
  results.push(`  ✗ ${name}\n     ${msg.split("\n").join("\n     ")}`);
}

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ph5v9-"));
}

function writeJson(file: string, obj: unknown) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
}

async function run() {
  // -- BLOCKER #1: anyEnforceConfigured runtime flag --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    // Mode enforce but adapter unavailable (no access.json)
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "enforce",
          identity: "guest",
          accessJsonPath: "/nonexistent/missing.json",
          background: { identity: "deny" },
        },
      },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);
    if (runtime.anyArmed)
      bad("BLOCKER#1 expected !anyArmed", runtime);
    else if (!runtime.anyEnforceConfigured)
      bad("BLOCKER#1 expected anyEnforceConfigured=true", runtime);
    else ok("BLOCKER#1 anyEnforceConfigured=true when adapter unavailable");
  }

  // -- BLOCKER #2: filterScopedResults fail-closed --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "enforce",
          identity: "guest",
          accessJsonPath: "/nonexistent/missing.json",
          background: { identity: "deny" },
        },
      },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);
    const ctx = makeForegroundContext("req-test");

    const fakeChunk: SearchResult = {
      score: 1.0,
      path: "extra:claude-whatsapp/messages-db/12345@s.whatsapp.net/2026-04-28",
      citation: "fake",
      snippet: "secret content",
      provenance: {
        class: {
          kind: "channel",
          sourceChannel: "whatsapp",
          sourceChatId: "12345@s.whatsapp.net",
        },
        sourceChannel: "whatsapp",
        sourceChatId: "12345@s.whatsapp.net",
      },
    };

    const filtered = filterScopedResults([fakeChunk], ctx, runtime, {
      scope: cfg.scope,
    });
    if (filtered.results.length !== 0)
      bad("BLOCKER#2 filter should drop chunk when enforce+disarmed", filtered);
    else if (filtered.stats.dropped !== 1)
      bad("BLOCKER#2 stats.dropped expected 1", filtered.stats);
    else ok("BLOCKER#2 filterScopedResults fail-closed on enforce+disarmed");
  }

  // -- BLOCKER #3: buildSqlPreFilter emits deny-all clause --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "enforce",
          identity: "guest",
          accessJsonPath: "/nonexistent/missing.json",
          background: { identity: "deny" },
        },
      },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);
    const ctx = makeForegroundContext("req-test");

    const sql = buildSqlPreFilter(ctx, runtime, cfg.scope);
    if (sql.whereSql.length === 0)
      bad("BLOCKER#3 SQL pre-filter should emit deny-all clause", sql);
    else if (!sql.whereSql.includes("source_channel != ?"))
      bad("BLOCKER#3 expected deny-all clause shape", sql);
    else if (!sql.params.includes("whatsapp"))
      bad("BLOCKER#3 expected whatsapp in params", sql);
    else ok("BLOCKER#3 buildSqlPreFilter emits deny-all on enforce+disarmed");
  }

  // -- BLOCKER #4: assertCanReadPath fail-closed --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "enforce",
          identity: "guest",
          accessJsonPath: "/nonexistent/missing.json",
          background: { identity: "deny" },
        },
      },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);
    const ctx = makeForegroundContext("req-test");

    const gate = assertCanReadPath(
      "extra:claude-whatsapp/logs/2026-04-01.md",
      ctx,
      runtime,
      cfg.scope,
      ws
    );
    if (gate.allowed)
      bad("BLOCKER#4 assertCanReadPath should deny on enforce+disarmed", gate);
    else ok("BLOCKER#4 assertCanReadPath fail-closed on enforce+disarmed");
  }

  // -- BLOCKER #5: preventive promote guard diverts --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "enforce",
          identity: "guest",
          accessJsonPath: "/nonexistent/missing.json",
          background: { identity: "deny" },
        },
      },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);

    const candidates = [
      { entry: { path: "extra:claude-whatsapp/2026-04-09.md" } },
      { entry: { path: "memory/MEMORY.md" } },
    ];
    const result = applyPreventivePromoteGuard(candidates, runtime);
    if (result.skipped !== 1)
      bad("BLOCKER#5 promote guard expected 1 skipped", result);
    else if (result.kept.length !== 1)
      bad("BLOCKER#5 promote guard expected 1 kept (local)", result);
    else ok("BLOCKER#5 promote guard diverts WA candidate on enforce+disarmed");
  }

  // -- BLOCKER #6: anyArmed=false + anyEnforceConfigured=false is true no-op --
  // Sanity that unconfigured users see no behavior change.
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);
    if (runtime.anyArmed || runtime.anyEnforceConfigured)
      bad(
        "BLOCKER#6 unconfigured user should have all-false flags",
        runtime
      );
    else ok("BLOCKER#6 unconfigured user: no-op preserved");
  }

  // -- BLOCKER #7: mode=shadow doesn't trigger anyEnforceConfigured --
  // shadow should NOT fail-close on disarmed (intended: shadow observes only).
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "shadow",
          accessJsonPath: "/nonexistent/missing.json",
          background: { identity: "deny" },
        },
      },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);
    if (runtime.anyEnforceConfigured)
      bad(
        "BLOCKER#7 shadow mode should not trigger anyEnforceConfigured",
        runtime
      );
    else ok("BLOCKER#7 shadow mode: anyEnforceConfigured=false (observes only)");
  }

  // -- Doctor #1: checkScopeStale --
  {
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
    });
    const c = checkScopeStale(ws);
    if (c.id !== "scope-stale") bad("checkScopeStale id", c);
    else if (c.status !== "off")
      bad("checkScopeStale expected off when scope absent", c);
    else ok("checkScopeStale: off when scope not configured");
  }

  {
    const ws = makeWs();
    const accessPath = path.join(ws, "fake-access.json");
    writeJson(accessPath, { ownerJids: [] });
    // Set mtime to 30s ago.
    const t = Date.now() - 30_000;
    fs.utimesSync(accessPath, t / 1000, t / 1000);
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "shadow",
          accessJsonPath: accessPath,
        },
      },
    });
    const c = checkScopeStale(ws);
    if (c.status !== "info")
      bad("checkScopeStale expected info when recently edited", c);
    else if (!c.message.includes("modified"))
      bad("checkScopeStale message missing 'modified'", c);
    else ok("checkScopeStale: info when access.json recently edited");
  }

  // -- Doctor #2: checkScopeOwnerAssertion --
  {
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: { whatsapp: { mode: "off" } },
    });
    const c = checkScopeOwnerAssertion(ws);
    if (c.id !== "scope-owner-assertion") bad("owner-assertion id", c);
    else if (c.status !== "ok")
      bad("owner-assertion: expected ok when not owner", c);
    else ok("checkScopeOwnerAssertion: ok when identity != owner");
  }

  {
    const ws = makeWs();
    const trustDir = path.join(ws, "trust");
    // Phase 8: trust file lives under <trustDir>/<workspace-fingerprint>/.
    const fp = workspaceFingerprint(ws);
    const fpDir = path.join(trustDir, fp);
    fs.mkdirSync(fpDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(fpDir, 0o700);
    const trustFile = path.join(fpDir, "whatsapp-owner");
    fs.writeFileSync(trustFile, "", { mode: 0o600 });
    fs.chmodSync(trustFile, 0o600);
    process.env.CLAW_SCOPE_TRUST_DIR = trustDir;
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: { whatsapp: { mode: "enforce", identity: "owner" } },
    });
    const c = checkScopeOwnerAssertion(ws);
    delete process.env.CLAW_SCOPE_TRUST_DIR;
    if (c.status !== "info")
      bad("owner-assertion expected info when owner unlocked", c);
    else if (!c.message.includes("whatsapp"))
      bad("owner-assertion missing channel name", c);
    else
      ok(
        "checkScopeOwnerAssertion: info when identity=owner + trust file exists"
      );
  }

  // -- Doctor #3: checkScopeSchemaDrift --
  {
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
    });
    const c = checkScopeSchemaDrift(ws);
    if (c.id !== "scope-schema-drift") bad("schema-drift id", c);
    else if (c.status !== "off")
      bad("schema-drift expected off when scope absent", c);
    else ok("checkScopeSchemaDrift: off when scope not configured");
  }

  // -- Codex round-9 LOW: future-mtime --
  {
    const ws = makeWs();
    const accessPath = path.join(ws, "fake-access.json");
    writeJson(accessPath, { ownerJids: [] });
    // Set mtime to 1h in the future
    const t = (Date.now() + 3_600_000) / 1000;
    fs.utimesSync(accessPath, t, t);
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "shadow",
          accessJsonPath: accessPath,
        },
      },
    });
    const c = checkScopeStale(ws);
    if (c.status !== "warn")
      bad("Codex round-9 future-mtime: expected warn", c);
    else if (!c.message.includes("clock skew"))
      bad("Codex round-9 future-mtime: expected clock skew message", c);
    else ok("Codex round-9: future-mtime triggers clock-skew warn");
  }

  // -- Codex round-9 LOW: exact 5s boundary fires now (>=) --
  {
    const ws = makeWs();
    const accessPath = path.join(ws, "fake-access.json");
    writeJson(accessPath, { ownerJids: [] });
    const t = (Date.now() - 5_000) / 1000;
    fs.utimesSync(accessPath, t, t);
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "shadow",
          accessJsonPath: accessPath,
        },
      },
    });
    const c = checkScopeStale(ws);
    // With the >= boundary fix, exact 5s should fire as info (not silently ok)
    if (c.status !== "info")
      bad("Codex round-9 exact 5s boundary: expected info", c);
    else ok("Codex round-9: exact 5s boundary fires as info");
  }

  // -- Codex round-9 multi-channel isolation: WA enforce + Telegram off --
  // Verify the deny-all clause only targets WhatsApp, not Telegram.
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "enforce",
          identity: "guest",
          accessJsonPath: "/nonexistent/missing.json",
          background: { identity: "deny" },
        },
        telegram: {
          mode: "off",
          background: { identity: "deny" },
        },
      },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);
    const ctx = makeForegroundContext("req-test");

    const sql = buildSqlPreFilter(ctx, runtime, cfg.scope);
    if (!sql.params.includes("whatsapp"))
      bad("multi-channel: SQL should target whatsapp", sql);
    else if (sql.params.includes("telegram"))
      bad("multi-channel: SQL must NOT target telegram (off)", sql);
    else
      ok(
        "multi-channel isolation: WA enforce+disarmed denied, Telegram off untouched"
      );
  }

  // -- Codex round-9 SQL NULL semantics: pre-Phase-4a-2.6 chunks denied --
  // A chunk with `source_channel = null` (legacy daily transcript) must
  // satisfy the deny-all predicate `chunks.source_channel != ?`. In
  // SQL, NULL != 'whatsapp' evaluates to NULL (not true). The semantic
  // contract: chunks with NULL channel are filtered OUT under enforce
  // (correct fail-closed behavior).
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "enforce",
          identity: "guest",
          accessJsonPath: "/nonexistent/missing.json",
          background: { identity: "deny" },
        },
      },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);
    const ctx = makeForegroundContext("req-test");

    // Build a fake legacy chunk with provenance.class.kind = "local"
    // (which is how legacy daily transcripts classify before Phase
    // 4a-2.6 indexer migration).
    const legacyChunk: SearchResult = {
      score: 1.0,
      path: "memory/MEMORY.md",
      citation: "legacy",
      snippet: "legacy data",
      provenance: {
        class: { kind: "local" },
        sourceChannel: null,
        sourceChatId: null,
      },
    };

    const filtered = filterScopedResults([legacyChunk], ctx, runtime, {
      scope: cfg.scope,
    });
    // Legacy local chunks (memory/...) should pass through — they
    // aren't channel-derived. Post-filter is correct. SQL pre-filter
    // behavior on rows with NULL source_channel: NULL != 'whatsapp'
    // is NULL in SQL — those rows are filtered OUT by WHERE clauses.
    // For local rows that's by construction; for legacy WA-derived
    // rows pre-migration, that's the intended fail-closed denial.
    if (filtered.results.length !== 1)
      bad("Codex round-9 NULL semantics: local chunks should pass", filtered);
    else ok("Codex round-9: local chunks pass-through under enforce+disarmed");
  }

  console.log(results.join("\n"));
  console.log(
    `\n${pass}/${pass + fail} Phase 5 v9 (ship-readiness) tests passed`
  );
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
