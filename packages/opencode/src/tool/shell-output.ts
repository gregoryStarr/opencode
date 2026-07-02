import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import { backgroundShells } from "./shell"

const DESCRIPTION = [
  "Retrieves output from a background shell started with the bash tool's background=true option.",
  "",
  "- Returns only output produced since the previous bash_output call for that shell_id, along with the command's current status (running/completed/error/cancelled).",
  "- Pass kill=true to terminate a running background command.",
  "- Do NOT call this in a tight polling loop. Continue with other work and check output when you have a concrete reason to (e.g., before using a server the command starts, or after being told a build takes a while).",
].join("\n")

export const Parameters = Schema.Struct({
  shell_id: Schema.String.annotate({
    description: "The shell_id returned by a bash call with background=true",
  }),
  kill: Schema.optional(Schema.Boolean).annotate({
    description: "Terminate the background command instead of just reading its output",
  }),
})

const terminal = new Set(["completed", "error", "cancelled"])

export const ShellOutputTool = Tool.define(
  "bash_output",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const record = backgroundShells.get(args.shell_id)
          let info = yield* background.get(args.shell_id)
          if (!record && !info) {
            throw new Error(
              `No background shell found with shell_id "${args.shell_id}". It may never have existed, or its output buffer was evicted after too many background shells were started.`,
            )
          }

          if (args.kill) {
            yield* background.cancel(args.shell_id)
            info = yield* background.get(args.shell_id)
          }
          const status = info?.status ?? (args.kill ? "cancelled" : "running")

          const delta = record ? record.output.slice(record.cursor) : ""
          if (record) record.cursor = record.output.length

          // Free the buffer once the command is done and fully read.
          if (record && terminal.has(status) && record.cursor >= record.output.length) {
            backgroundShells.delete(args.shell_id)
          }

          const command = record?.command ?? info?.title ?? "(unknown)"
          const lines = [`<shell id="${args.shell_id}" status="${status}">`, `<command>${command}</command>`]
          if (info?.status === "error" && info.error) lines.push(`<error>${info.error}</error>`)
          if (record?.truncated) {
            lines.push("<note>Older output was dropped because the buffer limit was reached.</note>")
          }
          lines.push("<new_output>", delta || "(no new output)", "</new_output>", "</shell>")

          return {
            title: command,
            metadata: { status, bytes: Buffer.byteLength(delta, "utf-8") },
            output: lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
