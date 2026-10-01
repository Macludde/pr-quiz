#!/usr/bin/env node
// Usage:
//   quiz.mjs lint   <quiz.json>
//   quiz.mjs render <quiz.json> [outDir]          writes quiz.md + quiz.html
//   quiz.mjs post   <quiz.json> [outDir] [--dry-run]  lint, render, upsert the PR comment
// Run from inside the git checkout the quiz is about (or pass --cwd=<dir>).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "<!-- pr-quiz:v1 -->";
const KINDS = {
  runtime: "Where it runs",
  architecture: "Architecture",
  decision: "Design decision",
  behavior: "Behavior",
  failure: "Known issue",
  contract: "Contract",
};
const REQUIRED_KINDS = ["runtime", "architecture", "decision", "failure"];
const MAX = { q: 180, option: 90, why: 260, diagramLines: 14, label: 32, message: 40, participants: 4, diagramWidth: 640 };
const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.PR_QUIZ_HOME ?? join(homedir(), ".local/share/pr-quiz");

const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? true];
  }),
);
const [cmd, quizPath, outArg] = argv.filter((a) => !a.startsWith("--"));
const cwd = resolve(flags.cwd ?? process.cwd());

function sh(bin, args, opts = {}) {
  return execFileSync(bin, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], ...opts });
}

const fileCache = new Map();
function fileAt(sha, path) {
  const key = `${sha}:${path}`;
  if (!fileCache.has(key)) {
    try {
      fileCache.set(key, sh("git", ["show", key]).split("\n"));
    } catch {
      fileCache.set(key, null);
    }
  }
  return fileCache.get(key);
}

function changedFiles(quiz) {
  const base = `origin/${quiz.base}`;
  try {
    const mb = sh("git", ["merge-base", base, quiz.sha]).trim();
    return new Set(sh("git", ["diff", "--name-only", mb, quiz.sha]).split("\n").filter(Boolean));
  } catch {
    try {
      return new Set(sh("gh", ["pr", "diff", String(quiz.pr), "--repo", quiz.repo, "--name-only"]).split("\n").filter(Boolean));
    } catch {
      return null;
    }
  }
}

const norm = (s) => s.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();

