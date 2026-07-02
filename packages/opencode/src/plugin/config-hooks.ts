import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import type { ConfigHooksV1 } from "@opencode-ai/core/v1/config/hooks"
import { spawn } from "node:child_process"

const DEFAULT_TIMEOUT_MS = 60_000
const OUTPUT_MAX_BYTES = 100_000

const log = {
  warn: (message: string, data?: Record<string, unknown>) => console.warn(`[config-hooks] ${message}`, data ?? ""),
}

export type HookResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function matchHook(matcher: string | undefined, value: string) {
  if (matcher === undefined) return true
  try {
    return new RegExp(matcher).test(value)
  } catch {
    log.warn("invalid hook matcher regex", { matcher })
    return false
  }
}

export function runHookCommand(input: {
  command: string
  cwd: string
  payload: unknown
  timeout?: number
}): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, {
      shell: true,
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, input.timeout ?? DEFAULT_TIMEOUT_MS)

    const settle = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: stdout.slice(0, OUTPUT_MAX_BYTES),
        stderr: stderr.slice(0, OUTPUT_MAX_BYTES),
        timedOut,
      })
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_MAX_BYTES) stdout += chunk.toString("utf-8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_MAX_BYTES) stderr += chunk.toString("utf-8")
    })
    child.on("error", (error) => {
      stderr += String(error)
      settle(null)
    })
    child.on("close", (code) => settle(code))

    child.stdin.on("error", () => {})
    child.stdin.write(JSON.stringify(input.payload))
    child.stdin.end()
  })
}

/**
 * Built-in plugin that runs user-configured shell commands (`hooks` in
 * opencode.json) on tool calls and bus events — Claude-Code-style hooks
 * without writing a JS plugin.
 *
 * Semantics:
 * - `tool.execute.before`: exit code 2 blocks the tool call and surfaces
 *   stderr to the model; other failures are logged and do not block.
 * - `tool.execute.after`: stdout is appended to the tool output so the model
 *   sees it; failures are logged.
 * - `event`: fire-and-forget, matched against the event type.
 */
export const ConfigHooksPlugin: Plugin = async (input: PluginInput) => {
  let hooks: ConfigHooksV1.Info | undefined

  const run = async (
    kind: keyof ConfigHooksV1.Info,
    matchValue: string,
    payload: Record<string, unknown>,
  ): Promise<HookResult[]> => {
    const commands = hooks?.[kind] ?? []
    const results: HookResult[] = []
    for (const hook of commands) {
      if (!matchHook(hook.matcher, matchValue)) continue
      const result = await runHookCommand({
        command: hook.command,
        cwd: input.worktree,
        payload: { hook: kind, worktree: input.worktree, directory: input.directory, ...payload },
        timeout: hook.timeout,
      })
      if (result.timedOut) {
        log.warn("hook timed out", { kind, command: hook.command })
      } else if (result.code !== 0 && result.code !== 2) {
        log.warn("hook failed", { kind, command: hook.command, code: result.code, stderr: result.stderr })
      }
      results.push(result)
    }
    return results
  }

  return {
    config: async (cfg) => {
      hooks = (cfg as { hooks?: ConfigHooksV1.Info }).hooks
    },
    "tool.execute.before": async (info, output) => {
      const results = await run("tool.execute.before", info.tool, {
        tool: info.tool,
        sessionID: info.sessionID,
        callID: info.callID,
        args: output?.args,
      })
      const blocked = results.find((result) => result.code === 2)
      if (blocked) {
        throw new Error(
          `Tool call blocked by a configured "tool.execute.before" hook.\n${blocked.stderr.trim() || blocked.stdout.trim() || "(the hook produced no explanation)"}`,
        )
      }
    },
    "tool.execute.after": async (info, output) => {
      // The host passes no output object for error tool states — hooks still
      // run (observers may care about failures) but there is nothing to append to.
      const results = await run("tool.execute.after", info.tool, {
        tool: info.tool,
        sessionID: info.sessionID,
        callID: info.callID,
        args: info.args,
        title: output?.title,
        output: output?.output,
      })
      if (!output) return
      const extra = results
        .map((result) => result.stdout.trim())
        .filter(Boolean)
        .join("\n")
      if (extra) {
        output.output += `\n\n<hook name="tool.execute.after">\n${extra}\n</hook>`
      }
    },
    event: async ({ event }) => {
      // Fire-and-forget: event hooks must never slow down the bus.
      void run("event", event.type, { event }).catch((error) => {
        log.warn("event hook failed", { error: String(error) })
      })
    },
  } satisfies Hooks
}
