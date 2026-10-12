# Roblox Studio MCP skill

[![checks](https://github.com/urvape/roblox-studio-mcp/actions/workflows/checks.yml/badge.svg)](https://github.com/urvape/roblox-studio-mcp/actions/workflows/checks.yml)

Drive an open Roblox Studio place from the command line through Roblox's bundled
`StudioMCP.exe` bridge — for coding agents that have no native `roblox_*` MCP tools.

## Install

```bash
npx skills add urvape/roblox-studio-mcp --skill roblox-studio-mcp-cli --yes
```

That copies the skill into the project's `.agents/skills/roblox-studio-mcp-cli/`. Add `-g` to install
it for your user rather than the current project.

## Pin a version

A release is tagged whenever the skill itself changes, so an install can be reproduced instead
of tracking `main` — the CLI takes a Git ref after a `#`:

```bash
npx skills add 'urvape/roblox-studio-mcp#v1.0.1' --skill roblox-studio-mcp-cli --yes
```

A branch name works in the same position, and a full 40-character commit SHA pins exactly one
revision. See the repository's Releases for the available tags.

## Use

```bash
node .agents/skills/roblox-studio-mcp-cli/scripts/rbx.mjs bridge status   # port, keeper, Studio heartbeat
node .agents/skills/roblox-studio-mcp-cli/scripts/rbx.mjs list           # every available tool
node .agents/skills/roblox-studio-mcp-cli/scripts/roblox-mcp.mjs --studios
```

See `skills/roblox-studio-mcp-cli/SKILL.md` for the whole command surface and the safety layer
(`--dry-run`, `--backup`, `undo`).

## Optional: native MCP tools

The CLI needs nothing beyond Studio, but an MCP host such as Freebuff can expose the place as
native tools instead. That needs a launcher and a registration on the machine:

```bash
node .agents/skills/roblox-studio-mcp-cli/scripts/bootstrap.mjs
```

It writes the launcher and the `roblox-studio-mcp-cli` registration, then reports what it cannot
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

## License

MIT — see [LICENSE](LICENSE). The scripts run with full agent permissions, so read them before
installing if that matters to you.

## Notes for maintainers

This repository is generated: `pack-skill.mjs` in the canonical tooling directory builds it
from the same manifest that the installed skill is mirrored from, including `checks/` and the
workflows. Regenerate and push rather than editing files here by hand.

Two workflows run here: `checks` on every push and pull request, and `release`, which tags a
version when something under `skills/` changes. Both run `node checks/run.mjs` first, so a red
commit is never tagged.
