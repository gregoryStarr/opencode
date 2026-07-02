import { describe, expect, test } from "bun:test"
import { resolveTools } from "../../src/session/llm/request"

const tools = {
  StructuredOutput: {} as never,
  edit: {} as never,
  grep: {} as never,
}

const denyByDefault = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "grep", pattern: "*", action: "allow" },
] as never

describe("resolveTools", () => {
  test("keeps StructuredOutput for deny-by-default agents", () => {
    const result = resolveTools({
      tools,
      agent: { permission: denyByDefault } as never,
      permission: [],
      user: {} as never,
    })
    expect(Object.keys(result).toSorted()).toEqual(["StructuredOutput", "grep"])
  })

  test("still honors user tool disables for regular tools", () => {
    const result = resolveTools({
      tools,
      agent: { permission: [{ permission: "*", pattern: "*", action: "allow" }] } as never,
      permission: [],
      user: { tools: { edit: false } } as never,
    })
    expect(Object.keys(result).toSorted()).toEqual(["StructuredOutput", "grep"])
  })
})
