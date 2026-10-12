#!/usr/bin/env node
// run.mjs — the checks this repository's CI runs on every push.
//
//   node checks/run.mjs [repoRoot] [--json]
//
// These are the checks that still mean something on a machine with no Windows, no Roblox
// Studio and no bridge:
//
//   syntax     every .mjs in the repository parses (node --check — parses, never executes)
//   spawn      every spawn()/spawnSync() call passes windowsHide (checks/check-spawn.mjs)
//   skill      each SKILL.md has frontmatter whose `name` matches its folder and a
//              description, and every scripts/*.mjs it documents actually exists
//   cli        the shipped CLI answers --help with exit 0 before touching the bridge
//   bootstrap  the shipped bootstrap.mjs honours --dry-run against a temp home: it reports
//              what it would write and leaves the filesystem untouched
//
// Deliberately absent: anything that needs this machine. The canonical tooling's verify.mjs
// also mirrors itself into ~/.agents/skills and probes the live bridge — neither of those
// exists on a runner, which is why that command stays local and this one ships.
//
// Exit code is 0 only when every check passed, so the workflow can gate on it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const positional = argv.filter((a) => !a.startsWith("-"));

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`run.mjs — the checks CI runs on every push

Usage: node checks/run.mjs [repoRoot] [--json]

  repoRoot   directory to check (default: the repository this file lives in)
  --json     machine-readable result

Exit 0 only when every check passed.`);
  process.exit(0);
}

const unknown = argv.find((a) => a.startsWith("--") && a !== "--json");
if (unknown) {
  console.error(`run.mjs: unknown flag ${unknown}`);
  process.exit(2);
}
if (positional.length > 1) {
  console.error(`run.mjs: expected at most one root, got ${positional.length}`);
  process.exit(2);
}

const ROOT = resolve(positional[0] ?? join(HERE, ".."));
const rel = (p) => relative(ROOT, p).split(sep).join("/");

/** Every file under dir whose name satisfies keep(). Dot dirs and node_modules are skipped. */
function walk(dir, keep) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}

/** Run node with the given args from the repository root and capture the outcome. */
function runNode(args, { timeoutMs = 60000 } = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    // windowsHide is REQUIRED: without it a console window flashes on the user's screen.
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    // status is null when the child was killed (for example by the timeout above).
    code: r.status === null ? 124 : r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
  };
}

const checks = [];
function record(name, ok, summary, detail = "") {
  const lines = detail.trim().split("\n").filter(Boolean);
  if (lines[0] === summary) lines.shift(); // a check's first output line is already the summary
  checks.push({ name, ok, summary, detail: lines.slice(-12).join("\n") });
}

// --- the skills in this repository ----------------------------------------
// The `skills` CLI discovers a skill by its SKILL.md, so that file is the contract these
// checks defend: valid frontmatter, a folder name that matches `name`, and docs that point
// at scripts that exist.
const skillsRoot = join(ROOT, "skills");
const skills = existsSync(skillsRoot)
  ? readdirSync(skillsRoot)
      .map((name) => join(skillsRoot, name))
      .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md")))
  : [];

/** Frontmatter of a SKILL.md as a flat map, with block scalars folded onto one line. */
function frontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
  if (!m) return null;
  const fields = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      fields[key] = kv[2].trim().replace(/^["']|["']$/g, "");
    } else if (key && line.trim()) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

// --- syntax ---------------------------------------------------------------
{
  const files = walk(ROOT, (name) => name.endsWith(".mjs"));
  const broken = [];
  for (const file of files) {
    const r = runNode(["--check", file]);
    if (r.code !== 0) {
      // Drop stack frames so the failure reads as "file:line — SyntaxError: ...".
      const lines = (r.stderr || r.stdout)
        .trim()
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("at ") && !/^\^+$/.test(l));
      const err = lines.find((l) => /error/i.test(l)) ?? lines[lines.length - 1] ?? "failed";
      const at = /:(\d+)$/.exec(lines[0] ?? "");
      broken.push(`${rel(file)}${at ? `:${at[1]}` : ""}: ${err}`);
    }
  }
  record(
    "syntax",
    broken.length === 0,
    broken.length ? `${broken.length} of ${files.length} files failed` : `${files.length} files parse`,
    broken.join("\n"),
  );
}

// --- spawn hygiene --------------------------------------------------------
{
  const r = runNode([join("checks", "check-spawn.mjs"), ROOT]);
  record("spawn", r.code === 0, r.output.split("\n")[0] || `exit ${r.code}`, r.code === 0 ? "" : r.output);
}

