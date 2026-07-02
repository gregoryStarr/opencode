import { describe, expect, test } from "bun:test"
import os from "os"
import type { PluginInput } from "@opencode-ai/plugin"
import { ConfigHooksPlugin, matchHook, runHookCommand } from "../../src/plugin/config-hooks"

const input = { worktree: os.tmpdir(), directory: os.tmpdir() } as PluginInput

async function load(hooks: unknown) {
  const plugin = await ConfigHooksPlugin(input)
  await plugin.config!({ hooks } as never)
  return plugin
}

describe("config-hooks matcher", () => {
  test("matches everything when omitted", () => {
    expect(matchHook(undefined, "bash")).toBe(true)
  })

  test("matches by regex", () => {
    expect(matchHook("^(bash|edit)$", "bash")).toBe(true)
    expect(matchHook("^(bash|edit)$", "read")).toBe(false)
  })

  test("invalid regex never matches", () => {
    expect(matchHook("(", "bash")).toBe(false)
  })
})

describe("config-hooks runner", () => {
  test("captures stdout and exit code", async () => {
    const result = await runHookCommand({ command: "echo hook-ran", cwd: os.tmpdir(), payload: {} })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("hook-ran")
    expect(result.timedOut).toBe(false)
  })

  test("kills on timeout", async () => {
    const sleep = process.platform === "win32" ? "ping -n 30 127.0.0.1 >NUL" : "sleep 30"
    const result = await runHookCommand({ command: sleep, cwd: os.tmpdir(), payload: {}, timeout: 200 })
    expect(result.timedOut).toBe(true)
  }, 10_000)
})

describe("config-hooks plugin", () => {
  test("before hook with exit 2 blocks the tool call", async () => {
    const plugin = await load({
      "tool.execute.before": [{ command: "echo refused >&2 && exit 2", matcher: "^bash$" }],
    })
    expect(
      plugin["tool.execute.before"]!({ tool: "bash", sessionID: "ses", callID: "call" }, { args: {} }),
    ).rejects.toThrow(/refused/)
  })

  test("before hook with exit 0 does not block", async () => {
    const plugin = await load({
      "tool.execute.before": [{ command: "exit 0" }],
    })
    await plugin["tool.execute.before"]!({ tool: "bash", sessionID: "ses", callID: "call" }, { args: {} })
  })

  test("non-matching before hook is skipped", async () => {
    const plugin = await load({
      "tool.execute.before": [{ command: "exit 2", matcher: "^edit$" }],
    })
    await plugin["tool.execute.before"]!({ tool: "bash", sessionID: "ses", callID: "call" }, { args: {} })
  })

  test("after hook stdout is appended to tool output", async () => {
    const plugin = await load({
      "tool.execute.after": [{ command: "echo lint-clean" }],
    })
    const output = { title: "t", output: "original", metadata: {} }
    await plugin["tool.execute.after"]!({ tool: "edit", sessionID: "ses", callID: "call", args: {} }, output)
    expect(output.output).toContain("original")
    expect(output.output).toContain("lint-clean")
    expect(output.output).toContain('<hook name="tool.execute.after">')
  })

  test("after hook tolerates missing output (error tool states)", async () => {
    const plugin = await load({
      "tool.execute.after": [{ command: "echo observed" }],
    })
    // The host passes undefined output when the tool errored — must not throw.
    await plugin["tool.execute.after"]!(
      { tool: "edit", sessionID: "ses", callID: "call", args: {} },
      undefined as never,
    )
  })

  test("no hooks configured is a no-op", async () => {
    const plugin = await load(undefined)
    const output = { title: "t", output: "original", metadata: {} }
    await plugin["tool.execute.after"]!({ tool: "edit", sessionID: "ses", callID: "call", args: {} }, output)
    expect(output.output).toBe("original")
  })
})
