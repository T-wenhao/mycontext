import { createHash } from "node:crypto"
import {
  EXTERNAL_INFERENCE_CONTRACT_VERSION,
  ExternalInferenceJobError,
  ExternalInferenceJobRepository,
  type ExternalInferenceClaim,
  type ExternalInferenceJobRow,
  type ExternalInferenceJobStatus,
  type ExternalInferenceSubmission,
  type ExternalInferenceSubmitResult,
  type ExternalInferenceWorkerHost,
} from "@mycontext/store"
import type { Clock, Logger } from "@mycontext/kernel"
import type { SqliteDatabase } from "@mycontext/store"

/**
 * T02：kl 建图 Phase B 的图谱抽取外部化。
 *
 * external-only 模式下，kl 的 litellm 抽取调用（OpenAI chat completions 形状）
 * 由桌面代理为 graph-extraction 外部 Job：请求内容只存在本内存里（与 kl 的
 * 在途 HTTP 连接同生命周期），worker 经 MCP claim/submit 完成推理，宿主校验
 * 后把补全文本交还给 kl —— worker 全程接触不到 kl 的存储，kl 也不感知换芯。
 *
 * 幂等键是 messages 的哈希：kl 对同一批内容的重试落进同一个 Job；应用重启后
 * broker 换盐重发布，旧 Job 走 skip 出队（kl 会重新发起请求）。
 */
export const GRAPH_EXTRACTION_PROMPT_VERSION = "kl-extract-v1"
const GRAPH_EXTRACTION_DOMAIN = "graph-extraction"
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 500
const MAX_RESULT_CHARS = 200_000

export interface GraphExtractionBrokerOptions {
  db: SqliteDatabase
  clock: Clock
  logger?: Logger
  /** 单条 kl 请求等待 worker 提交的上限；超时返回 504，由 kl 自行重试。 */
  waitTimeoutMs?: number
  pollIntervalMs?: number
}

export interface GraphExtractionBrokerCompletion {
  status: number
  body: unknown
}

interface PendingRequest {
  model: string
  messages: readonly unknown[]
}

export interface GraphExtractionChatBroker {
  handleChatCompletion(body: unknown): Promise<GraphExtractionBrokerCompletion>
}

/** MCP worker 宿主只认 ExternalInferenceWorkerHost；broker 同时实现两侧。 */
export type GraphExtractionBrokerHost = GraphExtractionChatBroker &
  Pick<ExternalInferenceWorkerHost, "claim" | "heartbeat" | "submit" | "status"> & {
    revokeWorker(workerId: string): number
    revokeAllWorkers(): number
    jobDomain(jobId: string): "graph-extraction" | null
  }

export class GraphExtractionBroker implements GraphExtractionBrokerHost {
  private readonly jobs: ExternalInferenceJobRepository
  private readonly pending = new Map<string, PendingRequest>()
  private readonly results = new Map<string, { content: string; usageTokens: number | null }>()
  private readonly waiters = new Map<
    string,
    Set<(value: GraphExtractionBrokerCompletion) => void>
  >()
  private readonly salt: string
  private readonly waitTimeoutMs: number
  private readonly pollIntervalMs: number

