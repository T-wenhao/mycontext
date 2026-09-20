import { describe, expect, it, vi } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { EXTERNAL_INFERENCE_TOOLS, ExternalInferenceMcpServer } from "@mycontext/agent-runtime"
import type {
  ExternalInferenceClaim,
  ExternalInferenceJobRow,
  ExternalInferenceWorkerHost,
} from "@mycontext/store"

const NOW = 1_800_000_000_000

function job(): ExternalInferenceJobRow {
  return {
    id: "job-1",
    domainKind: "distillation",
    domainRef: "task-1",
    state: "leased",
    attempts: 1,
    leaseOwner: "worker-a",
    leaseExpiresAt: NOW + 60_000,
    promptVersion: "distill-tasks-v1",
    contractVersion: "external-inference-v1",
    submissionId: null,
    submissionDigest: null,
    resultCount: null,
    usageTokens: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function claim(): ExternalInferenceClaim {
  return {
    job: job(),
    prompt: "invented prompt",
    evidence: [],
  }
}

async function request(
  server: ExternalInferenceMcpServer,
  token: string | undefined,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === "" ? null : JSON.parse(text) }
}

function toolText(body: Record<string, unknown>): string | null {
  const result = body.result
  const text = result?.content?.[0]?.text
  return text === undefined ? undefined : JSON.parse(text)
}

function makeHost() {
  const submitted: unknown[] = []
  const host: ExternalInferenceWorkerHost = {
    claim: vi.fn(() => claim()),
    heartbeat: vi.fn(() => job()),
    submit: vi.fn((input) => {
      submitted.push(input)
      return { status: "committed" as const, job: { ...job(), state: "committed" as const } }
    }),
    status: vi.fn(() => ({
      total: 1,
      pending: 0,
      leased: 1,
      committed: 0,
      failed: 0,
      skipped: 0,
      jobs: [job()],
    })),
  }
  return { host, submitted }
}

describe("ExternalInferenceMcpServer", () => {
  it("keeps the endpoint local, authenticates workers, and exposes the four tools", async () => {
    const clock = new ManualClock(NOW)
    const { host, submitted } = makeHost()
    const server = new ExternalInferenceMcpServer({ host, clock, port: 0 })
    await server.start()
    const credential = server.issueWorkerCredential("worker-a")

    try {
      expect(
        (await request(server, undefined, { jsonrpc: "2.0", id: 1, method: "initialize" })).status,
      ).toBe(401)
      expect(
        (
          await request(
            server,
            credential.token,
            { jsonrpc: "2.0", id: 1, method: "initialize" },
            { origin: "https://example.invalid" },
          )
        ).status,
      ).toBe(403)

      const initialized = await request(server, credential.token, {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {},
      })
      expect(initialized.body.result.serverInfo.name).toBe("mycontext-external-inference")

      const listed = await request(server, credential.token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
      })
      expect(listed.body.result.tools.map((item: { name: string }) => item.name)).toEqual([
        EXTERNAL_INFERENCE_TOOLS.claim,
        EXTERNAL_INFERENCE_TOOLS.heartbeat,
        EXTERNAL_INFERENCE_TOOLS.submit,
        EXTERNAL_INFERENCE_TOOLS.status,
      ])

      const claimed = await request(server, credential.token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: EXTERNAL_INFERENCE_TOOLS.claim, arguments: {} },
      })
      expect(toolText(claimed.body)).toEqual(claim())
      expect(host.claim).toHaveBeenCalledWith({ workerId: "worker-a" })

      const heartbeat = await request(server, credential.token, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: EXTERNAL_INFERENCE_TOOLS.heartbeat,
          arguments: { jobId: "job-1", leaseMs: 5_000 },
        },
      })
      expect(toolText(heartbeat.body).leaseOwner).toBe("worker-a")

      const result = { items: [] }
      const submittedResponse = await request(server, credential.token, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: EXTERNAL_INFERENCE_TOOLS.submit,
          arguments: {
            jobId: "job-1",
            submissionId: "submission-1",
            contractVersion: "external-inference-v1",
            result,
            usageTokens: 19,
          },
        },
      })
      expect(toolText(submittedResponse.body).status).toBe("committed")
      expect(submitted).toHaveLength(1)
      expect(submitted[0]).toMatchObject({ workerId: "worker-a", result, usageTokens: 19 })

      const status = await request(server, credential.token, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: EXTERNAL_INFERENCE_TOOLS.status, arguments: {} },
      })
      expect(toolText(status.body).total).toBe(1)
    } finally {
      await server.stop()
    }
  })

  it("returns content-free protocol errors instead of leaking host or source data", async () => {
    const clock = new ManualClock(NOW)
    const { host } = makeHost()
    const server = new ExternalInferenceMcpServer({ host, clock, port: 0 })
    await server.start()
    const credential = server.issueWorkerCredential("worker-a")

    try {
      const unknown = await request(server, credential.token, {
        jsonrpc: "2.0",
        id: "unknown",
        method: "made-up/method",
      })
      expect(unknown.body.error.code).toBe(-32601)
      expect(JSON.stringify(unknown.body)).not.toContain("source")

      const invalidJson = await request(server, credential.token, "not-json")
      expect(invalidJson.body.error.code).toBe(-32600)

      const mismatchedWorker = await request(server, credential.token, {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: EXTERNAL_INFERENCE_TOOLS.claim,
          arguments: { workerId: "worker-b" },
        },
      })
      expect(toolText(mismatchedWorker.body)).toEqual({ error: "WORKER_MISMATCH" })
    } finally {
      await server.stop()
    }
  })
})
