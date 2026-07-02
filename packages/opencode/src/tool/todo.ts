import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

// Lenient tool-boundary schema: weaker models routinely omit `priority`, which
// the shared Todo.Info requires. Default it here (to "medium") so a forgotten
// field doesn't fail the tool call, while the stored todo still carries all
// three fields. Kept at the LLM boundary only — Todo.Info is unchanged.
const TodoInput = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.optional(Schema.String).annotate({
    description: "Priority level of the task: high, medium, low (defaults to medium)",
  }),
})

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(TodoInput)).annotate({ description: "The updated todo list" }),
})

type Metadata = {
  todos: Todo.Info[]
}

export const TodoWriteTool = Tool.define<typeof Parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const todos = params.todos.map((item) => ({ ...item, priority: item.priority ?? "medium" }))
          yield* todo.update({
            sessionID: ctx.sessionID,
            todos,
          })

          return {
            title: `${todos.filter((x) => x.status !== "completed").length} todos`,
            output: JSON.stringify(todos, null, 2),
            metadata: {
              todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