// --- skill integrity ------------------------------------------------------
{
  const problems = [];
  if (!skills.length) problems.push("no skills/<name>/SKILL.md found — the CLI would install nothing");
  for (const dir of skills) {
    const name = dir.split(sep).pop();
    const src = readFileSync(join(dir, "SKILL.md"), "utf8");
    const fields = frontmatter(src);
    if (!fields) {
      problems.push(`${name}/SKILL.md: no --- frontmatter block`);
      continue;
    }
    if (!fields.name) problems.push(`${name}/SKILL.md: frontmatter has no \`name\``);
    else if (fields.name !== name) problems.push(`${name}/SKILL.md: name "${fields.name}" != folder`);
    if (!fields.description) problems.push(`${name}/SKILL.md: frontmatter has no \`description\``);

    // Docs drift silently; every script path the skill mentions must be real.
    const refs = new Set([...src.matchAll(/scripts\/[\w.-]+(?:\/[\w.-]+)*\.mjs/g)].map((m) => m[0]));
    for (const ref of refs) {
      if (!existsSync(join(dir, ref))) problems.push(`${name}/SKILL.md: documents missing ${ref}`);
    }
  }
  record(
    "skill",
    problems.length === 0,
    problems.length
      ? `${problems.length} problem(s)`
      : `${skills.length} skill(s) valid (frontmatter + documented scripts exist)`,
    problems.join("\n"),
  );
}

// --- the shipped CLI ------------------------------------------------------
// --help must answer and exit before any bridge work, so it works with no Studio anywhere.
{
  const problems = [];
  const answered = [];
  for (const dir of skills) {
    const name = dir.split(sep).pop();
    const r = runNode([join("skills", name, "scripts", "rbx.mjs"), "--help"]);
    if (r.code !== 0) problems.push(`${name}: rbx.mjs --help exited ${r.code}\n${r.output.split("\n").slice(0, 3).join("\n")}`);
    else if (!r.stdout.trim()) problems.push(`${name}: rbx.mjs --help printed nothing`);
    else answered.push(name);
  }
  record(
    "cli",
    answered.length > 0 && problems.length === 0,
    !answered.length
      ? "not run (no skill in this root)"
      : problems.length
        ? `${problems.length} failure(s)`
        : `rbx.mjs --help answers (${answered.join(", ")})`,
    problems.join("\n"),
  );
}

// --- the shipped setup step ----------------------------------------------
// bootstrap writes outside its own tree, so this only checks the safe mode: --dry-run against
// a throwaway home and Roblox dir must report what it would do and write nothing at all.
{
  const problems = [];
  let reported = null;
  const sandbox = skills.length ? mkdtempSync(join(tmpdir(), "rbx-checks-")) : null;
  try {
    for (const dir of skills) {
      const name = dir.split(sep).pop();
      const r = runNode([
        join("skills", name, "scripts", "bootstrap.mjs"),
        "--dry-run",
        "--json",
        "--home",
        join(sandbox, "home"),
        "--roblox-dir",
        join(sandbox, "roblox"),
      ]);
      // Exit 1 is the documented "Studio is not installed" signal, which is the norm off Windows.
      if (r.code !== 0 && r.code !== 1) {
        problems.push(`${name}: bootstrap --dry-run exited ${r.code}\n${r.output.split("\n").slice(0, 3).join("\n")}`);
        continue;
      }
      let report = null;
      try {
        report = JSON.parse(r.stdout);
      } catch {
        problems.push(`${name}: bootstrap --dry-run --json did not print JSON`);
        continue;
      }
      reported = report;
      if (!report.bat || report.bat.changed !== true) {
        problems.push(`${name}: bootstrap did not report the launcher it would write`);
      }
      if (report.checks?.node?.ok !== true) {
        problems.push(`${name}: bootstrap reports this Node (${process.versions.node}) as unsupported`);
      }
      const left = readdirSync(sandbox);
      if (left.length) {
        problems.push(`${name}: --dry-run wrote ${left.join(", ")} into the sandbox home`);
      }
    }
  } finally {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  }
  record(
    "bootstrap",
    reported !== null && problems.length === 0,
    reported === null
      ? "not run (no skill in this root)"
      : problems.length
        ? `${problems.length} problem(s)`
        : `--dry-run honours the sandbox (node ${process.versions.node}, studio ${reported.checks?.studio?.ok ? "found" : "absent"})`,
    problems.join("\n"),
  );
}

// --- report ---------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);

if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, root: ROOT, node: process.versions.node, checks }, null, 2));
} else {
  console.log(`checks: ${checks.length} checks, ${failed.length} failed  (node ${process.versions.node}, root ${ROOT})`);
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(10)} ${c.summary}`);
    if (!c.ok) for (const line of c.detail.split("\n")) if (line) console.log(`        ${line}`);
  }
}

process.exit(failed.length ? 1 : 0);
