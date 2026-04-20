/**
 * Tier 1 tests for WhatsApp detection across channel-detector and voice.
 *
 * Exercises the state-contract alignment with claude-whatsapp v1.x:
 *  - `status.json` as auth probe (not `auth/` dir → avoids false positives
 *    when the plugin has only started but never paired).
 *  - `installed_plugins.json` resolution for local-scope installs, including
 *    the "multi-agent" case (install local in Project A, run from Project B).
 *  - Top-level `audioTranscription` / `audioLanguage` schema.
 *
 * Run: `npx tsx tests/whatsapp-detection.test.ts`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectChannels,
  detectWhatsappProjectDir,
} from "../lib/channel-detector.ts";
import { detectWhatsappAudio } from "../lib/voice.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, msg: (err as Error).message });
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  home: string;
  cwd: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-wa-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  // Make the plugin appear "installed" — detectChannels only runs the probe
  // when the plugin cache has a matching entry.
  const cacheDir = path.join(home, ".claude", "plugins", "cache", "claude-whatsapp");
  fs.mkdirSync(cacheDir, { recursive: true });
  return {
    home,
    cwd,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeInstalledPlugins(
  home: string,
  entries: Array<{ scope: string; projectPath: string }>
) {
  const f = path.join(home, ".claude", "plugins", "installed_plugins.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: { "whatsapp@claude-whatsapp": entries } }, null, 2)
  );
}

function writeFile(p: string, body: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function whatsappStatus(channels: ReturnType<typeof detectChannels>) {
  const w = channels.find((c) => c.name === "whatsapp");
  assert(w, "whatsapp entry missing from detectChannels output");
  return w;
}

// ---------------------------------------------------------------------------
// detectWhatsappProjectDir
// ---------------------------------------------------------------------------

check("detectWhatsappProjectDir: exact cwd match wins over other local entries", () => {
  const fx = makeFixture();
  try {
    const other = path.join(fx.home, "project-a");
    writeInstalledPlugins(fx.home, [
      { scope: "local", projectPath: other },
      { scope: "local", projectPath: fx.cwd },
    ]);
    const got = detectWhatsappProjectDir(fx.home, fx.cwd);
    assert(got === fx.cwd, `expected ${fx.cwd}, got ${got}`);
  } finally {
    fx.cleanup();
  }
});

check("detectWhatsappProjectDir: falls back to first local when cwd doesn't match", () => {
  const fx = makeFixture();
  try {
    const other = path.join(fx.home, "project-a");
    writeInstalledPlugins(fx.home, [
      { scope: "local", projectPath: other },
    ]);
    const got = detectWhatsappProjectDir(fx.home, fx.cwd);
    assert(got === other, `expected ${other}, got ${got}`);
  } finally {
    fx.cleanup();
  }
});

check("detectWhatsappProjectDir: returns undefined when no local install", () => {
  const fx = makeFixture();
  try {
    writeInstalledPlugins(fx.home, [
      { scope: "user", projectPath: "" },
    ]);
    const got = detectWhatsappProjectDir(fx.home, fx.cwd);
    assert(got === undefined, `expected undefined, got ${got}`);
  } finally {
    fx.cleanup();
  }
});

check("detectWhatsappProjectDir: returns undefined when installed_plugins.json missing", () => {
  const fx = makeFixture();
  try {
    const got = detectWhatsappProjectDir(fx.home, fx.cwd);
    assert(got === undefined, `expected undefined, got ${got}`);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// detectChannels — WhatsApp probe
// ---------------------------------------------------------------------------

check("whatsapp probe: project-local status.json → authenticated yes", () => {
  const fx = makeFixture();
  try {
    writeInstalledPlugins(fx.home, [{ scope: "local", projectPath: fx.cwd }]);
    writeFile(
      path.join(fx.cwd, ".whatsapp", "status.json"),
      JSON.stringify({ status: "connected", ts: Date.now() })
    );
    const ch = whatsappStatus(
      detectChannels({ home: fx.home, cwd: fx.cwd, platform: "darwin", env: {} })
    );
    assert(ch.installed === "yes", `installed=${ch.installed}`);
    assert(
      ch.authenticated === "yes",
      `expected authenticated=yes, got ${ch.authenticated} (${ch.detail.authenticated})`
    );
  } finally {
    fx.cleanup();
  }
});

check("whatsapp probe: auth/ dir exists but no status.json → authenticated NO (false-positive guard)", () => {
  const fx = makeFixture();
  try {
    writeInstalledPlugins(fx.home, [{ scope: "local", projectPath: fx.cwd }]);
    // Plugin started once, created auth/ dir, but never paired → no status.json.
    fs.mkdirSync(path.join(fx.cwd, ".whatsapp", "auth"), { recursive: true });
    const ch = whatsappStatus(
      detectChannels({ home: fx.home, cwd: fx.cwd, platform: "darwin", env: {} })
    );
    assert(
      ch.authenticated === "no",
      `expected authenticated=no, got ${ch.authenticated} — empty auth/ should NOT be a pass`
    );
  } finally {
    fx.cleanup();
  }
});

check("whatsapp probe: global channels dir status.json → authenticated yes", () => {
  const fx = makeFixture();
  try {
    // No installed_plugins.json (user-scope install). Plugin writes to global.
    writeFile(
      path.join(fx.home, ".claude", "channels", "whatsapp", "status.json"),
      JSON.stringify({ status: "connected" })
    );
    const ch = whatsappStatus(
      detectChannels({ home: fx.home, cwd: fx.cwd, platform: "darwin", env: {} })
    );
    assert(
      ch.authenticated === "yes",
      `expected authenticated=yes, got ${ch.authenticated}`
    );
  } finally {
    fx.cleanup();
  }
});

check("whatsapp probe: multi-agent (install in project A, run from project B) → resolves A", () => {
  const fx = makeFixture();
  try {
    const projectA = path.join(fx.home, "project-a");
    fs.mkdirSync(projectA, { recursive: true });
    writeInstalledPlugins(fx.home, [{ scope: "local", projectPath: projectA }]);
    writeFile(
      path.join(projectA, ".whatsapp", "status.json"),
      JSON.stringify({ status: "connected" })
    );
    // Running from a different cwd (project B == fx.cwd).
    const ch = whatsappStatus(
      detectChannels({ home: fx.home, cwd: fx.cwd, platform: "darwin", env: {} })
    );
    assert(
      ch.authenticated === "yes",
      `expected authenticated=yes for multi-agent, got ${ch.authenticated} (${ch.detail.authenticated})`
    );
  } finally {
    fx.cleanup();
  }
});

check("whatsapp probe: no state anywhere → authenticated no", () => {
  const fx = makeFixture();
  try {
    writeInstalledPlugins(fx.home, [{ scope: "local", projectPath: fx.cwd }]);
    // No status.json, no auth/, nothing.
    const ch = whatsappStatus(
      detectChannels({ home: fx.home, cwd: fx.cwd, platform: "darwin", env: {} })
    );
    assert(
      ch.authenticated === "no",
      `expected authenticated=no, got ${ch.authenticated}`
    );
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// detectWhatsappAudio
// ---------------------------------------------------------------------------

check("detectWhatsappAudio: top-level schema with transcription on + language", () => {
  const fx = makeFixture();
  try {
    writeInstalledPlugins(fx.home, [{ scope: "local", projectPath: fx.cwd }]);
    writeFile(
      path.join(fx.cwd, ".whatsapp", "config.json"),
      JSON.stringify({ audioTranscription: true, audioLanguage: "en" })
    );
    const st = detectWhatsappAudio({ home: fx.home, cwd: fx.cwd });
    assert(st.pluginConfigured, "pluginConfigured should be true");
    assert(st.audioEnabled, "audioEnabled should be true");
    assert(st.audioLanguage === "en", `audioLanguage=${st.audioLanguage}`);
  } finally {
    fx.cleanup();
  }
});

check("detectWhatsappAudio: top-level audioTranscription=false → not enabled", () => {
  const fx = makeFixture();
  try {
    writeInstalledPlugins(fx.home, [{ scope: "local", projectPath: fx.cwd }]);
    writeFile(
      path.join(fx.cwd, ".whatsapp", "config.json"),
      JSON.stringify({ audioTranscription: false, audioLanguage: null })
    );
    const st = detectWhatsappAudio({ home: fx.home, cwd: fx.cwd });
    assert(st.pluginConfigured, "pluginConfigured should be true");
    assert(!st.audioEnabled, "audioEnabled should be false");
  } finally {
    fx.cleanup();
  }
});

check("detectWhatsappAudio: no config anywhere → pluginConfigured false", () => {
  const fx = makeFixture();
  try {
    const st = detectWhatsappAudio({ home: fx.home, cwd: fx.cwd });
    assert(!st.pluginConfigured, "pluginConfigured should be false");
    assert(!st.audioEnabled, "audioEnabled should be false");
  } finally {
    fx.cleanup();
  }
});

check("detectWhatsappAudio: malformed JSON → pluginConfigured true + error set", () => {
  const fx = makeFixture();
  try {
    writeInstalledPlugins(fx.home, [{ scope: "local", projectPath: fx.cwd }]);
    writeFile(path.join(fx.cwd, ".whatsapp", "config.json"), "{not valid json");
    const st = detectWhatsappAudio({ home: fx.home, cwd: fx.cwd });
    assert(st.pluginConfigured, "pluginConfigured should be true when file exists");
    assert(!st.audioEnabled, "audioEnabled should be false when parse fails");
    assert(typeof st.error === "string" && st.error.length > 0, `expected error message, got ${st.error}`);
  } finally {
    fx.cleanup();
  }
});

check("detectWhatsappAudio: multi-agent resolution (config lives in project A)", () => {
  const fx = makeFixture();
  try {
    const projectA = path.join(fx.home, "project-a");
    fs.mkdirSync(projectA, { recursive: true });
    writeInstalledPlugins(fx.home, [{ scope: "local", projectPath: projectA }]);
    writeFile(
      path.join(projectA, ".whatsapp", "config.json"),
      JSON.stringify({ audioTranscription: true, audioLanguage: "es" })
    );
    // Running from project B (fx.cwd != projectA), but the helper resolves A.
    const st = detectWhatsappAudio({ home: fx.home, cwd: fx.cwd });
    assert(st.pluginConfigured, "pluginConfigured should be true (resolved via installed_plugins.json)");
    assert(st.audioEnabled, "audioEnabled should be true");
    assert(st.audioLanguage === "es", `audioLanguage=${st.audioLanguage}`);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.msg ? ": " + r.msg : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
