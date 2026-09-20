import type { SqliteDatabase } from "../database.js"

export const EXTERNAL_INFERENCE_JOB_STATES = [
  "pending",
  "leased",
  "committed",
  "failed",
  "skipped",
] as const
export type ExternalInferenceJobState = (typeof EXTERNAL_INFERENCE_JOB_STATES)[number]

/**
 * T01 交付蒸馏（distillation）；T02 起图谱抽取（graph-extraction）复用同一
 * 协议：kl 建图 Phase B 的每次 LLM 抽取调用由宿主代理为外部 Job，worker 提交
 * 的补全文本经宿主校验后原样返回给 kl。
 */
export type ExternalInferenceDomainKind = "distillation" | "graph-extraction"

/**
 * 运行时协议的最小载荷。
 *
 * 这些类型故意放在 store 的公共边界：agent-runtime 负责传输，领域包负责
 * 组装/校验，三者不互相依赖。source/evidence 只出现在 claim 响应，不写进
 * `external_inference_jobs` 表。
 */
export const EXTERNAL_INFERENCE_CONTRACT_VERSION = "external-inference-v1"

export interface ExternalInferenceEvidence {
  ref: string
  sentAt: number
  author: "self" | "other"
  content: string
}

export interface ExternalInferenceClaim {
  job: ExternalInferenceJobRow
  prompt: string
  evidence: readonly ExternalInferenceEvidence[]
}

export interface ExternalInferenceSubmission {
  jobId: string
  submissionId: string
  contractVersion: string
  result: unknown
  usageTokens?: number | null
}

export interface ExternalInferenceSubmitResult {
  status: "committed" | "already_committed"
  job: ExternalInferenceJobRow
}

export interface ExternalInferenceWorkerHost {
  claim(input: {
    workerId: string
    leaseMs?: number
  }): ExternalInferenceClaim | null | Promise<ExternalInferenceClaim | null>
  heartbeat(input: {
    jobId: string
    workerId: string
    leaseMs?: number
  }): ExternalInferenceJobRow | null | Promise<ExternalInferenceJobRow | null>
  submit(
    input: ExternalInferenceSubmission & { workerId: string },
  ): ExternalInferenceSubmitResult | Promise<ExternalInferenceSubmitResult>
  status(): ExternalInferenceJobStatus | Promise<ExternalInferenceJobStatus>
}

