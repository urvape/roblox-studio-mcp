#!/usr/bin/env node
// rbx-sync.mjs — create/update scripts in the open Studio place from a folder of .luau files.
//
// Each file maps to a place script by its filename (the ".luau" is dropped):
//   game.ServerScriptService.Foo.luau          -> ModuleScript  game.ServerScriptService.Foo
//   game.ServerScriptService.Bar.server.luau   -> Script        game.ServerScriptService.Bar
//   game.StarterPlayer.StarterPlayerScripts.Baz.client.luau
//                                              -> LocalScript   ...Baz
// A leading "-- className: X" comment overrides the inferred class.
// A name not starting with game./Workspace./LocalPlayer. is prefixed with "game.".
//
//   node rbx-sync.mjs ./scripts                 # sync the folder once
//   node rbx-sync.mjs ./scripts --dry-run       # show diffs, change nothing
//   node rbx-sync.mjs ./scripts --backup        # back up each script before writing
//   node rbx-sync.mjs ./scripts --json
//   node rbx-sync.mjs ./scripts --watch         # keep mirroring as files change
//   node rbx-sync.mjs ./scripts --watch --prune # ...and delete scripts for removed files
//
// Watch mode holds one MCP connection and polls the tree for changes. A script edited in
// Studio after this session wrote it is never silently clobbered: the change is skipped
// with a warning unless --force is given. Locally deleted files are ignored unless --prune.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { connect } from "./mcp-client.mjs";
import { deleteScript, readScript, resolveStudioId, writeScript } from "./lib/place.mjs";
import { backupScript, unifiedDiff } from "./lib/safety.mjs";
import { ensureBridge, sleep } from "./lib/bridge.mjs";

const CLASS_SUFFIX = { server: "Script", client: "LocalScript", module: "ModuleScript" };

const argv = process.argv.slice(2);
const flags = {
  dryRun: false,
  json: false,
  backup: false,
  heal: true,
  watch: false,
  prune: false,
  force: false,
  interval: 800,
  studio: undefined,
};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") flags.dryRun = true;
  else if (a === "--json") flags.json = true;
  else if (a === "--backup") flags.backup = true;
  else if (a === "--no-heal") flags.heal = false;
  else if (a === "--watch") flags.watch = true;
  else if (a === "--prune") flags.prune = true;
  else if (a === "--force") flags.force = true;
  else if (a === "--interval") flags.interval = Number(argv[++i]) || 800;
  else if (a === "--studio") flags.studio = argv[++i];
  else rest.push(a);
}

const dir = rest[0];
if (!dir) {
  console.error(
    "Usage: node rbx-sync.mjs <dir> [--watch] [--dry-run] [--backup] [--prune] [--force] [--interval ms] [--json]",
  );
  process.exit(2);
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const note = (s) => console.log(`[${stamp()}] ${s}`);

function walk(d) {
  const out = [];
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (extname(name) === ".luau") out.push(p);
  }
  return out;
}

/** Cheap change fingerprint: path -> "mtime:size". */
function fingerprint() {
  const out = new Map();
  for (const f of walk(dir)) {
    const s = statSync(f);
    out.set(f, `${s.mtimeMs}:${s.size}`);
  }
  return out;
}

function diffFingerprints(prev, next) {
  const changed = [];
  for (const [f, v] of next) if (prev.get(f) !== v) changed.push(f);
  for (const f of prev.keys()) if (!next.has(f)) changed.push(f);
  return changed;
}

/** Map a filename to its place path and default class, without reading the file. */
function mapName(file) {
  let stem = basename(file, ".luau");
  let className = "ModuleScript";
  const dot = stem.lastIndexOf(".");
  if (dot > 0) {
    const suffix = stem.slice(dot + 1).toLowerCase();
    if (CLASS_SUFFIX[suffix]) {
      className = CLASS_SUFFIX[suffix];
      stem = stem.slice(0, dot);
    }
  }
  return { dotPath: /^(game|Workspace|LocalPlayer)\./.test(stem) ? stem : `game.${stem}`, className };
}

/** filename -> { dotPath, className, content } */
function mapFile(file) {
  const { dotPath, className } = mapName(file);
  const content = readFileSync(file, "utf8");
  const header = content.match(/^\s*--\s*className:\s*([A-Za-z]+)/m);
  return { dotPath, className: header ? header[1] : className, content };
}

// Content this session last confirmed in the place, keyed by dot path. Used to tell
// "nobody else touched it" apart from "edited in Studio since we wrote it".
const lastWritten = new Map();

