// mcp-client.mjs — zero-dependency stdio MCP client for Roblox Studio's MCP bridge.
//
// It launches the SAME server entry Freebuff reads from ~/.agents/mcp.json
// ("Roblox_Studio" -> cmd.exe /c "cd /d %LOCALAPPDATA%\Roblox && .\mcp.bat"
//  -> StudioMCP.exe), then speaks newline-delimited JSON-RPC over stdin/stdout.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SERVER_NAME = "Roblox_Studio";

/** Resolve how to launch the Roblox Studio MCP server.
 *  Order: RBX_MCP_COMMAND env override -> ~/.agents/mcp.json -> mcp.bat fallback. */
export function resolveLaunch() {
  if (process.env.RBX_MCP_COMMAND) {
    return {
      command: process.env.RBX_MCP_COMMAND,
      args: process.env.RBX_MCP_ARGS ? process.env.RBX_MCP_ARGS.split(" ") : [],
      source: "RBX_MCP_COMMAND env",
    };
  }

  const cfgPath = join(homedir(), ".agents", "mcp.json");
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const entry = cfg?.mcpServers?.[SERVER_NAME];
    if (entry?.command) {
      return {
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env,
        cwd: entry.cwd,
        source: cfgPath,
      };
    }
  } catch (err) {
    // fall through to the built-in default
  }

  return {
    command: "cmd.exe",
    args: ["/c", "cd /d %LOCALAPPDATA%\\Roblox && .\\mcp.bat"],
    source: "built-in fallback",
  };
}

/** A connected MCP session over stdio. */
export class McpClient {
  constructor(child, launch) {
    this.child = child;
    this.launch = launch;
    this._pending = new Map();
    this._nextId = 1;
    this._buf = "";
    this._stderr = "";
    this._closed = false;
    this.serverInfo = null;

    child.stderr.on("data", (d) => {
      this._stderr += d.toString("utf8");
    });
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.on("exit", (code) => {
      this._closed = true;
      for (const { reject } of this._pending.values()) {
        reject(new Error(`Server exited (code ${code}). stderr: ${this._stderr.trim()}`));
      }
      this._pending.clear();
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString("utf8");
    let idx;
    while ((idx = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON noise
      }
      if (msg.id != null && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  }

  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this._closed) return Promise.reject(new Error("Client is closed"));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async listTools() {
    const res = await this.request("tools/list", {});
    return res?.tools ?? [];
  }

  async callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args }, { timeoutMs: 120000 });
  }

  get stderr() {
    return this._stderr.trim();
  }

  close() {
    this._closed = true;
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill();
    } catch {}
  }
}

/** Launch the server and complete the MCP initialize handshake. */
export async function connect({ clientName = "freebuff-rbx", launch } = {}) {
  const spec = launch ?? resolveLaunch();
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const client = new McpClient(child, spec);
  client.serverInfo = await client.request(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
    { timeoutMs: 20000 },
  );
  client.notify("notifications/initialized");
  return client;
}

/** Extract a JSON object from an MCP tool result, or return the raw text. */
export function toolResultText(result) {
  const text = (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
