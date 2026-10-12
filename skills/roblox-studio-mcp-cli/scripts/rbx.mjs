#!/usr/bin/env node
// rbx.mjs — command-line access to everything the Roblox Studio MCP server exposes,
// without needing an MCP host. Each tool becomes a subcommand (thin passthrough),
// plus convenience aliases and a safety layer (dry-run, backups, undo).
//
//   node rbx.mjs list                       # list tools + their arguments
//   node rbx.mjs studios | state | console
//   node rbx.mjs tree --path Workspace      # search_game_tree
//   node rbx.mjs read game.ServerScriptService.Foo
//   node rbx.mjs search Player  |  grep "Humanoid"
//   node rbx.mjs edit game.ServerScriptService.Foo --edits '[{"old_string":"a","new_string":"b"}]'
//   node rbx.mjs write game.ServerScriptService.Foo --file ./Foo.luau
//   node rbx.mjs diff game.ServerScriptService.Foo --file ./Foo.luau
//   node rbx.mjs backups [dot.path] | undo [dot.path] [--all]
//   node rbx.mjs play | stop
//   node rbx.mjs <any_tool_name> --flag value ...
//
// Safety flags (apply to edit/write):
//   --dry-run   print a diff and change nothing
//   --backup    save current contents before writing (see `undo`)
// Global: --json   raw output   --studio <id>   pick a Studio instance

import { readFileSync } from "node:fs";
import { connect, toolResultText } from "./mcp-client.mjs";
import { readScript, resolveStudioId, writeScript } from "./lib/place.mjs";
import { BRIDGE_PORT, bridgeStatus, ensureBridge, stopBridge } from "./lib/bridge.mjs";
import { backupScript, latestBackup, listBackups, readBackup, unifiedDiff } from "./lib/safety.mjs";

const ALIASES = {
  studios: { tool: "list_roblox_studios" },
  state: { tool: "get_studio_state" },
  tree: { tool: "search_game_tree", positionals: ["path"] },
  read: { tool: "script_read", positionals: ["target_file"] },
  search: { tool: "script_search", positionals: ["keywords"] },
  grep: { tool: "script_grep", positionals: ["query"] },
  console: { tool: "get_console_output" },
  edit: { tool: "multi_edit", positionals: ["file_path"] },
  play: { tool: "start_stop_play", fixed: { is_start: true } },
  stop: { tool: "start_stop_play", fixed: { is_start: false } },
};

const AUTO_PROPS = new Set(["studio_id", "datamodel_type"]);

function coerce(value, spec) {
  const type = spec?.type;
  if (type === "number" || type === "integer") return Number(value);
  if (type === "boolean") return value === true || value === "true";
  if (type === "array") {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value.split(",");
    }
  }
  return value;
}

function parseToolArgs(tool, argv, positionalProps = []) {
  const props = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  const args = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--args") {
      Object.assign(args, JSON.parse(argv[++i]));
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = coerce(next, props[key]);
        i++;
      }
    } else {
      positionals.push(a);
    }
  }

  const target = positionalProps.length ? positionalProps : required.filter((r) => !AUTO_PROPS.has(r));
  for (const p of target) {
    if (args[p] === undefined && positionals.length) args[p] = coerce(positionals.shift(), props[p]);
  }
  return args;
}

/** Apply multi_edit-style edits in memory (for dry-run previews). */
function applyEdits(content, edits) {
  let c = content ?? "";
  let fresh = content === null || content === "";
  for (const e of edits ?? []) {
    if (e.old_string === "") {
      c = fresh ? e.new_string : e.new_string + c;
      fresh = false;
    } else if (e.replace_all) {
      c = c.split(e.old_string).join(e.new_string);
    } else {
      const i = c.indexOf(e.old_string);
      if (i < 0) throw new Error(`old_string not found: ${JSON.stringify(e.old_string.slice(0, 60))}`);
      c = c.slice(0, i) + e.new_string + c.slice(i + e.old_string.length);
    }
  }
  return c;
}

const printResult = (text) =>
  console.log(typeof text === "string" ? text : JSON.stringify(text, null, 2));

const argv = process.argv.slice(2);
const command = argv[0];
const flags = { dryRun: false, json: false, backup: false, all: false, heal: true, studio: undefined };
const rest = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") flags.dryRun = true;
  else if (a === "--json") flags.json = true;
  else if (a === "--backup") flags.backup = true;
  else if (a === "--all") flags.all = true;
  else if (a === "--no-heal") flags.heal = false;
  else if (a === "--studio") flags.studio = argv[++i];
  else rest.push(a);
}

