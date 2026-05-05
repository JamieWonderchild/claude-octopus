#!/usr/bin/env node

const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const OCTOPUS_DIR = path.join(os.homedir(), '.claude', 'octopus');
const LOG_FILE = path.join(OCTOPUS_DIR, 'runs.jsonl');
const HOOK_SCRIPT = path.join(__dirname, '..', 'src', 'hook.js');

function install() {
  if (!existsSync(OCTOPUS_DIR)) mkdirSync(OCTOPUS_DIR, { recursive: true });

  let settings = {};
  if (existsSync(SETTINGS_PATH)) {
    try { settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); } catch {}
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.Stop) settings.hooks.Stop = [];

  const alreadyInstalled = settings.hooks.Stop.some(h =>
    h.hooks?.some(hh => hh.command?.includes('octopus'))
  );
  if (alreadyInstalled) {
    console.log('claude-octopus hook already installed');
    return;
  }

  settings.hooks.Stop.push({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `node "${HOOK_SCRIPT}"`,
        async: true,
        statusMessage: 'Updating knowledge models...'
      }
    ]
  });

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log('claude-octopus installed');
  console.log(`  Hook: ${HOOK_SCRIPT}`);
  console.log(`  Log:  ${LOG_FILE}`);
}

function parseFrontmatter(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const descMatch = content.match(/^description:\s*(.+)$/m);
    return {
      name: nameMatch?.[1]?.trim() || path.basename(filePath, '.md'),
      description: descMatch?.[1]?.trim() || ''
    };
  } catch { return { name: path.basename(filePath, '.md'), description: '' }; }
}

function listModels() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];

  const models = [];
  const now = Date.now();

  for (const project of readdirSync(projectsDir)) {
    const memoryDir = path.join(projectsDir, project, 'memory');
    if (!existsSync(memoryDir)) continue;

    for (const file of readdirSync(memoryDir)) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
      const filePath = path.join(memoryDir, file);
      const stat = statSync(filePath);
      const ageDays = Math.floor((now - stat.mtimeMs) / 86400000);
      const { name, description } = parseFrontmatter(filePath);
      models.push({ name, description, file, project, ageDays, stale: ageDays > 30 });
    }
  }

  return models.sort((a, b) => a.ageDays - b.ageDays);
}

function status() {
  if (!existsSync(LOG_FILE)) {
    console.log('No runs yet. Have a Claude conversation first.');
    return;
  }

  const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const runs = entries.filter(e => e.gate);
  const yes = runs.filter(e => e.gate === 'yes').length;
  const no = runs.filter(e => e.gate === 'no').length;
  const skipped = runs.filter(e => e.gate === 'skip').length;

  const totalCost = entries.reduce((sum, e) => sum + (e.gate_cost || 0) + (e.update_cost || 0), 0);
  const totalTokens = entries.reduce((sum, e) => sum + (e.gate_tokens || 0) + (e.update_tokens || 0), 0);

  console.log(`\n── Runs ──────────────────────────────────────────`);
  console.log(`Total: ${runs.length}  |  updated: ${yes}  |  no-op: ${no}  |  skipped: ${skipped}`);
  console.log(`Gate yes rate: ${(yes + no) ? Math.round((yes / (yes + no)) * 100) : 0}% of non-skipped`);
  console.log(`\n── Cost ──────────────────────────────────────────`);
  console.log(`Total tokens: ${totalTokens.toLocaleString()}  |  Est. cost: $${totalCost.toFixed(4)}`);

  console.log(`\n── Last 8 runs ───────────────────────────────────`);
  runs.slice(-8).forEach(e => {
    const ts = e.ts ? new Date(e.ts).toLocaleString() : '?';
    const domains = e.domains?.length ? ` [${e.domains.join(', ')}]` : '';
    const cost = e.gate_cost ? `  $${(e.gate_cost).toFixed(4)}` : '';
    console.log(`  ${ts}  ${e.gate.padEnd(5)}  ${e.reason}${domains}${cost}`);
  });

  const models = listModels();
  if (models.length === 0) {
    console.log(`\n── Models ────────────────────────────────────────`);
    console.log('  No model files found yet.');
    return;
  }

  const stale = models.filter(m => m.stale);
  console.log(`\n── Models (${models.length} total${stale.length ? `, ${stale.length} stale` : ''}) ────────────────────────`);
  models.forEach(m => {
    const age = m.ageDays === 0 ? 'today' : `${m.ageDays}d ago`;
    const flag = m.stale ? ' ⚠ stale' : '';
    const desc = m.description ? `  ${m.description}` : '';
    console.log(`  ${m.name.padEnd(30)} ${age.padStart(8)}${flag}${desc}`);
  });
}

function uninstall() {
  if (!existsSync(SETTINGS_PATH)) {
    console.log('No settings file found.');
    return;
  }
  let settings = {};
  try { settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); } catch { return; }

  if (settings.hooks?.Stop) {
    settings.hooks.Stop = settings.hooks.Stop.filter(h =>
      !h.hooks?.some(hh => hh.command?.includes('octopus'))
    );
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log('claude-octopus hook removed from settings.json');
}

const command = process.argv[2];
if (command === 'install') install();
else if (command === 'status') status();
else if (command === 'uninstall') uninstall();
else {
  console.log('Usage: claude-octopus [install|status|uninstall]');
}
