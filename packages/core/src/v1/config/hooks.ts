export * as ConfigHooksV1 from "./hooks"

import { Schema } from "effect"
import { NonNegativeInt } from "../../schema"

export const Command = Schema.Struct({
  command: Schema.String.annotate({
    description: "Shell command to run. Receives a JSON payload describing the event on stdin.",
  }),
  matcher: Schema.optional(Schema.String).annotate({
    description:
      "Regex matched against the tool id (tool hooks) or event type (event hooks). Omit to match everything.",
  }),
  timeout: Schema.optional(NonNegativeInt).annotate({
    description: "Timeout in milliseconds before the hook command is killed (default: 60000)",
  }),
}).annotate({ identifier: "HookCommand" })
export type Command = Schema.Schema.Type<typeof Command>

export const Info = Schema.Struct({
  "tool.execute.before": Schema.optional(Schema.Array(Command)).annotate({
    description:
      "Run before a tool executes. Exit code 2 blocks the tool call and feeds stderr back to the model; other exit codes are logged without blocking.",
  }),
  "tool.execute.after": Schema.optional(Schema.Array(Command)).annotate({
    description: "Run after a tool executes. Stdout is appended to the tool output shown to the model.",
  }),
  event: Schema.optional(Schema.Array(Command)).annotate({
    description:
      "Run on bus events (e.g. session lifecycle). The matcher is applied to the event type; hooks run fire-and-forget.",
  }),
}).annotate({ identifier: "HooksConfig" })
export type Info = Schema.Schema.Type<typeof Info>
