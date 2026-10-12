// lib/bridge.mjs — keeps the Roblox Studio MCP bridge (127.0.0.1:13469) alive.
//
// StudioMCP.exe is a proxy that LISTENS on the fixed loopback port 13469, where Studio
// connects over WebSocket. A per-command proxy only works while some long-lived proxy
// owns that port, so this module detects a dead port and starts a detached keeper
// (lib/bridge-keeper.mjs) that holds StudioMCP.exe's stdin open and outlives the CLI.

import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_PORT = 13469;
export const BRIDGE_HOST = "127.0.0.1";

const KEEPER = join(dirname(fileURLToPath(import.meta.url)), "bridge-keeper.mjs");
const STATE = join(tmpdir(), "rbx-studio-mcp-bridge.json");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when something is listening on the bridge port. */
export function isBridgeListening({ host = BRIDGE_HOST, port = BRIDGE_PORT, timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Locate StudioMCP.exe: RBX_MCP_EXE override, else newest under %LOCALAPPDATA%\Roblox\Versions. */
export function findStudioMcpExe() {
  if (process.env.RBX_MCP_EXE) return process.env.RBX_MCP_EXE;

  const versions = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Roblox", "Versions");
  if (versions && existsSync(versions)) {
    let best = null;
    for (const dir of readdirSync(versions)) {
      const exe = join(versions, dir, "StudioMCP.exe");
      if (!existsSync(exe)) continue;
      const mtime = statSync(exe).mtimeMs;
      if (!best || mtime > best.mtime) best = { exe, mtime };
    }
    if (best) return best.exe;
  }

  throw new Error(
    "StudioMCP.exe not found. Set RBX_MCP_EXE to its path, or open Roblox Studio once to install it.",
  );
}

/**
 * Whether Roblox Studio itself is running (no point holding a bridge for a closed Studio).
 * The image name is overridable via RBX_KEEPER_STUDIO_IMAGE, matching the keeper's check.
 */
export function isStudioRunning(image = process.env.RBX_KEEPER_STUDIO_IMAGE || "RobloxStudioBeta.exe") {
  if (process.platform !== "win32") return true; // unknown elsewhere; don't block healing
  try {
    // windowsHide is REQUIRED: the keeper calls this on a timer, and without
    // CREATE_NO_WINDOW every poll flashes a console window on screen.
    const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`], {
      encoding: "utf8",
      windowsHide: true,
    });
    return (out.stdout ?? "").toLowerCase().includes(image.toLowerCase());
  } catch {
    return true;
  }
}

export function readKeeperState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Ask the running keeper for its live state (heartbeat, proxy, verbose flag) over the
 * loopback control port it publishes in the state file. Returns null when there is no
 * keeper to ask, or when it does not answer in time — callers fall back to the state file.
 */
export function askKeeper({ timeoutMs = 1500 } = {}) {
  const state = readKeeperState();
  const port = state?.controlPort;
  if (!port || !alivePid(state?.pid)) return Promise.resolve(null);

  return new Promise((resolve) => {
    const sock = net.connect({ host: BRIDGE_HOST, port });
    let settled = false;
    let buffer = "";
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => sock.write("status\n"));
    sock.on("data", (chunk) => {
      buffer += chunk;
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      try {
        done(JSON.parse(buffer.slice(0, i)));
      } catch {
        done(null);
      }
    });
    sock.once("timeout", () => done(null));
    sock.once("error", () => done(null));
    sock.once("close", () => done(null));
  });
}

function alivePid(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the bridge is listening, starting a detached keeper only when it is not.
 * Returns { listening, started, pid, exe }. Never disturbs a healthy bridge.
 */
export async function ensureBridge({ waitMs = 8000, start = true } = {}) {
  if (await isBridgeListening()) {
    const state = readKeeperState();
    return { listening: true, started: false, pid: alivePid(state?.pid) ? state.pid : null, exe: state?.exe ?? null };
  }
  if (!start) {
    return { listening: false, started: false, pid: null, exe: null, reason: "healing-disabled" };
  }
  if (!isStudioRunning()) {
    return { listening: false, started: false, pid: null, exe: null, reason: "studio-not-running" };
  }

  const exe = findStudioMcpExe();
  const keeper = spawn(process.execPath, [KEEPER, exe], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  keeper.unref();

  try {
    writeFileSync(STATE, JSON.stringify({ pid: keeper.pid, exe, startedAt: new Date().toISOString() }, null, 2));
  } catch {}

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isBridgeListening()) return { listening: true, started: true, pid: keeper.pid, exe };
    await sleep(150);
  }

  return { listening: false, started: true, pid: keeper.pid, exe };
}

/** Stop the keeper (and its StudioMCP.exe child). Returns true if something was stopped. */
export function stopBridge() {
  const state = readKeeperState();
  if (!state?.pid) return false;
  const args =
    process.platform === "win32"
      ? ["/PID", String(state.pid), "/T", "/F"]
      : ["-TERM", String(state.pid)];
  const cmd = process.platform === "win32" ? "taskkill" : "kill";
  spawnSync(cmd, args, { stdio: "ignore", windowsHide: true });
  return true;
}

/**
 * Current bridge state for display. `heartbeat` is the keeper's live view of Studio and is
 * null when no keeper answers (dead, or started by an older build).
 */
export async function bridgeStatus() {
  const listening = await isBridgeListening();
  const state = readKeeperState();
  const keeperAlive = alivePid(state?.pid);
  const live = keeperAlive ? await askKeeper() : null;

  return {
    listening,
    port: BRIDGE_PORT,
    keeperPid: state?.pid ?? null,
    keeperAlive,
    exe: state?.exe ?? live?.exe ?? null,
    heartbeat: live
      ? {
          studioSeen: Boolean(live.studioSeen),
          fresh: Boolean(live.heartbeatFresh),
          lastHeartbeatAt: live.lastHeartbeatAt ?? null,
          ageMs: live.heartbeatAgeMs ?? null,
          graceMs: live.graceMs ?? null,
          proxyUp: Boolean(live.proxyUp),
          verbose: Boolean(live.verbose),
        }
      : null,
  };
}
