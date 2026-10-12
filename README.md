# Roblox Studio MCP skill

Drive an open Roblox Studio place from the command line through Roblox's bundled
`StudioMCP.exe` bridge — for coding agents that have no native `roblox_*` MCP tools.

## Install

```bash
npx skills add urvape/roblox-studio-mcp --skill roblox-studio-mcp --yes
```

That copies the skill into the project's `.agents/skills/roblox-studio-mcp/`. Add `-g` to install
it for your user rather than the current project.

## Use

```bash
node .agents/skills/roblox-studio-mcp/scripts/rbx.mjs bridge status   # port, keeper, Studio heartbeat
node .agents/skills/roblox-studio-mcp/scripts/rbx.mjs list           # every available tool
node .agents/skills/roblox-studio-mcp/scripts/roblox-mcp.mjs --studios
```

See `skills/roblox-studio-mcp/SKILL.md` for the whole command surface and the safety layer
(`--dry-run`, `--backup`, `undo`).

## Optional: native MCP tools

The CLI needs nothing beyond Studio, but an MCP host such as Freebuff can expose the place as
native tools instead. That needs a launcher and a registration on the machine:

```bash
node .agents/skills/roblox-studio-mcp/scripts/bootstrap.mjs
```

It writes the launcher and the `roblox-studio-mcp` registration, then reports what it cannot
fix for you (Studio missing, manifest not yet approved). Approve the server in the host's MCP
panel and start a new session.

## Requirements

- Windows, Node 18+, and Roblox Studio installed with a place open — Roblox ships
  `StudioMCP.exe` only for Windows.

## Checks

CI runs these on every push and pull request (Node 18 and 22), and you can run exactly the
same thing locally — no dependencies, no install step:

```bash
node checks/run.mjs
```

It parses every `.mjs` without executing it, fails if any `spawn()`/`spawnSync()` call omits
`windowsHide`, validates each `SKILL.md`'s frontmatter (`name` must match its folder) and the
`scripts/*.mjs` paths it documents, checks the CLI answers `--help` with no Studio running,
and proves `bootstrap.mjs --dry-run` reports what it would write without touching the disk.

Everything that needs Windows, Roblox Studio or the live bridge stays in the canonical tooling
directory's `verify.mjs`, which mirrors itself into `~/.agents/skills` and probes the bridge —
neither of which can run on a runner.

## Notes for maintainers

This repository is generated: `pack-skill.mjs` in the canonical tooling directory builds it
from the same manifest that the installed skill is mirrored from, including `checks/` and the
workflow. Regenerate and push rather than editing files here by hand.
