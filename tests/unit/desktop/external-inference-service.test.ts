import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { ExternalInferenceService } from "@main/services/external-inference.service.js"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_800_000_000_000
const logger = createLogger("ExternalInferenceTest", { level: "error" })

const services: ExternalInferenceService[] = []
const temporaryRoots: string[] = []

afterEach(async () => {
  while (services.length > 0) await services.pop()?.detach()
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

describe("ExternalInferenceService", () => {
  it("writes a non-vault handoff and revokes it when external mode stops", async () => {
    const vault = openTestVault()
    const handoffRoot = mkdtempSync(join(tmpdir(), "mycontext-external-inference-"))
    temporaryRoots.push(handoffRoot)
    const handoffFile = join(handoffRoot, "handoff.json")
    const service = new ExternalInferenceService({
      clock: new ManualClock(NOW),
      logger,
    })
    services.push(service)

    await service.attach(vault.db, handoffFile)
    const handoff = service.handoff("worker-one")

    expect(handoff.path).toBe(handoffFile)
    expect(handoff.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(handoff.externalOnly).toBe(true)
    expect(service.statusView().externalOnly).toBe(true)
    expect(service.statusView().activeCredentials).toBe(1)
    expect(service.statusView().handoffPath).toBe(handoffFile)

    const manifest = JSON.parse(readFileSync(handoffFile, "utf8")) as {
      endpoint: string
      workerId: string
      credential: { token: string }
    }
    expect(manifest.endpoint).toBe(handoff.endpoint)
    expect(manifest.workerId).toBe("worker-one")
    expect(manifest.credential.token).toHaveLength(43)
    expect(JSON.stringify(manifest)).not.toContain(vault.path)

    service.setExternalOnly(false)
    expect(service.statusView().externalOnly).toBe(false)
    expect(service.statusView().activeCredentials).toBe(0)
    expect(service.statusView().handoffPath).toBeNull()
    expect(existsSync(handoffFile)).toBe(false)

    const rejected = await fetch(handoff.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${manifest.credential.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(rejected.status).toBe(401)

    await service.detach()
    expect(existsSync(handoffFile)).toBe(false)
    expect(service.endpoint()).toBeNull()
    expect(service.statusView().activeCredentials).toBe(0)
    vault.close()
  })
})
