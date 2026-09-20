import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  EXTERNAL_INFERENCE_BROKER_WORKER_ID,
  EXTERNAL_INFERENCE_TOOLS,
  ExternalInferenceMcpServer,
  type ExternalInferenceCredential,
} from "@mycontext/agent-runtime"
import { ExternalInferenceDistillHost } from "@mycontext/distill"
import type { Clock, Logger } from "@mycontext/kernel"
import {
  EXTERNAL_INFERENCE_CONTRACT_VERSION,
  type ExternalInferenceSubmission,
  type ExternalInferenceWorkerHost,
} from "@mycontext/store"
import type {
  ExternalInferenceJobRow,
  ExternalInferenceJobStatus,
  SqliteDatabase,
} from "@mycontext/store"
import { GraphExtractionBroker } from "./external-inference-graph-broker.js"

export interface ExternalInferenceServiceOptions {
  clock: Clock
  logger: Logger
  getForbiddenTerms?: () => readonly string[]
  getConversationScope?: () => {
    restricted: boolean
    allow: readonly string[]
  }
  onExternalOnlyChanged?: (enabled: boolean) => void
  onHostCommit?: () => void
}

export interface ExternalInferenceHandoffView {
  path: string
  endpoint: string
  workerId: string
  expiresAt: number
  externalOnly: true
}

export interface ExternalInferenceServiceStatus extends ExternalInferenceJobStatus {
  endpoint: string | null
  handoffPath: string | null
  externalOnly: boolean
  activeCredentials: number
}

/**
 * Desktop 侧的 External Inference 生命周期边界。
 *
 * MCP server 只在当前 vault 挂载且有身份时监听 loopback；切 vault、登出或
 * 退出时先停 server，再由 vault teardown 关闭数据库。worker credential 只写入
 * 应用级 0600 交接清单，不进入 vault 或日志，停止外部模式时立即删除。
 */
export class ExternalInferenceService {
  private server: ExternalInferenceMcpServer | null = null
  private host: ExternalInferenceDistillHost | null = null
  private graphBroker: GraphExtractionBroker | null = null
  private composite: ExternalInferenceWorkerHost | null = null
  private brokerToken: string | null = null
  private handoffFile: string | null = null
  private externalOnly = false

  constructor(private readonly options: ExternalInferenceServiceOptions) {}

  async attach(db: SqliteDatabase, handoffFile?: string): Promise<void> {
    await this.detach()

    const host = new ExternalInferenceDistillHost({
      db,
      clock: this.options.clock,
      newId: randomUUID,
      logger: this.options.logger,
      forbiddenTerms: this.options.getForbiddenTerms?.() ?? [],
      ...(this.options.getConversationScope === undefined
        ? {}
        : { getConversationScope: this.options.getConversationScope }),
      ...(this.options.onHostCommit === undefined
        ? {}
        : { onHostCommit: this.options.onHostCommit }),
    })
    // T02：图谱抽取 broker。claim/submit 按 domainKind 路由（见下面的组合宿主），
    // chat 路由只在 external-only 时被 kl 的 env 指到。
    const graphBroker = new GraphExtractionBroker({
      db,
      clock: this.options.clock,
      logger: this.options.logger,
    })
    const composite: ExternalInferenceWorkerHost = {
      claim: (input: { workerId: string; leaseMs?: number }) =>
        host.claim(input) ?? graphBroker.claim(input),
      heartbeat: (input: { jobId: string; workerId: string; leaseMs?: number }) =>
        host.heartbeat(input),
      submit: (input: ExternalInferenceSubmission & { workerId: string }) => {
        // 按 Job 的 domain 精确分派：蒸馏 Job 归蒸馏宿主，其余归图谱 broker。
        const domain = host.jobDomain(input.jobId) ?? graphBroker.jobDomain(input.jobId)
        if (domain === "graph-extraction") return graphBroker.submit(input)
        if (domain === "distillation") return host.submit(input)
        throw new Error("JOB_NOT_FOUND")
      },
      status: () => mergeStatus(host.status(), graphBroker.status()),
    }
    const server = new ExternalInferenceMcpServer({
      host: composite,
      clock: this.options.clock,
      logger: this.options.logger,
      chatBroker: graphBroker,
    })

    try {
      await server.start()
      const brokerCredential = server.issueWorkerCredential(EXTERNAL_INFERENCE_BROKER_WORKER_ID)
      this.host = host
      this.graphBroker = graphBroker
      this.composite = composite
      this.server = server
      this.brokerToken = brokerCredential.token
      this.handoffFile = handoffFile ?? null
      this.options.logger.info("external inference server started", {
        port: server.port,
        publishedJobs: 0,
      })
      // 恢复一次“提交已落库、进程却在收尾前退出”的窗口。
      this.options.onHostCommit?.()
    } catch (error) {
      await server.stop()
      throw error
    }
  }

  async detach(): Promise<void> {
    const server = this.server
    server?.credentials.revokeAll()
    this.revokeAllLeases()
    this.removeHandoff()
    this.server = null
    this.host = null
    this.graphBroker = null
    this.composite = null
    this.brokerToken = null
    this.externalOnly = false
    this.handoffFile = null
    await server?.stop()
  }