export function lint(quiz) {
  const errors = [];
  const warn = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);

  for (const k of ["repo", "pr", "base", "sha", "title", "questions"]) if (quiz[k] == null) err("quiz", `missing "${k}"`);
  if (errors.length) return { errors, warn };
  if (!/^[0-9a-f]{40}$/.test(quiz.sha)) err("quiz", "sha must be the full 40-char head commit");
  else {
    try {
      sh("git", ["cat-file", "-e", `${quiz.sha}^{commit}`]);
    } catch {
      err("quiz", `commit ${quiz.sha} not in this checkout; fetch it first`);
    }
  }
  const qs = quiz.questions;
  if (!Array.isArray(qs) || qs.length < 4 || qs.length > 10) err("quiz", "need 4–10 questions (aim for 5–8)");
  if (!Array.isArray(qs)) return { errors, warn };

  const kinds = new Set(qs.map((q) => q.kind));
  for (const k of REQUIRED_KINDS) if (!kinds.has(k)) err("quiz", `no "${k}" question; required kinds: ${REQUIRED_KINDS.join(", ")}`);

  const changed = changedFiles(quiz);
  if (!changed) warn.push(`could not diff origin/${quiz.base}...${quiz.sha}; skipped changed-file coverage`);

  const checkRef = (where, ref, maxLines) => {
    if (!ref?.path || !Number.isInteger(ref.from) || !Number.isInteger(ref.to)) return err(where, "needs {path, from, to}");
    const lines = fileAt(quiz.sha, ref.path);
    if (!lines) return err(where, `${ref.path} does not exist at ${quiz.sha.slice(0, 7)}`);
    if (ref.from < 1 || ref.to < ref.from || ref.to > lines.length) err(where, `${ref.path}#L${ref.from}-L${ref.to} out of range (file has ${lines.length} lines)`);
    if (ref.to - ref.from + 1 > maxLines) err(where, `${ref.path} range is ${ref.to - ref.from + 1} lines; cite at most ${maxLines}`);
  };

  let longestCorrect = 0;
  let citesChanged = 0;
  const seenPrompts = new Set();
  qs.forEach((q, i) => {
    const at = `q${i + 1}`;
    if (!KINDS[q.kind]) err(at, `kind must be one of ${Object.keys(KINDS).join(", ")}`);
    if (typeof q.q !== "string" || q.q.trim().length < 20) err(at, "q (the question) is missing or too short");
    else if (q.q.length > MAX.q) err(at, `q is ${q.q.length} chars; max ${MAX.q}`);
    if (typeof q.correct !== "string" || !q.correct.trim()) err(at, "missing correct");
    if (!Array.isArray(q.distractors) || q.distractors.length < 2 || q.distractors.length > 3) err(at, "need 2–3 distractors");
    if (typeof q.why !== "string" || q.why.trim().length < 40) err(at, "why must name the mechanism and the trap (≥ 40 chars)");
    else if (q.why.length > MAX.why) err(at, `why is ${q.why.length} chars; max ${MAX.why}. Let the diagram carry the flow`);
    if (!Array.isArray(q.evidence) || !q.evidence.length) err(at, "needs ≥ 1 evidence range");
    if (errors.some((e) => e.startsWith(`${at}:`))) return;
    lintDiagram(at, q.diagram, err);

    if (seenPrompts.has(norm(q.q))) err(at, "duplicate question");
    seenPrompts.add(norm(q.q));
    if (/```/.test(q.q) || /```/.test(q.why)) err(at, "no fenced blocks in q/why; put code in the `code` field");
    if (/\b(NOT|EXCEPT)\b/.test(q.q)) err(at, "negative stem (NOT/EXCEPT); ask for the true thing");

    const opts = [q.correct, ...q.distractors];
    if (new Set(opts.map(norm)).size !== opts.length) err(at, "options must be distinct");
    for (const o of opts) {
      if (/\b(all|none|both|neither) of (the )?(above|these|them)\b/i.test(o)) err(at, `banned option "${o}"`);
      if (o.length > MAX.option) err(at, `option is ${o.length} chars; max ${MAX.option}`);
    }
    if (norm(q.correct).length >= 15 && norm(q.q).includes(norm(q.correct))) err(at, "the question text contains the correct answer");

    const maxD = Math.max(...q.distractors.map((d) => d.length));
    if (q.correct.length > maxD * 1.5 && q.correct.length - maxD > 25) err(at, `length tell: correct is ${q.correct.length} chars, longest distractor ${maxD}`);
    if (q.correct.length > maxD) longestCorrect++;

    if (q.code) checkRef(`${at}.code`, q.code, 30);
    q.evidence.forEach((e, j) => checkRef(`${at}.evidence[${j}]`, e, 80));
    if (changed && [q.code, ...q.evidence].some((r) => r && changed.has(r.path))) citesChanged++;
  });

  if (qs.length >= 4 && longestCorrect > Math.ceil(qs.length / 2)) err("quiz", `the correct option is the longest in ${longestCorrect}/${qs.length} questions; trim it or lengthen distractors`);
  if (changed && citesChanged < Math.ceil(qs.length * 0.75)) err("quiz", `only ${citesChanged}/${qs.length} questions cite a file this PR changes; quiz the diff, not the neighborhood`);
  return { errors, warn };
}

