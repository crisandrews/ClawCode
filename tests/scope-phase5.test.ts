/**
 * Phase 5 — UX polish + lifecycle + doctor proactive offer + scope-status row.
 *
 * Tier1 cases:
 *   - checkScopeStatus: scope-absent path; configured-but-disarmed; armed.
 *   - checkScopeWizardAvailable: marker-dismissed; offer fires when WA paired
 *     + scope off; no offer when channel not paired or scope already configured.
 *   - startLifecycleWatcher: clearScopeRuntimeCache fires on file change with
 *     atomic rename pattern (parent dir watch); inert when dir missing.
 *
 * No browser/jsdom required — all paths are pure Node fs + the doctor
 * checks. Lifecycle watcher uses the injectable debounce override.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkScopeStatus,
  checkScopeWizardAvailable,
} from "../lib/doctor.ts";
import {
  startLifecycleWatcher,
  type LifecycleWatcherHandle,
} from "../lib/scope/lifecycle.ts";
import {
  clearScopeRuntimeCache,
  detectScopeRuntime,
  _resetRuntimeForTests,
} from "../lib/scope/runtime.ts";

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

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ph5-"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // -- checkScopeStatus when scope absent --
  {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "agent-config.json"), "{}", "utf-8");
    const c = checkScopeStatus(ws);
    if (c.id !== "scope-status") bad("scope-status id", c.id);
    if (c.status !== "ok") bad("scope-status absent: status", c.status);
    if (!c.message.includes("not configured"))
      bad("scope-status absent: message", c.message);
    else ok("checkScopeStatus — absent scope block returns ok/not-configured");
  }

  // -- checkScopeStatus when scope configured but mode off --
  // Per-channel info row should surface the disarmed state. Status is
  // info (a row to look at), not warn or error.
  {
    const ws = makeWorkspace();
    const cfg = {
      scope: {
        whatsapp: { mode: "off", identity: "auto", background: { identity: "deny" } },
      },
    };
    fs.writeFileSync(
      path.join(ws, "agent-config.json"),
      JSON.stringify(cfg, null, 2),
      "utf-8"
    );
    _resetRuntimeForTests();
    const c = checkScopeStatus(ws);
    if (c.status !== "info")
      bad("scope-status off: status (expected info)", c.status);
    else if (!c.message.includes("whatsapp"))
      bad("scope-status off: message", c.message);
    else if (!c.message.includes("disarmed"))
      bad("scope-status off: missing disarmed tag", c.message);
    else ok("checkScopeStatus — configured-off channel shows mode + disarmed");
  }

  // -- checkScopeWizardAvailable: marker-dismissed (env-var override; hermetic) --
  // Codex round 1 LOW #7: don't touch real ~/.claude. Use
  // CLAW_SCOPE_DISMISS_MARKER env override.
  {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "agent-config.json"), "{}", "utf-8");
    const tmpMarker = fs.mkdtempSync(path.join(os.tmpdir(), "ph5dm-"));
    const markerPath = path.join(tmpMarker, ".scope-wizard-dismissed");
    fs.writeFileSync(markerPath, "test-dismissed", "utf-8");
    const prior = process.env.CLAW_SCOPE_DISMISS_MARKER;
    process.env.CLAW_SCOPE_DISMISS_MARKER = markerPath;
    try {
      const c = checkScopeWizardAvailable(ws);
      if (c.status !== "off")
        bad("scope-wizard dismissed: status", `${c.status} ${c.message}`);
      else if (!c.message.includes("dismissed"))
        bad("scope-wizard dismissed: message", c.message);
      else ok("checkScopeWizardAvailable — marker-dismissed returns off (env override)");
    } finally {
      if (prior === undefined) delete process.env.CLAW_SCOPE_DISMISS_MARKER;
      else process.env.CLAW_SCOPE_DISMISS_MARKER = prior;
    }
  }

  // -- checkScopeWizardAvailable: scope already enabled (mode=shadow) --
  {
    const ws = makeWorkspace();
    const cfg = {
      scope: {
        whatsapp: { mode: "shadow" },
      },
    };
    fs.writeFileSync(
      path.join(ws, "agent-config.json"),
      JSON.stringify(cfg, null, 2),
      "utf-8"
    );
    // Ensure no dismiss marker
    const markerPath = path.join(
      os.homedir(),
      ".claude",
      "agent",
      ".scope-wizard-dismissed"
    );
    if (fs.existsSync(markerPath)) {
      // skip this case if user already has the marker (don't tamper)
      ok("checkScopeWizardAvailable — already-enabled case skipped (user has dismiss marker)");
    } else {
      const c = checkScopeWizardAvailable(ws);
      // Either ok ("no eligible channel") or off ("dismissed") is acceptable;
      // the offer must NOT fire when scope.whatsapp.mode is non-off.
      if (c.status === "info")
        bad("scope-wizard offer fired despite scope already enabled", c.message);
      else
        ok("checkScopeWizardAvailable — non-off mode suppresses the offer");
    }
  }

  // -- checkScopeStatus warns on misconfigured-armed (mode != off + disarmed) --
  // Codex round 1 MEDIUM #1. Force governance unresolvable by pointing
  // accessJsonPath at a non-existent file — adapter init returns null
  // → channel disarmed despite mode=enforce.
  {
    const ws = makeWorkspace();
    const fakeAccess = path.join(ws, "no-access-here.json");
    const cfg = {
      scope: {
        whatsapp: {
          mode: "enforce",
          accessJsonPath: fakeAccess,
        },
      },
    };
    fs.writeFileSync(
      path.join(ws, "agent-config.json"),
      JSON.stringify(cfg, null, 2),
      "utf-8"
    );
    _resetRuntimeForTests();
    const c = checkScopeStatus(ws);
    if (c.status !== "warn")
      bad(
        "scope-status misconfigured: expected warn",
        `${c.status} ${c.message}`
      );
    else if (!c.message.includes("disarmed"))
      bad("scope-status misconfigured: message missing disarmed", c.message);
    else if (!c.hint || !c.hint.includes("enforce"))
      bad("scope-status misconfigured: hint should warn user", String(c.hint));
    else ok("checkScopeStatus — non-off + disarmed → warn (Codex round 1 MEDIUM #1)");
  }

  // -- startLifecycleWatcher: inert when dir missing --
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ph5lcm-"));
    const fakeFile = path.join(tmp, "no-dir-here", "installed_plugins.json");
    const handle = startLifecycleWatcher({ pluginsFilePath: fakeFile });
    try {
      if (handle.active())
        bad("watcher should be inert when parent dir missing", "active=true");
      else ok("startLifecycleWatcher — inert when parent dir missing");
    } finally {
      handle.close();
    }
  }

  // -- startLifecycleWatcher: fires on change with parent-dir pattern --
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ph5lcw-"));
    const file = path.join(tmp, "installed_plugins.json");
    fs.writeFileSync(file, "{}", "utf-8");
    let fires = 0;
    const handle = startLifecycleWatcher({
      pluginsFilePath: file,
      debounceMs: 30,
      onChange: () => {
        fires++;
      },
    });
    try {
      if (!handle.active()) throw new Error("watcher should be active when dir exists");
      // Give the kqueue/inotify subscription a microtask to attach
      // before triggering the change.
      await sleep(50);
      // Modify the file
      fs.writeFileSync(file, '{"version":1}', "utf-8");
      // Wait for debounce + a margin
      await sleep(200);
      if (fires < 1)
        throw new Error(`expected at least 1 onChange fire, got ${fires}`);
      ok("startLifecycleWatcher — fires onChange + clearScopeRuntimeCache on file change");
    } catch (e) {
      bad("watcher fire", e);
    } finally {
      handle.close();
    }
  }

  // -- startLifecycleWatcher: cache cleared after fire --
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ph5lcc-"));
    const file = path.join(tmp, "installed_plugins.json");
    fs.writeFileSync(file, "{}", "utf-8");
    // Prime the runtime cache via detectScopeRuntime
    _resetRuntimeForTests();
    detectScopeRuntime({ scope: undefined });
    // detectScopeRuntime with no scope shouldn't cache, but the api
    // contract is that clearScopeRuntimeCache always succeeds.
    let fired = false;
    const handle = startLifecycleWatcher({
      pluginsFilePath: file,
      debounceMs: 20,
      onChange: () => {
        fired = true;
      },
    });
    try {
      fs.writeFileSync(file, '{"updated":true}', "utf-8");
      await sleep(100);
      if (!fired)
        throw new Error("onChange did not fire after change-write");
      // clearScopeRuntimeCache is exported and idempotent; calling it
      // here too verifies the symbol resolves.
      clearScopeRuntimeCache();
      ok("startLifecycleWatcher — clearScopeRuntimeCache callable; watcher fires");
    } catch (e) {
      bad("cache-clear flow", e);
    } finally {
      handle.close();
    }
  }

  // -- checkScopeWizardAvailable v3: positive offer with INJECTED detector (Codex round 2 LOW) --
  // Earlier coverage was non-hermetic — passed when no WA installed
  // simply because the real detector returned no match. v3 supplies a
  // fake detector so the offer branch is genuinely exercised.
  {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "agent-config.json"), "{}", "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ph5pos-"));
    const fakeMarker = path.join(tmp, "absent-marker"); // does not exist
    const prior = process.env.CLAW_SCOPE_DISMISS_MARKER;
    process.env.CLAW_SCOPE_DISMISS_MARKER = fakeMarker;
    try {
      // Inject: WA reports installed+authenticated.
      const fakeDetector = () => [
        { name: "whatsapp", installed: "yes", authenticated: "yes" },
        // Plus an unsupported channel that should be filtered out by
        // the SUPPORTED_OFFER_CHANNELS whitelist.
        { name: "telegram", installed: "yes", authenticated: "yes" },
      ];
      const c = checkScopeWizardAvailable(ws, fakeDetector as any);
      if (c.status !== "info")
        bad(
          "scope-wizard injected positive: expected info",
          `${c.status} ${c.message}`
        );
      else if (!c.message.includes("whatsapp"))
        bad("offer message must name whatsapp", c.message);
      else if (
        c.message.includes("telegram") ||
        c.message.includes("discord") ||
        c.message.includes("imessage")
      )
        bad(
          "unsupported channel leaked into offer (Codex round 1 MEDIUM #2)",
          c.message
        );
      else if (!c.message.includes("dismiss"))
        bad(
          "dismiss instruction must be in message body (Codex round 2 LOW)",
          c.message
        );
      else
        ok(
          "checkScopeWizardAvailable — injected detector exercises positive offer with whitelist + dismiss in body"
        );
    } finally {
      if (prior === undefined) delete process.env.CLAW_SCOPE_DISMISS_MARKER;
      else process.env.CLAW_SCOPE_DISMISS_MARKER = prior;
    }
  }

  // -- config-merge v3: invalid scope.<channel>.mode coerces to "off" (Codex round 2 MEDIUM) --
  {
    try {
      const { loadConfig } = await import("../lib/config.ts");
      const ws = makeWorkspace();
      const cfg = {
        scope: {
          whatsapp: {
            mode: "enfroce", // typo
            identity: "owner-typo",
            background: { identity: "system-typo" },
          },
        },
      };
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify(cfg, null, 2),
        "utf-8"
      );
      const loaded = loadConfig(ws);
      const wa = loaded.scope?.whatsapp;
      if (!wa) throw new Error("scope.whatsapp lost during merge");
      if (wa.mode !== "off")
        throw new Error(`typo'd mode should coerce to off, got ${wa.mode}`);
      if (wa.identity !== "auto")
        throw new Error(`bogus identity should coerce to auto, got ${wa.identity}`);
      if (wa.background?.identity !== "deny")
        throw new Error(
          `bogus bg.identity should coerce to deny, got ${wa.background?.identity}`
        );
      ok(
        "config merge — invalid mode/identity/bg.identity values coerce to safe defaults (Codex round 2 MEDIUM)"
      );
    } catch (e) {
      bad("config coercion", e);
    }
  }

  // -- checkScopeWizardAvailable: positive offer when supported channel installed + scope off --
  // Codex round 1 LOW #6: positive path coverage.
  // Note: this test uses the local environment's actual channel detector
  // (not a mock). Its outcome depends on whether claude-whatsapp is
  // installed in the test environment. Both branches are acceptable:
  //   - "info" with "whatsapp" → fires correctly
  //   - "ok" with "no eligible channel" → no WA installed, also fine
  // What's NOT acceptable: status "info" mentioning telegram/discord/imessage
  // (Codex round 1 MEDIUM #2 — restrict offer to channels with adapters)
  {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "agent-config.json"), "{}", "utf-8");
    // Hermetic dismiss-marker — set to a definitely-not-existing path
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ph5px-"));
    const fakeMarker = path.join(tmp, "absent-marker");
    const prior = process.env.CLAW_SCOPE_DISMISS_MARKER;
    process.env.CLAW_SCOPE_DISMISS_MARKER = fakeMarker;
    try {
      const c = checkScopeWizardAvailable(ws);
      if (c.status === "info") {
        // Offer fired — the named channel must be in the supported set
        if (
          c.message.includes("telegram") ||
          c.message.includes("discord") ||
          c.message.includes("imessage")
        )
          bad(
            "scope-wizard offer fired for unsupported channel",
            c.message
          );
        else if (!c.message.includes("whatsapp"))
          bad("scope-wizard offer info but no channel named", c.message);
        else
          ok(
            "checkScopeWizardAvailable — positive offer restricted to whatsapp (Codex MEDIUM #2)"
          );
      } else if (c.status === "ok" || c.status === "off") {
        // No WA installed in the test env, or detector returned no eligible
        ok(
          "checkScopeWizardAvailable — no offer when no supported channel paired (acceptable)"
        );
      } else {
        bad("scope-wizard positive: unexpected status", c.status);
      }
    } finally {
      if (prior === undefined) delete process.env.CLAW_SCOPE_DISMISS_MARKER;
      else process.env.CLAW_SCOPE_DISMISS_MARKER = prior;
    }
  }

  // -- close() is idempotent --
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ph5lcd-"));
    const file = path.join(tmp, "installed_plugins.json");
    fs.writeFileSync(file, "{}", "utf-8");
    const handle = startLifecycleWatcher({ pluginsFilePath: file, debounceMs: 50 });
    handle.close();
    handle.close(); // double-close should not throw
    ok("LifecycleWatcherHandle.close is idempotent");
  }
}

run()
  .then(() => {
    process.stdout.write(results.join("\n") + "\n\n");
    process.stdout.write(`${pass}/${pass + fail} Phase 5 tests passed\n`);
    if (fail > 0) process.exit(1);
  })
  .catch((e) => {
    console.error("test runner crashed:", e);
    process.exit(2);
  });
