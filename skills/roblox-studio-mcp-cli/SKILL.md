---
name: roblox-studio-mcp-cli
description: Use when working with a Roblox Studio place from the terminal or when Roblox Studio MCP tools are missing from the session - inspecting or editing Luau scripts, exploring the game tree, reading the Studio output, or diagnosing the localhost:13469 MCP bridge.
license: MIT
---

# Roblox Studio MCP

Drive an open Roblox Studio place from the command line through Roblox's bundled
`StudioMCP.exe` bridge — no MCP host required. Works even when the session has no
native `roblox_*` tools.

## When to Use

- Inspect, search, create, or edit Luau scripts in the currently open Studio place.
- Explore the DataModel hierarchy, read the output log, or check play state.
- The session has **no Roblox MCP tools** but Studio is open (see Gotchas).
- Studio shows `ConnectFail` to `localhost:13469` in its logs.

## Locate the bridge

The bridge is Roblox's own `StudioMCP.exe` (`...\Roblox\Versions\*\StudioMCP.exe`).
It listens on `127.0.0.1:13469`; Studio connects to it as a WebSocket client.
Freebuff launches it from `~/.agents/mcp.json` (`Roblox_Studio` → `mcp.bat`).

The CLI in `scripts/` spawns the same entry, so it stays in sync with the config.
Run scripts from this skill's directory; they need Node 18+ and an open Studio place.

On a fresh machine those two may not exist yet: `node scripts/bootstrap.mjs` recreates the
launcher and the MCP registration (`node bootstrap.mjs` from the canonical tooling directory).

> `scripts/` is **generated** from the canonical workspace copy
> (`Documents/Roblox Development/roblox-mcp`) by `sync-skill.mjs`. Edit the canonical copy,
> not these files.

## Commands

```bash
node scripts/roblox-mcp.mjs --tools        # list tools; --studios to list open places
node scripts/rbx.mjs list                  # every tool + its arguments
node scripts/rbx.mjs state                 # play state / datamodels
node scripts/rbx.mjs tree Workspace        # explore the hierarchy
node scripts/rbx.mjs read game.ServerScriptService.Foo
node scripts/rbx.mjs search Player         # fuzzy script-name search
node scripts/rbx.mjs grep "Humanoid"       # search all script contents
node scripts/rbx.mjs console               # Studio output log
```

### Editing safely

```bash
node scripts/rbx.mjs edit <dot.path> --edits '[{"old_string":"a","new_string":"b"}]' --dry-run
node scripts/rbx.mjs write <dot.path> --file ./Foo.luau --backup
node scripts/rbx.mjs diff <dot.path> --file ./Foo.luau
node scripts/rbx.mjs backups [dot.path]
node scripts/rbx.mjs undo [dot.path] [--all]
```

Always `--dry-run` first, then apply with `--backup`. `undo` restores the most recent
backup for a script (per-path), which is the whole recovery story.

### Batch sync

`node scripts/rbx-sync.mjs <dir> [--dry-run] [--backup]` maps each `.luau` file to a
script by filename: `game.Service.Foo.luau` → `game.Service.Foo` (ModuleScript);
`.server.luau` → Script; `.client.luau` → LocalScript. A `-- className: X` header
overrides the class. Names without a `game.`/`Workspace.`/`LocalPlayer.` prefix get `game.`.

`--watch` mirrors continuously: an initial pass, then it re-syncs changed files while you
edit. It protects Studio-side edits (skips with a warning unless `--force`) and ignores
locally deleted files unless `--prune` is passed.

Any tool works by name: `node scripts/rbx.mjs inspect_instance --path ...`. Use
`--args '<json>'` for raw arguments, `--studio <id>` to pick a place, `--json` for raw output.

## Gotchas

- **Tools missing from the session?** Freebuff attaches an MCP server's tools only after
  its tool manifest is approved (state `~/.freebuff/mcp.json` shows `approvedManifest`);
  approve the `Roblox_Studio` server in Freebuff's MCP panel, then start a new session.
  The CLI works regardless.
- **`list_roblox_studios` returns 0 while Studio is open.** The long-lived proxy on `13469`
  died. Commands now self-heal: they detect the dead port before connecting and start a
  detached keeper holding `StudioMCP.exe` stdin open, then wait for Studio to reconnect.
  Watch for `[rbx] bridge was down; restarted StudioMCP` on stderr. Manage it directly with
  `node scripts/rbx.mjs bridge status|start|stop`; `--no-heal` disables the repair.
  `bridge status` asks the running keeper for its live view, so its `studio:` line says
  whether Studio's heartbeat is being seen right now and when it was last seen — that tells
  "no place attached" apart from "the proxy is down".
- **The keeper exits on its own** once Studio goes quiet for a grace window, freeing the
  port, so no stray proxy is left behind. It detects that from the proxy's `--verbose`
  stderr heartbeat (Studio pings ~every 5s) and spawns nothing to do it.
- One place is assumed when only one Studio is open; pass `--studio <id>` otherwise.