function lintDiagram(at, d, err) {
  if (typeof d !== "string" || !d.trim()) return err(at, "needs a mermaid `diagram` that shows why the answer is right");
  const lines = d.trim().split("\n");
  const head = lines[0].trim();
  if (!/^(flowchart|graph) (TD|TB)\b|^sequenceDiagram\b|^stateDiagram-v2\b/.test(head)) err(at, `diagram starts "${head}"; use flowchart TD, sequenceDiagram or stateDiagram-v2 (LR overflows a phone)`);
  if (lines.length > MAX.diagramLines) err(at, `diagram has ${lines.length} lines; max ${MAX.diagramLines}`);
  if (/```/.test(d)) err(at, "diagram is raw mermaid, without a fence");
  for (const m of d.matchAll(/[[({|]"([^"]*)"[\])}|]|\[([^\]"]+)\]|\(([^)"]+)\)|\{([^}"]+)\}|\|([^|"]+)\|/g)) {
    const label = m.slice(1).find((g) => g !== undefined).replace(/^[([{]+|[)\]}]+$/g, "").trim();
    if (label.length > MAX.label) err(at, `diagram label "${label}" is ${label.length} chars; max ${MAX.label}`);
  }
  if (head.startsWith("sequenceDiagram")) {
    const parts = new Set();
    for (const l of lines.slice(1)) {
      const p = l.match(/^\s*(?:participant|actor)\s+(\S+)/);
      if (p) parts.add(p[1]);
      const msg = l.match(/^\s*(\S+?)\s*-[->x)]+\+?-?\s*(\S+?)\s*:\s*(.*)$/);
      if (msg) {
        parts.add(msg[1]);
        parts.add(msg[2]);
        if (msg[3].length > MAX.message) err(at, `diagram message "${msg[3]}" is ${msg[3].length} chars; max ${MAX.message}`);
      }
    }
    if (parts.size > MAX.participants) err(at, `sequence diagram has ${parts.size} participants; max ${MAX.participants}`);
  }
}

// Renders every diagram with the same Mermaid the page uses; a diagram GitHub can't parse would show as an error block.
async function checkDiagrams(htmlFile) {
  let chromium;
  try {
    ({ chromium } = await import(join(HERE, "../node_modules/playwright/index.mjs")));
  } catch {
    return { errors: [], warn: ["playwright not installed (npm i in the skill dir); diagrams not render-checked"] };
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlFile}`);
    await page.waitForFunction(() => window.__checkDiagrams, null, { timeout: 30000 });
    const res = await page.evaluate(() => window.__checkDiagrams());
    const errors = [];
    for (const r of res) {
      if (r.error) errors.push(`q${r.n}.diagram: mermaid cannot render it: ${r.error.split("\n")[0]}`);
      else if (r.width > MAX.diagramWidth) errors.push(`q${r.n}.diagram: ${Math.round(r.width)}px wide; max ${MAX.diagramWidth} or text shrinks unreadably on a phone`);
    }
    return { errors, warn: [] };
  } finally {
    await browser.close();
  }
}

function rng(seedStr) {
  let a = createHash("sha256").update(seedStr).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANG = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".jsx": "jsx", ".sql": "sql", ".md": "md", ".json": "json", ".yml": "yaml", ".yaml": "yaml", ".sh": "bash", ".py": "python", ".css": "css", ".hcl": "hcl" };

export function build(quiz) {
  const link = (r) => `https://github.com/${quiz.repo}/blob/${quiz.sha}/${r.path}#L${r.from}-L${r.to}`;
  const label = (r) => `${basename(r.path)}:${r.from}${r.to !== r.from ? `-${r.to}` : ""}`;
  // Spread answer letters evenly, then shuffle per question so position carries no signal.
  const qs = quiz.questions;
  const rand = rng(`${quiz.sha}:${quiz.pr}`);
  const slots = qs.map((q, i) => i % (q.distractors.length + 1));
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return qs.map((q, i) => {
    const n = q.distractors.length + 1;
    const answer = Math.min(slots[i], n - 1);
    const r = rng(`${quiz.sha}:${i}:${q.q}`);
    const ds = [...q.distractors];
    for (let k = ds.length - 1; k > 0; k--) {
      const j = Math.floor(r() * (k + 1));
      [ds[k], ds[j]] = [ds[j], ds[k]];
    }
    const options = [...ds.slice(0, answer), q.correct, ...ds.slice(answer)];
    const code = q.code
      ? { ...q.code, lang: LANG[extname(q.code.path)] ?? "", text: fileAt(quiz.sha, q.code.path).slice(q.code.from - 1, q.code.to).join("\n"), href: link(q.code), label: label(q.code) }
      : null;
    return {
      n: i + 1,
      kind: q.kind,
      kindLabel: KINDS[q.kind],
      q: q.q,
      code,
      options,
      answer,
      why: q.why,
      diagram: q.diagram.trim(),
      evidence: q.evidence.map((e) => ({ href: link(e), label: label(e) })),
    };
  });
}

const L = "ABCD";

function dedent(text) {
  const lines = text.split("\n");
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => l.slice(pad)).join("\n");
}

function hostedUrl(quiz) {
  const f = join(STORE, "public-url");
  return existsSync(f) ? `${readFileSync(f, "utf8").trim()}${quiz.repo}/${quiz.pr}/` : null;
}

