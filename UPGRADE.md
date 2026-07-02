# Fork: Harness Upgrade (fable-harness)

Goal: bring opencode's *harness* — system prompt, operating principles, tools,
subagents, context and memory — as close as possible to Claude Code quality,
tuned for **non-Claude backend models** (GPT / Gemini / local OSS), which need
more explicit scaffolding, not less.

Baseline: upstream `anomalyco/opencode` v1.17.13 (synced 2026-07-02).
All findings below were verified against that tree; paths are relative to
`packages/opencode/src/`.

**Status: complete — all phases merged into `dev`** (PRs #1, #2, #3, 2026-07-02),
live-validated end-to-end against `ollama-cloud/kimi-k2.7-code`. The section
headings below say "shipped on this branch" for historical accuracy; read them
as "merged to dev." User-facing docs are updated in
`packages/web/src/content/docs/` (config, tools, agents, rules). The only
remaining architectural gap is hard-forcing bash cwd inside isolated worktrees
(Phase 3.4 note).

---

## Live validation (2026-07-02, `ollama-cloud/kimi-k2.7-code`)

The whole feature set was smoke-tested end-to-end against a real non-Claude
model via `opencode run`. All five scenarios passed: basic tool loop;
background shell + `bash_output`; subagent with `output_schema`; worktree
isolation (child committed on `opencode/task/*`, main checkout untouched);
todo persistence across a multi-step task. The run surfaced five real issues
that only appear with a weaker model — all fixed and unit-tested:

1. `task.ts` passed a plain object as `format`; downstream validation needs a
   real `OutputFormatJsonSchema` instance.
2. **Upstream bug:** `session/llm/request.ts:resolveTools` filtered out the
   host-injected `StructuredOutput` tool for deny-by-default agents
   (explore/oracle), so structured output silently never worked for them.
   Now exempted.
3. Providers that ignore `toolChoice:"required"` (ollama-cloud) need the schema
   requirement restated in the prompt — added to the subagent preamble.
4. A too-low `compaction.threshold` caused an infinite compaction doom loop;
   the value is now floored at 0.5 (`overflow.ts`).
5. `todowrite` required `priority`, which weaker models routinely omit; the
   tool boundary now defaults it to "medium" (stored `Todo.Info` unchanged).

---

## Verified current state (what upstream already has)

Upstream closed several gaps during 2026 — these need no fork work, only
awareness (some are hidden behind env flags):

| Capability | Status | How to enable |
|---|---|---|
| Skills (Claude-Code compatible `SKILL.md`, incl. `~/.claude/skills`) | shipped, on by default | `skill/index.ts:173-233`, config `skills.paths` / `skills.urls` |
| Plan mode v2 (plan file, explore fan-out, `plan_exit` tool) | flag-gated | `OPENCODE_EXPERIMENTAL_PLAN_MODE` (`session/reminders.ts:70-89`) |
| Background subagents + task resume (`task_id`) | flag-gated | `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` (`tool/task.ts:97-102`) |
| LSP tool (definition/references/symbols/call-hierarchy) | flag-gated, no diagnostics op | `OPENCODE_EXPERIMENTAL_LSP_TOOL` (`registry.ts:233`) |
| AskUserQuestion equivalent (`question` tool) | gated to app/desktop | `OPENCODE_ENABLE_QUESTION_TOOL` (`registry.ts:195,220`) |
| Web search (Exa / Parallel backends) | gated to opencode provider | `OPENCODE_ENABLE_EXA` or `OPENCODE_ENABLE_PARALLEL` (`registry.ts:55-57`) |
| Tool-output pruning of old results | **off by default** | config `compaction.prune: true` (`session/compaction.ts:243-287`) |
| Compaction tuning | shipped | config `compaction.{auto,tail_turns,preserve_recent_tokens,reserved}` |
| Nested AGENTS.md attach-on-read | shipped | `session/instruction.ts:179-221` |
| Structured output (JSON schema per message) | shipped | `session/prompt.ts:1242-1248` |

Fork defaults (on out of the box, no env setup needed):

- **LSP tool** — opt out with `OPENCODE_DISABLE_LSP_TOOL`
- **Web search** (all providers) — opt out with `OPENCODE_DISABLE_WEBSEARCH`
- **Background subagents** (+ task background/output_schema/isolation params) —
  opt out with `OPENCODE_DISABLE_BACKGROUND_SUBAGENTS`
- **Tool-output pruning** (`compaction.prune`) — opt out with config
  `compaction.prune: false`
- **Question tool** — already on for the CLI/app/desktop clients upstream

Still opt-in (an interaction *mode*, enable per your preference):

```sh
export OPENCODE_EXPERIMENTAL_PLAN_MODE=true   # plan-mode v2 for the plan agent
```

---

## Phase 1 — shipped on this branch

### 1. Shared operating-principles layer (all providers)

Problem: behavioral quality is wildly uneven per provider prompt.
`codex.txt` (gpt-codex) has tool preambles, root-cause discipline and
lead-with-outcome answers; `default.txt` (all unknown/local models),
`kimi.txt` and `trinity.txt` lack autonomy/persistence, root-cause and
verification discipline. There was **no shared principles block** — the
provider `.txt` was the only behavioral surface
(`session/llm/request.ts:58-66`).

Fix: `session/prompt/principles.txt`, injected for every provider and agent
(except internal `compaction`/`title`/`summary` agents) as the first entry of
the shared `system` array in `session/prompt.ts` (assembly seam, ~line 1263).
Covers: persistence until resolved, narration/tool preambles, parallel tool
batching, root-cause discipline, verification-before-done, lead-with-outcome
communication, scope discipline, memory maintenance.

Escape hatch: `OPENCODE_DISABLE_SHARED_PRINCIPLES=true`
(`effect/runtime-flags.ts`).

### 2. Stronger default (unknown-model) prompt

`session/prompt/default.txt` is what every local/OSS model gets. It enforced
extreme brevity ("fewer than 4 lines", "one word answers are best") which
suppresses outcome reporting after multi-step work, and had no persistence or
root-cause sections. Reworked to: terse for simple Q&A, brief outcome summary
after multi-step work, plus persistence + root-cause sections.

### 3. Per-turn todo re-injection

The todo list was write-only context: after `todowrite`, the list scrolled out
of attention and was never re-surfaced (verified: `session/reminders.ts` only
injected plan/build-switch texts). Now `SessionReminders.apply` appends a
`<system-reminder>` with the current todo list (when non-empty and not fully
completed) to the last user message each turn — mirroring Claude Code's todo
reminders.

### 4. Persistent cross-session memory (file-based)

Upstream has **no** memory that survives a session. Added the minimal robust
version, Claude-Code style:

- `~/.config/opencode/MEMORY.md` (global) and `<worktree>/.opencode/MEMORY.md`
  (per-project) are auto-loaded into the system prompt when present
  (`session/instruction.ts` `systemPaths()`).
- `principles.txt` instructs the model to maintain these files with normal
  edit/write tools when the user shares durable preferences, decisions or
  corrections.

No new tools, no schema — plain files the user can read and edit.

---

## Phase 2 — shipped on branch `fable-harness-phase2`

1. **Structured subagent output** — `task` tool now accepts `output_schema`
   (JSON Schema). The subagent run is forced through the existing
   StructuredOutput machinery (`format: json_schema` on the child prompt) and
   the task result is the typed JSON object; a subagent that fails to produce
   schema-conformant output fails the task with the last text attached
   (`tool/task.ts`).
2. **Background shell** — `background: true` param on the `bash` tool starts
   the command as a BackgroundJob and returns a `shell_id` immediately; new
   `bash_output` tool serves incremental reads (delta since last call) and
   `kill: true` termination. Output buffers are capped at 2 MB per shell / 32
   shells with tail-eviction (`tool/shell.ts`, `tool/shell-output.ts`). Tests
   in `test/tool/shell.test.ts` ("tool.shell background").
3. **LSP on by default + diagnostics** — LSP tool no longer gated behind
   `OPENCODE_EXPERIMENTAL_LSP_TOOL`; opt out with `OPENCODE_DISABLE_LSP_TOOL`.
   New `diagnostics` operation returns current errors/warnings for a file
   (pull-based via `LSP.Service.diagnostics()`); `line`/`character` are now
   optional and validated per-operation (`tool/lsp.ts`, `tool/registry.ts`).
4. **Web search for every provider** — the opencode-provider gate is gone
   (both Exa and Parallel MCP endpoints are public; keys optional via
   `EXA_API_KEY` / `PARALLEL_API_KEY`). Opt out with
   `OPENCODE_DISABLE_WEBSEARCH`; backend override still
   `OPENCODE_WEBSEARCH_PROVIDER` (`tool/registry.ts:webSearchEnabled`).
5. **Oracle subagent** — read-only, adversarial reviewer/verifier agent
   (grep/glob/read/bash/webfetch/websearch/lsp, no edits) with a
   refute-by-default prompt (`agent/agent.ts`, `agent/prompt/oracle.txt`).
6. **Parallel fan-out guidance** — `principles.txt` gained a "Delegate and fan
   out" section (concurrent task calls, self-contained subagent prompts,
   delegate noisy exploration); `task.txt` documents `output_schema` (note 8).

