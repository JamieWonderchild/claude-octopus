# claude-octopus

Self-maintaining knowledge model system for Claude Code. After every conversation, a background agent silently classifies whether new knowledge was gained and — if so — updates your memory files automatically.

No manual maintenance. No extra prompting. It just runs.

## How it works

```
Conversation ends
  → Stop hook fires
  → Gatekeeper classifies the last turn (cheap, ~200 tokens)
  → If worth updating: updater agent reads transcript + rewrites memory files
  → Logged to ~/.claude/octopus/runs.jsonl
```

The gatekeeper skips routine tasks (bug fixes, formatting, one-off queries). The updater only runs when something genuinely new was learned.

Background processes set `CLAUDE_OCTOPUS_SKIP=1` to prevent recursive hook firing.

## Install

```bash
git clone https://github.com/JamieWonderchild/claude-octopus
cd claude-octopus
node bin/cli.js install
```

## Commands

```bash
node bin/cli.js install    # Wire Stop hook into ~/.claude/settings.json
node bin/cli.js status     # Show runs, cost, and model inventory
node bin/cli.js uninstall  # Remove hook from settings
```

## Status output

```
── Runs ──────────────────────────────────────────
Total: 42  |  updated: 8  |  no-op: 28  |  skipped: 6
Gate yes rate: 22% of non-skipped

── Cost ──────────────────────────────────────────
Total tokens: 48,302  |  Est. cost: $0.0821

── Last 8 runs ───────────────────────────────────
  5/5/2026  no     routine bug fix in known codebase
  5/5/2026  yes    new Convex pattern for async params  [convex]  $0.0031

── Models (12 total, 2 stale) ────────────────────────
  convex-patterns                today     Key Convex patterns and gotchas
  vetai-architecture             2d ago    Lamina platform architecture decisions
  nineteenth-hole                8d ago    Golf sweepstake SaaS — active decisions
  old-auth-notes                35d ago ⚠ stale
```

## Requirements

- [Claude Code](https://claude.ai/code) CLI installed and authenticated
- Node.js 18+
