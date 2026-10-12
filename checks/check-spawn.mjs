#!/usr/bin/env node
// check-spawn.mjs — fail if any spawn()/spawnSync() call in a tree omits windowsHide.
//
// Why this exists: on Windows, spawn without windowsHide creates a console window for the
// child. A process with no console of its own — the detached bridge keeper — that spawns on
// a timer therefore flashes a window on screen every poll. That shipped once (the keeper
// polled `tasklist` every 4s); this check stops it shipping again.
//
// It scans every .mjs file under the target root, so new files are covered automatically.
// A call that genuinely must not hide its window can opt out with a `spawn-no-window-ok`
// comment on the same line, which keeps the check honest instead of forcing a bogus fix.
//
//   node checks/check-spawn.mjs [root]   # exit 1 if any call omits windowsHide
//   node checks/check-spawn.mjs --json
//
// root defaults to the repository this file lives in (its parent's parent). It is run both by
// checks/run.mjs against a published repo and by the canonical tooling's verify.mjs against
// the tooling directory, so there is exactly one copy of this scan.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const positional = argv.filter((a) => !a.startsWith("-"));

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`check-spawn — fail if any spawn()/spawnSync() call omits windowsHide

Usage: node checks/check-spawn.mjs [root] [--json]

  root     directory tree to scan (default: ${DEFAULT_ROOT})
  --json   machine-readable result

Exit 1 when a call is missing windowsHide.`);
  process.exit(0);
}

const unknown = argv.find((a) => a.startsWith("--") && a !== "--json");
if (unknown) {
  console.error(`check-spawn: unknown flag ${unknown}`);
  process.exit(2);
}
if (positional.length > 1) {
  console.error(`check-spawn: expected at most one root, got ${positional.length}`);
  process.exit(2);
}

const ROOT = resolve(positional[0] ?? DEFAULT_ROOT);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

/** Blank out comments and string literals, preserving offsets and newlines. */
function stripLiterals(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < Math.min(to, n); k++) if (out[k] !== "\n") out[k] = " ";
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      blank(i, j + 2);
      i = j + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        j++;
      }
      blank(i + 1, j - 1);
      i = j;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Index of the `)` matching the `(` at openIdx. */
function callEnd(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const violations = [];
let checked = 0;

for (const file of walk(ROOT)) {
  const original = readFileSync(file, "utf8");
  const src = stripLiterals(original);

  const re = /\b(spawn|spawnSync)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const openIdx = src.indexOf("(", m.index);
    const end = callEnd(src, openIdx);
    if (end < 0) continue;
    checked++;

    const call = src.slice(m.index, end + 1);
    if (/windowsHide/.test(call)) continue;

    const line = original.slice(0, m.index).split("\n").length;
    const lineText = original.split("\n")[line - 1] ?? "";
    if (lineText.includes("spawn-no-window-ok")) continue;

    violations.push({
      file: relative(ROOT, file).split(sep).join("/"),
      line,
      call: `${m[1]}(...)`,
    });
  }
}

if (asJson) {
  console.log(JSON.stringify({ root: ROOT, checked, violations }, null, 2));
} else if (violations.length) {
  console.error(`check-spawn: ${violations.length} spawn call(s) missing windowsHide:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.call}`);
  console.error("\nAdd `windowsHide: true` (or justify with a `spawn-no-window-ok` comment).");
} else {
  console.log(`check-spawn: OK (${checked} spawn calls, all pass windowsHide)`);
}

process.exit(violations.length ? 1 : 0);