export function markdown(quiz, items, url) {
  const out = [
    MARKER,
    `## Quiz: do you own this PR?`,
    "",
    `${url ? `**[Play it →](${url})** · ` : ""}${items.length} questions · pick before you open the answer · <sub>${quiz.sha.slice(0, 7)}</sub>`,
    "",
  ];
  for (const it of items) {
    out.push("---", "", `#### ${it.n} · ${it.kindLabel}`, "", `**${it.q}**`, "");
    if (it.code) {
      const fence = it.code.text.includes("```") ? "````" : "```";
      out.push(`<sub>[\`${it.code.label}\`](${it.code.href})</sub>`, "", `${fence}${it.code.lang}`, dedent(it.code.text), fence, "");
    }
    it.options.forEach((o, k) => out.push(`- **${L[k]}.** ${o}`));
    out.push(
      "",
      "<details><summary><b>Answer</b></summary>",
      "",
      `**${L[it.answer]}.** ${it.options[it.answer]}`,
      "",
      "```mermaid",
      it.diagram,
      "```",
      "",
      it.why,
      "",
      `<sub>${it.evidence.map((e) => `[\`${e.label}\`](${e.href})`).join(" · ")}</sub>`,
      "",
      "</details>",
      "",
    );
  }
  return out.join("\n");
}

export function html(quiz, items) {
  const tpl = readFileSync(join(HERE, "../templates/quiz.html"), "utf8");
  const data = JSON.stringify({ title: quiz.title, repo: quiz.repo, pr: quiz.pr, sha: quiz.sha, items }).replace(/</g, "\\u003c");
  return tpl.replace("/*__QUIZ__*/null", data).replace("__TITLE__", quiz.title.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;")));
}

function upsertComment(quiz, body, outDir) {
  const ids = sh("gh", [
    "api", `repos/${quiz.repo}/issues/${quiz.pr}/comments`, "--paginate",
    "--jq", `.[] | select(.body | startswith("${MARKER}")) | .id`,
  ]).split("\n").filter(Boolean);
  const payload = join(outDir, "comment.json");
  writeFileSync(payload, JSON.stringify({ body }));
  const res = ids.length
    ? sh("gh", ["api", "--method", "PATCH", `repos/${quiz.repo}/issues/comments/${ids[0]}`, "--input", payload])
    : sh("gh", ["api", "--method", "POST", `repos/${quiz.repo}/issues/${quiz.pr}/comments`, "--input", payload]);
  const c = JSON.parse(res);
  return { id: c.id, url: c.html_url, updated: ids.length > 0 };
}

async function main() {
  if (!["lint", "render", "post"].includes(cmd) || !quizPath) {
    console.error("usage: quiz.mjs lint|render|post <quiz.json> [outDir] [--dry-run] [--no-link] [--cwd=<repo>]");
    process.exit(2);
  }
  const quiz = JSON.parse(readFileSync(quizPath, "utf8"));
  const { errors, warn } = lint(quiz);
  for (const w of warn) console.error(`warn  ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`FAIL  ${e}`);
    process.exit(1);
  }
  console.error(`ok    ${quiz.questions.length} questions`);
  if (cmd === "lint") return;

  const outDir = resolve(outArg ?? dirname(resolve(quizPath)));
  mkdirSync(outDir, { recursive: true });
  const items = build(quiz);
  const pubDir = join(STORE, quiz.repo, String(quiz.pr));
  const md = markdown(quiz, items, flags["no-link"] ? null : hostedUrl(quiz));
  if (md.length > 60000) {
    console.error(`FAIL  comment is ${md.length} chars; GitHub caps comments at 65536. Shorten code excerpts.`);
    process.exit(1);
  }
  writeFileSync(join(outDir, "quiz.md"), md);
  const page = html(quiz, items);
  writeFileSync(join(outDir, "quiz.html"), page);
  const dg = await checkDiagrams(join(outDir, "quiz.html"));
  for (const w of dg.warn) console.error(`warn  ${w}`);
  if (dg.errors.length) {
    for (const e of dg.errors) console.error(`FAIL  ${e}`);
    process.exit(1);
  }
  mkdirSync(pubDir, { recursive: true });
  writeFileSync(join(pubDir, "quiz.html"), page);
  writeFileSync(join(pubDir, "quiz.json"), JSON.stringify(quiz, null, 2));
  console.log(join(outDir, "quiz.md"));
  console.log(join(outDir, "quiz.html"));
  console.log(`hosted ${hostedUrl(quiz) ?? `${pubDir} (no tunnel URL yet; start serve.mjs --tunnel)`}`);
  if (cmd !== "post" || flags["dry-run"]) return;
  const { id, url, updated } = upsertComment(quiz, md, outDir);
  writeFileSync(join(pubDir, "comment.json"), JSON.stringify({ repo: quiz.repo, id, url }));
  console.log(`${updated ? "updated" : "posted"} ${url}`);
}

await main();