  /**
   * external-only 与否都可用（T02 起图谱抽取与主模型常态化走外部 Agent）：
   * kl 建图 Phase B 与主模型调用改道本进程的图谱抽取 broker，密钥为 broker
   * 专用 credential（与 worker credential 分开签发）。未 attach 时返回 null。
   */
  chatBrokerEndpoint(): { baseUrl: string; apiKey: string } | null {
    const server = this.server
    const token = this.brokerToken
    if (server === null || token === null) return null
    return { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: token }
  }

  issueWorkerCredential(workerId: string): ExternalInferenceCredential {
    const server = this.requireServer()
    return server.issueWorkerCredential(workerId)
  }

  revokeWorkerCredential(workerId: string): void {
    this.server?.credentials.revoke(workerId)
    this.host?.revokeWorker(workerId)
  }

  endpoint(): string | null {
    return this.server?.url ?? null
  }

  publishPending(limit = 20): ExternalInferenceJobRow[] {
    return this.externalOnly ? (this.host?.publishPending(limit) ?? []) : []
  }

  isExternalOnly(): boolean {
    return this.externalOnly
  }

  setExternalOnly(enabled: boolean): { externalOnly: boolean } {
    if (enabled) {
      this.requireServer()
      const changed = !this.externalOnly
      this.externalOnly = true
      if (changed) {
        const published = this.host?.publishPending() ?? []
        this.options.logger.info("external inference mode enabled", {
          publishedJobs: published.length,
          directModelCalls: 0,
        })
        this.options.onExternalOnlyChanged?.(true)
      }
    } else {
      const wasExternalOnly = this.externalOnly
      const revokedCredentials = this.server?.credentials.activeCount() ?? 0
      this.server?.credentials.revokeAll()
      const revokedLeases = this.revokeAllLeases()
      this.externalOnly = false
      this.removeHandoff()
      if (wasExternalOnly || revokedCredentials > 0 || revokedLeases > 0) {
        this.options.logger.info("external inference mode disabled", {
          revokedCredentials,
          revokedLeases,
        })
      }
      if (wasExternalOnly) this.options.onExternalOnlyChanged?.(false)
    }
    return { externalOnly: this.externalOnly }
  }

  /**
   * 通过用户交给所选 Agent 的 0600 清单签发凭据；IPC 只返回清单路径，
   * 不把 bearer 暴露给渲染进程。
   */
  handoff(workerId: string): ExternalInferenceHandoffView {
    const server = this.requireServer()
    const file = this.handoffFile
    if (file === null) throw new Error("external inference handoff is not configured")

    const credential = server.issueWorkerCredential(workerId)
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            version: 1,
            endpoint: server.url,
            workerId: credential.workerId,
            credential: { token: credential.token, expiresAt: credential.expiresAt },
            contractVersion: EXTERNAL_INFERENCE_CONTRACT_VERSION,
            tools: Object.values(EXTERNAL_INFERENCE_TOOLS),
            skill: "external-inference",
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      )
      this.setExternalOnly(true)
    } catch (error) {
      server.credentials.revokeAll()
      this.revokeAllLeases()
      this.externalOnly = false
      this.removeHandoff()
      throw error
    }

    return {
      path: file,
      endpoint: server.url,
      workerId: credential.workerId,
      expiresAt: credential.expiresAt,
      externalOnly: true,
    }
  }

  status(): ExternalInferenceJobStatus {
    return (
      this.host?.status() ?? {
        total: 0,
        pending: 0,
        leased: 0,
        committed: 0,
        failed: 0,
        skipped: 0,
        jobs: [],
      }
    )
  }

  statusView(): ExternalInferenceServiceStatus {
    return {
      ...this.status(),
      endpoint: this.endpoint(),
      handoffPath:
        this.handoffFile !== null && existsSync(this.handoffFile) ? this.handoffFile : null,
      externalOnly: this.externalOnly,
      activeCredentials: this.server?.credentials.activeCount() ?? 0,
    }
  }

  private removeHandoff(): void {
    if (this.handoffFile === null) return
    try {
      rmSync(this.handoffFile, { force: true })
    } catch {
      // 过期清单不能阻塞模式关闭或 vault teardown；凭据已先从内存撤销。
    }
  }
  private revokeAllLeases(): number {
    try {
      return this.host?.revokeAllWorkers() ?? 0
    } catch {
      // 凭据已经撤销；数据库异常时租约仍会按到期时间自然回收，不能反过来卡住停服。
      this.options.logger.warn("external inference lease revocation failed", {})
      return 0
    }
  }

  private requireServer(): ExternalInferenceMcpServer {
    if (this.server === null) throw new Error("external inference server is not attached")
    return this.server
  }
}

function mergeStatus(
  left: ExternalInferenceJobStatus,
  right: ExternalInferenceJobStatus,
): ExternalInferenceJobStatus {
  return {
    total: left.total + right.total,
    pending: left.pending + right.pending,
    leased: left.leased + right.leased,
    committed: left.committed + right.committed,
    failed: left.failed + right.failed,
    skipped: left.skipped + right.skipped,
    jobs: [...left.jobs, ...right.jobs].slice(0, 100),
  }
}
