#!/usr/bin/env node
// bootstrap.mjs — restore this machine's Roblox Studio wiring from this directory.
//
// Three things the tooling needs live outside this directory, and all three are wiped by a
// reset (or lost on a new machine):
//
//   %LOCALAPPDATA%\Roblox\mcp.bat        launcher Freebuff invokes to start StudioMCP.exe
//   ~/.agents/mcp.json                   registers that launcher as the Roblox_Studio server
//   ~/.agents/skills/<skill>/            the installed skill, regenerated from here
//
// Everything else comes back on its own: Studio's installer recreates StudioMCP.exe and the
// registry ContentFolder key it resolves through, and signing into Freebuff restores the
// Cloud-synced account skills.
//
//   node bootstrap.mjs [--home <dir>] [--roblox-dir <dir>] [--dry-run] [--json]
//
// Then, per project: node init-project.mjs <project>
//
// It also reports what it cannot fix for you: whether Studio is installed, whether Freebuff
// has approved the server's tool manifest, and whether the bridge is currently up with
// Studio attached.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeStatus } from "./lib/bridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = "Roblox_Studio";
const BAT_NAME = "mcp.bat";

const argv = process.argv.slice(2);
let homeFlag;
let robloxFlag;
let dryRun = false;
let asJson = false;
let help = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--home") homeFlag = argv[++i];
  else if (a === "--roblox-dir") robloxFlag = argv[++i];
  else if (a === "--dry-run") dryRun = true;
  else if (a === "--json") asJson = true;
  else if (a === "--help" || a === "-h") help = true;
  else {
    console.error(`bootstrap: unexpected argument ${a}`);
    process.exit(2);
  }
}

if (help) {
  console.log(`bootstrap — restore this machine's Roblox Studio wiring

Usage: node bootstrap.mjs [flags]

  --home <dir>        where ~/.agents lives     (default: your home directory)
  --roblox-dir <dir>  Roblox's local data dir   (default: %LOCALAPPDATA%\\Roblox)
  --dry-run           report what would change, write nothing
  --json              machine-readable result

Writes <roblox-dir>/${BAT_NAME} and <home>/.agents/mcp.json (merging, never
replacing other servers), and regenerates the installed skill if it has drifted.
Exit 1 if Studio itself is not installed yet.`);
  process.exit(0);
}

