import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWhatsappLiveSources } from '../lib/scope/live-source.ts';
import { saveVerifiedHostSession } from '../lib/host-session.ts';
import { generateResumeWrapper } from '../lib/service-generator.ts';
import { buildLaunchCommand } from '../lib/channel-detector.ts';

test('source selection revalidates owner, TTL and envelope revocation without exposing tokens', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = path.join(root, 'whatsapp'); const envelopes = path.join(channel, '.request-envelopes');
  fs.mkdirSync(envelopes, { recursive: true, mode: 0o700 });
  const access = path.join(channel, 'access.json');
  const owners = (ownerJids: string[]) => fs.writeFileSync(access, JSON.stringify({ ownerJids }), { mode: 0o600 });
  owners(['owner@s.whatsapp.net']);
  let now = Date.now(); const ts = now;
  const token = randomBytes(32).toString('base64url');
  const filename = path.join(envelopes, `${token}.json`);
  const envelope = (senderId = 'owner@s.whatsapp.net') => fs.writeFileSync(filename, JSON.stringify({ version: 1, token, chatId: 'owner@s.whatsapp.net', senderId, ts, expiresAt: ts + 60000 }), { mode: 0o600 });
  envelope();
  const sources = createWhatsappLiveSources({ workspace: root, channelDirectory: () => channel, now: () => now });
  const candidates = sources.list(); assert.equal(candidates.length, 1);
  assert.equal(JSON.stringify(candidates).includes(token), false); assert.equal(JSON.stringify(candidates).includes('@'), false);
  assert.equal(sources.resolve(candidates[0].id)?.ownerVerified, true);
  now += 60001; assert.equal(sources.resolve(candidates[0].id), null); now = ts;
  sources.list(); owners([]); assert.equal(sources.resolve(candidates[0].id), null);
  owners(['owner@s.whatsapp.net']); sources.list(); fs.unlinkSync(filename); assert.equal(sources.resolve(candidates[0].id), null);
  envelope('guest@s.whatsapp.net'); assert.deepEqual(sources.list(), []);
  envelope(); fs.chmodSync(access, 0o644); assert.deepEqual(sources.list(), []);
});

test('service wrapper resumes the verified native ID, blocks replacement and preserves config path', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live host_'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = fs.realpathSync(root), config = path.join(root, 'config');
  const sessions = path.join(config, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(sessions, { recursive: true });
  const session = randomUUID(); fs.writeFileSync(path.join(sessions, `${session}.jsonl`), '{}\n');
  // A more recent unrelated session must never be selected by --continue.
  fs.writeFileSync(path.join(sessions, `${randomUUID()}.jsonl`), '{}\n');
  const binary = path.join(root, 'claude-fixture.sh');
  fs.writeFileSync(binary, '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const wrapper = path.join(root, 'wrapper.sh'), flag = path.join(root, 'fresh.flag');
  fs.writeFileSync(wrapper, generateResumeWrapper({ workspace, claudeBin: binary, claudeConfigDir: config, logPath: path.join(root, 'log'), forceFreshFlagPath: flag, extraArgs: ['--chrome'] }));
  saveVerifiedHostSession(workspace, { generation: randomUUID(), nativeSessionId: session, bindingStatus: 'verified' });
  const run = () => spawnSync('bash', [wrapper], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
  assert.equal(run().status, 78, 'The existing MCP writer is still alive');
  const recordPath = path.join(root, '.clawcode-live', 'host-session.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  record.writerPid = Number(child.stdout); fs.writeFileSync(recordPath, JSON.stringify(record));
  const resumed = run(); assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(resumed.stdout.trim().split('\n'), ['--resume', session, '--dangerously-skip-permissions', '--chrome']);
  fs.writeFileSync(flag, ''); assert.equal(run().status, 78, 'Healing cannot silently replace pinned context'); fs.unlinkSync(flag);
  fs.unlinkSync(path.join(sessions, `${session}.jsonl`)); assert.equal(run().status, 78, 'A missing transcript must not select another session');
});

test('Live launch target is opt-in and cannot inject shell syntax', () => {
  assert.equal(buildLaunchCommand([]).includes('development-channels'), false);
  const command = buildLaunchCommand([], { liveChannelTarget: 'server:clawcode' });
  assert.match(command, /--dangerously-load-development-channels server:clawcode/);
  assert.equal(command.includes('skip-permissions'), false);
  assert.throws(() => buildLaunchCommand([], { liveChannelTarget: 'server:clawcode;echo unsafe' }));
});
