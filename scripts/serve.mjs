#!/usr/bin/env node
// Serves every published quiz under a secret path; with --tunnel, also runs a Cloudflare quick tunnel
// and records its public URL in <store>/public-url for quiz.mjs to link from PR comments.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const STORE = process.env.PR_QUIZ_HOME ?? join(homedir(), ".local/share/pr-quiz");
const PORT = Number(process.env.PR_QUIZ_PORT ?? 8790);
const tokenFile = join(STORE, ".token");
if (!existsSync(tokenFile)) {
  (await import("node:fs")).mkdirSync(STORE, { recursive: true });
  writeFileSync(tokenFile, randomBytes(18).toString("base64url"), { mode: 0o600 });
}
const TOKEN = readFileSync(tokenFile, "utf8").trim();

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function listQuizzes() {
  const out = [];
  for (const owner of safeDir(STORE)) for (const repo of safeDir(join(STORE, owner))) for (const pr of safeDir(join(STORE, owner, repo))) {
    const dir = join(STORE, owner, repo, pr);
    try {
      const q = JSON.parse(readFileSync(join(dir, "quiz.json"), "utf8"));
      out.push({ path: `${owner}/${repo}/${pr}/`, title: q.title, repo: q.repo, pr: q.pr, sha: q.sha, n: q.questions.length, mtime: statSync(join(dir, "quiz.html")).mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function safeDir(d) {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
}

function indexPage() {
  const rows = listQuizzes().map((q) => `
    <a class="row" href="${esc(q.path)}" data-key="${esc(`pr-quiz:${q.repo}#${q.pr}@${q.sha}`)}" data-n="${q.n}">
      <span class="t">${esc(q.title)}</span>
      <span class="m">${esc(q.repo)}#${q.pr} · ${q.n} questions · ${new Date(q.mtime).toISOString().slice(0, 10)}<b class="s"></b></span>
    </a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>PR quizzes</title><style>
:root{--bg:#f6f4ef;--card:#fffdf8;--ink:#1d1b16;--soft:#6b665b;--line:#e4dfd3;--ok:#1f7a5a}
@media (prefers-color-scheme:dark){:root{--bg:#15161a;--card:#1d1f24;--ink:#ecebe6;--soft:#9a988f;--line:#2d3037;--ok:#5fd0a3}}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.45 Inter,ui-sans-serif,system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 20px}
.row{display:flex;flex-direction:column;gap:4px;padding:16px;margin-bottom:10px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);text-decoration:none}
.t{font-weight:600}.m{font-size:14px;color:var(--soft)}.s{color:var(--ok);margin-left:6px}
</style></head><body><main><h1>PR quizzes</h1>${rows || "<p>No quizzes yet.</p>"}</main>
<script>document.querySelectorAll(".row").forEach(r=>{try{const p=JSON.parse(localStorage.getItem(r.dataset.key)||"null");if(p&&p.done){const s=r.querySelector(".s");s.textContent="· scored "+p.right+"/"+r.dataset.n;if(p.right<+r.dataset.n)s.style.color="var(--soft)"}}catch{}})</script>
</body></html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  const send = (code, body, type = "text/html; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" });
    res.end(body);
  };
  if (parts[0] !== TOKEN) return send(404, "not found", "text/plain");
  if (parts.length === 1) {
    if (!url.pathname.endsWith("/")) return res.writeHead(301, { location: `/${TOKEN}/` }).end();
    return send(200, indexPage());
  }
  if (parts.length === 4 && parts.slice(1).every((p) => /^[\w.-]+$/.test(p) && p !== ".." && p !== ".")) {
    if (!url.pathname.endsWith("/")) return res.writeHead(301, { location: `${url.pathname}/` }).end();
    const file = join(STORE, parts[1], parts[2], parts[3], "quiz.html");
    if (existsSync(file)) return send(200, readFileSync(file));
  }
  send(404, "not found", "text/plain");
});
server.listen(PORT, "127.0.0.1", () => console.log(`local  http://127.0.0.1:${PORT}/${TOKEN}/`));

// Quick-tunnel hostnames change on every restart; keep links in already-posted quiz comments alive.
function relinkComments(base) {
  const gh = process.env.GH_BIN ?? "/usr/bin/gh";
  for (const q of listQuizzes()) {
    try {
      const { repo, id } = JSON.parse(readFileSync(join(STORE, q.path, "comment.json"), "utf8"));
      const body = execFileSync(gh, ["api", `repos/${repo}/issues/comments/${id}`, "--jq", ".body"], { encoding: "utf8" }).replace(/\n$/, "");
      const next = body.replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\/[\w-]+\//g, base);
      if (next === body) continue;
      const payload = join(STORE, q.path, "relink.json");
      writeFileSync(payload, JSON.stringify({ body: next }));
      execFileSync(gh, ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${id}`, "--input", payload], { stdio: "ignore" });
      console.log(`relinked ${repo}#${q.pr}`);
    } catch (e) {
      if (e.code !== "ENOENT") console.error(`relink ${q.path}: ${e.message.split("\n")[0]}`);
    }
  }
}

if (process.argv.includes("--tunnel")) {
  const bin = process.env.CLOUDFLARED ?? join(homedir(), ".local/bin/cloudflared");
  const start = () => {
    const cf = spawn(bin, ["tunnel", "--no-autoupdate", "--protocol", process.env.PR_QUIZ_TUNNEL_PROTOCOL ?? "http2", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
    const onData = (buf) => {
      appendFileSync(join(STORE, "tunnel.log"), buf);
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !m[0].startsWith("https://api.")) {
        writeFileSync(join(STORE, "public-url"), `${m[0]}/${TOKEN}/\n`, { mode: 0o600 });
        console.log(`public ${m[0]}/${TOKEN}/`);
        relinkComments(`${m[0]}/${TOKEN}/`);
      }
    };
    cf.stdout.on("data", onData);
    cf.stderr.on("data", onData);
    cf.on("exit", (code) => {
      console.error(`cloudflared exited (${code}); restarting in 5s`);
      setTimeout(start, 5000);
    });
  };
  start();
}