/** Resolve the target Studio instance, restarting a dead bridge first when allowed. */
async function studioFor(client) {
  if (flags.studio) return flags.studio;
  if (flags.heal) {
    const b = await ensureBridge({ start: true });
    if (b.started) {
      console.error(
        b.listening
          ? `[rbx] bridge was down; restarted StudioMCP (keeper pid ${b.pid})`
          : `[rbx] bridge did not come up within the wait window (keeper pid ${b.pid})`,
      );
    } else if (!b.listening) {
      console.error(`[rbx] warning: nothing is listening on 127.0.0.1:${BRIDGE_PORT}`);
    }
  }
  return resolveStudioId(client, undefined, { timeoutMs: 8000 });
}

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(`rbx — Roblox Studio MCP from the command line

Usage: node rbx.mjs <command> [--flags] [--json] [--studio <id>]

Discovery / reads:
  list                 list every available tool and its arguments
  studios              list open Studio instances
  state                current play state / available datamodels
  tree [path]          explore the game hierarchy
  read <dot.path>      read a script
  search <keywords>    fuzzy script name search
  grep <pattern>       search all script contents
  console              Studio output log

Edits (safety flags: --dry-run, --backup):
  edit <dot.path> --edits '[{"old_string":"a","new_string":"b"}]'
  write <dot.path> --file <local.luau> [--className ModuleScript]
  diff <dot.path> --file <local.luau>
  backups [dot.path]   list saved backups
  undo [dot.path]      restore latest backup (--all to restore every script)

Bridge: bridge [status|start|stop]   port, keeper, Studio heartbeat

Play: play | stop.  Anything else is passed through as a tool name.
Dead-bridge healing is automatic; --no-heal disables it.`);
  process.exit(0);
}

// --- commands that don't need a live tool call -----------------------------
if (command === "backups") {
  const rows = listBackups(rest[0]);
  if (flags.json) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log("No backups found.");
  else for (const b of rows) console.log(`${b.stamp}  ${b.path}  (${b.at})`);
  process.exit(0);
}

/**
 * One human-readable line describing the keeper's live view of Studio. It states when the
 * heartbeat was last seen rather than asserting "connected": the keeper deliberately
 * tolerates a long silence before releasing the port, so a plain age is the honest report.
 */
function describeHeartbeat(hb) {
  if (!hb) return "unknown (keeper not answering)";
  if (!hb.studioSeen) return "no heartbeat seen yet (Studio not attached)";
  const seconds = (ms) => `${Math.round(ms / 1000)}s`;
  const released = hb.graceMs != null ? ` (port released after ${seconds(hb.graceMs)} of silence)` : "";
  if (hb.fresh) return `heartbeat ${seconds(hb.ageMs)} ago${released}`;
  return `no heartbeat for ${seconds(hb.ageMs)}${released}`;
}

// `bridge` needs no MCP session.
if (command === "bridge") {
  const sub = rest[0] ?? "status";
  if (sub === "start") {
    const b = await ensureBridge({ start: true });
    console.log(
      b.listening
        ? `Bridge listening on 127.0.0.1:${BRIDGE_PORT}${b.started ? ` (started keeper pid ${b.pid})` : " (already up)"}`
        : "Bridge failed to start.",
    );
    process.exit(b.listening ? 0 : 1);
  }
  if (sub === "stop") {
    console.log(stopBridge() ? "Keeper stopped." : "No keeper to stop.");
    process.exit(0);
  }
  const s = await bridgeStatus();
  if (flags.json) console.log(JSON.stringify(s, null, 2));
  else {
    console.log(`port:   ${s.port} (${s.listening ? "listening" : "DEAD"})`);
    console.log(`keeper: ${s.keeperPid ?? "-"}${s.keeperPid ? (s.keeperAlive ? " (alive)" : " (gone)") : ""}`);
    console.log(`exe:    ${s.exe ?? "-"}`);
    console.log(`studio: ${describeHeartbeat(s.heartbeat)}`);
  }
  process.exit(s.listening ? 0 : 1);
}

// Heal a dead bridge BEFORE connecting: connect() spawns our own long-enough-lived
// proxy, which would transiently bind the port and hide the failure.
if (flags.heal && command !== "list") {
  const b = await ensureBridge({ start: true });
  if (b.started && b.listening) {
    console.error(`[rbx] bridge was down; restarted StudioMCP (keeper pid ${b.pid})`);
  } else if (!b.listening) {
    console.error(`[rbx] warning: no bridge on 127.0.0.1:${BRIDGE_PORT}${b.reason ? ` (${b.reason})` : ""}`);
  }
}

const client = await connect({ clientName: "rbx.mjs" });

