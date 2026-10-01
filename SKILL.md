---
name: pr-quiz
description: Write a short multiple-choice quiz that checks whether a reader actually understands a pull request's code (where each piece runs, how it is wired, why it is shaped this way, how it behaves on a concrete scenario, and its known issues), with a Mermaid diagram in every answer. Lint it, host it as a phone-friendly page and post it as one updatable PR comment whose hidden answers link to the exact lines. Use right after opening or substantially updating a PR, or when asked to quiz someone on a PR or diff.
allowed-tools: Read, Write, Bash, Glob, Grep
---

**Arguments:** `$ARGUMENTS`: a PR number or URL. Defaults to the current branch's PR.

AI-written code gets merged unread. The quiz makes the reader commit to answers about the code itself, read on a phone in a few minutes. It works only if a skimmer gets it wrong and a reader gets it right. Keep it short: a terse question, one-line options, an answer that is a diagram plus one or two sentences.

## Gather

1. `gh pr view <pr> --json number,title,body,baseRefName,headRefOid,url,files`, then `git fetch origin <base> <headRefOid>`.
2. Read the diff (`git diff origin/<base>...<headRefOid>`), each changed file in full (`git show <sha>:<path>`; never check out the head) and one hop of callers and callees. If you wrote the PR, recall the alternatives you rejected and the edges you left open. If you didn't, use the alternatives the description names, or the next most obvious design.
3. For every changed piece, note the process it runs in (Electron main, preload, renderer, backend API, queue worker, sandbox, migration, CI) and the boundary data crosses (tRPC, IPC, queue, DB, HTTP).

## Choose 5–7 questions

Pick the few things someone must hold in their head to own this code, at most one question per idea. Kinds can repeat; each required kind appears at least once.

| kind | asks | distractors | diagram |
|---|---|---|---|
| `runtime` (required) | Which process runs this; what crosses which boundary? | The neighbouring process, a step this PR moved | `flowchart TD` with one subgraph per process |
| `architecture` (required) | Who owns the behaviour, the call order, where state lives | The module that looks responsible, the old path | `flowchart TD` of the call path |
| `decision` (required) | Why this over the obvious alternative; what forced it | The rejected alternatives, stated fairly | `flowchart TD` that forks into the chosen and the rejected branch, each ending in its consequence |
| `behavior` | Given X while Y, what happens? | Pre-PR behaviour, the happy-path assumption | `sequenceDiagram` of the scenario |
| `failure` (required) | What is still unhandled; what breaks if an invariant fails | Failures the code does handle | `flowchart TD` with the gap path marked |
| `contract` | Which invariant, test, flag or compatibility rule protects this | A guard that defends something else | `stateDiagram-v2` or `sequenceDiagram` |

The diagram column is a preference: use whichever form fits in the width limit.

Prefer `behavior` and `failure`: predicting an outcome forces reading the code. A `failure` question tells the truth: ask about the real gap, or else the boundary case most likely to be misread. A question may hinge on unchanged code that the change relies on, but its evidence includes the changed lines.

## Write

- **`q`** ≤ 180 chars: a concrete situation with real identifiers in backticks. "A cancelled one-off event has a meeting. What does the next sync do?", not "What does the sync service do?". Attach `code` (≤ 30 lines at the SHA) only when the question is about reading those lines; the script embeds the real source.
- **Options** ≤ 90 chars each, 3–4 of them in parallel form and of similar length. Every distractor is a belief a smart skimmer would hold. Write `correct` and `distractors` separately; the script shuffles.
- **`diagram`** (required): raw Mermaid without a fence that shows *why* the answer is right. Mark the deciding step `:::hit` and add `classDef hit stroke:#e8590c,stroke-width:3px` (or a `Note` in a sequence).
  - `flowchart TD`, `sequenceDiagram` or `stateDiagram-v2`; never LR, which overflows a phone.
  - ≤ 14 lines, labels ≤ 32 chars, ≤ 4 participants, messages ≤ 40 chars.
  - Width (≤ 640 px rendered) is the limit that binds. Sequence diagrams fit 2–3 participants with messages of about 20 chars. A flowchart fits 2 parallel branches with one node each before they rejoin. When a flow won't fit, make it a vertical chain.
  - Quote any label that contains punctuation: `A["recoverBody()"]`.
- **`why`** ≤ 260 chars: the mechanism in one sentence, the trap behind the most tempting distractor in another. The diagram carries the flow, so don't narrate it.
- **`evidence`**: `{path, from, to}` ranges at the SHA (≤ 80 lines) that prove the answer.
- **Banned**: trivia (names, counts, file names), anything answerable from general knowledge or the PR title, "all/none/both of the above", NOT/EXCEPT stems, and a correct answer that is the longest or most hedged option.
- **Self-check**: if the PR description alone answers it, rewrite it until the code is needed (code comments count as code). If the description covers the headline, ask about its consequences: the implied edge, the misleading field, the hidden fallback.

Write it outside the repo, e.g. `/tmp/pr-quiz/<pr>/quiz.json`:

```json
{
  "repo": "owner/name", "pr": 123, "base": "staging", "sha": "<40-char headRefOid>",
  "title": "<PR title>",
  "questions": [
    {
      "kind": "behavior",
      "q": "Job crashes after the tombstone, before `detach`. What does the retry hand off?",
      "code": { "path": "src/a.ts", "from": 10, "to": 28 },
      "correct": "…", "distractors": ["…", "…", "…"],
      "diagram": "sequenceDiagram\n  participant W as Worker\n  participant DB\n  W->>DB: tombstone occurrence\n  Note over W: crash\n  W->>DB: retry finds undetached\n  W->>W: detach once",
      "why": "Mechanism. Trap.",
      "evidence": [{ "path": "src/a.ts", "from": 10, "to": 28 }]
    }
  ]
}
```

## Render and post

Run from inside the checkout (`<skill-dir>` is this skill's folder):

```bash
node <skill-dir>/scripts/quiz.mjs render /tmp/pr-quiz/<pr>/quiz.json   # lint + render-check diagrams + publish page
node <skill-dir>/scripts/quiz.mjs post   /tmp/pr-quiz/<pr>/quiz.json   # same, then create or update the PR comment
```

Both fail when:
- a required kind is missing;
- a length limit above is exceeded;
- a diagram doesn't render or is wider than 640 px;
- evidence doesn't exist at the SHA;
- under 75% of questions cite a changed file;
- the correct option is more than 1.5× and more than 25 chars longer than the longest distractor, or is the longest option in over half the questions;
- the stem contains the answer, or a banned form appears.

Fix the quiz, never the linter.

`post` keeps one comment per PR, marked `<!-- pr-quiz:v1 -->`, and edits it on re-runs. Re-run after a push only if the push changes behaviour. The comment has a **Play it →** link to the hosted page, then each question with its answer in a collapsed block: the answer line, the diagram (GitHub renders Mermaid), the why, and line permalinks.

**Hosting.** Each render publishes `quiz.html` to `~/.local/share/pr-quiz/<owner>/<repo>/<pr>/`. The `pr-quiz` systemd user service runs `scripts/serve.mjs --tunnel`, which serves that store behind a secret token through a Cloudflare quick tunnel and lists every quiz at the token root. Scores are saved per device. The current URL is in `~/.local/share/pr-quiz/public-url`. When the tunnel restarts, the service rewrites the link in every posted comment. If the page is down, run `systemctl --user restart pr-quiz` and check `~/.local/share/pr-quiz/tunnel.log`. `--no-link` posts without the link.

Report the comment URL in one line. Never post on someone else's PR unless asked.