## Phase 3 — context & lifecycle

1. **Soft compaction threshold — shipped.** `compaction.threshold` config
   (default 0.9): auto-compaction triggers at that fraction of the usable
   window instead of the hard ceiling (`session/overflow.ts`,
   `core/v1/config/config.ts`).
2. **Structured compaction — shipped (fork delta only).** Upstream's
   `buildPrompt` already emits a sectioned template (Goal / Progress / Key
   Decisions / Next Steps / Relevant Files) — the original audit predated it.
   The fork adds the missing piece: the live todo list is read from the todo
   store and injected into the compaction prompt as authoritative context, so
   open work survives the boundary even when todowrite outputs were pruned
   (`session/compaction.ts`).
3. **Hooks — shipped.** Config-declared shell-command hooks (`hooks` in
   opencode.json), Claude-Code style, no JS plugin needed. Implemented as the
   built-in `ConfigHooksPlugin` layered on the existing plugin trigger seams:
   `tool.execute.before` (exit code 2 blocks the call, stderr goes to the
   model), `tool.execute.after` (stdout appended to tool output), `event`
   (fire-and-forget on bus events). Each command gets a JSON payload on stdin;
   `matcher` is a regex on tool id / event type; per-hook `timeout` (default
   60s). Files: `core/v1/config/hooks.ts`, `opencode/src/plugin/config-hooks.ts`,
   tests in `test/plugin/config-hooks.test.ts`.
