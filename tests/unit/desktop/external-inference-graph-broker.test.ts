import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import {
  ExternalInferenceMcpServer,
  EXTERNAL_INFERENCE_BROKER_WORKER_ID,
} from "@mycontext/agent-runtime"
import { ExternalInferenceService } from "@main/services/external-inference.service.js"
import {
  GraphExtractionBroker,
  type GraphExtractionBrokerHost,
} from "@main/services/external-inference-graph-broker.js"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_800_000_000_000
const logger = createLogger("GraphBrokerTest", { level: "error" })

const brokers: GraphExtractionBroker[] = []
const servers: ExternalInferenceMcpServer[] = []
const services: ExternalInferenceService[] = []
const temporaryRoots: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop()
  while (brokers.length > 0) brokers.pop()
  while (services.length > 0) await services.pop()?.detach()
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

function makeBroker(
  vault: ReturnType<typeof openTestVault>,
  overrides?: Partial<{ pollIntervalMs: number; waitTimeoutMs: number }>,
): GraphExtractionBroker {
  const broker = new GraphExtractionBroker({
    db: vault.db,
    clock: new ManualClock(NOW),
    logger,
    pollIntervalMs: 20,
    waitTimeoutMs: 5_000,
    ...overrides,
  })
  brokers.push(broker)
  return broker
}

const klBody = {
  model: "glm-5.3-flash",
  messages: [
    { role: "system", content: "你是信息抽取助手，返回 JSON。" },
    { role: "user", content: "消息：李四让我周五前把网表整理好发他。" },
  ],
}

describe("GraphExtractionBroker.handleChatCompletion", () => {
  it("发布 Job → claim 携带 kl 请求 → submit 后返回 OpenAI 形状的补全", async () => {
    const vault = openTestVault()
    const broker = makeBroker(vault)
    const pending = broker.handleChatCompletion(klBody)

    const claim = broker.claim({ workerId: "w1" })
    expect(claim).not.toBeNull()
    expect(claim?.job.domainKind).toBe("graph-extraction")
    expect(claim?.prompt).toContain("kl Phase B")
    expect(claim?.evidence[0]?.author).toBe("other")
    expect(claim?.evidence[0]?.content).toContain("网表")

    const submitted = broker.submit({
      jobId: claim!.job.id,
      workerId: "w1",
      submissionId: "sub-1",
      contractVersion: "external-inference-v1",
      result: { content: '{"items":[]}' },
      usageTokens: 100,
    })
    expect(submitted.status).toBe("committed")

    const completion = await pending
    expect(completion.status).toBe(200)
    const body = completion.body as {
      choices: { message: { content: string } }[]
      usage: { total_tokens: number }
    }
    expect(body.choices[0].message.content).toBe('{"items":[]}')
    expect(body.usage.total_tokens).toBe(100)
  })

  it("相同 messages 的重试落进同一个 Job（幂等去重）", async () => {
    const vault = openTestVault()
    const broker = makeBroker(vault)
    const first = broker.handleChatCompletion(klBody)
    const second = broker.handleChatCompletion(klBody)

    const claim = broker.claim({ workerId: "w1" })
    expect(claim).not.toBeNull()
    broker.submit({
      jobId: claim!.job.id,
      workerId: "w1",
      submissionId: "sub-1",
      contractVersion: "external-inference-v1",
      result: { content: '{"items":[]}' },
    })

    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(broker.status().total).toBe(1)
  })

  it("应用重启换盐后，旧 Job 证据丢失走 skip 出队", async () => {
    const vault = openTestVault()
    const oldBroker = makeBroker(vault, { waitTimeoutMs: 200 })
    const pending = oldBroker.handleChatCompletion(klBody)

    // 新实例（新盐、空内存）接手同一个库：旧 Job 不可认领，被跳过出队。
    const newBroker = makeBroker(vault)
    expect(newBroker.claim({ workerId: "w2" })).toBeNull()
    expect(newBroker.claim({ workerId: "w2" })).toBeNull()
    expect(newBroker.status().skipped).toBe(1)

    // 旧请求收到 502（Job 被新实例 skip），不悬挂到测试之外。
    await expect(pending).resolves.toMatchObject({ status: 502 })
  })

  it("worker 提交校验失败 → Job 失败 → kl 收到 502", async () => {
    const vault = openTestVault()
    const broker = makeBroker(vault)
    const pending = broker.handleChatCompletion(klBody)

    const claim = broker.claim({ workerId: "w1" })
    expect(claim).not.toBeNull()
    expect(() =>
      broker.submit({
        jobId: claim!.job.id,
        workerId: "w1",
        submissionId: "sub-bad",
        contractVersion: "external-inference-v1",
        result: { content: "   " },
      }),
    ).toThrow()

    const completion = await pending
    expect(completion.status).toBe(502)
  })
})

