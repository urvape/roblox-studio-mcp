#!/usr/bin/env node
// roblox-mcp.mjs — minimal stdio MCP client for Roblox Studio.
//
//   node roblox-mcp.mjs                 # initialize, list tools, call list_roblox_studios
//   node roblox-mcp.mjs --tools         # only list tools
//   node roblox-mcp.mjs --studios       # only list_roblox_studios
//   node roblox-mcp.mjs --tool <name> [--args '<json>']
//   node roblox-mcp.mjs --json          # raw JSON output
//   node roblox-mcp.mjs --launch-info   # show which server entry it will spawn

import { connect, resolveLaunch, toolResultText } from "./mcp-client.mjs";
import { ensureBridge } from "./lib/bridge.mjs";
import { waitForStudio } from "./lib/place.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const asJson = has("--json");

if (has("--launch-info")) {
  const spec = resolveLaunch();
  console.log(JSON.stringify(spec, null, 2));
  process.exit(0);
}

const showTools = has("--tools") || (!has("--tool") && !has("--studios"));
const showStudios = has("--studios") || (!has("--tool") && !has("--tools"));
const toolName = flagValue("--tool");
let toolArgs = {};
if (flagValue("--args")) {
  try {
    toolArgs = JSON.parse(flagValue("--args"));
  } catch (e) {
    console.error(`Invalid --args JSON: ${e.message}`);
    process.exit(2);
  }
}

// Heal a dead bridge before connecting (our own proxy would otherwise hold the port).
const heal = !argv.includes("--no-heal");
if (showStudios && heal) {
  const b = await ensureBridge({ start: true });
  if (b.started && b.listening) {
    console.error(`[roblox-mcp] bridge was down; restarted StudioMCP (keeper pid ${b.pid})`);
  } else if (!b.listening) {
    console.error(`[roblox-mcp] warning: no bridge on 127.0.0.1:13469${b.reason ? ` (${b.reason})` : ""}`);
  }
}

const client = await connect({ clientName: "roblox-mcp.mjs" });

if (showTools) {
  const tools = await client.listTools();
  if (asJson) {
    console.log(JSON.stringify(tools.map((t) => t.name), null, 2));
  } else {
    console.log(`Server: ${client.serverInfo?.serverInfo?.name} v${client.serverInfo?.serverInfo?.version}`);
    console.log(`Tools (${tools.length}):`);
    for (const t of tools) console.log(`  - ${t.name}`);
  }
}

if (showStudios) {
  const studios = await waitForStudio(client, { timeoutMs: heal ? 8000 : 0 });
  if (asJson) {
    console.log(JSON.stringify({ studios }));
  } else {
    console.log(`\nOpen Studio instances: ${studios.length}`);
    for (const s of studios) console.log(`  - ${s.name}  (${s.id})`);
  }
}

if (toolName) {
  const res = await client.callTool(toolName, toolArgs);
  const data = toolResultText(res);
  console.log(asJson ? JSON.stringify(res) : typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

client.close();
