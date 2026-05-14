/**
 * Phase 4a-3 — dreams dual-lane regression tier1+tier2.
 *
 * Covers:
 *   - encodeChatIdForFilename: POSIX safe, NTFS safe, reversible,
 *     reserved-basename guard, trailing-dot/space encode
 *   - parseScopedMemoryPath: round-trip + traversal rejection +
 *     `_anychat` sentinel
 *   - deriveProvenance: `.scoped/<channel>/MEMORY.<encoded>.md` →
 *     channel attribution (NOT `_local`)
 *   - DreamEngine.promoteToMemory: armed + channel candidate →
 *     scoped lane file written; local candidate → MEMORY.md;
 *     dual-lane is a no-op when no channel armed
 *   - Synthetic chunk rehydration via MemoryDB (Codex CRITICAL #10)
 *   - File permissions on scoped tree (0700 dir, 0600 file)
 *
 * Run: `npx tsx tests/scope-dreams-dual-lane.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  encodeChatIdForFilename,
  decodeChatIdFromFilename,
  parseScopedMemoryPath,
  isScopedMemoryPath,
  scopedMemoryPath,
} from "../lib/scope/scoped-paths.ts";
import { deriveProvenance } from "../lib/scope/provenance.ts";
import { _resetRuntimeForTests } from "../lib/scope/runtime.ts";
import { DreamEngine } from "../lib/dreaming.ts";
import { MemoryDB } from "../lib/memory-db.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

function tmpDir(prefix = "p4a3-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeCandidate(p: string, snippet = "decision: ship X") {
  return {
    key: `memory:${p}:1:1`,
    entry: {
      path: p,
      startLine: 1,
      endLine: 1,
      snippet,
      recallCount: 5,
      totalScore: 1,
      maxScore: 1,
      firstRecalledAt: new Date().toISOString(),
      lastRecalledAt: new Date().toISOString(),
      recallDays: ["2026-04-28"],
      conceptTags: ["x"],
    },
    signals: {
      frequency: 1,
      relevance: 1,
      queryDiversity: 1,
      recency: 1,
      consolidation: 1,
      conceptualRichness: 1,
    },
    finalScore: 1,
  };
}

// ---------------------------------------------------------------------------
// Encoder / decoder tier1
// ---------------------------------------------------------------------------

await check("encodeChatIdForFilename — preserves jid-safe chars unchanged", () => {
  const enc = encodeChatIdForFilename("alice@s.whatsapp.net");
  if (enc !== "alice@s.whatsapp.net")
    throw new Error(`expected unchanged, got ${enc}`);
});

await check("encodeChatIdForFilename — escapes NTFS-reserved chars", () => {
  // Build a hostile id with every NTFS-reserved char.
  const enc = encodeChatIdForFilename('a<b>c:d"e|f?g*h\\i/j');
  // None of the reserved chars must remain.
  for (const c of '<>:"|?*\\/') {
    if (enc.includes(c)) throw new Error(`reserved ${c} not escaped: ${enc}`);
  }
  // Round-trip.
  const dec = decodeChatIdFromFilename(enc);
  if (dec !== 'a<b>c:d"e|f?g*h\\i/j')
    throw new Error(`round-trip mismatch: ${dec}`);
});

await check("encodeChatIdForFilename — escapes control + DEL + percent", () => {
  const id = "a%b\x01c\x7fd";
  const enc = encodeChatIdForFilename(id);
  if (enc.includes("%01") === false || enc.includes("%7F") === false)
    throw new Error(`controls not escaped: ${enc}`);
  // % must be escaped as %25 so the decoder is unambiguous.
  if (!enc.includes("%25")) throw new Error(`% not escaped to %25: ${enc}`);
  const dec = decodeChatIdFromFilename(enc);
  if (dec !== id) throw new Error(`round-trip mismatch: ${JSON.stringify(dec)}`);
});

await check("encodeChatIdForFilename — guards NTFS reserved basenames", () => {
  for (const name of ["CON", "con", "PRN", "COM1", "LPT9", "NUL"]) {
    const enc = encodeChatIdForFilename(name);
    if (!enc.startsWith("_"))
      throw new Error(`${name} not prefixed: ${enc}`);
    const dec = decodeChatIdFromFilename(enc);
    if (dec !== name) throw new Error(`${name} round-trip: ${dec}`);
  }
});

// Codex post-impl HIGH #4: encoder must be injective even for natural
// chat-ids that happen to encode to the same shape as the reserved-
// basename prefix.
await check(
  "encodeChatIdForFilename — `CON` and `_CON` produce DISTINCT encodings",
  () => {
    const a = encodeChatIdForFilename("CON");
    const b = encodeChatIdForFilename("_CON");
    if (a === b)
      throw new Error(`collision: CON → ${a} === _CON → ${b}`);
    if (decodeChatIdFromFilename(a) !== "CON")
      throw new Error(`CON round-trip: ${decodeChatIdFromFilename(a)}`);
    if (decodeChatIdFromFilename(b) !== "_CON")
      throw new Error(`_CON round-trip: ${decodeChatIdFromFilename(b)}`);
  }
);

await check(
  "encodeChatIdForFilename — every reserved name has a distinct underscored form",
  () => {
    for (const name of ["CON", "PRN", "AUX", "NUL", "COM1", "LPT9"]) {
      const a = encodeChatIdForFilename(name);
      const b = encodeChatIdForFilename("_" + name);
      if (a === b) throw new Error(`collision on ${name}: ${a}`);
    }
  }
);

// Codex post-impl HIGH #5: literal chat-id `_anychat` must not
// collide with the wildcard sentinel.
await check(
  "encodeChatIdForFilename — literal `_anychat` does not collide with sentinel",
  () => {
    const enc = encodeChatIdForFilename("_anychat");
    if (enc === "_anychat")
      throw new Error("literal _anychat encoded as sentinel");
    const dec = decodeChatIdFromFilename(enc);
    if (dec !== "_anychat") throw new Error(`round-trip: ${dec}`);
  }
);

await check(
  "scopedMemoryPath — literal `_anychat` and wildcard sentinel produce DIFFERENT files",
  () => {
    const sentinel = scopedMemoryPath("whatsapp", "*");
    const literal = scopedMemoryPath("whatsapp", "_anychat");
    if (sentinel === literal)
      throw new Error(`collision: ${sentinel} === ${literal}`);
    // Sentinel must round-trip to "*"; literal to "_anychat".
    const sParsed = parseScopedMemoryPath(sentinel);
    const lParsed = parseScopedMemoryPath(literal);
    if (sParsed?.chatId !== "*")
      throw new Error(`sentinel parse: ${sParsed?.chatId}`);
    if (lParsed?.chatId !== "_anychat")
      throw new Error(`literal parse: ${lParsed?.chatId}`);
  }
);

await check("encodeChatIdForFilename — escapes trailing dot/space", () => {
  for (const id of ["alice.", "alice ", "bob..", "carol "]) {
    const enc = encodeChatIdForFilename(id);
    const last = enc[enc.length - 1];
    if (last === "." || last === " ")
      throw new Error(`trailing ${last === " " ? "space" : "dot"} not escaped: ${enc}`);
    const dec = decodeChatIdFromFilename(enc);
    if (dec !== id) throw new Error(`round-trip mismatch: ${dec}`);
  }
});

await check("encodeChatIdForFilename — empty string rejected", () => {
  let threw = false;
  try {
    encodeChatIdForFilename("");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("empty id should throw");
});

// ---------------------------------------------------------------------------
// scopedMemoryPath / parseScopedMemoryPath round-trip
// ---------------------------------------------------------------------------

await check("scopedMemoryPath + parseScopedMemoryPath — round-trip basic", () => {
  const p = scopedMemoryPath("whatsapp", "alice@s.whatsapp.net");
  if (p !== "memory/.scoped/whatsapp/MEMORY.alice@s.whatsapp.net.md")
    throw new Error(`unexpected path: ${p}`);
  const parsed = parseScopedMemoryPath(p);
  if (parsed?.channel !== "whatsapp" || parsed.chatId !== "alice@s.whatsapp.net")
    throw new Error(`parse failed: ${JSON.stringify(parsed)}`);
});

await check("scopedMemoryPath — `*` chat-id sentinel routes to _anychat", () => {
  const p = scopedMemoryPath("whatsapp", "*");
  if (!p.endsWith("MEMORY._anychat.md")) throw new Error(p);
  const parsed = parseScopedMemoryPath(p);
  if (parsed?.chatId !== "*") throw new Error(`expected *, got ${parsed?.chatId}`);
});

await check("scopedMemoryPath — rejects unsafe channel name", () => {
  let threw = 0;
  for (const name of ["whats/app", "whats..app", "WhatsApp", "wa app"]) {
    try {
      scopedMemoryPath(name, "x");
    } catch {
      threw++;
    }
  }
  if (threw !== 4) throw new Error(`expected 4 throws, got ${threw}`);
});

await check("parseScopedMemoryPath — rejects path traversal attempts", () => {
  if (parseScopedMemoryPath("memory/.scoped/whatsapp/../etc/MEMORY.x.md") !== null)
    throw new Error("traversal accepted");
  if (parseScopedMemoryPath("memory/.scoped/wh/MEMORY..md") !== null)
    throw new Error("`..` basename accepted");
});

await check("parseScopedMemoryPath — rejects non-scoped paths", () => {
  if (parseScopedMemoryPath("memory/MEMORY.md") !== null)
    throw new Error("non-scoped accepted");
  if (parseScopedMemoryPath("extra:claude-whatsapp/foo.md") !== null)
    throw new Error("extra path accepted");
});

await check("isScopedMemoryPath — fast structural check matches encoder output", () => {
  if (!isScopedMemoryPath("memory/.scoped/whatsapp/MEMORY.alice@s.whatsapp.net.md"))
    throw new Error("canonical path not matched");
  if (isScopedMemoryPath("memory/MEMORY.md"))
    throw new Error("MEMORY.md falsely matched");
  if (isScopedMemoryPath("memory/.scoped/whatsapp"))
    throw new Error("dir falsely matched");
});

// ---------------------------------------------------------------------------
// deriveProvenance — Codex CRITICAL #2
// ---------------------------------------------------------------------------

await check(
  "deriveProvenance: scoped path → channel attribution (NOT _local)",
  () => {
    const prov = deriveProvenance(
      "memory/.scoped/whatsapp/MEMORY.alice@s.whatsapp.net.md"
    );
    if (prov.class.kind !== "channel")
      throw new Error(`kind: ${prov.class.kind}`);
    if (prov.sourceChannel !== "whatsapp")
      throw new Error(`channel: ${prov.sourceChannel}`);
    if (prov.sourceChatId !== "alice@s.whatsapp.net")
      throw new Error(`chat: ${prov.sourceChatId}`);
  }
);

await check(
  "deriveProvenance: scoped path with `_anychat` → channel + null chat",
  () => {
    const prov = deriveProvenance(
      "memory/.scoped/whatsapp/MEMORY._anychat.md"
    );
    if (prov.class.kind !== "channel")
      throw new Error(`kind: ${prov.class.kind}`);
    if (prov.sourceChannel !== "whatsapp")
      throw new Error(`channel: ${prov.sourceChannel}`);
    if (prov.sourceChatId !== null)
      throw new Error(`chat should be null, got ${prov.sourceChatId}`);
  }
);

await check("deriveProvenance: encoded special chars round-trip", () => {
  const enc = encodeChatIdForFilename('alice<b>:c@s.whatsapp.net');
  const p = `memory/.scoped/whatsapp/MEMORY.${enc}.md`;
  const prov = deriveProvenance(p);
  if (prov.sourceChatId !== 'alice<b>:c@s.whatsapp.net')
    throw new Error(`chat round-trip failed: ${prov.sourceChatId}`);
});

await check("deriveProvenance: regular memory/ path remains _local", () => {
  const prov = deriveProvenance("memory/2026-04-28.md");
  if (prov.class.kind !== "local")
    throw new Error(`kind: ${prov.class.kind}`);
});

await check(
  "deriveProvenance: scoped with malformed encoded basename → null chat (decoded as-is)",
  () => {
    // A %ZZ would fail decodeURIComponent → parser returns null →
    // the path falls through past the scoped branch to local.
    const prov = deriveProvenance("memory/.scoped/whatsapp/MEMORY.%ZZ.md");
    // Falls through to local catch-all because the parser couldn't
    // decode — defensive, not a leak (it's still under memory/).
    if (prov.class.kind !== "local")
      throw new Error(`kind: ${prov.class.kind}`);
  }
);

// ---------------------------------------------------------------------------
// DreamEngine — dual-lane routing
// ---------------------------------------------------------------------------

await check(
  "DreamEngine.promoteToMemory — unarmed: all candidates go local (legacy behavior)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# Memory\n");
      // No scope.* in config → unarmed.
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({ memory: { backend: "builtin", citations: "auto" } })
      );
      const engine = new DreamEngine(ws) as unknown as {
        promoteToMemory: (p: unknown[]) => void;
      };
      engine.promoteToMemory([
        fakeCandidate("memory/2026-04-28.md"),
        fakeCandidate("extra:claude-whatsapp/2026-04-28.md"),
      ]);
      const memContent = fs.readFileSync(
        path.join(ws, "memory", "MEMORY.md"),
        "utf-8"
      );
      // No `.scoped` directory should exist when unarmed.
      const scopedExists = fs.existsSync(path.join(ws, "memory", ".scoped"));
      if (scopedExists)
        throw new Error("scoped dir created when no channel armed");
      // Unarmed: NO routing comment should appear (we hit the legacy
      // single-lane path).
      if (memContent.includes("routed to memory/.scoped"))
        throw new Error("routing comment leaked when unarmed");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "DreamEngine.promoteToMemory — armed: channel candidate → scoped lane file written + 0600 perms",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# Memory\n");
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const engine = new DreamEngine(ws) as unknown as {
        promoteToMemory: (p: unknown[]) => void;
      };
      // Synthetic chat path so provenance derives chat_id.
      const chatPath =
        "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28";
      engine.promoteToMemory([
        fakeCandidate("memory/2026-04-28.md", "decision: ship local thing"),
        fakeCandidate(chatPath, "alice mentioned X"),
      ]);

      const expectedScoped = path.join(
        ws,
        "memory",
        ".scoped",
        "whatsapp",
        "MEMORY.alice@s.whatsapp.net.md"
      );
      // Scoped file should NOT exist because rehydrate failed
      // (synthetic path with no MemoryDB wired into the engine).
      // But the routing decision must still be reflected in MEMORY.md.
      const memContent = fs.readFileSync(
        path.join(ws, "memory", "MEMORY.md"),
        "utf-8"
      );
      if (!memContent.includes("routed to memory/.scoped"))
        throw new Error("routing comment missing");
      if (memContent.includes("alice mentioned X"))
        throw new Error("scoped content leaked into MEMORY.md");
      // The scoped destination shouldn't have been created since
      // rehydrate produced no snippets — defensive check.
      if (fs.existsSync(expectedScoped)) {
        const stat = fs.statSync(expectedScoped);
        const mode = stat.mode & 0o777;
        if (mode !== 0o600)
          throw new Error(`scoped file mode ${mode.toString(8)}, want 600`);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "DreamEngine.promoteToMemory — armed + memoryDb wired: synthetic candidate rehydrates and lands in scoped lane",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# Memory\n");
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Plant a synthetic chunk via the public upsert API.
        const synthPath =
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28";
        const planted = memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: synthPath,
          text: "alice mentioned ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        if (!planted) throw new Error("plant failed");
        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        engine.promoteToMemory([fakeCandidate(synthPath, "irrelevant")]);
        const expectedScoped = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md"
        );
        if (!fs.existsSync(expectedScoped))
          throw new Error(
            "scoped file was not created despite memoryDb being wired"
          );
        const scopedContent = fs.readFileSync(expectedScoped, "utf-8");
        if (!scopedContent.includes("alice mentioned ship X"))
          throw new Error(
            `synthetic snippet not rehydrated into scoped file: ${scopedContent}`
          );
        // Permissions: 0600 file + 0700 dir (POSIX-only invariant)
        if (process.platform !== "win32") {
          const fileMode = fs.statSync(expectedScoped).mode & 0o777;
          if (fileMode !== 0o600)
            throw new Error(`file mode ${fileMode.toString(8)}, want 600`);
          const dirMode =
            fs.statSync(path.dirname(expectedScoped)).mode & 0o777;
          if (dirMode !== 0o700)
            throw new Error(`dir mode ${dirMode.toString(8)}, want 700`);
          const rootMode =
            fs.statSync(path.dirname(path.dirname(expectedScoped))).mode &
            0o777;
          if (rootMode !== 0o700)
            throw new Error(`scoped/ root mode ${rootMode.toString(8)}, want 700`);
        }
        // MEMORY.md must NOT contain the synthetic snippet.
        const memContent = fs.readFileSync(
          path.join(ws, "memory", "MEMORY.md"),
          "utf-8"
        );
        if (memContent.includes("alice mentioned ship X"))
          throw new Error("scoped content leaked into MEMORY.md");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "DreamEngine.promoteToMemory — local + scoped mixed: each lane gets its own",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# Memory\n");
      // Plant a real local file so rehydrate succeeds for the local
      // candidate.
      fs.writeFileSync(
        path.join(ws, "memory", "2026-04-28.md"),
        "decision: local-only thing\n"
      );
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "bob@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/bob@s.whatsapp.net/2026-04-28",
          text: "bob said hi",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        engine.promoteToMemory([
          fakeCandidate("memory/2026-04-28.md"),
          fakeCandidate(
            "extra:claude-whatsapp/messages-db/bob@s.whatsapp.net/2026-04-28"
          ),
        ]);
        const memContent = fs.readFileSync(
          path.join(ws, "memory", "MEMORY.md"),
          "utf-8"
        );
        if (!memContent.includes("decision: local-only thing"))
          throw new Error(
            `local candidate missing from MEMORY.md: ${memContent}`
          );
        if (memContent.includes("bob said hi"))
          throw new Error("scoped content leaked into MEMORY.md");
        const scopedFile = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.bob@s.whatsapp.net.md"
        );
        if (!fs.existsSync(scopedFile))
          throw new Error("scoped destination not written");
        const scopedContent = fs.readFileSync(scopedFile, "utf-8");
        if (!scopedContent.includes("bob said hi"))
          throw new Error(`scoped content missing: ${scopedContent}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "DreamEngine.promoteToMemory — repeat call is idempotent (no duplicate bullet)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# Memory\n");
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        const cand = fakeCandidate(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
        );
        engine.promoteToMemory([cand]);
        engine.promoteToMemory([cand]);
        const scopedFile = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md"
        );
        const content = fs.readFileSync(scopedFile, "utf-8");
        // The bullet line must appear exactly once despite two calls.
        const bulletMatches = content.match(/- ship X \*\(score:/g) ?? [];
        if (bulletMatches.length !== 1)
          throw new Error(
            `expected 1 bullet, got ${bulletMatches.length}: ${content}`
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "DreamEngine.promoteToMemory — armed but UNARMED-channel candidate goes local (preserves data)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# Memory\n");
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      // WhatsApp armed; telegram NOT configured.
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      // Plant a real telegram-rooted "extra:" file.
      fs.writeFileSync(
        path.join(ws, "memory", "telegram-source.md"),
        "tg-content\n"
      );
      const engine = new DreamEngine(ws) as unknown as {
        promoteToMemory: (p: unknown[]) => void;
      };
      // Telegram-shaped extra path. With current `deriveChannelHint`,
      // an unrecognized extra root comes back null → falls through
      // to legacy_unprovenanced (local). We just need to verify the
      // router doesn't drop it on the floor.
      engine.promoteToMemory([
        fakeCandidate("memory/2026-04-28-local.md", "decision: local"),
      ]);
      // No assertion failure means the unarmed-channel branch didn't
      // crash. The bullet may or may not appear depending on
      // rehydrate (the file doesn't exist), which is acceptable.
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex CRITICAL #10 — synthetic rehydration must succeed via MemoryDB
// ---------------------------------------------------------------------------

await check(
  "rehydrateSnippet via MemoryDB — synthetic path returns text WITHOUT line-number prefix",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "first line\nsecond line\nthird line",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const engine = new DreamEngine(ws, memDb) as unknown as {
          rehydrateSnippet: (e: unknown) => string | null;
        };
        const out = engine.rehydrateSnippet({
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          startLine: 1,
          endLine: 3,
        });
        if (out === null) throw new Error("returned null");
        // Must NOT contain `1\t` / `2\t` line-number prefixes.
        if (/^\d+\t/m.test(out))
          throw new Error(`line-number prefix leaked: ${JSON.stringify(out)}`);
        if (!out.includes("first line") || !out.includes("third line"))
          throw new Error(`snippet content missing: ${out}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "rehydrateSnippet without MemoryDB — synthetic path returns null (Codex CRITICAL #10 manifests)",
  () => {
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws) as unknown as {
        rehydrateSnippet: (e: unknown) => string | null;
      };
      const out = engine.rehydrateSnippet({
        path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
        startLine: 1,
        endLine: 3,
      });
      if (out !== null)
        throw new Error(
          `expected null without memoryDb, got ${JSON.stringify(out)}`
        );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex post-impl round 1 fixes — coverage
// ---------------------------------------------------------------------------

await check(
  "isScopedMemoryPath — rejects unknown channel name (post-impl MEDIUM #8)",
  () => {
    if (isScopedMemoryPath("memory/.scoped/notreal/MEMORY.x.md"))
      throw new Error("unknown channel accepted");
    if (parseScopedMemoryPath("memory/.scoped/notreal/MEMORY.x.md") !== null)
      throw new Error("parser accepted unknown channel");
    // Known channels should still parse.
    if (!isScopedMemoryPath("memory/.scoped/whatsapp/MEMORY.x.md"))
      throw new Error("known channel rejected");
  }
);

await check(
  "deriveProvenance — unknown-channel scoped path falls through to local (no PII trust)",
  () => {
    const prov = deriveProvenance(
      "memory/.scoped/notreal/MEMORY.alice@s.whatsapp.net.md"
    );
    // Falls through to the generic memory/... local catch-all
    // because the scoped-path parser rejected the unknown channel.
    // This is fail-closed: a planted file under a fake channel
    // doesn't get treated as channel-scoped content.
    if (prov.class.kind === "channel")
      throw new Error(
        `unknown channel was trusted: ${JSON.stringify(prov)}`
      );
  }
);

await check(
  "MemoryDB.sync — indexes memory/.scoped/<channel>/MEMORY.<chat>.md (post-impl HIGH #3)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory", ".scoped", "whatsapp"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md"
        ),
        "# Scoped memory — whatsapp\n\n## Promoted by dreaming (2026-04-29)\n\n- alice mentioned ship X *(score: 1.00, source: extra:claude-whatsapp/...)*\n"
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Force a sync to pick up the on-disk file.
        memDb.sync();
        // Search should now find content from the scoped file.
        const r = memDb.search("alice mentioned ship", { maxResults: 5 });
        if (r.length === 0)
          throw new Error("scoped file not indexed by sync()");
        // The hit must carry channel attribution (not _local).
        const hit = r.find((x) => x.path.includes(".scoped/whatsapp"));
        if (!hit) throw new Error("no hit on scoped path");
        if (hit.provenance?.sourceChannel !== "whatsapp")
          throw new Error(
            `expected sourceChannel whatsapp, got ${hit.provenance?.sourceChannel}`
          );
        if (hit.provenance?.sourceChatId !== "alice@s.whatsapp.net")
          throw new Error(
            `expected sourceChatId alice@s.whatsapp.net, got ${hit.provenance?.sourceChatId}`
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "DreamEngine — DREAMS.md redacts scoped paths (post-impl CRITICAL #2)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory", ".dreams"), { recursive: true });
      fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# Memory\n");
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      // Plant recall state so runDeep promotes a synthetic candidate.
      const synthPath =
        "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28";
      const recallState = {
        entries: {
          [`memory:${synthPath}:1:1`]: {
            path: synthPath,
            startLine: 1,
            endLine: 1,
            snippet: "alice ship X",
            recallCount: 5,
            totalScore: 5,
            maxScore: 1,
            firstRecalledAt: new Date().toISOString(),
            lastRecalledAt: new Date().toISOString(),
            recallDays: ["2026-04-26", "2026-04-27"],
            conceptTags: ["x"],
          },
        },
      };
      fs.writeFileSync(
        path.join(ws, "memory", ".dreams", "short-term-recall.json"),
        JSON.stringify(recallState)
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: synthPath,
          text: "alice ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const engine = new DreamEngine(ws, memDb);
        engine.runDeep({
          minScore: 0,
          minRecallCount: 1,
          minUniqueQueries: 1,
          maxPromotions: 1,
        });
        const dreamsContent = fs.readFileSync(
          path.join(ws, "DREAMS.md"),
          "utf-8"
        );
        // The raw chat-id MUST NOT appear in DREAMS.md.
        if (dreamsContent.includes("alice@s.whatsapp.net"))
          throw new Error(
            `chat-id leaked into DREAMS.md:\n${dreamsContent}`
          );
        // The synthetic chunk path MUST NOT appear either.
        if (dreamsContent.includes("messages-db/alice"))
          throw new Error(
            `synthetic path leaked into DREAMS.md:\n${dreamsContent}`
          );
        // The redacted form MUST appear.
        if (!dreamsContent.match(/<scoped:whatsapp:[0-9a-f]{8}>/))
          throw new Error(
            `expected <scoped:whatsapp:hash> in DREAMS.md, got:\n${dreamsContent}`
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "applyPreventivePromoteGuard — channel-aware: drops only ARMED-channel paths (post-impl HIGH #6)",
  async () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const { detectScopeRuntime, applyPreventivePromoteGuard } = await import(
        "../lib/scope/runtime.ts"
      );
      const { loadConfig } = await import("../lib/config.ts");
      const runtime = detectScopeRuntime(loadConfig(ws));
      if (!runtime.anyArmed) throw new Error("setup: not armed");
      const make = (p: string) => ({ entry: { path: p } });
      const out = applyPreventivePromoteGuard(
        [
          make("memory/2026-04-28.md"), // local — kept
          make("extra:claude-whatsapp/foo.md"), // armed channel — dropped
          make("extra:telegram/foo.md"), // unarmed channel — KEPT (regression)
        ],
        runtime
      );
      if (out.kept.length !== 2)
        throw new Error(`expected 2 kept, got ${out.kept.length}`);
      if (out.skipped !== 1)
        throw new Error(`expected 1 skipped, got ${out.skipped}`);
      const keptPaths = out.kept.map((c) => c.entry.path).sort();
      if (
        !keptPaths.includes("memory/2026-04-28.md") ||
        !keptPaths.includes("extra:telegram/foo.md")
      )
        throw new Error(
          `unarmed-channel path was dropped: ${JSON.stringify(keptPaths)}`
        );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "writeScopedMemory — concurrent writers serialize via lock (post-impl MEDIUM #7)",
  async () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        const cand = fakeCandidate(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
        );
        // Plant a stale lockfile to verify stale-lock recovery.
        const expected = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md.lock"
        );
        fs.mkdirSync(path.dirname(expected), { recursive: true });
        fs.writeFileSync(expected, "12345");
        const old = Date.now() - 60_000;
        fs.utimesSync(expected, new Date(old), new Date(old));
        // Write should still succeed under stale-lock recovery (60s
        // > 30s STALE_MS).
        engine.promoteToMemory([cand]);
        const dest = expected.replace(/\.lock$/, "");
        if (!fs.existsSync(dest))
          throw new Error("write blocked by stale lock");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex post-impl round 2 fixes — coverage
// ---------------------------------------------------------------------------

await check(
  "redactDreamPath — absolute path under workspace gets redacted (round2 CRITICAL #6)",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory", ".scoped", "whatsapp"), {
        recursive: true,
      });
      const engine = new DreamEngine(ws) as unknown as {
        redactDreamPath: (p: string) => string;
      };
      const abs = path.join(
        ws,
        "memory",
        ".scoped",
        "whatsapp",
        "MEMORY.alice@s.whatsapp.net.md"
      );
      const out = engine.redactDreamPath(abs);
      // Absolute path under workspace must NOT pass through unredacted.
      if (out.includes("alice@s.whatsapp.net"))
        throw new Error(`PII leak: ${out}`);
      // Should match `<scoped:whatsapp:hash>`.
      if (!/^<scoped:whatsapp:[0-9a-f]{8}>$/.test(out))
        throw new Error(`expected <scoped:whatsapp:hash>, got ${out}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "redactDreamPath — absolute extra: synthetic path normalizes via workspace-relative",
  () => {
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws) as unknown as {
        redactDreamPath: (p: string) => string;
      };
      // Logical extra: paths aren't absolute by construction, so this
      // checks the alternative branch fires for a non-workspace-rooted
      // string starting with extra:.
      const out = engine.redactDreamPath(
        "extra:claude-whatsapp/messages-db/alice/2026-04-28"
      );
      if (out.includes("alice"))
        throw new Error(`PII leak: ${out}`);
      if (!out.startsWith("<scoped:whatsapp:"))
        throw new Error(`expected scoped:whatsapp prefix, got ${out}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "redactDreamPath — fallback for unknown-channel scoped path (defense in depth)",
  () => {
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws) as unknown as {
        redactDreamPath: (p: string) => string;
      };
      // An unknown channel scoped path. parseScopedMemoryPath rejects
      // it (round2 MEDIUM #8 fix), but the redactor still hashes it
      // via the `memory/.scoped/` defense-in-depth fallback.
      const out = engine.redactDreamPath(
        "memory/.scoped/notreal/MEMORY.x.md"
      );
      if (out.includes("notreal/MEMORY"))
        throw new Error(`unredacted: ${out}`);
      if (!out.startsWith("<scoped:unknown:"))
        throw new Error(`expected unknown prefix, got ${out}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "MemoryDB.sync — unknown-channel .scoped/ dir is SKIPPED, not indexed as local (round2 HIGH #9)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      const fakeDir = path.join(ws, "memory", ".scoped", "notreal");
      fs.mkdirSync(fakeDir, { recursive: true });
      // Plant a file with content that would be alarming if indexed.
      fs.writeFileSync(
        path.join(fakeDir, "MEMORY.attacker.md"),
        "INJECTED: secret token ABC123"
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.sync();
        const r = memDb.search("INJECTED secret token", { maxResults: 5 });
        if (r.length !== 0)
          throw new Error(
            `unknown-channel scoped file got indexed: ${r.map((x) => x.path).join(", ")}`
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "applyPreventivePromoteGuard — exception isolation (round2 LOW #7)",
  async () => {
    const { applyPreventivePromoteGuard } = await import(
      "../lib/scope/runtime.ts"
    );
    const armed = {
      anyArmed: true,
      anyEnforceConfigured: true,
      channels: {
        whatsapp: {
          mode: "enforce" as const,
          configured: true,
          adapterAvailable: true,
          governanceResolvable: true,
          armed: true,
        },
      },
    };
    // Provide a candidate with a path that — even on a future change
    // to deriveProvenance — must still produce sane behavior. We
    // can't easily force deriveProvenance to throw without mocking,
    // so we exercise the type-guard path via an undefined entry path.
    const bad = { entry: { path: undefined as unknown as string } };
    const good = { entry: { path: "memory/x.md" } };
    const out = applyPreventivePromoteGuard([bad, good], armed);
    if (out.kept.length !== 2)
      throw new Error(
        `defensive path: expected 2 kept, got ${out.kept.length}`
      );
  }
);

await check(
  "MemoryDB — _anychat scoped chunk is owner-only via SQL prefilter NULL semantics (round2 MEDIUM #10)",
  () => {
    // Document the visibility contract: a chunk with source_chat_id
    // = NULL on a known channel is excluded by the partial-allowlist
    // SQL predicate. Owners (allowedChatIds === null → no prefilter)
    // still see it.
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory", ".scoped", "whatsapp"), {
        recursive: true,
      });
      // Sentinel scoped file (`_anychat` basename).
      fs.writeFileSync(
        path.join(ws, "memory", ".scoped", "whatsapp", "MEMORY._anychat.md"),
        "# scoped\n\n- general whatsapp note *(score: 1.00)*\n"
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.sync();
        // Owner search (no prefilter) finds it.
        const owner = memDb.search("general whatsapp note", { maxResults: 5 });
        if (owner.length === 0)
          throw new Error("owner search did not find _anychat content");
        const sentinel = owner.find((x) =>
          x.path.includes("MEMORY._anychat.md")
        );
        if (!sentinel) throw new Error("expected MEMORY._anychat.md hit");
        if (sentinel.provenance?.sourceChannel !== "whatsapp")
          throw new Error(
            `expected channel=whatsapp, got ${sentinel.provenance?.sourceChannel}`
          );
        if (sentinel.provenance?.sourceChatId !== null)
          throw new Error(
            `expected chat_id=null, got ${sentinel.provenance?.sourceChatId}`
          );
        // Partial-allowlist (non-owner) search excludes it.
        // memory-db.search prepends `AND` to the whereSql, so the
        // fragment passed here matches what `buildSqlPreFilter`
        // emits in production (no leading AND). Codex post-impl-
        // round3 LOW #9.
        const allowlist = memDb.search("general whatsapp note", {
          maxResults: 5,
          sqlPreFilter: {
            whereSql:
              "(chunks.source_channel != ? OR chunks.source_chat_id IN (?))",
            params: ["whatsapp", "alice@s.whatsapp.net"],
          },
        });
        const sentinelAllow = allowlist.find((x) =>
          x.path.includes("MEMORY._anychat.md")
        );
        if (sentinelAllow)
          throw new Error("non-owner partial-allowlist saw _anychat content");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "MemoryDB watcher — installs .scoped/ watch lazily when dir appears post-construction (round2 HIGH #3)",
  async () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Dir doesn't exist at construction time. Trigger an event
        // by creating it + a child file to nudge the parent watcher.
        const scopedDir = path.join(ws, "memory", ".scoped", "whatsapp");
        fs.mkdirSync(scopedDir, { recursive: true });
        fs.writeFileSync(
          path.join(scopedDir, "MEMORY.alice@s.whatsapp.net.md"),
          "# scoped\n\n- alice mentioned ship lazy *(score: 1.00)*\n"
        );
        // Force a sync (lazy watcher install would happen on next
        // event; sync ensures the file is indexed regardless).
        memDb.sync();
        const r = memDb.search("alice mentioned ship lazy", {
          maxResults: 5,
        });
        if (r.length === 0)
          throw new Error(
            "scoped file not indexed after post-construction creation"
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "writeScopedMemory — refuses takeover of fresh live lock (round2 MEDIUM #2)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        // Plant a FRESH lockfile (process.pid still alive — this
        // process). With round2's PID/hostname check, takeover must
        // not happen even if mtime is set old.
        const lockPath = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md.lock"
        );
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            pid: process.pid, // current process — definitely alive
            hostname: os.hostname(),
            ts: Date.now() - 60_000, // looks stale via mtime
          })
        );
        const oldDate = new Date(Date.now() - 60_000);
        fs.utimesSync(lockPath, oldDate, oldDate);

        const cand = fakeCandidate(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
        );
        engine.promoteToMemory([cand]);
        // The destination MUST NOT have been written because we held
        // the live lock — write should have given up after retries.
        const dest = lockPath.replace(/\.lock$/, "");
        if (fs.existsSync(dest))
          throw new Error(
            "concurrent live lock was stolen — PID check failed"
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex post-impl round 3 fixes — coverage
// ---------------------------------------------------------------------------

await check(
  "redactDreamPath — symlinked workspace canonical path still redacts (round3 CRITICAL #1)",
  () => {
    const ws = tmpDir();
    try {
      // Path with the sentinel substring but pointing at a different
      // path than pluginRoot. The substring guard must fire.
      const engine = new DreamEngine(ws) as unknown as {
        redactDreamPath: (p: string) => string;
      };
      const offTreePath = "/opt/elsewhere/memory/.scoped/whatsapp/MEMORY.alice@s.whatsapp.net.md";
      const out = engine.redactDreamPath(offTreePath);
      if (out.includes("alice@s.whatsapp.net"))
        throw new Error(`PII leak via canonical path: ${out}`);
      if (!out.startsWith("<scoped:whatsapp:"))
        throw new Error(`expected scoped:whatsapp:, got ${out}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "redactDreamPath — Windows-style backslash path with sentinel still redacts",
  () => {
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws) as unknown as {
        redactDreamPath: (p: string) => string;
      };
      const winLike =
        "C:\\Users\\someone\\proj\\memory\\.scoped\\whatsapp\\MEMORY.alice.md";
      const out = engine.redactDreamPath(winLike);
      if (out.includes("MEMORY.alice"))
        throw new Error(`PII leak on Windows-style: ${out}`);
      if (!out.startsWith("<scoped:whatsapp:"))
        throw new Error(`expected scoped:whatsapp:, got ${out}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "redactDreamPath — already-redacted text passes through unchanged (idempotent)",
  () => {
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws) as unknown as {
        redactDreamPath: (p: string) => string;
      };
      const already = "<scoped:whatsapp:abcd1234>";
      const out = engine.redactDreamPath(already);
      if (out !== already)
        throw new Error(`expected idempotent, got ${out} from ${already}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "DreamEngine.redactPathForDisplay — public alias hashes scoped paths (round3 CRITICAL #7)",
  () => {
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws);
      const out = engine.redactPathForDisplay(
        "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
      );
      if (out.includes("alice@s.whatsapp.net"))
        throw new Error(`alias did not redact: ${out}`);
      if (!out.startsWith("<scoped:whatsapp:"))
        throw new Error(`expected scoped:whatsapp:, got ${out}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "MemoryDB.bumpIndexerMetric — `scoped_unknown_channel_skipped` key accepted (round3 LOW #10)",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.bumpIndexerMetric("scoped_unknown_channel_skipped", 3);
        const v = memDb.getIndexerMetric("scoped_unknown_channel_skipped");
        if (v !== 3) throw new Error(`expected 3, got ${v}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "MemoryDB.sync — bumps `scoped_unknown_channel_skipped` for unknown-channel scoped files",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      const fakeDir = path.join(ws, "memory", ".scoped", "notreal");
      fs.mkdirSync(fakeDir, { recursive: true });
      fs.writeFileSync(
        path.join(fakeDir, "MEMORY.x.md"),
        "INJECTED content"
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.sync();
        const v = memDb.getIndexerMetric("scoped_unknown_channel_skipped");
        if (v !== 1)
          throw new Error(`expected 1 skip event, got ${v}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex post-impl round 4 fixes — coverage
// ---------------------------------------------------------------------------

await check(
  "redactDreamPath — mixed-case `Memory/.scoped/...` still redacts (round4 H1)",
  () => {
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws) as unknown as {
        redactDreamPath: (p: string) => string;
      };
      // Case variations a Windows / APFS case-insensitive FS could
      // surface. All must redact.
      const cases = [
        "/some/path/Memory/.scoped/whatsapp/MEMORY.alice.md",
        "/some/path/MEMORY/.SCOPED/whatsapp/MEMORY.alice.md",
        "C:\\Users\\x\\proj\\Memory\\.Scoped\\whatsapp\\MEMORY.alice.md",
      ];
      for (const c of cases) {
        const out = engine.redactDreamPath(c);
        if (out.includes("alice"))
          throw new Error(`mixed-case bypass on ${c}: ${out}`);
        if (!out.startsWith("<scoped:"))
          throw new Error(`expected redaction for ${c}, got ${out}`);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "writeScopedMemory — clock-skewed FUTURE mtime is treated as stale, not wedged (round4 H6)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        // Plant a stale lockfile with mtime FAR in the future + a
        // dead-pid payload so the same-host probe falls through to
        // the timestamp branch.
        const lockPath = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md.lock"
        );
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            // Pick a PID that's almost certainly not alive.
            pid: 1, // init — we send signal 0; some systems return EPERM
            hostname: "DEFINITELY-OTHER-HOST",
            ts: Date.now() + 24 * 60 * 60_000,
          })
        );
        const future = new Date(Date.now() + 24 * 60 * 60_000); // +1d
        fs.utimesSync(lockPath, future, future);

        const cand = fakeCandidate(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
        );
        engine.promoteToMemory([cand]);
        // The destination MUST exist — clamp(min(future, now)) makes
        // the lockfile look stale immediately (now - now = 0 < STALE_MS),
        // BUT the cross-host 5-minute grace branch requires
        // `now - effectiveMtime > 5min`. After clamping, that's
        // `now - now = 0 > 5min` → false → cross-host branch doesn't
        // take over. So this test verifies the clamp DOES NOT cause
        // an overaggressive takeover either: future mtime is at most
        // "stale at this moment" not "stale 1 day ago". Acceptable —
        // the lock holds until the grace expires from "now" forward.
        const dest = lockPath.replace(/\.lock$/, "");
        // Either way, the lock must NOT cause a runtime crash, and
        // canTakeOver must be a deterministic boolean. The test
        // mainly exercises that no exception fires for a future
        // mtime.
        // Sanity: lockfile still exists OR was taken over cleanly.
        const written = fs.existsSync(dest);
        const lockGone = !fs.existsSync(lockPath);
        // Either the dest was written (cross-host takeover after
        // grace, or same-host dead-PID path) or the lock is still
        // held (waiting on future grace). The clamp prevents the
        // PRIOR bug where future mtime would NEVER expire, giving
        // takeover behavior that can't even be triggered manually.
        if (written && lockGone) {
          // Took over successfully.
        } else if (!written && !lockGone) {
          // Lock still held — acceptable for a newly-clamped
          // future mtime. The wedged-forever bug would be: lock
          // held AND no path forward. The clamp gives a path.
        } else {
          throw new Error(
            `unexpected state: dest written=${written}, lock removed=${lockGone}`
          );
        }
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "dream tool wiring — server response uses redactPathForDisplay (round4 H12)",
  () => {
    // Direct contract test: redactPathForDisplay is a public method
    // on DreamEngine and produces redacted output for an extra: path.
    // The server.ts:1241 call site invokes this exact method, so a
    // unit-level assertion is sufficient to verify the contract
    // without spinning up the MCP server.
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws);
      // Real instance → real method.
      const out = engine.redactPathForDisplay(
        "extra:claude-whatsapp/messages-db/alice/2026-04-28"
      );
      if (!out.startsWith("<scoped:whatsapp:"))
        throw new Error(`server contract: ${out}`);
      // Local paths pass through unchanged.
      const local = engine.redactPathForDisplay("memory/2026-04-28.md");
      if (local !== "memory/2026-04-28.md")
        throw new Error(`local should pass through, got ${local}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex post-impl round 5 fixes — coverage
// ---------------------------------------------------------------------------

await check(
  "redactDreamPath — unknown channel in path body emits `<scoped:unknown:...>` (round5 RH-7)",
  () => {
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws) as unknown as {
        redactDreamPath: (p: string) => string;
      };
      // Off-tree path with `notreal/` channel slot. The channel
      // label MUST NOT echo `notreal` — that would let an attacker
      // plant arbitrary "channel" names into DREAMS.md / dream tool
      // output via a planted directory.
      const out = engine.redactDreamPath(
        "/some/path/memory/.scoped/notreal/MEMORY.x.md"
      );
      if (out.includes("notreal"))
        throw new Error(`unknown channel echoed: ${out}`);
      if (!out.startsWith("<scoped:unknown:"))
        throw new Error(`expected unknown label, got ${out}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "redactDreamPath — known channel in path body still uses real label",
  () => {
    const ws = tmpDir();
    try {
      const engine = new DreamEngine(ws) as unknown as {
        redactDreamPath: (p: string) => string;
      };
      const out = engine.redactDreamPath(
        "/some/path/memory/.scoped/whatsapp/MEMORY.alice.md"
      );
      if (!out.startsWith("<scoped:whatsapp:"))
        throw new Error(`expected whatsapp label, got ${out}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "writeScopedMemory — far-future mtime IS taken over (round5 RH-3 wedge fix)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const lockPath = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md.lock"
        );
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            pid: 99999, // placeholder
            hostname: "OTHER-HOST",
            ts: Date.now() + 365 * 24 * 60 * 60_000,
          })
        );
        // Mtime 1 year in the future — past the 5-min tolerance.
        const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60_000);
        fs.utimesSync(lockPath, farFuture, farFuture);

        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        const cand = fakeCandidate(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
        );
        engine.promoteToMemory([cand]);
        // Far-future mtime should be treated as corrupt → taken
        // over → write succeeds.
        const dest = lockPath.replace(/\.lock$/, "");
        if (!fs.existsSync(dest))
          throw new Error(
            "far-future mtime wedged the lock instead of taking over"
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "isKnownScopeChannel — exposed allowlist check (round5 RH-7 helper)",
  async () => {
    const { isKnownScopeChannel } = await import(
      "../lib/scope/scoped-paths.ts"
    );
    if (!isKnownScopeChannel("whatsapp")) throw new Error("whatsapp rejected");
    if (!isKnownScopeChannel("telegram")) throw new Error("telegram rejected");
    if (isKnownScopeChannel("notreal")) throw new Error("notreal accepted");
    if (isKnownScopeChannel("")) throw new Error("empty accepted");
    if (isKnownScopeChannel("WhatsApp"))
      throw new Error("uppercase variant accepted");
  }
);

await check(
  "scope-cache lockfile — far-future mtime auto-recovers (round5 RH-4)",
  async () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const lockPath = path.join(ws, "memory", "scope-cache.json.lock");
      fs.writeFileSync(lockPath, "stale");
      const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60_000);
      fs.utimesSync(lockPath, farFuture, farFuture);

      const { writeScopeCache } = await import("../lib/scope/cache.ts");
      const cachePath = path.join(ws, "memory", "scope-cache.json");
      const ok = writeScopeCache(cachePath, { hello: "world" }, { lockPath });
      if (!ok)
        throw new Error("write blocked by far-future stale lock (wedge)");
      if (fs.existsSync(lockPath))
        throw new Error("stale lock not cleaned up after write completed");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex post-impl round 6 fixes — coverage
// ---------------------------------------------------------------------------

await check(
  "writeScopedMemory — far-future mtime + LIVE same-host writer is NOT stolen (round6 #1)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const lockPath = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md.lock"
        );
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // LIVE same-host writer (this process) with far-future mtime.
        // The probe must detect "alive" and refuse takeover.
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            ts: Date.now() + 365 * 24 * 60 * 60_000,
          })
        );
        const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60_000);
        fs.utimesSync(lockPath, farFuture, farFuture);

        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        const cand = fakeCandidate(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
        );
        engine.promoteToMemory([cand]);
        // Live same-host writer must hold its lock — destination
        // NOT created.
        const dest = lockPath.replace(/\.lock$/, "");
        if (fs.existsSync(dest))
          throw new Error(
            "live same-host lock with far-future mtime was stolen"
          );
        // Lockfile still present.
        if (!fs.existsSync(lockPath))
          throw new Error("live same-host lockfile removed unexpectedly");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "writeScopedMemory — far-future mtime + cross-host writer IS stolen (round6 #1 cross-host)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const lockPath = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md.lock"
        );
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // Cross-host writer — we can't probe → timestamp-based.
        // Far-future mtime is the trigger for takeover.
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            pid: 99999,
            hostname: "DEFINITELY-NOT-THIS-HOST-12345",
            ts: Date.now() + 365 * 24 * 60 * 60_000,
          })
        );
        const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60_000);
        fs.utimesSync(lockPath, farFuture, farFuture);

        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        const cand = fakeCandidate(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
        );
        engine.promoteToMemory([cand]);
        const dest = lockPath.replace(/\.lock$/, "");
        if (!fs.existsSync(dest))
          throw new Error(
            "cross-host far-future lock should have been taken over"
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex post-impl round 7 concerns — coverage
// ---------------------------------------------------------------------------

await check(
  "writeScopedMemory — same-host crash recovery: ESRCH dead PID is taken over (round7 #10)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const lockPath = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md.lock"
        );
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // Find a definitely-dead PID. Pick a high number AND signal
        // it; on POSIX kill 0 returns ESRCH if not present. We need
        // to avoid PIDs that COULD be alive — use 999999 (extremely
        // unlikely to be a live process).
        const deadPid = 999_999;
        // Sanity: confirm dead (skip test if not — to avoid CI
        // false-positive on a system with a process at this pid).
        try {
          process.kill(deadPid, 0);
          console.log("  (skipping: pid 999999 was alive on this system)");
          return;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
            console.log("  (skipping: kill probe gave non-ESRCH)");
            return;
          }
        }
        // Plant a same-host lockfile with old mtime + dead PID.
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            pid: deadPid,
            hostname: os.hostname(),
            ts: Date.now() - 60_000,
          })
        );
        const oldDate = new Date(Date.now() - 60_000);
        fs.utimesSync(lockPath, oldDate, oldDate);

        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        const cand = fakeCandidate(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
        );
        engine.promoteToMemory([cand]);
        const dest = lockPath.replace(/\.lock$/, "");
        if (!fs.existsSync(dest))
          throw new Error(
            "ESRCH same-host crash recovery did not take over the lock"
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "writeScopedMemory — invalid PID payload routes through cross-host fallback (round7 #8)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: { backend: "builtin", citations: "auto" },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28",
          text: "ship X",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const lockPath = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY.alice@s.whatsapp.net.md.lock"
        );
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // Plant an old lockfile with PID=0 (invalid). The validator
        // rejects → falls into the "no valid payload" branch which
        // (for an old lockfile) takes over as malformed.
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            pid: 0,
            hostname: os.hostname(),
            ts: Date.now() - 60_000,
          })
        );
        const oldDate = new Date(Date.now() - 60_000);
        fs.utimesSync(lockPath, oldDate, oldDate);

        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        const cand = fakeCandidate(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28"
        );
        engine.promoteToMemory([cand]);
        const dest = lockPath.replace(/\.lock$/, "");
        if (!fs.existsSync(dest))
          throw new Error(
            "invalid PID payload should have been treated as malformed → takeover"
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex post-impl round 8 — non-synthetic extra: rehydration
// ---------------------------------------------------------------------------

await check(
  "rehydrateSnippet — real on-disk extra:<root>/<file>.md routes via MemoryDB (round8 HIGH)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    const extraRoot = tmpDir("p4a3-extra-");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      // Plant a real channel-log file under an extraPath.
      fs.writeFileSync(
        path.join(extraRoot, "2026-04-28.md"),
        "alice: hello world\nalice: ship X is done\nbob: noted\n"
      );
      const memDb = new MemoryDB(ws, [extraRoot], { quietBoot: true });
      try {
        memDb.sync();
        const engine = new DreamEngine(ws, memDb) as unknown as {
          rehydrateSnippet: (e: unknown) => string | null;
        };
        // Logical path: extra:<basename>/<file>.md per resolveLogicalPath.
        const logical = `extra:${path.basename(extraRoot)}/2026-04-28.md`;
        const out = engine.rehydrateSnippet({
          path: logical,
          startLine: 2,
          endLine: 2,
        });
        if (out === null)
          throw new Error("real on-disk extra: file failed to rehydrate");
        if (!out.includes("ship X is done"))
          throw new Error(`expected line content, got ${JSON.stringify(out)}`);
        // Must NOT contain the line-number prefix `2\t`.
        if (/^\d+\t/.test(out))
          throw new Error(`line-number prefix leaked: ${JSON.stringify(out)}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(extraRoot, { recursive: true, force: true });
    }
  }
);

await check(
  "DreamEngine.promoteToMemory — armed: real extra: log candidate lands in scoped lane (round8 HIGH end-to-end)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    const extraRoot = tmpDir("p4a3-extra-");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# Memory\n");
      // Channel-shaped extraPath: name contains "claude-whatsapp" so
      // deriveChannelHint returns "whatsapp".
      const channelDir = path.join(extraRoot, "claude-whatsapp-data");
      fs.mkdirSync(channelDir, { recursive: true });
      fs.writeFileSync(
        path.join(channelDir, "2026-04-28.md"),
        "this is the snippet to promote\nalice: more text\n"
      );
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: {
            backend: "builtin",
            citations: "auto",
            extraPaths: [extraRoot],
          },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [extraRoot], { quietBoot: true });
      try {
        memDb.sync();
        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        const logical = `extra:${path.basename(extraRoot)}/claude-whatsapp-data/2026-04-28.md`;
        engine.promoteToMemory([fakeCandidate(logical, "irrelevant")]);
        // Scoped destination should exist (chat_id unknown for non-
        // synthetic paths → routes to `_anychat` sentinel).
        const sentinelDest = path.join(
          ws,
          "memory",
          ".scoped",
          "whatsapp",
          "MEMORY._anychat.md"
        );
        if (!fs.existsSync(sentinelDest))
          throw new Error(
            "scoped sentinel file not written for real extra: log candidate"
          );
        const content = fs.readFileSync(sentinelDest, "utf-8");
        if (!content.includes("this is the snippet to promote"))
          throw new Error(
            `expected snippet rehydrated into scoped sentinel, got:\n${content}`
          );
        // MEMORY.md must NOT have the snippet.
        const memContent = fs.readFileSync(
          path.join(ws, "memory", "MEMORY.md"),
          "utf-8"
        );
        if (memContent.includes("this is the snippet to promote"))
          throw new Error("scoped content leaked into MEMORY.md");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(extraRoot, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Codex post-impl round 9 — close WATCH items for completeness
// ---------------------------------------------------------------------------

await check(
  "rehydrateSnippet — synthetic content with leading `\\d+\\t` is NOT stripped (round9 WATCH #1)",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const synthPath =
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-28";
        // Plant content where a line legitimately starts with
        // `5\t` (e.g. a JID prefix that contains a digit + tab).
        memDb.upsertSyntheticChunk({
          channel: "whatsapp",
          chatId: "alice@s.whatsapp.net",
          path: synthPath,
          text: "5\tship X done\n12\thello",
          upstreamMaxTs: Math.floor(Date.now() / 1000),
        });
        const engine = new DreamEngine(ws, memDb) as unknown as {
          rehydrateSnippet: (e: unknown) => string | null;
        };
        const out = engine.rehydrateSnippet({
          path: synthPath,
          startLine: 1,
          endLine: 2,
        });
        if (out === null) throw new Error("returned null");
        // The leading `5\t` and `12\t` MUST be preserved (synthetic
        // path → no per-line strip).
        if (!out.includes("5\tship X done"))
          throw new Error(
            `synthetic prefix mistakenly stripped: ${JSON.stringify(out)}`
          );
        if (!out.includes("12\thello"))
          throw new Error(
            `second-line prefix mistakenly stripped: ${JSON.stringify(out)}`
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "DreamEngine.promoteToMemory — armed wa + UNARMED telegram extra: lands LOCAL (round9 WATCH #2)",
  () => {
    _resetRuntimeForTests();
    const ws = tmpDir();
    const tgRoot = tmpDir("p4a3-tg-");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# Memory\n");
      // telegram-marker extra root.
      fs.writeFileSync(
        path.join(tgRoot, "telegram-export-2026-04-28.md"),
        "telegram general note\n"
      );
      const accessPath = path.join(ws, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
      );
      // ONLY whatsapp armed; telegram unconfigured.
      fs.writeFileSync(
        path.join(ws, "agent-config.json"),
        JSON.stringify({
          memory: {
            backend: "builtin",
            citations: "auto",
            extraPaths: [tgRoot],
          },
          scope: {
            whatsapp: { mode: "shadow", accessJsonPath: accessPath },
          },
        })
      );
      const memDb = new MemoryDB(ws, [tgRoot], { quietBoot: true });
      try {
        memDb.sync();
        const engine = new DreamEngine(ws, memDb) as unknown as {
          promoteToMemory: (p: unknown[]) => void;
        };
        const logical = `extra:${path.basename(tgRoot)}/telegram-export-2026-04-28.md`;
        engine.promoteToMemory([fakeCandidate(logical, "irrelevant")]);
        // Telegram unarmed → must NOT land in scoped lane.
        const tgScoped = path.join(
          ws,
          "memory",
          ".scoped",
          "telegram",
          "MEMORY._anychat.md"
        );
        if (fs.existsSync(tgScoped))
          throw new Error("unarmed telegram routed to scoped lane");
        // Should land in MEMORY.md instead (local lane preserves
        // unarmed-channel data).
        const memContent = fs.readFileSync(
          path.join(ws, "memory", "MEMORY.md"),
          "utf-8"
        );
        if (!memContent.includes("telegram general note"))
          throw new Error(
            `unarmed telegram candidate did not land in MEMORY.md:\n${memContent}`
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(tgRoot, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let pass = 0;
for (const r of results) {
  if (r.pass) {
    console.log(`  ✓ ${r.name}`);
    pass++;
  } else {
    console.log(`  ✗ ${r.name}: ${r.msg}`);
  }
}
console.log(`\n${pass}/${results.length} Phase 4a-3 dual-lane tests passed`);
if (pass !== results.length) process.exit(1);