describe("ExternalInferenceMcpServer /v1/chat/completions 路由", () => {
  it("未配置 broker 时 404；配了 broker 但缺凭据 401；带凭据走通全链", async () => {
    const vault = openTestVault()
    const broker = makeBroker(vault)
    const noBroker = new ExternalInferenceMcpServer({
      host: broker,
      clock: new ManualClock(NOW),
      logger,
    })
    servers.push(noBroker)
    const noBrokerPort = await noBroker.start()
    const withBroker = new ExternalInferenceMcpServer({
      host: broker,
      clock: new ManualClock(NOW),
      logger,
      chatBroker: broker,
    })
    servers.push(withBroker)
    const port = await withBroker.start()
    const token = withBroker.issueWorkerCredential(EXTERNAL_INFERENCE_BROKER_WORKER_ID).token

    const post = async (base: string, bearer: string | null) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (bearer !== null) headers.Authorization = `Bearer ${bearer}`
      return fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(klBody),
      })
    }

    const notFound = await post(`http://127.0.0.1:${noBrokerPort}`, token)
    expect(notFound.status).toBe(404)

    const unauthorized = await post(`http://127.0.0.1:${port}`, "wrong")
    expect(unauthorized.status).toBe(401)

    const pending = post(`http://127.0.0.1:${port}`, token)
    // 请求经服务器进入 broker 的 pending 队列是异步的；等它出现再认领。
    let claim: ReturnType<GraphExtractionBrokerHost["claim"]> = null
    for (let attempt = 0; attempt < 40 && claim === null; attempt += 1) {
      await new Promise((r) => setTimeout(r, 25))
      claim = broker.claim({ workerId: "w1" })
    }
    expect(claim).not.toBeNull()
    broker.submit({
      jobId: claim!.job.id,
      workerId: "w1",
      submissionId: "sub-route",
      contractVersion: "external-inference-v1",
      result: { content: "OK" },
    })
    const response = await pending
    expect(response.status).toBe(200)
    const body = (await response.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0].message.content).toBe("OK")
  })
})

describe("ExternalInferenceService.chatBrokerEndpoint", () => {
  it("external-only 开启后暴露 broker 端点与专用凭据", async () => {
    const vault = openTestVault()
    const handoffRoot = mkdtempSync(join(tmpdir(), "mycontext-graph-broker-"))
    temporaryRoots.push(handoffRoot)
    const service = new ExternalInferenceService({
      clock: new ManualClock(NOW),
      logger,
    })
    services.push(service)
    const handoffFile = join(handoffRoot, "handoff.json")

    expect(service.chatBrokerEndpoint()).toBeNull()
    await service.attach(vault.db, handoffFile)
    expect(service.chatBrokerEndpoint()).toBeNull()

    const handoff = service.handoff("worker-one")
    expect(handoff.externalOnly).toBe(true)
    const endpoint = service.chatBrokerEndpoint()
    expect(endpoint).not.toBeNull()
    expect(endpoint?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(endpoint?.apiKey.length).toBeGreaterThan(20)

    service.setExternalOnly(false)
    expect(service.chatBrokerEndpoint()).toBeNull()
  })
})