/** Sync one file. Returns a result record. */
async function syncFile(client, studioId, file) {
  let mapped;
  try {
    mapped = mapFile(file);
  } catch (e) {
    return { file, status: "error", error: e.message };
  }
  const { dotPath, className, content } = mapped;

  const cur = await readScript(client, dotPath, studioId);
  if (cur.exists && cur.content === content) {
    lastWritten.set(dotPath, content);
    return { file, path: dotPath, status: "unchanged" };
  }

  // Conflict guard: the place changed since we last put content there.
  const known = lastWritten.get(dotPath);
  if (cur.exists && known !== undefined && cur.content !== known && !flags.force) {
    return {
      file,
      path: dotPath,
      status: "skipped",
      reason: "changed in Studio since last write (use --force to overwrite)",
      diff: unifiedDiff(cur.content, content, dotPath),
    };
  }

  const diff = unifiedDiff(cur.content, content, dotPath);
  if (flags.dryRun) {
    return { file, path: dotPath, status: cur.exists ? "would-update" : "would-create", diff };
  }

  try {
    if (flags.backup && cur.exists) backupScript(dotPath, cur.content, { op: "sync" });
    const action = await writeScript(client, dotPath, content, { className, studioId });
    lastWritten.set(dotPath, content);
    return { file, path: dotPath, status: action };
  } catch (e) {
    return { file, path: dotPath, status: "error", error: e.message };
  }
}

function report(results, { verbose = true } = {}) {
  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const r of results) {
    if (r.status === "unchanged" && !verbose) continue;
    console.log(`${r.status.padEnd(13)} ${r.path ?? r.file}${r.error ? "  ! " + r.error : ""}${r.reason ? "  (" + r.reason + ")" : ""}`);
    if (r.diff) console.log(r.diff.replace(/^/gm, "    "));
  }
  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  console.log(Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join("  "));
}

let client;
let studioId;

async function openSession(label) {
  if (client) {
    try {
      client.close();
    } catch {}
  }
  if (flags.heal && !flags.studio) {
    const b = await ensureBridge({ start: true });
    if (b.started && b.listening) {
      console.error(`[rbx-sync] bridge was down; restarted StudioMCP (keeper pid ${b.pid})`);
    } else if (!b.listening) {
      console.error(`[rbx-sync] warning: no bridge on 127.0.0.1:13469${b.reason ? ` (${b.reason})` : ""}`);
    }
  }
  client = await connect({ clientName: label });
  studioId = await resolveStudioId(client, flags.studio, { timeoutMs: 8000 });
}

// ---- one-shot -----------------------------------------------------------------
if (!flags.watch) {
  const files = walk(dir).sort();
  if (!files.length) {
    console.error(`No .luau files under ${dir}`);
    process.exit(1);
  }

  await openSession("rbx-sync.mjs");
  const results = [];
  try {
    for (const file of files) results.push(await syncFile(client, studioId, file));
    report(results);
    if (results.some((r) => r.status === "error")) process.exitCode = 1;
  } finally {
    client.close();
  }
  process.exit();
}

// ---- watch --------------------------------------------------------------------
if (!existsSync(dir)) {
  console.error(`No such directory: ${dir}`);
  process.exit(2);
}

await openSession("rbx-sync.mjs (watch)");
note(`watching ${dir} every ${flags.interval}ms${flags.dryRun ? " (dry-run)" : ""}${flags.prune ? " (prune)" : ""}`);

async function pass(files) {
  const results = [];
  for (const file of files) {
    let r;
    try {
      r = await syncFile(client, studioId, file);
    } catch (e) {
      // The bridge or session may have dropped; reconnect once and retry.
      try {
        await openSession("rbx-sync.mjs (watch)");
        r = await syncFile(client, studioId, file);
      } catch (e2) {
        r = { file, status: "error", error: `${e.message} -> retry failed: ${e2.message}` };
      }
    }
    results.push(r);
  }
  for (const r of results) {
    if (r.status === "unchanged") continue;
    if (flags.json) {
      console.log(JSON.stringify(r));
      continue;
    }
    console.log(
      `${r.status.padEnd(13)} ${r.path ?? r.file}${r.error ? "  ! " + r.error : ""}${r.reason ? "  (" + r.reason + ")" : ""}`,
    );
  }
  return results;
}

// Initial pass, so the place matches before we start reacting to changes.
// pass() prints its own lines; report() is only for the one-shot tally.
await pass(walk(dir).sort());

let prev = fingerprint();

const stop = () => {
  note("stopping");
  try {
    client?.close();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

for (;;) {
  await sleep(flags.interval);

  const next = fingerprint();
  const changed = diffFingerprints(prev, next);
  prev = next;
  if (!changed.length) continue;

  // Let a just-written file settle before reading it.
  await sleep(150);
  prev = fingerprint();

  const gone = changed.filter((f) => !existsSync(f));
  const present = changed.filter((f) => existsSync(f));

  for (const f of gone) {
    const dotPath = mapName(f).dotPath;
    if (!flags.prune) {
      note(`gone locally: ${dotPath} (ignored; use --prune to delete it in the place)`);
      continue;
    }
    try {
      if (flags.backup) {
        const cur = await readScript(client, dotPath, studioId);
        if (cur.exists) backupScript(dotPath, cur.content, { op: "prune" });
      }
      const status = await deleteScript(client, dotPath, studioId);
      lastWritten.delete(dotPath);
      note(`${status === "deleted" ? "deleted" : "absent (nothing to delete)"}  ${dotPath}`);
    } catch (e) {
      note(`error deleting ${dotPath}: ${e.message}`);
    }
  }

  if (present.length) await pass(present);
}

