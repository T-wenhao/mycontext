import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Clock, Logger } from "@mycontext/kernel"
import {
  EXTERNAL_INFERENCE_CONTRACT_VERSION,
  ExternalInferenceJobError,
  type ExternalInferenceWorkerHost,
} from "@mycontext/store"

export const EXTERNAL_INFERENCE_MCP_PATH = "/mcp"
export const EXTERNAL_INFERENCE_CHAT_PATH = "/v1/chat/completions"
export const EXTERNAL_INFERENCE_BROKER_WORKER_ID = "kl-graph-extraction-broker"
export const EXTERNAL_INFERENCE_TOOLS = {
  claim: "external_inference_claim",
  heartbeat: "external_inference_heartbeat",
  submit: "external_inference_submit",
  status: "external_inference_status",
} as const

export interface ExternalInferenceCredential {
  workerId: string
  token: string
  expiresAt: number
}

export interface ExternalInferenceCredentialOptions {
  clock: Clock
  ttlMs?: number
}

/**
 * External worker 凭据与已有 search/persona token 分开签发、分开撤销。
 *
 * 这是本机运行时凭据，不落库；进程重启后失效。worker 只能拿到一个
 * purpose-specific bearer，协议层不会接受 vault 路径或数据库连接参数。
 */
export class ExternalInferenceCredentialAuthority {
  private readonly issued = new Map<string, ExternalInferenceCredential>()
  private readonly ttlMs: number

  constructor(private readonly options: ExternalInferenceCredentialOptions) {
    this.ttlMs = boundedTtl(options.ttlMs ?? 60 * 60_000)
  }

  issue(workerId: string): ExternalInferenceCredential {
    const normalized = requireString(workerId, "workerId")
    this.revoke(normalized)
    const credential: ExternalInferenceCredential = {
      workerId: normalized,
      token: randomBytes(32).toString("base64url"),
      expiresAt: this.options.clock.now() + this.ttlMs,
    }
    this.issued.set(credential.token, credential)
    return credential
  }

  verify(token: string): string | null {
    const record = this.issued.get(token)
    if (record === undefined) return null
    if (this.options.clock.now() >= record.expiresAt) {
      this.issued.delete(token)
      return null
    }
    // Map 查询已绑定对应记录；这里再做恒定时间比较，避免热路径退化成普通字符串比较。
    if (!sameSecret(token, record.token)) return null
    return record.workerId
  }

  revoke(workerId: string): void {
    const normalized = workerId.trim()
    for (const [token, record] of this.issued) {
      if (record.workerId === normalized) this.issued.delete(token)
    }
  }

  revokeAll(): void {
    this.issued.clear()
  }

  activeCount(): number {
    const now = this.options.clock.now()
    let count = 0
    for (const [token, record] of this.issued) {
      if (now >= record.expiresAt) this.issued.delete(token)
      else count += 1
    }
    return count
  }
}

export interface ExternalInferenceMcpServerOptions {
  host: ExternalInferenceWorkerHost
  clock: Clock
  logger?: Logger
  /** 0 表示让操作系统分配一个可用的回环端口。 */
  port?: number
  credentials?: ExternalInferenceCredentialAuthority
  maxBodyBytes?: number
  /**
   * 图谱抽取代理（T02）：external-only 模式下，kl 建图 Phase B 的 litellm
   * 抽取调用打到 `/v1/chat/completions`，由实现方把请求体发布为
   * graph-extraction 外部 Job，等待 worker 提交并校验后原样返回补全文本。
   * 实现方自己负责幂等（按请求内容去重）与等待超时。
   */
  chatBroker?: {
    /** 处理一条 chat completion 请求，返回透传给调用方的状态码与响应体。 */
    handleChatCompletion(body: unknown): Promise<{ status: number; body: unknown }>
  }
}

interface RpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

interface RpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: { code: string } }
}

const JSON_RPC_INVALID_REQUEST = -32600
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INVALID_PARAMS = -32602
const JSON_RPC_INTERNAL_ERROR = -32603
const DEFAULT_MAX_BODY_BYTES = 512 * 1024

/**
 * 给外部推理 worker 使用的本机 MCP 兼容 JSON-RPC 服务。
 *
 * 这里只注册 Skill 所需的最小接口，不提供通用数据库或文件系统工具，
 * 让 worker 无法绕过宿主授权边界。
 */
export class ExternalInferenceMcpServer {
  private server: Server | null = null
  readonly credentials: ExternalInferenceCredentialAuthority

  constructor(private readonly options: ExternalInferenceMcpServerOptions) {
    this.credentials = options.credentials ?? new ExternalInferenceCredentialAuthority(options)
  }

