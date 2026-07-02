# Fork: Harness Upgrade (fable-harness)

Goal: bring opencode's *harness* — system prompt, operating principles, tools,
subagents, context and memory — as close as possible to Claude Code quality,
tuned for **non-Claude backend models** (GPT / Gemini / local OSS), which need
more explicit scaffolding, not less.

Baseline: upstream `anomalyco/opencode` v1.17.13 (synced 2026-07-02).
All findings below were verified against that tree; paths are relative to
`packages/opencode/src/`.

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

Recommended baseline env for this fork's users:

```sh
export OPENCODE_EXPERIMENTAL_PLAN_MODE=true
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
export OPENCODE_EXPERIMENTAL_LSP_TOOL=true
export OPENCODE_ENABLE_QUESTION_TOOL=true
```

and in `opencode.json`:

```json
{ "compaction": { "prune": true } }
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

## Phase 2 — planned (tools & subagents)

1. **Structured subagent output** — thread the existing json_schema/
   StructuredOutput machinery (`session/prompt.ts:1242-1248`) through
   `tool/task.ts` so a parent can request typed results instead of parsing the
   subagent's last text part (`task.ts:199`).
2. **Background shell** — `run_in_background` param on `tool/shell.ts` +
   an output-polling tool, reusing `background/job.ts` (currently used only by
   TaskTool).
3. **Un-gate LSP tool by default** in the fork and add a `diagnostics`
   operation (`tool/lsp.ts:11-21` has 9 ops but no diagnostics).
4. **Pluggable web search** — relax the provider gate (`registry.ts:55-57`,
   `268-270`) to allow any configured search backend.
5. **Oracle/reviewer subagent** — a read-only high-reasoning verification
   agent alongside build/plan/general/explore (`agent/agent.ts:140-265`).
6. **Parallel fan-out guidance** — provider prompts + task.txt should state
   that multiple `task` calls in one message run concurrently.

## Phase 3 — planned (context & lifecycle)

1. **Soft compaction threshold** — `session/overflow.ts:22-34` triggers only
   at the hard ceiling; add `compaction.threshold` (e.g. 0.85) so compaction
   runs with headroom.
2. **Structured compaction** — preserve files-touched / decisions / open todos
   as distinct sections across the boundary (`session/compaction.ts`).
3. **Hooks** — pre/post tool-call and session lifecycle hooks beyond the
   current plugin seams.
4. **Worktree isolation for subagents** — absent upstream (verified); build on
   `snapshot/`.

---

## Dead code found while auditing (upstream cleanup candidates)

- `session/prompt/plan-reminder-anthropic.txt` — never imported.
- `tool/plan-enter.txt` — no PlanEnterTool exists; `plan_enter` is only a
  permission key.
- `experimental.batch_tool` config field — the batch tool was deleted; the
  option has zero consumers.
- `session/prompt/copilot-gpt-5.txt` — never imported.
