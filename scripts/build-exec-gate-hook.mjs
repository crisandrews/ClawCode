#!/usr/bin/env node
/**
 * Build `dist/exec-gate-resolver.cjs` — the pre-built CommonJS bundle the
 * PreToolUse hook script invokes. Bundling sidesteps the ~150-200ms
 * cold-start of `tsx` on every tool call; the bundled CJS file boots in
 * ~11-12ms and gives the resolver a budget well under the 50ms armed-path
 * target.
 *
 * Drift detection (Codex Step 2 post-impl round-1 FAIL G + round-2 LOW 2):
 * the bundle's first line is a deterministic comment header
 *
 *   /* scope-exec-gate-bundle@<source-sha256> *\/
 *
 * computed from the actual files esbuild pulled into the bundle (via
 * `--metafile`). Auto-discovery means a new transitive import is
 * automatically covered; conversely, files that aren't actually bundled
 * (e.g. type-only imports) don't pollute the hash. The tier1 test
 * `scope-exec-gate.test.ts` recomputes the same hash and asserts the
 * bundle's header matches — so a hand-edited or stale bundle fails CI
 * before it can ship.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const OUT = path.join(ROOT, "dist", "exec-gate-resolver.cjs");
const META = path.join(ROOT, "dist", "exec-gate-resolver.meta.json");
const ENTRY = path.join(ROOT, "lib", "scope", "exec-gate-hook-entry.ts");

const esbuildBin = path.join(ROOT, "node_modules", ".bin", "esbuild");

function runEsbuild() {
  if (!fs.existsSync(esbuildBin)) {
    throw new Error(
      "build-exec-gate-hook: esbuild not found at node_modules/.bin/esbuild. Run `npm install` first."
    );
  }
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  execSync(
    `"${esbuildBin}" "${ENTRY}" --bundle --format=cjs --platform=node --target=node18 --external:better-sqlite3 --external:@modelcontextprotocol/sdk --external:@huggingface/transformers --metafile="${META}" --outfile="${OUT}"`,
    { cwd: ROOT, stdio: "inherit" }
  );
}

/**
 * `injectedInputs` (test-only): when provided, used instead of reading
 * the on-disk metafile. Lets tier1 tests exercise the filter logic
 * against synthetic Windows-style paths without spawning a real
 * cross-platform esbuild.
 */
function discoverSourceFiles({ injectedInputs } = {}) {
  let inputs;
  if (injectedInputs) {
    inputs = injectedInputs;
  } else {
    if (!fs.existsSync(META)) {
      throw new Error(
        `build-exec-gate-hook: metafile missing at ${META}. Run \`npm run build:hook\` first.`
      );
    }
    const meta = JSON.parse(fs.readFileSync(META, "utf8"));
    inputs = Object.keys(meta.inputs ?? {});
  }
  // Codex round-3 LOW 1: normalize backslashes (Windows esbuild may
  // emit `lib\scope\exec-gate.ts`). Without this, the filters below
  // miss `node_modules\`/`..\`/`.\` variants on Windows and leak
  // external entries into the source hash.
  const normalized = inputs.map((p) => p.replace(/\\/g, "/"));
  // Filter to workspace-local files. esbuild emits paths relative to the
  // working dir (which is ROOT), and node_modules entries we don't care
  // about (those are externalized/inlined and the bundle only loads them
  // at runtime). The hash should cover only our source files so external
  // package upgrades don't invalidate it spuriously.
  const localFiles = normalized
    .filter((p) => !p.startsWith("node_modules/"))
    .filter((p) => !p.startsWith("../"))
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/^\.\//, ""))
    .sort();
  return localFiles;
}

function computeSourceSha() {
  const sourceFiles = discoverSourceFiles();
  const hash = crypto.createHash("sha256");
  for (const rel of sourceFiles) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`build-exec-gate-hook: missing source file ${rel}`);
    }
    hash.update(rel);
    hash.update("\n");
    hash.update(fs.readFileSync(abs));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export { discoverSourceFiles, computeSourceSha };

// Run only when invoked directly (skip when imported by a test).
const isMain = (() => {
  try {
    return path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    runEsbuild();
    const sourceSha = computeSourceSha();
    const header = `/* scope-exec-gate-bundle@${sourceSha} */\n`;
    const body = fs.readFileSync(OUT, "utf8");
    fs.writeFileSync(OUT, header + body);

    const shortSha = sourceSha.slice(0, 16);
    console.log(
      `\nBuilt ${path.relative(ROOT, OUT)} (source-sha=${shortSha}…, ${discoverSourceFiles().length} source files hashed)`
    );
    console.log(
      "If you modified any scope source file, commit the rebuilt bundle alongside the source changes."
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