  get port(): number {
    const address = this.server?.address()
    return typeof address === "object" && address !== null ? address.port : 0
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}${EXTERNAL_INFERENCE_MCP_PATH}`
  }

  issueWorkerCredential(workerId: string): ExternalInferenceCredential {
    return this.credentials.issue(workerId)
  }

  start(): Promise<number> {
    if (this.server !== null) return Promise.resolve(this.port)
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        this.handle(request, response).catch((error: unknown) => {
          this.options.logger?.warn("external inference request failed", {
            code: errorCode(error),
          })
          if (error instanceof ProtocolError) {
            const code =
              error.code === "METHOD_NOT_FOUND"
                ? JSON_RPC_METHOD_NOT_FOUND
                : JSON_RPC_INVALID_REQUEST
            this.writeRpcError(response, null, code, error.code.toLowerCase(), error.code)
          } else {
            this.writeJson(response, 500, { error: "internal" })
          }
        })
      })
      server.on("error", reject)
      server.listen(this.options.port ?? 0, "127.0.0.1", () => {
        this.server = server
        resolve(this.port)
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    if (server === null) {
      this.credentials.revokeAll()
      return Promise.resolve()
    }
    this.server = null
    this.credentials.revokeAll()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === EXTERNAL_INFERENCE_CHAT_PATH) {
      await this.handleChatCompletion(request, response)
      return
    }
    if (request.url !== EXTERNAL_INFERENCE_MCP_PATH) {
      this.writeJson(response, 404, { error: "not_found" })
      return
    }
    if (request.method !== "POST") {
      this.writeJson(response, 405, { error: "method_not_allowed" })
      return
    }
    // 该端点只允许本机 worker；浏览器页面即使在本机也不能跨 Origin 调用。
    if (request.headers.origin !== undefined) {
      this.writeJson(response, 403, { error: "forbidden_origin" })
      return
    }

    const workerId = this.authorize(request)
    if (workerId === null) {
      this.writeJson(response, 401, { error: "unauthorized" })
      return
    }

    const body = await readJsonBody(request, this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
    const rpc = parseRpcRequest(body)
    if (rpc === null) {
      this.writeRpcError(
        response,
        null,
        JSON_RPC_INVALID_REQUEST,
        "invalid_request",
        "INVALID_REQUEST",
      )
      return
    }

    const id =
      rpc.id === null || typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : null
    const method = typeof rpc.method === "string" ? rpc.method : null
    if (method === null) {
      this.writeRpcError(
        response,
        id,
        JSON_RPC_INVALID_REQUEST,
        "invalid_request",
        "INVALID_REQUEST",
      )
      return
    }
    // MCP notification 没有响应体，避免把它误当普通 RPC 返回。
    if (method.startsWith("notifications/")) {
      response.writeHead(202)
      response.end()
      return
    }

    try {
      const result = await this.dispatch(method, rpc.params, workerId)
      this.writeJson(response, 200, { jsonrpc: "2.0", id, result } satisfies RpcResponse)
    } catch (error) {
      const code = errorCode(error)
      const rpcCode =
        error instanceof ProtocolError
          ? error.code === "METHOD_NOT_FOUND"
            ? JSON_RPC_METHOD_NOT_FOUND
            : JSON_RPC_INVALID_PARAMS
          : error instanceof ExternalInferenceJobError
            ? JSON_RPC_INVALID_PARAMS
            : JSON_RPC_INTERNAL_ERROR
      this.options.logger?.warn("external inference operation rejected", { method, code })
      this.writeRpcError(response, id, rpcCode, code.toLowerCase(), code)
    }
  }

  /**
   * 图谱抽取代理入口：kl 的 litellm 抽取调用（OpenAI chat completions 形状）。
   *
   * 与 /mcp 一样只允许本机 + Bearer（broker 用独立的 purpose credential，由
   * desktop 组装 kl 环境时注入），拒绝带 Origin 的浏览器跨源调用。请求体上限
   * 与 MCP 一致；未配置 broker 时保持 404，协议面不扩大。
   */
  private async handleChatCompletion(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.options.chatBroker === undefined) {
      this.writeJson(response, 404, { error: "not_found" })
      return
    }
    if (request.method !== "POST") {
      this.writeJson(response, 405, { error: "method_not_allowed" })
      return
    }
    if (request.headers.origin !== undefined) {
      this.writeJson(response, 403, { error: "forbidden_origin" })
      return
    }
    const workerId = this.authorize(request)
    if (workerId === null) {
      this.writeJson(response, 401, { error: "unauthorized" })
      return
    }
    const body = await readJsonBody(request, this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
    try {
      const handled = await this.options.chatBroker.handleChatCompletion(body)
      this.writeJson(response, handled.status, handled.body)
    } catch (error) {
      this.options.logger?.warn("external inference chat broker failed", {
        code: errorCode(error),
      })
      this.writeJson(response, 500, { error: "internal" })
    }
  }

  private async dispatch(method: string, params: unknown, workerId: string): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mycontext-external-inference", version: "1" },
      }
    }
    if (method === "tools/list") {
      return { tools: TOOL_DEFINITIONS }
    }
    if (method !== "tools/call") {
      throw new ProtocolError("METHOD_NOT_FOUND")
    }

    const call = asRecord(params)
    const name = requireString(call.name, "name")
    const args = asRecord(call.arguments)
    try {
      if (name === EXTERNAL_INFERENCE_TOOLS.claim) {
        assertOptionalWorker(args.workerId, workerId)
        const claim = await this.options.host.claim({
          workerId,
          ...(typeof args.leaseMs === "number" ? { leaseMs: args.leaseMs } : {}),
        })
        return toolResult(claim)
      }
      if (name === EXTERNAL_INFERENCE_TOOLS.heartbeat) {
        assertOptionalWorker(args.workerId, workerId)
        const jobId = requireString(args.jobId, "jobId")
        const heartbeat = await this.options.host.heartbeat({
          jobId,
          workerId,
          ...(typeof args.leaseMs === "number" ? { leaseMs: args.leaseMs } : {}),
        })
        return toolResult(heartbeat)
      }
      if (name === EXTERNAL_INFERENCE_TOOLS.submit) {
        assertOptionalWorker(args.workerId, workerId)
        const jobId = requireString(args.jobId, "jobId")
        const submissionId = requireString(args.submissionId, "submissionId")
        const contractVersion = requireString(args.contractVersion, "contractVersion")
        if (contractVersion !== EXTERNAL_INFERENCE_CONTRACT_VERSION) {
          throw new ProtocolError("UNSUPPORTED_CONTRACT")
        }
        if (!("result" in args)) throw new ProtocolError("MISSING_RESULT")
        const serialized = JSON.stringify(args.result)
        if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
          throw new ProtocolError("RESULT_TOO_LARGE")
        }
        const submitted = await this.options.host.submit({
          workerId,
          jobId,
          submissionId,
          contractVersion,
          result: args.result,
          usageTokens:
            typeof args.usageTokens === "number" && Number.isFinite(args.usageTokens)
              ? args.usageTokens
              : null,
        })
        return toolResult(submitted)
      }
      if (name === EXTERNAL_INFERENCE_TOOLS.status) {
        return toolResult(await this.options.host.status())
      }
      throw new ProtocolError("UNKNOWN_TOOL")
    } catch (error) {
      return toolError(errorCode(error))
    }
  }

  private authorize(request: IncomingMessage): string | null {
    const header = request.headers.authorization ?? ""
    if (!header.startsWith("Bearer ")) return null
    return this.credentials.verify(header.slice(7))
  }

  private writeRpcError(
    response: ServerResponse,
    id: string | number | null,
    code: number,
    message: string,
    stableCode: string,
  ): void {
    this.writeJson(response, 200, {
      jsonrpc: "2.0",
      id,
      error: { code, message, data: { code: stableCode } },
    } satisfies RpcResponse)
  }

  private writeJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    })
    response.end(payload)
  }
}

const TOOL_DEFINITIONS = [
  {
    name: EXTERNAL_INFERENCE_TOOLS.claim,
    description:
      "Claim one prepared External Inference Job and receive its bounded prompt and evidence.",
    inputSchema: { type: "object", properties: { leaseMs: { type: "number" } } },
  },
  {
    name: EXTERNAL_INFERENCE_TOOLS.heartbeat,
    description: "Renew the Worker Lease for a claimed job.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: { jobId: { type: "string" }, leaseMs: { type: "number" } },
    },
  },
  {
    name: EXTERNAL_INFERENCE_TOOLS.submit,
    description: "Submit an untrusted structured result for host validation and commit.",
    inputSchema: {
      type: "object",
      required: ["jobId", "submissionId", "contractVersion", "result"],
      properties: {
        jobId: { type: "string" },
        submissionId: { type: "string" },
        contractVersion: { type: "string", const: EXTERNAL_INFERENCE_CONTRACT_VERSION },
        result: { type: "object" },
        usageTokens: { type: ["number", "null"] },
      },
    },
  },
  {
    name: EXTERNAL_INFERENCE_TOOLS.status,
    description: "Inspect job metadata and lifecycle counts without source content.",
    inputSchema: { type: "object", properties: {} },
  },
] as const

class ProtocolError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "ProtocolError"
  }
}

function parseRpcRequest(body: unknown): RpcRequest | null {
  const record = asRecordOrNull(body)
  if (record === null || record.jsonrpc !== "2.0" || typeof record.method !== "string") return null
  return record
}

function asRecord(value: unknown): Record<string, unknown> {
  return asRecordOrNull(value) ?? {}
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ProtocolError(`MISSING_${name.toUpperCase()}`)
  return value.trim()
}

function assertOptionalWorker(value: unknown, expected: string): void {
  if (value !== undefined && value !== expected) throw new ProtocolError("WORKER_MISMATCH")
}

function toolResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }] }
}

function toolError(code: string): { isError: true; content: [{ type: "text"; text: string }] } {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] }
}

function errorCode(error: unknown): string {
  if (error instanceof ExternalInferenceJobError) return error.code
  if (error instanceof ProtocolError) return error.code
  return "HOST_ERROR"
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function boundedTtl(value: number): number {
  return Number.isFinite(value)
    ? Math.max(60_000, Math.min(24 * 60 * 60_000, Math.floor(value)))
    : 60 * 60_000
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new ProtocolError("REQUEST_TOO_LARGE")
    chunks.push(buffer)
  }
  if (chunks.length === 0) throw new ProtocolError("EMPTY_REQUEST")
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new ProtocolError("INVALID_JSON")
  }
}