try {
  const tools = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  if (command === "list") {
    console.log(`Server: ${client.serverInfo?.serverInfo?.name} (${client.launch?.source ?? "?"})`);
    for (const t of tools) {
      const required = t.inputSchema?.required ?? [];
      const props = Object.keys(t.inputSchema?.properties ?? {});
      console.log(`\n${t.name}`);
      if (props.length) console.log(`    args: ${props.map((p) => (required.includes(p) ? p + "*" : p)).join(", ")}`);
    }
    process.exit(0);
  }

  // --- undo -----------------------------------------------------------------
  if (command === "undo") {
    const studioId = await studioFor(client);
    const targets = flags.all ? [...new Set(listBackups().map((b) => b.path))] : [rest[0]];
    if (!targets[0]) {
      console.error("Usage: rbx.mjs undo <dot.path> [--all]");
      process.exit(2);
    }
    let restored = 0;
    for (const dotPath of targets) {
      const b = latestBackup(dotPath);
      if (!b) {
        console.error(`No backup for ${dotPath}`);
        continue;
      }
      const content = readBackup(b);
      await writeScript(client, dotPath, content, { studioId });
      console.log(`Restored ${dotPath} from ${b.stamp}`);
      restored++;
    }
    process.exit(restored ? 0 : 1);
  }

  // --- diff -----------------------------------------------------------------
  if (command === "diff") {
    const dotPath = rest[0];
    const local = valueOf(rest, "--file");
    if (!dotPath || !local) {
      console.error("Usage: rbx.mjs diff <dot.path> --file <local.luau>");
      process.exit(2);
    }
    const studioId = await studioFor(client);
    const cur = await readScript(client, dotPath, studioId);
    const localText = readFileSync(local, "utf8");
    const d = unifiedDiff(cur.content, localText, dotPath);
    console.log(d || "No differences.");
    process.exit(0);
  }

  // --- write ----------------------------------------------------------------
  if (command === "write") {
    const dotPath = rest[0];
    const local = valueOf(rest, "--file");
    const inline = valueOf(rest, "--content");
    const className = valueOf(rest, "--className");
    if (!dotPath || (!local && inline === undefined)) {
      console.error("Usage: rbx.mjs write <dot.path> --file <local.luau> [--className X]");
      process.exit(2);
    }
    const content = inline !== undefined ? inline : readFileSync(local, "utf8");
    const studioId = await studioFor(client);
    const cur = await readScript(client, dotPath, studioId);

    if (flags.dryRun) {
      const d = unifiedDiff(cur.content, content, dotPath);
      console.log(d || "No changes (file already matches).");
      process.exit(0);
    }
    if (flags.backup && cur.exists) console.log(`Backed up ${dotPath} -> ${backupScript(dotPath, cur.content, { op: "write" })}`);
    const action = await writeScript(client, dotPath, content, { className, studioId });
    console.log(`${action === "created" ? "Created" : "Updated"} ${dotPath}`);
    process.exit(0);
  }

  // --- aliases + thin passthrough ------------------------------------------
  let toolName = command;
  let fixed = {};
  let positionals = [];
  if (ALIASES[command]) {
    toolName = ALIASES[command].tool;
    fixed = ALIASES[command].fixed ?? {};
    positionals = ALIASES[command].positionals ?? [];
  }

  const tool = byName.get(toolName);
  if (!tool) {
    console.error(`Unknown command/tool: ${command}\nRun "node rbx.mjs list" to see available tools.`);
    process.exit(2);
  }

  const required = tool.inputSchema?.required ?? [];
  const args = { ...fixed, ...parseToolArgs(tool, rest, positionals) };

  if (required.includes("studio_id") && !args.studio_id) {
    args.studio_id = await studioFor(client);
  }
  if (required.includes("datamodel_type") && !args.datamodel_type) args.datamodel_type = "Edit";

  // Safety layer for edit: dry-run preview and pre-write backup.
  if (command === "edit") {
    const dotPath = args.file_path;
    const cur = await readScript(client, dotPath, args.studio_id);
    if (flags.dryRun) {
      const next = applyEdits(cur.exists ? cur.content : null, args.edits);
      const d = unifiedDiff(cur.content, next, dotPath);
      console.log(d || "No changes.");
      process.exit(0);
    }
    if (flags.backup && cur.exists) {
      console.log(`Backed up ${dotPath} -> ${backupScript(dotPath, cur.content, { op: "edit" })}`);
    }
  }

  const res = await client.callTool(toolName, args);
  if (flags.json) console.log(JSON.stringify(res, null, 2));
  else if (res?.isError) {
    console.error(toolResultText(res));
    process.exitCode = 1;
  } else printResult(toolResultText(res));
} finally {
  client.close();
}

function valueOf(list, name) {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
}