export interface ExternalInferenceJobRow {
  id: string
  domainKind: ExternalInferenceDomainKind
  domainRef: string
  state: ExternalInferenceJobState
  attempts: number
  leaseOwner: string | null
  leaseExpiresAt: number | null
  promptVersion: string
  contractVersion: string
  submissionId: string | null
  submissionDigest: string | null
  resultCount: number | null
  usageTokens: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface ExternalInferenceJobStatus {
  total: number
  pending: number
  leased: number
  committed: number
  failed: number
  skipped: number
  jobs: ExternalInferenceJobRow[]
}

interface RawRow {
  id: string
  domain_kind: string
  domain_ref: string
  state: string
  attempts: number
  lease_owner: string | null
  lease_expires_at: number | null
  prompt_version: string
  contract_version: string
  submission_id: string | null
  submission_digest: string | null
  result_count: number | null
  usage_tokens: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

const STATE_SET = new Set<string>(EXTERNAL_INFERENCE_JOB_STATES)
const DOMAIN_SET = new Set<string>(["distillation", "graph-extraction"])
const DEFAULT_LEASE_MS = 10 * 60_000
const DEFAULT_MAX_ATTEMPTS = 3

export class ExternalInferenceJobError extends Error {
  constructor(
    readonly code:
      | "JOB_NOT_FOUND"
      | "JOB_ID_CONFLICT"
      | "LEASE_LOST"
      | "SUBMISSION_CONFLICT"
      | "INVALID_STATE"
      | "INVALID_SUBMISSION"
      | "UNKNOWN_EVIDENCE"
      | "TASK_NOT_FOUND"
      | "UNSUPPORTED_DOMAIN",
    message = code,
  ) {
    super(message)
    this.name = "ExternalInferenceJobError"
  }
}

function toRow(raw: RawRow): ExternalInferenceJobRow {
  return {
    id: raw.id,
    domainKind: DOMAIN_SET.has(raw.domain_kind)
      ? (raw.domain_kind as ExternalInferenceDomainKind)
      : "distillation",
    domainRef: raw.domain_ref,
    state: STATE_SET.has(raw.state) ? (raw.state as ExternalInferenceJobState) : "failed",
    attempts: raw.attempts,
    leaseOwner: raw.lease_owner,
    leaseExpiresAt: raw.lease_expires_at,
    promptVersion: raw.prompt_version,
    contractVersion: raw.contract_version,
    submissionId: raw.submission_id,
    submissionDigest: raw.submission_digest,
    resultCount: raw.result_count,
    usageTokens: raw.usage_tokens,
    lastError: raw.last_error,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

function required(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized === "") throw new TypeError(`${name} must not be empty`)
  return normalized
}

function boundedError(code: string): string {
  return code.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 120) || "UNKNOWN"
}

export class ExternalInferenceJobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  enqueue(
    input: {
      id: string
      domainKind: ExternalInferenceDomainKind
      domainRef: string
      promptVersion: string
      contractVersion: string
    },
    at: number,
  ): ExternalInferenceJobRow {
    const id = required(input.id, "id")
    if (!DOMAIN_SET.has(input.domainKind)) {
      throw new TypeError(`unsupported domainKind: ${String(input.domainKind)}`)
    }
    const domainRef = required(input.domainRef, "domainRef")
    const promptVersion = required(input.promptVersion, "promptVersion")
    const contractVersion = required(input.contractVersion, "contractVersion")
    const existingByDomain = this.db
      .prepare<
        [string, string],
        RawRow
      >("SELECT * FROM external_inference_jobs WHERE domain_kind = ? AND domain_ref = ?")
      .get(input.domainKind, domainRef)
    if (existingByDomain !== undefined) return toRow(existingByDomain)

    const existingById = this.findById(id)
    if (existingById !== null) {
      throw new ExternalInferenceJobError("JOB_ID_CONFLICT")
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO external_inference_jobs
           (id, domain_kind, domain_ref, state, attempts, prompt_version,
            contract_version, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .run(id, input.domainKind, domainRef, promptVersion, contractVersion, at, at)

    const row = this.findById(id)
    if (row === null) throw new ExternalInferenceJobError("JOB_ID_CONFLICT")
    if (row.domainKind !== input.domainKind || row.domainRef !== domainRef) {
      throw new ExternalInferenceJobError("JOB_ID_CONFLICT")
    }
    return row
  }

  findById(id: string): ExternalInferenceJobRow | null {
    const raw = this.db
      .prepare<[string], RawRow>("SELECT * FROM external_inference_jobs WHERE id = ?")
      .get(id)
    return raw === undefined ? null : toRow(raw)
  }

  list(limit = 100): ExternalInferenceJobRow[] {
    return this.db
      .prepare<[number], RawRow>(
        "SELECT * FROM external_inference_jobs ORDER BY created_at ASC, id ASC LIMIT ?",
      )
      .all(Math.max(1, Math.min(500, limit)))
      .map(toRow)
  }

  claim(
    workerId: string,
    now: number,
    leaseMs: number,
    maxAttempts = 3,
    domainKind?: ExternalInferenceDomainKind,
  ): ExternalInferenceJobRow | null {
    const owner = required(workerId, "workerId")
    const boundedLeaseMs = boundedLease(leaseMs)
    const attemptsLimit = boundedAttempts(maxAttempts)
    const transaction = this.db.transaction(() => {
      /**
       * 最后一次租约也可能被 worker 丢下。若只在 SELECT 里排除 attempts 已满的行，
       * 它会永远停在 leased：无法再领取，状态页却仍显示执行中。领取新任务前
       * 原子收束这些过期行，让失败可见且不把旧 owner 留在库里。
       */
      this.db
        .prepare(
          `UPDATE external_inference_jobs
              SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                  last_error = 'MAX_ATTEMPTS_EXCEEDED', updated_at = ?
            WHERE state = 'leased'
              AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
              AND attempts >= ?`,
        )
        .run(now, now, attemptsLimit)

      const domainClause = domainKind === undefined ? "" : " AND domain_kind = ?"
      const params: (number | string)[] =
        domainKind === undefined ? [attemptsLimit, now] : [attemptsLimit, now, domainKind]
      const raw = this.db
        .prepare<(number | string)[], RawRow>(
          `SELECT * FROM external_inference_jobs
             WHERE attempts < ?
               AND (
                 state = 'pending'
                 OR state = 'failed'
                 OR (state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
               )
               ${domainClause}
             ORDER BY created_at ASC, id ASC
             LIMIT 1`,
        )
        .get(...params)
      if (raw === undefined) return null

      this.db
        .prepare(
          `UPDATE external_inference_jobs
              SET state = 'leased', attempts = attempts + 1,
                  lease_owner = ?, lease_expires_at = ?, last_error = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(owner, now + boundedLeaseMs, now, raw.id)
      return this.findById(raw.id)
    })
    return transaction()
  }

  heartbeat(
    jobId: string,
    workerId: string,
    now: number,
    leaseMs: number,
  ): ExternalInferenceJobRow | null {
    const owner = required(workerId, "workerId")
    const boundedLeaseMs = boundedLease(leaseMs)
    const result = this.db
      .prepare(
        `UPDATE external_inference_jobs
            SET lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'leased' AND lease_owner = ?
            AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
      )
      .run(now + boundedLeaseMs, now, jobId, owner, now)
    return result.changes === 0 ? null : this.findById(jobId)
  }

  /**
   * 主动撤回指定 worker（或全部 worker）的租约。
   *
   * 仅撤凭据会让任务一直占着 `leased`，直到超时后才可重领；用户明确停止
   * 外部执行时不应还要等这段窗口，所以这里同步把租约退回 `pending`。
   */
  revokeLeases(at: number, workerId?: string): ExternalInferenceJobRow[] {
    const owner = workerId === undefined ? undefined : required(workerId, "workerId")
    const transaction = this.db.transaction(() => {
      const rows =
        owner === undefined
          ? this.db
              .prepare<
                [],
                RawRow
              >("SELECT * FROM external_inference_jobs WHERE state = 'leased' ORDER BY id ASC")
              .all()
          : this.db
              .prepare<
                [string],
                RawRow
              >("SELECT * FROM external_inference_jobs WHERE state = 'leased' AND lease_owner = ? ORDER BY id ASC")
              .all(owner)
      const update = this.db.prepare(
        `UPDATE external_inference_jobs
            SET state = 'pending', attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
                lease_owner = NULL, lease_expires_at = NULL,
                last_error = 'LEASE_REVOKED', updated_at = ?
          WHERE id = ? AND state = 'leased'`,
      )
      for (const row of rows) update.run(at, row.id)
      return rows.map((row) => ({
        ...toRow(row),
        state: "pending" as const,
        attempts: Math.max(0, row.attempts - 1),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "LEASE_REVOKED",
        updatedAt: at,
      }))
    })
    return transaction()
  }

  commit(
    input: {
      jobId: string
      workerId: string
      submissionId: string
      submissionDigest: string
      resultCount: number
      usageTokens: number | null
      at: number
    },
    applyDomainCommit: () => void,
  ): { status: "committed" | "already_committed"; job: ExternalInferenceJobRow } {
    const owner = required(input.workerId, "workerId")
    const submissionId = required(input.submissionId, "submissionId")
    const submissionDigest = required(input.submissionDigest, "submissionDigest")
    const transaction = this.db.transaction(() => {
      const current = this.findById(input.jobId)
      if (current === null) throw new ExternalInferenceJobError("JOB_NOT_FOUND")
      if (current.state === "committed") {
        if (
          current.submissionId === submissionId &&
          current.submissionDigest === submissionDigest
        ) {
          return { status: "already_committed" as const, job: current }
        }
        throw new ExternalInferenceJobError("SUBMISSION_CONFLICT")
      }
      this.assertLease(current, owner, input.at)
      if (!Number.isInteger(input.resultCount) || input.resultCount < 0) {
        throw new ExternalInferenceJobError("INVALID_STATE")
      }
      applyDomainCommit()
      this.db
        .prepare(
          `UPDATE external_inference_jobs
              SET state = 'committed', lease_owner = NULL, lease_expires_at = NULL,
                  submission_id = ?, submission_digest = ?, result_count = ?,
                  usage_tokens = ?, last_error = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          submissionId,
          submissionDigest,
          input.resultCount,
          input.usageTokens,
          input.at,
          input.jobId,
        )
      const committed = this.findById(input.jobId)
      if (committed === null) throw new ExternalInferenceJobError("JOB_NOT_FOUND")
      return { status: "committed" as const, job: committed }
    })
    return transaction()
  }

  fail(jobId: string, workerId: string, errorCode: string, at: number): ExternalInferenceJobRow {
    const current = this.findById(jobId)
    if (current === null) throw new ExternalInferenceJobError("JOB_NOT_FOUND")
    this.assertLease(current, required(workerId, "workerId"), at)
    this.db
      .prepare(
        `UPDATE external_inference_jobs
            SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                last_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(boundedError(errorCode), at, jobId)
    const failed = this.findById(jobId)
    if (failed === null) throw new ExternalInferenceJobError("JOB_NOT_FOUND")
    return failed
  }

  skip(jobId: string, workerId: string, reasonCode: string, at: number): ExternalInferenceJobRow {
    const current = this.findById(jobId)
    if (current === null) throw new ExternalInferenceJobError("JOB_NOT_FOUND")
    this.assertLease(current, required(workerId, "workerId"), at)
    this.db
      .prepare(
        `UPDATE external_inference_jobs
            SET state = 'skipped', lease_owner = NULL, lease_expires_at = NULL,
                last_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(boundedError(reasonCode), at, jobId)
    const skipped = this.findById(jobId)
    if (skipped === null) throw new ExternalInferenceJobError("JOB_NOT_FOUND")
    return skipped
  }

  status(limit = 100): ExternalInferenceJobStatus {
    const counts = this.db
      .prepare<
        [],
        { state: string; count: number }
      >("SELECT state, count(*) AS count FROM external_inference_jobs GROUP BY state")
      .all()
    const status: ExternalInferenceJobStatus = {
      total: 0,
      pending: 0,
      leased: 0,
      committed: 0,
      failed: 0,
      skipped: 0,
      jobs: this.list(limit),
    }
    for (const row of counts) {
      if (!STATE_SET.has(row.state)) continue
      const state = row.state as ExternalInferenceJobState
      status[state] = row.count
      status.total += row.count
    }
    return status
  }

  private assertLease(job: ExternalInferenceJobRow, workerId: string, now: number): void {
    if (
      job.state !== "leased" ||
      job.leaseOwner !== workerId ||
      job.leaseExpiresAt === null ||
      job.leaseExpiresAt <= now
    ) {
      throw new ExternalInferenceJobError("LEASE_LOST")
    }
  }
}

function boundedLease(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1_000, Math.min(30 * 60_000, Math.floor(value)))
    : DEFAULT_LEASE_MS
}

function boundedAttempts(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(10, Math.floor(value)))
    : DEFAULT_MAX_ATTEMPTS
}