const home = resolve(homeFlag ?? homedir());
const robloxDir = resolve(robloxFlag ?? join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Roblox"));
const batFile = join(robloxDir, BAT_NAME);
const mcpFile = join(home, ".agents", "mcp.json");

/**
 * Installed copies of this skill under ~/.agents/skills, whatever directory name they carry.
 * Found by signature rather than by name so a rename here cannot make this report lie — and
 * so the shipped copy, which has no manifest to read, stays correct.
 */
function installedSkills(home) {
  const root = join(home, ".agents", "skills");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(
    (name) => existsSync(join(root, name, "SKILL.md")) && existsSync(join(root, name, "scripts", "bootstrap.mjs")),
  );
}

/** Newest StudioMCP.exe under <robloxDir>\Versions, or null. */
function newestStudioMcp(dir) {
  const versions = join(dir, "Versions");
  if (!existsSync(versions)) return null;
  let best = null;
  for (const name of readdirSync(versions)) {
    const exe = join(versions, name, "StudioMCP.exe");
    if (!existsSync(exe)) continue;
    const mtime = statSync(exe).mtimeMs;
    if (!best || mtime > best.mtime) best = { exe, mtime };
  }
  return best?.exe ?? null;
}

/**
 * The launcher. The pinned path keeps the common case fast; the registry branch resolves the
 * version folder after a Studio update, so this file survives version bumps untended.
 */
function launcherBat(exe) {
  const registry = [
    `else (for /f "tokens=2*" %%A in ('reg query HKEY_CURRENT_USER\\Software\\Roblox\\RobloxStudio /v ContentFolder') do (`,
    `"%%B/..\\StudioMCP.exe" %*`,
    "))",
  ];
  const lines = ["@echo off"];
  if (exe) {
    lines.push(`if exist "${exe}" ( "${exe}" %* )`, registry[0], ...registry.slice(1));
  } else {
    // No pinned path: query the registry directly (a leading `else` needs the `if` above).
    lines.push(registry[0].replace(/^else /, ""), ...registry.slice(1));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** The MCP entry, merged into whatever else is registered. */
function withRobloxServer(cfg) {
  const base = cfg && typeof cfg === "object" ? cfg : {};
  return {
    ...base,
    mcpServers: {
      ...(base.mcpServers ?? {}),
      [SERVER]: { command: "cmd.exe", args: ["/c", `cd /d %LOCALAPPDATA%\\Roblox && .\\${BAT_NAME}`] },
    },
  };
}

const exe = newestStudioMcp(robloxDir);

// --- 1. the two wiring files ---------------------------------------------
// Compare meaning, not bytes: a launcher that differs only in line endings or a trailing
// newline is already correct, and rewriting it would be a change nobody asked for.
const sameText = (a, b) => a.replace(/\r\n/g, "\n").replace(/\s*$/, "") === b.replace(/\r\n/g, "\n").replace(/\s*$/, "");

const batNext = launcherBat(exe);
const batChanged = !existsSync(batFile) || !sameText(readFileSync(batFile, "utf8"), batNext);
if (batChanged && !dryRun) {
  mkdirSync(dirname(batFile), { recursive: true });
  writeFileSync(batFile, batNext);
}

let mcpExisting = null;
try {
  mcpExisting = JSON.parse(readFileSync(mcpFile, "utf8"));
} catch {}
const mcpNext = withRobloxServer(mcpExisting);
const mcpChanged = JSON.stringify(mcpNext) !== JSON.stringify(mcpExisting);
if (mcpChanged && !dryRun) {
  mkdirSync(dirname(mcpFile), { recursive: true });
  writeFileSync(mcpFile, `${JSON.stringify(mcpNext, null, 2)}\n`);
}

// --- 2. the installed skill ----------------------------------------------
// Only the canonical tooling directory carries sync-skill.mjs. Inside an installed skill
// there is nothing to regenerate — the skills CLI put these files there — so skip, not fail.
let skill;
if (!existsSync(join(HERE, "sync-skill.mjs"))) {
  skill = "n/a (installed copy; regenerate from the canonical tooling directory)";
} else {
  // sync-skill writes to the real home; only run it when the mirror has actually drifted.
  const check = spawnSync(process.execPath, ["sync-skill.mjs", "--check"], { cwd: HERE, encoding: "utf8", windowsHide: true });
  if (check.status === 0) skill = "in sync";
  else if (dryRun) skill = "would be regenerated";
  else {
    const write = spawnSync(process.execPath, ["sync-skill.mjs"], { cwd: HERE, encoding: "utf8", windowsHide: true });
    skill = write.status === 0 ? "regenerated" : `FAILED: ${(write.stderr || write.stdout || "").trim().split("\n")[0]}`;
  }
}

// --- 3. what bootstrap cannot fix for you --------------------------------
const nodeMajor = Number(process.versions.node.split(".")[0]);

function approvalState() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(home, ".freebuff", "mcp.json"), "utf8"));
  } catch {
    return "no ~/.freebuff/mcp.json yet (Freebuff registers it on first run)";
  }
  const entry = Object.values(cfg.servers ?? {}).find((s) => s?.configKey === SERVER);
  if (!entry) return "server not registered with Freebuff yet";
  if (!entry.approvedManifest || !entry.allowedTools) return "manifest not approved — approve it in Freebuff's MCP panel, then start a new session";
  return "approved";
}

const status = await bridgeStatus();
const heartbeat = status.heartbeat;
const installed = installedSkills(home);

const report = {
  home,
  robloxDir,
  dryRun,
  bat: { file: batFile, changed: batChanged, pinnedExe: exe },
  mcp: { file: mcpFile, changed: mcpChanged },
  skill: { regeneratedFrom: HERE, state: skill },
  checks: {
    node: { version: process.versions.node, ok: nodeMajor >= 18 },
    studio: { exe, ok: Boolean(exe) },
    skillInstalled: installed.length > 0,
    installedSkillDirs: installed,
    approval: approvalState(),
    bridge: {
      listening: status.listening,
      keeperPid: status.keeperPid,
      heartbeat: heartbeat ? { fresh: heartbeat.fresh, ageMs: heartbeat.ageMs } : null,
    },
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const verb = dryRun ? "would write" : "wrote";
  console.log(`bootstrap: home ${home}`);
  console.log(`  bat     ${batChanged ? verb : "up to date"} ${BAT_NAME}${exe ? ` (pins ${exe})` : " (registry lookup only)"}`);
  console.log(`  mcp     ${mcpChanged ? verb : "up to date"} .agents/mcp.json (${SERVER} -> ${BAT_NAME})`);
  console.log(`  skill   ${skill}`);
  console.log(`  checks  node v${process.versions.node}${nodeMajor >= 18 ? "" : " (needs 18+)"}`);
  console.log(`          studio ${exe ? "installed" : "MISSING — install Roblox Studio, open a place once, then re-run"}`);
  console.log(`          approval ${approvalState()}`);
  console.log(`          skill ${installed.length ? installed.join(", ") : "none under ~/.agents/skills (run sync-skill.mjs)"}`);
  console.log(
    `          bridge ${status.listening ? `listening (keeper ${status.keeperPid ?? "-"})` : "not listening"}` +
      `${heartbeat ? (heartbeat.fresh ? `, Studio heartbeat ${Math.round(heartbeat.ageMs / 1000)}s ago` : ", Studio heartbeat stale") : ""}`,
  );
}

if (!exe) {
  console.error(`bootstrap: no StudioMCP.exe under ${join(robloxDir, "Versions")} — install Roblox Studio and open a place once.`);
  process.exit(1);
}
