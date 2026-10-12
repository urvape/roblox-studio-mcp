// lib/safety.mjs — backups, restore lookup, and unified diff for edit safety.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".rbx-backups");

const safeName = (dotPath) => dotPath.replace(/[^A-Za-z0-9._-]/g, "_");

/** Save a script's current contents under a timestamped backup folder. Returns the file path. */
export function backupScript(dotPath, content, meta = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(ROOT, stamp);
  mkdirSync(dir, { recursive: true });

  const file = safeName(dotPath) + ".luau";
  writeFileSync(join(dir, file), content, "utf8");

  const manifestPath = join(dir, "_manifest.json");
  let items = [];
  if (existsSync(manifestPath)) {
    try {
      items = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {}
  }
  items.push({ path: dotPath, file, at: new Date().toISOString(), ...meta });
  writeFileSync(manifestPath, JSON.stringify(items, null, 2));
  return join(dir, file);
}

/** All backups, newest first. Optionally filtered to one script path. */
export function listBackups(filterPath) {
  if (!existsSync(ROOT)) return [];
  const out = [];
  for (const stamp of readdirSync(ROOT).sort().reverse()) {
    const manifestPath = join(ROOT, stamp, "_manifest.json");
    if (!existsSync(manifestPath)) continue;
    let items = [];
    try {
      items = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    for (const it of items) if (!filterPath || it.path === filterPath) out.push({ stamp, ...it });
  }
  return out;
}

export function latestBackup(dotPath) {
  return listBackups(dotPath)[0] ?? null;
}

export function readBackup(b) {
  return readFileSync(join(ROOT, b.stamp, b.file), "utf8");
}

// ---- unified diff -----------------------------------------------------------

function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push([" ", a[i++], j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", a[i++], j]);
    else ops.push(["+", b[j], ++j]);
  }
  while (i < n) ops.push(["-", a[i++], j]);
  while (j < m) ops.push(["+", b[j], ++j]);
  return ops;
}

/** Produce a unified-style diff (or "" when identical). */
export function unifiedDiff(oldText, newText, label, context = 3) {
  if (oldText === newText) return "";
  const A = oldText.split(/\r?\n/);
  const B = newText.split(/\r?\n/);
  const ops = diffOps(A, B);

  const aBefore = [];
  const bBefore = [];
  let ac = 0;
  let bc = 0;
  for (const [t] of ops) {
    aBefore.push(ac + 1);
    bBefore.push(bc + 1);
    if (t !== "+") ac++;
    if (t !== "-") bc++;
  }

  const changed = ops.map((o, i) => (o[0] !== " " ? i : -1)).filter((i) => i >= 0);
  const ranges = [];
  let st = Math.max(0, changed[0] - context);
  let en = Math.min(ops.length - 1, changed[0] + context);
  for (const c of changed.slice(1)) {
    if (c - context <= en + 1) en = Math.min(ops.length - 1, c + context);
    else {
      ranges.push([st, en]);
      st = Math.max(0, c - context);
      en = Math.min(ops.length - 1, c + context);
    }
  }
  ranges.push([st, en]);

  const lines = [`--- a/${label}`, `+++ b/${label}`];
  for (const [s, e] of ranges) {
    const slice = ops.slice(s, e + 1);
    const aCount = slice.filter((o) => o[0] !== "+").length;
    const bCount = slice.filter((o) => o[0] !== "-").length;
    lines.push(`@@ -${aBefore[s]},${aCount} +${bBefore[s]},${bCount} @@`);
    for (const [t, text] of slice) lines.push(t + text);
  }
  return lines.join("\n");
}
