// lib/place.mjs — helpers for reading/writing scripts in the open Studio place.

import { toolResultText } from "../mcp-client.mjs";
import { sleep } from "./bridge.mjs";

/** script_read returns "  12→line text"; strip the line-number prefix back to source. */
export function parseScriptRead(text) {
  if (typeof text !== "string") return null;
  const out = [];
  let matched = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\d+→(.*)$/);
    if (m) {
      out.push(m[1]);
      matched = true;
    }
  }
  return matched ? out.join("\n") : null;
}

export async function listStudios(client) {
  const data = toolResultText(await client.callTool("list_roblox_studios", {}));
  return data?.studios ?? [];
}

/** Poll until at least one Studio instance is visible (Studio reconnects to the bridge within ~2s). */
export async function waitForStudio(client, { timeoutMs = 8000, pollMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const studios = await listStudios(client);
    if (studios.length) return studios;
    if (Date.now() >= deadline) return studios;
    await sleep(pollMs);
  }
}

export async function resolveStudioId(client, explicit, { timeoutMs = 8000 } = {}) {
  if (explicit) return explicit;
  const studios = await waitForStudio(client, { timeoutMs });
  if (!studios.length) throw new Error("No open Roblox Studio instance found. Open a place in Studio and retry.");
  return studios[0].id;
}

/** Read a script. Returns { exists, content } (content "" when absent). */
export async function readScript(client, dotPath, studioId) {
  const res = await client.callTool("script_read", { target_file: dotPath, studio_id: studioId });
  if (res?.isError) return { exists: false, content: "" };
  return { exists: true, content: parseScriptRead(toolResultText(res)) ?? "" };
}

/** Wrap arbitrary text in a Luau long-bracket string at a level not present in it. */
export function luaLongString(s) {
  let level = 0;
  while (s.includes("]" + "=".repeat(level) + "]")) level++;
  const eq = "=".repeat(level);
  return `[${eq}[${s}]${eq}]`;
}

/**
 * Create or overwrite a script with whole-file content.
 * Creates via multi_edit; overwrites by setting .Source through execute_luau,
 * falling back to a full-content multi_edit replace if Source is not writable.
 * Returns "created" | "updated".
 */
export async function writeScript(client, dotPath, content, { className, studioId } = {}) {
  const cur = await readScript(client, dotPath, studioId);

  if (!cur.exists) {
    const res = await client.callTool("multi_edit", {
      file_path: dotPath,
      className: className || "ModuleScript",
      datamodel_type: "Edit",
      studio_id: studioId,
      edits: [{ old_string: "", new_string: content }],
    });
    if (res?.isError) throw new Error(toolResultText(res));
    return "created";
  }

  const code = `${dotPath}.Source = ${luaLongString(content)}`;
  const res = await client.callTool("execute_luau", { code, datamodel_type: "Edit", studio_id: studioId });
  if (!res?.isError) return "updated";

  // Fallback: replace the entire body via multi_edit.
  const res2 = await client.callTool("multi_edit", {
    file_path: dotPath,
    datamodel_type: "Edit",
    studio_id: studioId,
    edits: [{ old_string: cur.content, new_string: content }],
  });
  if (res2?.isError) throw new Error(toolResultText(res2));
  return "updated";
}

/** Destroy a script in the place. Returns "deleted" or "absent" (nothing to remove). */
export async function deleteScript(client, dotPath, studioId) {
  const cur = await readScript(client, dotPath, studioId);
  if (!cur.exists) return "absent";
  const res = await client.callTool("execute_luau", {
    code: `${dotPath}:Destroy()`,
    datamodel_type: "Edit",
    studio_id: studioId,
  });
  if (res?.isError) throw new Error(toolResultText(res));
  return "deleted";
}
