#!/usr/bin/env node
// lib/bridge-keeper.mjs — long-lived holder for the Roblox Studio MCP bridge.
//
// Spawned detached by lib/bridge.mjs. It runs StudioMCP.exe with an open stdin pipe so the
// proxy keeps listening on 127.0.0.1:13469, and it watches the proxy's `--verbose` stderr
// for Studio's heartbeat. Studio sends a JSON-RPC ping roughly every 5s while connected
// ("Message from studio <id>"), so when that heartbeat stops for a grace window the keeper
// releases the port and exits.
//
// This detection is fully event-driven: the keeper spawns NO subprocesses on a timer. An
// earlier version polled `tasklist`, which cost a process per poll and flashed a console
// window on screen every time.
//
// The keeper also answers for its own state on demand: it listens on a private loopback port
// and publishes that port in the shared state file, so `rbx.mjs bridge status` can ask
// whether Studio's heartbeat is being seen right now, and when it was last seen. Keeping the
// answer here (rather than writing it to disk on every ping) means the steady state is still
// zero I/O.
//
//   node bridge-keeper.mjs <StudioMCP.exe> [extra proxy args...]
//
//   RBX_KEEPER_GRACE_MS    silence tolerated before shutting down (default 20000)
//   RBX_KEEPER_CHECK_MS    how often to compare timestamps        (default 2000)
//   RBX_KEEPER_CONTROL_MS  how long a control client may take     (default 2000)

import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, ...proxyArgs] = process.argv.slice(2);
if (!exe) {
  console.error("usage: node bridge-keeper.mjs <StudioMCP.exe> [extra proxy args...]");
  process.exit(2);
}

const STATE = join(tmpdir(), "rbx-studio-mcp-bridge.json");
const GRACE_MS = Number(process.env.RBX_KEEPER_GRACE_MS ?? 20000);
const CHECK_MS = Number(process.env.RBX_KEEPER_CHECK_MS ?? 2000);
const CONTROL_MS = Number(process.env.RBX_KEEPER_CONTROL_MS ?? 2000);

// Lines the proxy emits on stderr that prove Studio is attached right now.
const STUDIO_ALIVE = /(Studio connected|Message from studio)/;

let studioSeen = false;
let lastActivity = 0;
let usedVerbose = false;
let startedAt = 0;
let child;
let restarting = false;

function launch(args) {
  startedAt = Date.now();
  child = spawn(exe, args, {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });

  child.stderr.setEncoding("utf8");
  let buffer = "";
  child.stderr.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (STUDIO_ALIVE.test(line)) {
        if (!studioSeen) console.error("bridge-keeper: Studio heartbeat detected");
        studioSeen = true;
        lastActivity = Date.now();
      }
    }
    // Never let a pathological stream without newlines grow without bound.
    if (buffer.length > 1_000_000) buffer = buffer.slice(-1000);
  });

  child.on("exit", (code) => {
    // If --verbose itself was rejected, retry once without it so the bridge still works,
    // just without heartbeat-driven shutdown.
    if (usedVerbose && !restarting && code !== 0 && Date.now() - startedAt < 2500) {
      console.error("bridge-keeper: proxy rejected --verbose; continuing without heartbeat detection");
      restarting = true;
      usedVerbose = false;
      launch([]);
      return;
    }
    clearState();
    process.exit(code ?? 0);
  });

  child.on("error", (e) => {
    console.error(`bridge-keeper: ${e.message}`);
    clearState();
    process.exit(1);
  });
}

/** Remove the state file, but only while it still describes this keeper. */
function clearState() {
  try {
    const state = JSON.parse(readFileSync(STATE, "utf8"));
    if (state?.pid === process.pid) unlinkSync(STATE);
  } catch {}
}

let stopping = false;
function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  if (reason) console.error(`bridge-keeper: ${reason}`);
  clearState();
  try {
    control.close();
  } catch {}
  try {
    child.kill();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
process.on("SIGHUP", () => shutdown());

// --- on-demand state ------------------------------------------------------
// `heartbeatFresh` is computed when the question is asked, not when the ping arrives, so a
// status query reports the gap as it stands at that moment.
function respond(request) {
  if (request !== "status" && request !== "ping") return { error: `unknown request: ${request}` };
  const age = lastActivity ? Date.now() - lastActivity : null;
  return {
    pid: process.pid,
    exe,
    proxyUp: Boolean(child && child.exitCode === null && !child.killed),
    proxyUptimeMs: startedAt ? Date.now() - startedAt : null,
    verbose: usedVerbose,
    studioSeen,
    heartbeatFresh: studioSeen && age !== null && age < GRACE_MS,
    lastHeartbeatAt: lastActivity ? new Date(lastActivity).toISOString() : null,
    heartbeatAgeMs: age,
    graceMs: GRACE_MS,
    checkMs: CHECK_MS,
  };
}

/** Publish the control port, but only while the state file still describes this keeper. */
function publishControlPort(port) {
  try {
    const state = JSON.parse(readFileSync(STATE, "utf8"));
    if (state?.pid !== process.pid) return;
    writeFileSync(STATE, JSON.stringify({ ...state, controlPort: port }, null, 2));
  } catch {}
}

const control = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.setTimeout(CONTROL_MS, () => socket.destroy());
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const i = buffer.indexOf("\n");
    if (i < 0) {
      if (buffer.length > 4096) socket.destroy();
      return;
    }
    socket.end(`${JSON.stringify(respond(buffer.slice(0, i).trim()))}\n`);
  });
  socket.on("error", () => {});
});

// Loopback only: this answers local status queries, it is not a public endpoint.
control.on("error", (e) => console.error(`bridge-keeper: control channel unavailable: ${e.message}`));
control.listen(0, "127.0.0.1", () => {
  const addr = control.address();
  if (addr && typeof addr === "object") publishControlPort(addr.port);
});

// Default to --verbose (that is where the heartbeat comes from); extra args win, which
// also lets tests point this at a mock proxy.
if (proxyArgs.length) {
  launch(proxyArgs);
} else {
  usedVerbose = true;
  launch(["--verbose"]);
}

// No subprocess here — just timestamp comparison.
setInterval(() => {
  if (stopping || !studioSeen) return;
  const silentFor = Date.now() - lastActivity;
  if (silentFor >= GRACE_MS) {
    shutdown(`no Studio activity for ${Math.round(silentFor / 1000)}s; releasing port 13469`);
  }
}, CHECK_MS);
