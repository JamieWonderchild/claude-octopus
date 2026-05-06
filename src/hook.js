#!/usr/bin/env node

const { readFileSync, existsSync, mkdirSync, appendFileSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const OCTOPUS_DIR = path.join(os.homedir(), '.claude', 'octopus');
const LOG_FILE = path.join(OCTOPUS_DIR, 'runs.jsonl');

// Prevent recursion: our background claude processes set this env var
if (process.env.CLAUDE_OCTOPUS_SKIP) process.exit(0);

function ensureDirs() {
  if (!existsSync(OCTOPUS_DIR)) mkdirSync(OCTOPUS_DIR, { recursive: true });
}

function log(entry) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

// Derive the Claude projects memory dir from a working directory path
// e.g. /Users/jar/Documents -> ~/.claude/projects/-Users-jar-Documents/memory
function getMemoryDir(cwd) {
  const hash = cwd.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', hash, 'memory');
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text).join(' ');
  }
  return '';
}

function getLastTurn(transcriptPath) {
  if (!existsSync(transcriptPath)) return null;

  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines.slice(-20)) {
    try {
      const obj = JSON.parse(line);
      const msg = obj.message;
      if (!msg?.role || !msg?.content) continue;
      const text = extractText(msg.content);
      if (text.trim()) messages.push(`${msg.role}: ${text.slice(0, 800)}`);
    } catch {}
  }

  return messages.slice(-4).join('\n\n');
}

function runGatekeeper(lastTurn) {
  const prompt = `Classify whether this conversation turn contains new knowledge worth persisting to long-term memory.

Reply with JSON only (no markdown):
{"worth_updating": boolean, "reason": "one sentence", "domains": ["short-domain-name"]}

WORTH persisting: new project decisions, architectural patterns, user preferences, novel solutions, new integrations discovered.
NOT worth persisting: routine bug fixes, formatting, typos, one-off queries, things already well-understood.

Last conversation turn:
${lastTurn}`;

  const result = spawnSync('claude', ['-p', prompt, '--output-format', 'json'], {
    timeout: 30000,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_OCTOPUS_SKIP: '1' }
  });

  if (result.status !== 0 || !result.stdout) {
    return { worth_updating: false, reason: 'gatekeeper failed', domains: [], tokens: 0, cost: 0 };
  }

  try {
    const outer = JSON.parse(result.stdout);
    const gate = JSON.parse(outer.result);
    const tokens = (outer.usage?.input_tokens || 0) + (outer.usage?.output_tokens || 0);
    return { ...gate, tokens, cost: outer.total_cost_usd || 0 };
  } catch {
    return { worth_updating: false, reason: 'parse error', domains: [], tokens: 0, cost: 0 };
  }
}

function getExcerpt(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-40).map(line => {
    try {
      const obj = JSON.parse(line);
      const msg = obj.message;
      if (!msg?.role || !msg?.content) return null;
      const text = extractText(msg.content);
      return text.trim() ? `${msg.role}: ${text.slice(0, 1500)}` : null;
    } catch { return null; }
  }).filter(Boolean).join('\n\n');
}

function runUpdater(transcriptPath, domains, memoryDir) {
  const excerpt = getExcerpt(transcriptPath);

  const prompt = `You are a knowledge curator for a developer's Claude Code memory system.

Memory directory: ${memoryDir}
Domains touched in this conversation: ${domains.join(', ')}

Your job:
1. Glob the memory directory to see what files exist
2. Read the MEMORY.md index and relevant existing memory files
3. Identify what is GENUINELY NEW in the conversation excerpt below
4. Update existing memory files OR create new ones using this frontmatter format:

---
name: descriptive-name
description: one-line description for the memory index
type: project
---

[concise content]

5. If you create new files, add them to MEMORY.md index (one line per entry: "- [Title](file.md) — one-line hook")
6. Be concise. Don't repeat what is already captured. Don't pad. Only write what's new.

Conversation excerpt:
${excerpt}`;

  const result = spawnSync('claude', [
    '-p', prompt,
    '--allowedTools', 'Read,Write,Edit,Glob',
    '--permission-mode', 'acceptEdits',
    '--output-format', 'json'
  ], {
    timeout: 120000,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_OCTOPUS_SKIP: '1' }
  });

  try {
    const outer = JSON.parse(result.stdout);
    const tokens = (outer.usage?.input_tokens || 0) + (outer.usage?.output_tokens || 0);
    return { tokens, cost: outer.total_cost_usd || 0 };
  } catch {
    return { tokens: 0, cost: 0 };
  }
}

// Entry point
ensureDirs();

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const { session_id, transcript_path, stop_reason, cwd = '' } = JSON.parse(input);

    if (stop_reason && stop_reason !== 'end_turn') {
      log({ session_id, gate: 'skip', reason: `stop_reason=${stop_reason}` });
      return;
    }

    const lastTurn = getLastTurn(transcript_path);
    if (!lastTurn || lastTurn.length < 100) {
      log({ session_id, gate: 'skip', reason: 'conversation too short' });
      return;
    }

    const gate = runGatekeeper(lastTurn);
    log({ session_id, gate: gate.worth_updating ? 'yes' : 'no', reason: gate.reason, domains: gate.domains, cwd, gate_tokens: gate.tokens, gate_cost: gate.cost });

    if (gate.worth_updating) {
      const memoryDir = getMemoryDir(cwd);
      const start = Date.now();
      const update = runUpdater(transcript_path, gate.domains, memoryDir);
      log({ session_id, event: 'updater_done', ms: Date.now() - start, update_tokens: update.tokens, update_cost: update.cost });
    }
  } catch (e) {
    log({ event: 'error', message: e.message });
  }
});
