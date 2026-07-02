import { Effect, Stream } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export const WORKTREE_DIR = path.join(".opencode", "worktrees")

export type Isolation = {
  /** Absolute path of the isolated worktree. */
  directory: string
  /** Worktree path relative to the repo root (used in permission patterns). */
  relative: string
  branch: string
  /** Commit the worktree branched from, for detecting new commits. */
  base: string
}

export type FinishResult =
  | { removed: true }
  | { removed: false; dirtyFiles: number; commits: number }

const git = (spawner: ChildProcessSpawner["Service"], cwd: string, args: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, stdin: "ignore" }))
      const output = yield* Stream.runFold(
        Stream.decodeText(handle.all),
        () => "",
        (acc: string, chunk) => acc + chunk,
      )
      const code = yield* handle.exitCode
      return { code, output: output.trim() }
    }),
  ).pipe(
    Effect.mapError((error) => new Error(`git ${args.join(" ")} failed to run: ${String(error)}`)),
  )

const must = (spawner: ChildProcessSpawner["Service"], cwd: string, args: string[]) =>
  git(spawner, cwd, args).pipe(
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.succeed(result.output)
        : Effect.fail(new Error(`git ${args.join(" ")} exited with code ${result.code}:\n${result.output}`)),
    ),
  )

/** Best-effort: keep isolation worktrees out of `git status` in the main checkout. */
const exclude = (root: string) =>
  Effect.promise(async () => {
    const entry = WORKTREE_DIR.replaceAll("\\", "/") + "/"
    const file = path.join(root, ".git", "info", "exclude")
    try {
      const current = await fs.readFile(file, "utf-8").catch(() => "")
      if (current.split(/\r?\n/).includes(entry)) return
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.appendFile(file, (current.endsWith("\n") || current === "" ? "" : "\n") + entry + "\n")
    } catch {
      // .git may be a file (nested worktree) or read-only; isolation still works,
      // the worktree dir will just show as untracked.
    }
  })

export const create = Effect.fn("TaskWorktree.create")(function* (
  spawner: ChildProcessSpawner["Service"],
  input: { root: string; slug: string },
) {
  const base = yield* must(spawner, input.root, ["rev-parse", "HEAD"]).pipe(
    Effect.mapError(
      () =>
        new Error(
          "isolation: \"worktree\" requires the project to be a git repository with at least one commit",
        ),
    ),
  )
  const relative = path.join(WORKTREE_DIR, input.slug)
  const directory = path.join(input.root, relative)
  const branch = `opencode/task/${input.slug}`
  yield* exclude(input.root)
  yield* must(spawner, input.root, ["worktree", "add", directory, "-b", branch])
  return { directory, relative, branch, base } satisfies Isolation
})

/**
 * Inspect the worktree after the task finishes. A clean worktree with no new
 * commits is removed (and its branch deleted); anything else is kept so the
 * parent can merge or inspect it.
 */
export const finish = Effect.fn("TaskWorktree.finish")(function* (
  spawner: ChildProcessSpawner["Service"],
  isolation: Isolation,
  root: string,
) {
  const status = yield* git(spawner, isolation.directory, ["status", "--porcelain"])
  const head = yield* git(spawner, isolation.directory, ["rev-parse", "HEAD"])
  const dirtyFiles = status.code === 0 && status.output ? status.output.split("\n").length : 0
  const commits =
    head.code === 0 && head.output !== isolation.base
      ? yield* git(spawner, isolation.directory, ["rev-list", "--count", `${isolation.base}..HEAD`]).pipe(
          Effect.map((result) => (result.code === 0 ? Number(result.output) || 0 : 1)),
        )
      : 0

  if (dirtyFiles === 0 && commits === 0 && status.code === 0 && head.code === 0) {
    yield* git(spawner, root, ["worktree", "remove", "--force", isolation.directory])
    yield* git(spawner, root, ["branch", "-D", isolation.branch])
    return { removed: true } satisfies FinishResult
  }
  return { removed: false, dirtyFiles, commits } satisfies FinishResult
})

export function prompt(isolation: Isolation, root: string) {
  return [
    "<system-reminder>",
    `You are working in an ISOLATED git worktree: ${isolation.directory} (branch ${isolation.branch}).`,
    `- Do ALL file reads and edits inside that directory, using absolute paths under it.`,
    `- Pass workdir="${isolation.directory}" on every bash/shell command. Never operate on the main checkout at ${root}.`,
    "- Edits outside the worktree are denied by permissions.",
    "- When you finish, commit your changes on the branch with a clear message. If you made no changes, leave the tree clean.",
    "</system-reminder>",
  ].join("\n")
}

export function report(isolation: Isolation, result: FinishResult) {
  if (result.removed) {
    return "The isolated worktree was removed because the task left no changes."
  }
  return [
    `The task's changes are in an isolated worktree, NOT in the main checkout:`,
    `- path: ${isolation.directory}`,
    `- branch: ${isolation.branch} (${result.commits} commit(s), ${result.dirtyFiles} uncommitted file(s))`,
    `To use the changes, merge or cherry-pick the branch (e.g. \`git merge ${isolation.branch}\`), then remove the worktree with \`git worktree remove ${isolation.directory}\`.`,
  ].join("\n")
}

export * as TaskWorktree from "./task-worktree"