4. **Worktree isolation for subagents — shipped.** `isolation: "worktree"` on
   the task tool runs the subagent against a fresh git worktree at
   `.opencode/worktrees/task-<id>` (branch `opencode/task/<id>`,
   auto-added to `.git/info/exclude`). Enforcement is two-layered:
   - **Permissions (hard):** the child session gets `edit: deny *` +
     `edit: allow <worktree>/*` appended last — `Permission.evaluate` is
     last-match-wins, so edit/write/patch outside the worktree are denied.
   - **Prompt (steering):** a preamble tells the subagent its working
     directory, to use absolute paths under it, and to pass
     `workdir=<worktree>` on shell commands (bash cwd cannot be hard-forced
     without instance surgery — the honest remaining gap; see below).
   On completion (foreground or background) the worktree is inspected: clean →
   removed and branch deleted; dirty or committed → kept, and the task output
   gains a `<task_worktree>` block with path, branch, and change counts so the
   parent can merge. Files: `tool/task-worktree.ts`, `tool/task.ts`; tests in
   `test/tool/task-worktree.test.ts`.
   Known limitation: shell commands that ignore the prompt's `workdir`
   instruction still run in the main checkout's cwd; fixing that requires the
   session-scoped cwd override through `InstanceState` (instance-per-worktree),
   left as the one remaining architectural follow-up.

---

## Dead code found while auditing (upstream cleanup candidates)

- `session/prompt/plan-reminder-anthropic.txt` — never imported.
- `tool/plan-enter.txt` — no PlanEnterTool exists; `plan_enter` is only a
  permission key.
- `experimental.batch_tool` config field — the batch tool was deleted; the
  option has zero consumers.
- `session/prompt/copilot-gpt-5.txt` — never imported.
