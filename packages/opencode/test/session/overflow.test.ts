import { describe, expect, test } from "bun:test"
import { isOverflow } from "../../src/session/overflow"

const model = { limit: { context: 100_000, input: 0, output: 0 } } as never
const tokens = (total: number) => ({ input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
// usable ~= context - maxOutputTokens; with output limit 0 the transform falls
// back to a default reserve. We only assert relative behavior across thresholds.

describe("isOverflow threshold floor", () => {
  test("default threshold does not trigger on a small conversation", () => {
    expect(isOverflow({ cfg: {} as never, tokens: tokens(1_000), model })).toBe(false)
  })

  test("a pathologically low threshold is floored, not honored", () => {
    // At the raw 0.01 value a 1k-token conversation would overflow immediately
    // (the doom-loop trigger). The 0.5 floor must prevent that.
    const low = isOverflow({ cfg: { compaction: { threshold: 0.01 } } as never, tokens: tokens(1_000), model })
    expect(low).toBe(false)
  })

  test("floor matches an explicit 0.5 threshold", () => {
    const clamped = isOverflow({ cfg: { compaction: { threshold: 0.01 } } as never, tokens: tokens(60_000), model })
    const half = isOverflow({ cfg: { compaction: { threshold: 0.5 } } as never, tokens: tokens(60_000), model })
    expect(clamped).toBe(half)
  })

  test("auto:false disables overflow entirely", () => {
    expect(isOverflow({ cfg: { compaction: { auto: false, threshold: 0.5 } } as never, tokens: tokens(99_000), model })).toBe(
      false,
    )
  })
})
