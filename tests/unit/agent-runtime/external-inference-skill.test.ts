import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

describe("external inference worker skill", () => {
  it("documents the bounded claim-heartbeat-submit workflow without storage access", () => {
    const markdown = readFileSync(
      join(
        import.meta.dirname,
        "../../../apps/desktop/resources/skills/external-inference/SKILL.md",
      ),
      "utf8",
    )

    expect(markdown).toContain("external_inference_claim")
    expect(markdown).toContain("external_inference_heartbeat")
    expect(markdown).toContain("external_inference_submit")
    expect(markdown).toContain("external_inference_status")
    expect(markdown).toContain("Never ask for, open or search a vault")
    expect(markdown).toContain('"items"')
    expect(markdown).not.toContain("Bearer ")
  })
})
