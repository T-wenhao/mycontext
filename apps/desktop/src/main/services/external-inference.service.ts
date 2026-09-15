import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  EXTERNAL_INFERENCE_TOOLS,
  ExternalInferenceMcpServer,
  type ExternalInferenceCredential,
} from "@mycontext/agent-runtime"
import { ExternalInferenceDistillHost } from "@mycontext/distill"
import type { Clock, Logger } from "@mycontext/kernel"
import { EXTERNAL_INFERENCE_CONTRACT_VERSION } from "@mycontext/store"
import type {
  ExternalInferenceJobRow,
  ExternalInferenceJobStatus,
  SqliteDatabase,
} from "@mycontext/store"

export interface ExternalInferenceServiceOptions {
  clock: Clock
  logger: Logger
  getForbiddenTerms?: () => readonly string[]
  getConversationScope?: () => {
    restricted: boolean
    allow: readonly string[]
  }
  onExternalOnlyEnabled?: () => void
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
    const server = new ExternalInferenceMcpServer({
      host,
      clock: this.options.clock,
      logger: this.options.logger,
    })

    try {
      await server.start()
      this.host = host
      this.server = server
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
    this.externalOnly = false
    this.handoffFile = null
    await server?.stop()
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
        this.options.onExternalOnlyEnabled?.()
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
