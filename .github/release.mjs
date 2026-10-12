#!/usr/bin/env node
// release.mjs — publish a GitHub Release for a version, called by workflows/release.yml.
//
// Creating a release is one API call, so it lives in a reviewable script rather than a YAML
// blob: the body it builds is what a consumer reads when pinning a version, and the failure
// path prints GitHub's own message instead of a bare exit code.
//
//   GH_TOKEN=<token> TAG=v1.0.0 node .github/release.mjs
//   GH_TOKEN=x TAG=v1.0.0 node .github/release.mjs --dry-run   # print the payload, send nothing
//
// Run from the repository root. GH_TOKEN needs contents:write (the workflow passes
// github.token); GITHUB_REPOSITORY and GITHUB_SHA are the ones Actions provides.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const required = { GH_TOKEN: "GH_TOKEN", TAG: "TAG", GITHUB_REPOSITORY: "GITHUB_REPOSITORY", GITHUB_SHA: "GITHUB_SHA" };
for (const [key, name] of Object.entries(required)) {
  if (!process.env[key]) {
    console.error(`release: ${name} is not set`);
    process.exit(2);
  }
}

const { GH_TOKEN: token, TAG: tag, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;

// One install line per skill, so adding a second skill cannot silently leave it unmentioned.
let skills;
try {
  skills = readdirSync("skills").filter((name) => existsSync(join("skills", name, "SKILL.md")));
} catch {
  console.error("release: no skills/ directory here — run this from the repository root");
  process.exit(2);
}
if (!skills.length) {
  console.error("release: skills/ holds no skill (no SKILL.md) — nothing to describe");
  process.exit(2);
}

const installs = skills.map((skill) => `npx skills add ${repo}#${tag} --skill ${skill} --yes`).join("\n");

const body = `Pin this version instead of tracking \`main\`:

\`\`\`bash
${installs}
\`\`\`

The tag points at the commit whose checks passed in this job.`;

const payload = {
  tag_name: tag,
  name: tag,
  target_commitish: sha,
  body,
  // GitHub's own notes (commit list, first-time contributors) are appended to the body above.
  generate_release_notes: true,
  draft: false,
};

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
});

const json = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`release: GitHub refused (${res.status} ${res.statusText}): ${json?.message ?? "no message"}`);
  for (const error of json?.errors ?? []) console.error(`  ${JSON.stringify(error)}`);
  process.exit(1);
}

console.log(`release: ${json.tag_name} -> ${json.html_url}`);