  constructor(private readonly options: GraphExtractionBrokerOptions) {
    this.jobs = new ExternalInferenceJobRepository(options.db)
    this.salt = createHash("sha256")
      .update(`${options.clock.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 16)
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  /** kl 的 litellm 调用入口：发布 Job 并阻塞等待 worker 提交。 */
  async handleChatCompletion(body: unknown): Promise<GraphExtractionBrokerCompletion> {
    const parsed = parseChatBody(body)
    if (parsed === null) {
      return { status: 400, body: { error: { message: "model/messages invalid" } } }
    }
    const { model, messages } = parsed
    const ref = this.refFor(messages)
    const id = `graph-${ref.slice(0, 32)}`
    this.pending.set(ref, { model, messages })
    this.jobs.enqueue(
      {
        id,
        domainKind: GRAPH_EXTRACTION_DOMAIN,
        domainRef: ref,
        promptVersion: GRAPH_EXTRACTION_PROMPT_VERSION,
        contractVersion: EXTERNAL_INFERENCE_CONTRACT_VERSION,
      },
      this.options.clock.now(),
    )
    const completion = await this.waitForCommit(id, ref)
    if (completion === null) {
      return {
        status: 504,
        body: { error: { message: "external extraction wait timeout", code: "WAIT_TIMEOUT" } },
      }
    }
    return completion
  }

  claim(input: { workerId: string; leaseMs?: number }): ExternalInferenceClaim | null {
    const now = this.options.clock.now()
    const job = this.jobs.claim(
      input.workerId,
      now,
      boundedLease(input.leaseMs),
      3,
      GRAPH_EXTRACTION_DOMAIN,
    )
    if (job === null) return null
    const pending = this.pending.get(job.domainRef)
    if (pending === undefined) {
      // 应用重启会换盐重发布；旧 Job 的证据只存在旧进程内存里，这里跳过出队。
      try {
        this.jobs.skip(job.id, input.workerId, "EVIDENCE_LOST", now)
      } catch {
        // 租约竞态由下一次领取回收。
      }
      return null
    }
    return {
      job,
      prompt: buildGraphPrompt(job, pending),
      evidence: [graphEvidence(job, pending, now)],
    }
  }

  heartbeat(input: {
    jobId: string
    workerId: string
    leaseMs?: number
  }): ExternalInferenceJobRow | null {
    return this.jobs.heartbeat(
      input.jobId,
      input.workerId,
      this.options.clock.now(),
      boundedLease(input.leaseMs),
    )
  }

  submit(input: ExternalInferenceSubmission & { workerId: string }): ExternalInferenceSubmitResult {
    if (input.contractVersion !== EXTERNAL_INFERENCE_CONTRACT_VERSION) {
      throw new ExternalInferenceJobError("INVALID_SUBMISSION")
    }
    const result = asRecord(input.result)
    const content = typeof result.content === "string" ? result.content : ""
    if (content.trim() === "" || content.length > MAX_RESULT_CHARS) {
      const error = new ExternalInferenceJobError("INVALID_SUBMISSION")
      try {
        this.jobs.fail(input.jobId, input.workerId, error.code, this.options.clock.now())
      } catch {
        // 无租约时保留校验错误本身，队列行由租约超时回收。
      }
      throw error
    }
    const usageTokens =
      typeof input.usageTokens === "number" && Number.isFinite(input.usageTokens)
        ? Math.max(0, Math.floor(input.usageTokens))
        : null
    const now = this.options.clock.now()
    const existing = this.jobs.findById(input.jobId)
    if (existing === null) throw new ExternalInferenceJobError("JOB_NOT_FOUND")
    const committed = this.jobs.commit(
      {
        jobId: input.jobId,
        workerId: input.workerId,
        submissionId: input.submissionId,
        submissionDigest: createHash("sha256").update(content).digest("hex"),
        resultCount: 1,
        usageTokens,
        at: now,
      },
      () => {
        // 结果内容只进 broker 内存（与 kl 在途连接同生命周期），队列行只留元数据。
        this.results.set(existing.domainRef, { content, usageTokens })
      },
    )
    this.notifyWaiters(existing.domainRef)
    return committed
  }

  status(): ExternalInferenceJobStatus {
    const status: ExternalInferenceJobStatus = {
      total: 0,
      pending: 0,
      leased: 0,
      committed: 0,
      failed: 0,
      skipped: 0,
      jobs: [],
    }
    for (const row of this.jobs.list(500)) {
      if (row.domainKind !== GRAPH_EXTRACTION_DOMAIN) continue
      status.jobs.push(row)
      status.total += 1
      status[row.state] += 1
    }
    return status
  }

  revokeWorker(workerId: string): number {
    return this.jobs.revokeLeases(this.options.clock.now(), workerId).length
  }

  revokeAllWorkers(): number {
    return this.jobs.revokeLeases(this.options.clock.now()).length
  }

  /** 组合宿主按 Job 的 domain 分派 submit；只认自己的 domain。 */
  jobDomain(jobId: string): "graph-extraction" | null {
    const row = this.jobs.findById(jobId)
    return row === null || row.domainKind !== GRAPH_EXTRACTION_DOMAIN ? null : "graph-extraction"
  }

  private waitForCommit(
    jobId: string,
    ref: string,
  ): Promise<GraphExtractionBrokerCompletion | null> {
    const deadlineAt = this.options.clock.now() + this.waitTimeoutMs
    return new Promise((resolve) => {
      const waiters = this.waiters.get(ref) ?? new Set<Resolve>()
      waiters.add(resolve)
      this.waiters.set(ref, waiters)
      let settled = false
      const settle = (value: GraphExtractionBrokerCompletion): void => {
        if (settled) return
        settled = true
        clearInterval(timer)
        const set = this.waiters.get(ref)
        set?.delete(resolve)
        resolve(value)
      }
      const timer = setInterval(() => {
        let row: ExternalInferenceJobRow | null
        try {
          row = this.jobs.findById(jobId)
        } catch {
          // 测试/停机路径可能先关闭数据库；此时请求方连接早已断开。
          settle({ status: 502, body: { error: { message: "broker store closed" } } })
          return
        }
        if (row === null) {
          settle({ status: 502, body: { error: { message: "job vanished" } } })
          return
        }
        if (row.state === "committed") {
          const result = this.results.get(ref)
          settle(
            result === undefined
              ? { status: 502, body: { error: { message: "committed result lost in broker" } } }
              : { status: 200, body: completionBody(row, result.content, result.usageTokens) },
          )
          return
        }
        if (row.state === "failed" || row.state === "skipped") {
          settle({
            status: 502,
            body: {
              error: {
                message: `external extraction ${row.state}`,
                code: row.lastError ?? "EXTRACTION_FAILED",
              },
            },
          })
          return
        }
        if (this.options.clock.now() >= deadlineAt) {
          settle({
            status: 504,
            body: { error: { message: "external extraction wait timeout", code: "WAIT_TIMEOUT" } },
          })
        }
      }, this.pollIntervalMs)
    })
  }

  private notifyWaiters(ref: string): void {
    const waiters = this.waiters.get(ref)
    if (waiters === undefined) return
    this.waiters.delete(ref)
    const result = this.results.get(ref)
    const row = this.jobs
      .list(500)
      .find((r) => r.domainRef === ref && r.domainKind === GRAPH_EXTRACTION_DOMAIN)
    if (result === undefined || row === undefined) return
    for (const resolve of waiters) {
      resolve({ status: 200, body: completionBody(row, result.content, result.usageTokens) })
    }
  }

  private refFor(messages: readonly unknown[]): string {
    return createHash("sha256").update(this.salt).update(JSON.stringify(messages)).digest("hex")
  }
}

function completionBody(
  row: ExternalInferenceJobRow,
  content: string,
  usageTokens: number | null,
): unknown {
  return {
    id: `chatcmpl-external-${row.id}`,
    object: "chat.completion",
    created: Math.floor(row.updatedAt / 1000),
    model: "external-worker",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usageTokens ?? 0,
      completion_tokens: 0,
      total_tokens: usageTokens ?? 0,
    },
  }
}

function buildGraphPrompt(job: ExternalInferenceJobRow, pending: PendingRequest): string {
  return [
    "这是 MyContext 图谱抽取管线（kl Phase B）发出的一条 LLM 抽取调用。",
    "请以助手身份完成 evidence 中 messages 描述的任务：evidence 是完整的原始请求（含 system 提示词与待抽取内容）。",
    "返回的最终文本必须严格满足该请求自身的输出契约（通常是仅含 JSON 的补全文本，不要附加解释或代码围栏之外的文字）。",
    `Job: ${job.id} | promptVersion: ${job.promptVersion} | model: ${pending.model}`,
  ].join("\n")
}

function graphEvidence(
  job: ExternalInferenceJobRow,
  pending: PendingRequest,
  now: number,
): ExternalInferenceClaim["evidence"][number] {
  return {
    ref: `kl-extract:${job.domainRef.slice(0, 16)}`,
    sentAt: now,
    author: "other",
    content: JSON.stringify({ model: pending.model, messages: pending.messages }),
  }
}

function parseChatBody(body: unknown): { model: string; messages: readonly unknown[] } | null {
  if (typeof body !== "object" || body === null) return null
  const record = body as Record<string, unknown>
  const messages = record.messages
  if (!Array.isArray(messages) || messages.length === 0) return null
  for (const message of messages) {
    if (typeof message !== "object" || message === null) return null
    const m = message as Record<string, unknown>
    if (typeof m.role !== "string" || typeof m.content !== "string") return null
  }
  const model =
    typeof record.model === "string" && record.model.trim() !== "" ? record.model.trim() : "unknown"
  return { model, messages }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {}
  return value as Record<string, unknown>
}

function boundedLease(value: number | undefined): number {
  return Number.isFinite(value ?? NaN)
    ? Math.max(1_000, Math.min(30 * 60_000, Math.floor(value ?? 0)))
    : 10 * 60_000
}

type Resolve = (value: GraphExtractionBrokerCompletion) => void
