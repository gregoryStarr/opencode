import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import { execSync } from "node:child_process"
import { TaskWorktree } from "../../src/tool/task-worktree"
import { testEffect } from "../lib/effect"

const layer = Layer.mergeAll(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node])))
const it = testEffect(layer)

async function scratchRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-worktree-"))
  execSync("git init -q -b main", { cwd: root })
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: root })
  return root
}

describe("task worktree isolation", () => {
  it.live("creates a worktree and removes it when clean", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(scratchRepo)
      const spawner = yield* ChildProcessSpawner
      const isolation = yield* TaskWorktree.create(spawner, { root, slug: "clean" })
      expect(isolation.directory).toBe(path.join(root, ".opencode", "worktrees", "clean"))
      expect(isolation.branch).toBe("opencode/task/clean")
      const stat = yield* Effect.promise(() => fs.stat(isolation.directory))
      expect(stat.isDirectory()).toBe(true)

      const result = yield* TaskWorktree.finish(spawner, isolation, root)
      expect(result.removed).toBe(true)
      const gone = yield* Effect.promise(() =>
        fs.stat(isolation.directory).then(
          () => false,
          () => true,
        ),
      )
      expect(gone).toBe(true)
      // Branch deleted too.
      const branches = execSync("git branch --list 'opencode/task/*'", { cwd: root }).toString()
      expect(branches.trim()).toBe("")
    }),
  )

  it.live("keeps a dirty worktree and reports changes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(scratchRepo)
      const spawner = yield* ChildProcessSpawner
      const isolation = yield* TaskWorktree.create(spawner, { root, slug: "dirty" })
      yield* Effect.promise(() => fs.writeFile(path.join(isolation.directory, "new.txt"), "hello"))

      const result = yield* TaskWorktree.finish(spawner, isolation, root)
      expect(result.removed).toBe(false)
      if (!result.removed) {
        expect(result.dirtyFiles).toBe(1)
        expect(result.commits).toBe(0)
      }
      const stat = yield* Effect.promise(() => fs.stat(isolation.directory))
      expect(stat.isDirectory()).toBe(true)
      expect(TaskWorktree.report(isolation, result)).toContain(isolation.branch)
    }),
  )

  it.live("keeps a worktree with new commits", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(scratchRepo)
      const spawner = yield* ChildProcessSpawner
      const isolation = yield* TaskWorktree.create(spawner, { root, slug: "committed" })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(isolation.directory, "done.txt"), "done")
        execSync("git add . && git -c user.email=t@t -c user.name=t commit -q -m work", { cwd: isolation.directory })
      })

      const result = yield* TaskWorktree.finish(spawner, isolation, root)
      expect(result.removed).toBe(false)
      if (!result.removed) expect(result.commits).toBe(1)
    }),
  )

  it.live("fails clearly outside a git repository", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "task-nogit-")))
      const spawner = yield* ChildProcessSpawner
      const exit = yield* TaskWorktree.create(spawner, { root, slug: "x" }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.live("adds the worktree dir to git info/exclude", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(scratchRepo)
      const spawner = yield* ChildProcessSpawner
      yield* TaskWorktree.create(spawner, { root, slug: "excluded" })
      const exclude = yield* Effect.promise(() => fs.readFile(path.join(root, ".git", "info", "exclude"), "utf-8"))
      expect(exclude).toContain(".opencode/worktrees/")
      // The parent repo status stays clean despite the worktree living inside it.
      const status = execSync("git status --porcelain", { cwd: root }).toString()
      expect(status.trim()).toBe("")
    }),
  )
})
