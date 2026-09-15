/**
 * 模型网关的运行时配置 —— **单一真源**。
 *
 * 设置面板、onboarding 第 2 步、以及隐藏的「高级 AI」面板，改的都是这一份。
 * 落 `control.sqlite` 的 `app_settings`（应用级，不随账号切换）+ keychain（apiKey）。
 *
 * ## 三层解析
 *
 * 每个字段：`用户在设置里存的(非空) ?? kernel loadConfig 的默认层`。
 * loadConfig 内部已经是 `内置默认 < .env < 真实环境变量` —— 那整套作为「默认层」
 * 原样保留，用户存的覆盖值叠加在最上面。所以：开发者只配 `.env` 零 UI 就能跑，
 * 打包用户在设置里存的值优先。
 *
 * ## KL 三项的回退
 *
 * `kl*` 留空表示「回退主配置」。`klEffective()` 给出**真正会用到**的值
 * （已解析回退），供 UI 显示「当前实际用 X」，也供 kl-server 的 gateway getter 取。
 *
 * ## 为什么要 seed process.env
 *
 * 两条子进程路（opencode 的 `resolveGatewayModelConfig(process.env)`、
 * kl 的 `ANTHROPIC_AUTH_TOKEN`）都是**每次 spawn 现读 process.env**。
 * 启动时 seed、改配置时 re-seed，这两条路就自动变成「下次 spawn 生效」——
 * 一行消费点都不用改。见 `seedProcessEnv` 的注释。
 */
import type { LoadedConfig, Logger } from "@mycontext/kernel"
import {
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_EMBED_SEND_DIMENSIONS,
  type ModelProvider,
  type RuntimeConfigView,
  type RuntimeConfigApply,
  type RuntimeConfigProbe,
} from "@mycontext/ipc-contract"
import type { SettingsRepository } from "@mycontext/store"

/**
 * embedding 网关 base 规整成 OpenAI 兼容形态：**恰好以一个 `/v1` 结尾**。
 *
 * litellm 把 base 原样交给 OpenAI SDK，SDK 视其为 API 根并拼 `/embeddings`；
 * SDK 自己的默认根是 `https://api.openai.com/v1` —— `/v1` 属于根本身。
 * DashScope 只提供 `…/compatible-mode/v1/embeddings`，所以：
 * - 缺 `/v1` → 404（litellm.NotFoundError: OpenAIException - Error code: 404）
 * - 用户配的 URL 已带 `/v1` 而这里再拼一个 → `/v1/v1` 同样 404（实测事故）
 *
 * 于是把结尾任意个 `/v1` 收敛成一个，缺则补一个。与 kl 侧
 * `kl_graph/utils/litellm_config.py` 的 `openai_base_url` 同口径
 * （kl 侧对一切入口做防御性兜底，这里是源头修正）。
 *
 * ★ 归一化对**用户单独填的 embedding 地址**同样适用 —— 用户手填时同样会
 * 带不带 `/v1` 都有，这个坑不因为字段换了来源就消失。
 */
export function openAiEmbedBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "")
  if (trimmed === "") return ""
  return `${trimmed.replace(/(\/v1)+$/, "")}/v1`
}

/** 落库的非敏感覆盖项（apiKey 走 keychain，不在这里）。 */
interface StoredOverrides {
  llmBaseUrl?: string
  modelMain?: string
  /** 主模型协议覆盖。缺省 = 走默认层（kernel 默认 openai）。 */
  mainProvider?: ModelProvider
  embedModel?: string
  /**
   * embedding 专用地址覆盖。缺省 = 沿用 KL 地址（改动前的唯一行为）。
   *
   * ★ 这三项（base/dim/sendDimensions）**故意不进 kernel 的 `MYCONTEXT_*` 默认层** ——
   * 它们只在 UI 里配。理由：默认层那套（内置 < .env < 真实 env）的价值是"开发者
   * 零 UI 能跑"，而这三项的正确值**取决于用户接的是哪个 embedding 服务**，
   * 没有一个"对所有人都对"的 env 默认可言。留空时回退到 contract 里的内置常量，
   * 与改动前写死的行为逐字一致。
   */
  embedBaseUrl?: string
  embeddingDim?: number
  embedSendDimensions?: boolean
  klLlmBaseUrl?: string
  klModelMain?: string
  /** 知识库协议覆盖。缺省 = 走默认层（kernel 默认 openai）。 */
  klProvider?: ModelProvider
}

/** 进程内消费者要的明文解析结果。 */
export interface ResolvedRuntimeConfig {
  llmBaseUrl: string
  llmApiKey: string
  modelMain: string
  /** 主模型协议（默认层 ?? 用户覆盖）。opencode 子进程与直连 LlmClient 都按它切传输。 */
  mainProvider: ModelProvider
  embedModel: string
  /** KL 三项已解析回退后的**实际生效**值 */
  klBaseUrl: string
  klApiKey: string
  klModel: string
  /** KL 抽取协议（默认层 ?? 用户覆盖）。传给 kl 的 `KL_LLM_PROVIDER`。 */
  klProvider: ModelProvider
  /**
   * embedding 那一路**实际会用**的地址，已归一化到恰好一个 `/v1`。
   *
   * 解析顺序：用户单独填的（非空）→ 沿用 `klBaseUrl`。后者是改动前的唯一行为，
   * 所以没配过这一项的老用户拿到的值与改动前逐字一致。
   */
  embedBaseUrl: string
  /**
   * embedding 那一路**实际会用**的密钥（用户单独填的 ?? 沿用 KL 那把）。
   *
   * ★ 与 `embedBaseUrl` 必须成对回退：地址指到别的 host 而 key 还是 KL 那把
   * 基本必然 401，而那个 401 只会表现为建图时 embedding 批次反复重试。
   */
  embedApiKey: string
  /** embedding 维度（用户配的 ?? 内置默认 2048）。传给 kl 的 `KL_EMBEDDING_DIM`。 */
  embeddingDim: number
  /** 是否显式发 `dimensions`（用户配的 ?? 内置默认 true）。 */
  embedSendDimensions: boolean
}

/** kl-server 每次 spawn 真正收到的一份脱离 UI 形态的配置快照。 */
export interface ResolvedKlGatewayConfig {
  llmBaseUrl: string
  llmProvider: ModelProvider
  llmModel: string
  embedBaseUrl: string
  embedModel: string
  apiKey: string
  embedApiKey: string
  embeddingDim: number
  sendDimensions: boolean
}

/** 保存输入：字符串三态见 contract 的 saveRuntimeConfigInputSchema。 */
export interface SaveRuntimeConfigPatch {
  llmBaseUrl?: string | undefined
  llmApiKey?: string | null | undefined
  modelMain?: string | undefined
  /** 主模型协议。undefined = 不改。 */
  mainProvider?: ModelProvider | undefined
  embedModel?: string | undefined
  klLlmBaseUrl?: string | undefined
  klLlmApiKey?: string | null | undefined
  klModelMain?: string | undefined
  /** 知识库协议。undefined = 不改。 */
  klProvider?: ModelProvider | undefined
  /** embedding 专用地址。空串 = 清空（回退沿用 KL 地址）。 */
  embedBaseUrl?: string | undefined
  /** embedding 专用密钥。undefined = 不改，null/"" = 清空（回退沿用 KL 那把）。 */
  embedApiKey?: string | null | undefined
  /** embedding 维度。null = 清空（回退内置默认）。 */
  embeddingDim?: number | null | undefined
  /** 是否显式发 `dimensions`。null = 清空（回退内置默认）。 */
  embedSendDimensions?: boolean | null | undefined
}

export interface RuntimeConfigServiceOptions {
  settings: SettingsRepository
  logger: Logger
  secretStore: {
    read(key: string): string | null
    write(key: string, value: string): void
  }
  /** 默认层：kernel 的 loadConfig（含 .env / 真实 env） */
  defaults: LoadedConfig
  /** 便于测试注入；缺省用真实 process.env */
  env?: NodeJS.ProcessEnv
  /** 探测网关用的 fetch。注入以便测试不打真网络 */
  fetchImpl?: typeof fetch
}

const SETTING_KEY = "runtime_llm_config"
const LLM_API_KEY_SECRET = "runtime_llm_api_key"
const KL_API_KEY_SECRET = "runtime_kl_api_key"
/**
 * embedding 专用密钥的 keychain 槽位。
 *
 * ★ 它**不在** `StoredOverrides` 里 —— 密钥一律走 keychain，落库那份只放
 * 非敏感覆盖项（与 `llmApiKey`/`klLlmApiKey` 同一条规矩）。
 */
const EMBED_API_KEY_SECRET = "runtime_embed_api_key"

/** 旧的隐藏高级面板存储位（首次运行 adopt 用）。 */
const LEGACY_ADVANCED_KEY = "advanced_ai_config"
const LEGACY_ADVANCED_API_KEY_SECRET = "advanced_ai_api_key"

type FieldSource = RuntimeConfigView["llmBaseUrl"]["source"]

export class RuntimeConfigService {
  private readonly listeners = new Set<(resolved: ResolvedRuntimeConfig) => void>()
  /** seed 前的真实环境值；GUI 清空时恢复，避免应用自己写入的别名反过来接管配置。 */
  private readonly envBeforeSeed = new Map<string, string | undefined>()

  constructor(private readonly options: RuntimeConfigServiceOptions) {
    this.adoptLegacyIfNeeded()
  }

  /** 探测用的 fetch（测试可注入）。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  private envValue(...keys: string[]): string {
    const env = this.options.env ?? process.env
    for (const key of keys) {
      const value = env[key]?.trim() ?? ""
      if (value !== "") return value
    }
    return ""
  }

  private restoreSeededEnv(...keys: string[]): void {
    const env = this.options.env ?? process.env
    for (const key of keys) {
      if (!this.envBeforeSeed.has(key)) continue
      const original = this.envBeforeSeed.get(key)
      if (original === undefined) delete env[key]
      else env[key] = original
      this.envBeforeSeed.delete(key)
    }
  }

  /** 明文解析结果。进程内消费者（LlmHolder、kl gateway getter）用它。 */
  resolved(): ResolvedRuntimeConfig {
    const stored = this.readStored()
    const d = this.options.defaults.values

    const pick = (override: string | undefined, fallback: string): string => {
      const trimmed = override?.trim() ?? ""
      return trimmed !== "" ? trimmed : fallback
    }

    const configuredLlmBaseUrl = pick(stored.llmBaseUrl, d.llmBaseUrl)
    const llmBaseUrl =
      configuredLlmBaseUrl !== "" ? configuredLlmBaseUrl : this.envValue("ANTHROPIC_BASE_URL")
    const configuredLlmApiKey = this.options.secretStore.read(LLM_API_KEY_SECRET) ?? d.llmApiKey
    const llmApiKey =
      configuredLlmApiKey.trim() !== ""
        ? configuredLlmApiKey
        : this.envValue("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY")
    const modelMain = pick(stored.modelMain, d.modelMain)
    const mainProvider: ModelProvider = stored.mainProvider ?? d.modelProvider
    const embedModel = pick(stored.embedModel, d.embedModel)

    // KL 三项：存的(非空) ?? env 默认层 ?? 回退主配置。
    const klBaseRaw = pick(stored.klLlmBaseUrl, d.klLlmBaseUrl)
    const klApiRaw = this.options.secretStore.read(KL_API_KEY_SECRET) ?? d.klLlmApiKey
    const klModelRaw = pick(stored.klModelMain, d.klModelMain)
    /**
     * ★ 协议独立于 base/model/key 的「回退主配置」逻辑：`用户存的 ?? 默认层`
     * （kernel 默认 openai，见 config.ts 的长注释）。主模型与知识库各自一份，
     * 两条子进程/直连路都按各自的 provider 切传输。
     */
    const klProvider: ModelProvider = stored.klProvider ?? d.klProvider

    const klBaseUrl =
      klBaseRaw.trim() !== ""
        ? klBaseRaw
        : llmBaseUrl.trim() !== ""
          ? llmBaseUrl
          : this.envValue("KL_LLM_BASE_URL")
    /**
     * ★ embedding 地址：用户单独填的优先，否则沿用 KL 地址 —— 后者是改动前
     * 那句 `openAiEmbedBaseUrl(base)` 的原样保留，所以没动过这一项的用户
     * 完全感知不到这次改动。两条分支都过归一化（用户手填也会带不带 `/v1`）。
     */
    const embedBaseRaw = stored.embedBaseUrl?.trim() ?? ""
    const embedBaseUrl = openAiEmbedBaseUrl(
      embedBaseRaw !== ""
        ? embedBaseRaw
        : klBaseUrl.trim() !== ""
          ? klBaseUrl
          : this.envValue("KL_EMBED_BASE_URL"),
    )
    /**
     * ★ embedding 密钥与地址**同构回退**：用户单独填的优先，否则沿用 KL 那把
     * （改动前的唯一行为）。两者各自独立回退是刻意的 —— 有人会"换 host 但
     * 复用同一把 key"（同一家的另一个域名），也有人"同 host 不同 key"。
     * 绑成一体的话其中一种就表达不出来。
     */
    const klApiKey =
      klApiRaw.trim() !== ""
        ? klApiRaw
        : llmApiKey.trim() !== ""
          ? llmApiKey
          : this.envValue(klProvider === "anthropic" ? "ANTHROPIC_AUTH_TOKEN" : "OPENAI_API_KEY")
    const embedKeyRaw = this.options.secretStore.read(EMBED_API_KEY_SECRET) ?? ""

    return {
      llmBaseUrl,
      llmApiKey,
      modelMain,
      mainProvider,
      embedModel,
      klBaseUrl,
      klApiKey,
      klModel: klModelRaw.trim() !== "" ? klModelRaw : modelMain,
      klProvider,
      embedBaseUrl,
      embedApiKey:
        embedKeyRaw.trim() !== ""
          ? embedKeyRaw
          : klApiKey.trim() !== ""
            ? klApiKey
            : this.envValue("KL_EMBED_API_KEY"),
      embeddingDim: stored.embeddingDim ?? DEFAULT_EMBEDDING_DIM,
      embedSendDimensions: stored.embedSendDimensions ?? DEFAULT_EMBED_SEND_DIMENSIONS,
    }
  }

  /**
   * GUI 的最终摘要与 kl-server 启动都必须读这一份，避免启动层再叠隐藏覆盖。
   * `KL_LLM_MODEL` 不在这里另开优先级；开发者应使用受配置系统追踪来源的
   * `MYCONTEXT_KL_MODEL_MAIN`，而 GUI 保存值始终优先于默认层。
   */
  resolvedKlGateway(): ResolvedKlGatewayConfig {
    const resolved = this.resolved()
    return {
      llmBaseUrl: resolved.klBaseUrl,
      llmProvider: resolved.klProvider,
      llmModel: resolved.klModel,
      embedBaseUrl: resolved.embedBaseUrl,
      embedModel: resolved.embedModel,
      apiKey: resolved.klApiKey,
      embedApiKey: resolved.embedApiKey,
      embeddingDim: resolved.embeddingDim,
      sendDimensions: resolved.embedSendDimensions,
    }
  }

  /** 脱敏视图。apiKey 只给「是否已配置」+ 后 4 位。 */
  view(): RuntimeConfigView {
    const stored = this.readStored()
    const d = this.options.defaults
    const resolved = this.resolved()
    const gateway = this.resolvedKlGateway()

    const plain = (
      override: string | undefined,
      key: "llmBaseUrl" | "modelMain" | "embedModel" | "klLlmBaseUrl" | "klModelMain",
    ): { value: string; source: FieldSource } => {
      const trimmed = override?.trim() ?? ""
      if (trimmed !== "") return { value: trimmed, source: "user" }
      return { value: d.values[key], source: this.defaultSource(key) }
    }

    const secret = (
      secretKey: string,
      defaultKey: "llmApiKey" | "klLlmApiKey",
    ): { configured: boolean; tail: string | null; source: FieldSource } => {
      const fromSecret = this.options.secretStore.read(secretKey)
      if (fromSecret !== null && fromSecret !== "") {
        return {
          configured: true,
          tail: fromSecret.length >= 4 ? fromSecret.slice(-4) : null,
          source: "user",
        }
      }
      const fromDefault = d.values[defaultKey]
      return {
        configured: fromDefault !== "",
        // 默认层的 key（env/.env 明文）不回显后 4 位：那也是密钥
        tail: null,
        source: this.defaultSource(defaultKey),
      }
    }

    const llmBaseUrl = plain(stored.llmBaseUrl, "llmBaseUrl")
    if (llmBaseUrl.value.trim() === "" && resolved.llmBaseUrl !== "") {
      llmBaseUrl.value = resolved.llmBaseUrl
      llmBaseUrl.source = "env"
    }
    const llmApiKey = secret(LLM_API_KEY_SECRET, "llmApiKey")
    if (!llmApiKey.configured && resolved.llmApiKey !== "") {
      llmApiKey.configured = true
      llmApiKey.source = "env"
    }
    const modelMain = plain(stored.modelMain, "modelMain")
    const mainProvider = {
      value: resolved.mainProvider,
      source: stored.mainProvider !== undefined ? "user" : this.defaultSource("modelProvider"),
    } as const
    const embedModel = plain(stored.embedModel, "embedModel")
    const klLlmBaseUrl = plain(stored.klLlmBaseUrl, "klLlmBaseUrl")
    const klLlmApiKey = secret(KL_API_KEY_SECRET, "klLlmApiKey")
    const klModelMain = plain(stored.klModelMain, "klModelMain")
    const klProvider = {
      value: resolved.klProvider,
      source: stored.klProvider !== undefined ? "user" : this.defaultSource("klProvider"),
    } as const
    const embedBaseUrl = {
      value: stored.embedBaseUrl ?? "",
      source: stored.embedBaseUrl !== undefined ? ("user" as const) : ("default" as const),
    }
    const ownEmbedKey = this.options.secretStore.read(EMBED_API_KEY_SECRET)
    const embedApiKey =
      ownEmbedKey !== null && ownEmbedKey !== ""
        ? {
            configured: true,
            tail: ownEmbedKey.length >= 4 ? ownEmbedKey.slice(-4) : null,
            source: "user" as const,
          }
        : {
            configured: gateway.embedApiKey !== "",
            tail: null,
            source: "default" as const,
          }
    const embeddingDim = {
      value: resolved.embeddingDim,
      source: stored.embeddingDim !== undefined ? ("user" as const) : ("default" as const),
    }
    const embedSendDimensions = {
      value: resolved.embedSendDimensions,
      source: stored.embedSendDimensions !== undefined ? ("user" as const) : ("default" as const),
    }

    const klBaseSource =
      klLlmBaseUrl.value.trim() !== ""
        ? klLlmBaseUrl.source
        : llmBaseUrl.value.trim() !== ""
          ? ("inheritedMain" as const)
          : ("env" as const)
    const klModelSource =
      klModelMain.value.trim() !== "" ? klModelMain.source : ("inheritedMain" as const)
    const klKeySource = klLlmApiKey.configured
      ? klLlmApiKey.source
      : llmApiKey.configured
        ? ("inheritedMain" as const)
        : gateway.apiKey !== ""
          ? ("env" as const)
          : ("inheritedMain" as const)
    const embedBaseSource =
      embedBaseUrl.value.trim() !== ""
        ? embedBaseUrl.source
        : gateway.llmBaseUrl !== ""
          ? ("inheritedKl" as const)
          : ("env" as const)
    const embedKeySource =
      embedApiKey.source === "user"
        ? ("user" as const)
        : gateway.apiKey !== ""
          ? ("inheritedKl" as const)
          : gateway.embedApiKey !== ""
            ? ("env" as const)
            : ("inheritedKl" as const)

    return {
      llmBaseUrl,
      llmApiKey,
      modelMain,
      mainProvider,
      embedModel,
      klLlmBaseUrl,
      klLlmApiKey,
      klModelMain,
      klProvider,
      /**
       * ★ embedding 三项**没有默认层**（见 `StoredOverrides` 里那段注释）——
       * 存了就 `user`，没存就 `default`（内置常量 / 沿用 KL 地址）。
       * 不走 `plain()`：那个 helper 的回退取 `d.values[key]`，而这三项在
       * kernel 配置里根本没有对应键。
       */
      embedBaseUrl,
      /**
       * ★ embedding 密钥同样没有默认层：填过就 `user`（给后 4 位），
       * 没填过就 `default` + `configured` 表示**回退的那把**在不在。
       *
       * `configured` 报的是"这一路到底有没有密钥可用"（回退解析后的结果），
       * 而不是"这个槽位有没有填" —— 后者由 `source` 表达。这样 UI 上
       * "未配置"就只在**真的一把都没有**时出现，不会在"跟随 KL"时误报。
       */
      embedApiKey,
      embeddingDim,
      embedSendDimensions,
      klEffective: {
        baseUrl: gateway.llmBaseUrl,
        baseUrlSource: klBaseSource,
        model: gateway.llmModel,
        modelSource: klModelSource,
        apiKeyConfigured: gateway.apiKey !== "",
        apiKeySource: klKeySource,
        provider: gateway.llmProvider,
        providerSource: klProvider.source,
        embedBaseUrl: gateway.embedBaseUrl,
        embedBaseUrlSource: embedBaseSource,
        embedModel: gateway.embedModel,
        embedModelSource: embedModel.source,
        embedApiKeyConfigured: gateway.embedApiKey !== "",
        embedApiKeySource: embedKeySource,
        embeddingDim: gateway.embeddingDim,
        embeddingDimSource: embeddingDim.source,
        sendDimensions: gateway.sendDimensions,
        sendDimensionsSource: embedSendDimensions.source,
      },
    }
  }

  /**
   * 保存。落库 + 写 keychain → re-seed process.env → 通知 listeners。
   * 返回哪些消费点已即时生效、哪些要重启子进程（UI 分级横幅用）。
   */
  save(patch: SaveRuntimeConfigPatch, nowIso: string): RuntimeConfigApply {
    const stored = this.readStored()

    // 只作用于**自由串**字段（枚举/数值/布尔单独处理，见下）。
    type StringKey = Exclude<
      keyof StoredOverrides,
      "mainProvider" | "klProvider" | "embeddingDim" | "embedSendDimensions"
    >
    const merge = (key: StringKey, value: string | undefined): void => {
      if (value === undefined) return
      // 空串 = 清空这一项（回退默认层）；非空 = 覆盖
      if (value.trim() === "") delete stored[key]
      else stored[key] = value.trim()
    }
    merge("llmBaseUrl", patch.llmBaseUrl)
    merge("modelMain", patch.modelMain)
    merge("embedModel", patch.embedModel)
    merge("embedBaseUrl", patch.embedBaseUrl)
    merge("klLlmBaseUrl", patch.klLlmBaseUrl)
    merge("klModelMain", patch.klModelMain)
    // 协议是枚举而非自由串，不走 trim-and-delete 的 merge：undefined = 不改，
    // 给了就覆盖（两个合法值之一，由 contract 的 schema 保证）。
    if (patch.mainProvider !== undefined) stored.mainProvider = patch.mainProvider
    if (patch.klProvider !== undefined) stored.klProvider = patch.klProvider
    /**
     * ★ 数值/布尔的三态：`undefined` = 不改，`null` = 清空（回退内置默认），
     * 值 = 覆盖。**不能**用「假值即清空」那套 —— `embedSendDimensions: false`
     * 是一个用户真会选的**有效值**（自建 vLLM 要关掉它），把 false 当"没填"
     * 会让"关掉"这个动作永久存不进去。这就是为什么这两个字段的清空语义
     * 用显式 `null` 而不是空串/假值。
     */
    if (patch.embeddingDim !== undefined) {
      if (patch.embeddingDim === null) delete stored.embeddingDim
      else stored.embeddingDim = patch.embeddingDim
    }
    if (patch.embedSendDimensions !== undefined) {
      if (patch.embedSendDimensions === null) delete stored.embedSendDimensions
      else stored.embedSendDimensions = patch.embedSendDimensions
    }

    this.options.settings.set(SETTING_KEY, JSON.stringify(stored), nowIso)

    // apiKey 三态：undefined 不改，null/"" 清空，字符串写入。
    this.writeSecret(LLM_API_KEY_SECRET, patch.llmApiKey)
    this.writeSecret(KL_API_KEY_SECRET, patch.klLlmApiKey)
    this.writeSecret(EMBED_API_KEY_SECRET, patch.embedApiKey)

    // GUI 显式清空时先撤销本服务早先 seed 的别名，再解析回退层。
    if (patch.llmBaseUrl !== undefined && patch.llmBaseUrl.trim() === "") {
      this.restoreSeededEnv("MYCONTEXT_LLM_BASE_URL", "ANTHROPIC_BASE_URL")
    }
    if (patch.llmApiKey === null || patch.llmApiKey?.trim() === "") {
      this.restoreSeededEnv("MYCONTEXT_LLM_API_KEY", "ANTHROPIC_AUTH_TOKEN")
    }

    this.seedProcessEnv()

    const resolved = this.resolved()
    for (const listener of this.listeners) listener(resolved)

    // 记「改了哪些字段」，不记值（baseUrl 可能含内网地址，apiKey 更不能记）。
    this.options.logger.info("runtime config updated", {
      fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined),
    })

    return {
      // 进程内消费者（数字人直连、autoBuild 判定）下一次调用就用新值
      appliedNow: true,
      // 两条子进程路要重启才生效（env 在 spawn 时定死）
      needsRestart: ["agent", "klServer"],
    }
  }

  /**
   * 探测网关：`GET {base}/v1/models`。
   *
   * ## ★ 为什么要有这个动作
   *
   * 模型名/密钥填错**不会当场报错** —— 它在几小时后的蒸馏或建图里表现为
   * `model_not_found` / 401，而那些错是静默的（日志一行，界面无声）。
   * 这正是本项目最怕的失效形态。一次探测把它变成「现在当场告诉你」。
   *
   * 同一次请求顺带给出**可选模型列表** —— 于是模型名可以从"猜着填"
   * 变成"从列表里挑"。
   *
   * ## 用草稿值而不是已存配置
   *
   * 用户是在"还没保存"的状态下点测试的（先测通再存才是自然顺序）。
   * `apiKey` 省略时回退到已存的那把 —— 「不改 key、只测地址」要能表达。
   *
   * 失败一律**归类**（见 contract 的 reason 枚举）而不是把原文怼给用户：
   * 401 与 DNS 失败要给出的下一步动作完全不同。
   */
  /**
   * 探测网关并**识别协议**：先试 OpenAI 兼容口，传输不对再试 Anthropic 口。
   *
   * ## ★ 为什么要有这个动作
   *
   * 模型名/密钥填错**不会当场报错** —— 它在几小时后的蒸馏或建图里表现为
   * `model_not_found` / 401，而那些错是静默的（日志一行，界面无声）。
   * 这正是本项目最怕的失效形态。一次探测把它变成「现在当场告诉你」。
   *
   * 同一次请求顺带给出**可选模型列表** + **识别到的协议** —— 于是模型名可以从
   * "猜着填"变成"从列表里挑"，协议也不用用户去猜（同事踩过的坑：给了
   * OpenAI 兼容 URL 却被当 Anthropic 发 → 404）。
   *
   * ## 为什么先 openai 后 anthropic
   *
   * 应用侧网关基本都是 OpenAI 兼容口（`/chat/completions`、`/embeddings`）。所以
   * 先用 `Authorization: Bearer` 试 OpenAI 形态；只有当它以**传输不对**的信号
   * （404 / 非 401·403 的 4xx）失败时，才换 `x-api-key` + `anthropic-version`
   * 头再试一次 Anthropic 口。401/403 是「地址对、密钥不对」，不该触发换协议重试。
   * 网络层失败（超时/DNS/拒连）两种协议都会一样失败，所以不重试，直接 unreachable。
   *
   * ## 用草稿值而不是已存配置
   *
   * 用户是在"还没保存"的状态下点测试的（先测通再存才是自然顺序）。
   * `apiKey` 省略时回退到已存的那把 —— 「不改 key、只测地址」要能表达。
   *
   * 失败一律**归类**（见 contract 的 reason 枚举）而不是把原文怼给用户：
   * 401 与 DNS 失败要给出的下一步动作完全不同。
   */
  async probe(input: {
    baseUrl?: string | undefined
    apiKey?: string | undefined
  }): Promise<RuntimeConfigProbe> {
    const resolved = this.resolved()
    const base = (input.baseUrl ?? "").trim() !== "" ? input.baseUrl!.trim() : resolved.llmBaseUrl
    const key = (input.apiKey ?? "").trim() !== "" ? input.apiKey!.trim() : resolved.llmApiKey

    if (base.trim() === "") {
      return this.probeFail("unreachable", null)
    }
    if (key.trim() === "") {
      return this.probeFail("noKey", null)
    }

    // base 可能带或不带 /v1（两种都有人填）—— 规范化，不让用户去记。
    const root = base.replace(/\/+$/, "").replace(/\/v1$/, "")
    const url = `${root}/v1/models`

    try {
      // ── 第 1 试：OpenAI 兼容口 ──
      const openai = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${key}` },
        // 8 秒：探测是用户**在等**的动作，不能像后台请求那样给 90 秒
        signal: AbortSignal.timeout(8_000),
      })

      if (openai.ok) {
        const parsed = await this.parseModels(openai, "openai")
        if (parsed !== null) {
          this.options.logger.info("gateway probe ok", {
            providers: parsed.providers,
            provider: parsed.provider,
            models: parsed.models.length,
          })
          return { ok: true, reason: null, ...parsed, detail: null }
        }
        // 200 但形状不对：多半 URL 填到了控制台首页（返回 HTML）。
        return this.probeFail("badResponse", null)
      }

      // 401/403 = 地址对、密钥不对：换协议也没用，直接归类。
      if (openai.status === 401 || openai.status === 403) {
        const detail = (await openai.text().catch(() => "")).slice(0, 300)
        this.options.logger.info("gateway probe failed", {
          status: openai.status,
          reason: "unauthorized",
        })
        return this.probeFail("unauthorized", detail === "" ? null : detail)
      }

      // ── 第 2 试：Anthropic 口（仅在 OpenAI 口报「传输不对」信号时）──
      const anthropic = await this.fetchImpl(url, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(8_000),
      })

      if (anthropic.ok) {
        const parsed = await this.parseModels(anthropic, "anthropic")
        if (parsed !== null) {
          this.options.logger.info("gateway probe ok", {
            providers: parsed.providers,
            provider: parsed.provider,
            models: parsed.models.length,
          })
          return { ok: true, reason: null, ...parsed, detail: null }
        }
        return this.probeFail("badResponse", null)
      }

      // 两种口都没通：按 Anthropic 口的状态归类（401/403 → 密钥问题，其余 → 地址不像模型服务）。
      const detail = (await anthropic.text().catch(() => "")).slice(0, 300)
      const reason =
        anthropic.status === 401 || anthropic.status === 403 ? "unauthorized" : "badResponse"
      this.options.logger.info("gateway probe failed", {
        openaiStatus: openai.status,
        anthropicStatus: anthropic.status,
        reason,
      })
      return this.probeFail(reason, detail === "" ? null : detail)
    } catch (error) {
      // 超时 / DNS / 拒连都归 unreachable —— 对用户是同一个下一步（检查地址）
      const detail = error instanceof Error ? error.message.slice(0, 300) : null
      this.options.logger.info("gateway probe unreachable", { detail })
      return this.probeFail("unreachable", detail)
    }
  }

  /** 探测失败的统一形状（各字段空着）。 */
  private probeFail(
    reason: RuntimeConfigProbe["reason"],
    detail: string | null,
  ): RuntimeConfigProbe {
    return {
      ok: false,
      reason,
      provider: null,
      providers: [],
      modelProviders: {},
      detail,
      models: [],
    }
  }

  /**
   * 从 `/v1/models` 响应体解析出 `{provider, providers, modelProviders, models}`。
   * 形状不对返回 null。
   *
   * ## ★★ 协议识别以 `supported_endpoint_types` 为准，不靠信封形状猜
   *
   * 之前这里只看响应信封是 OpenAI 形（`{data:[{id}]}`）还是 Anthropic 形
   * （`{data:[{type:"model"}]}`）来定一个协议 —— 但很多网关（如本机 mulerun）
   * 的 `/v1/models` 会**逐模型**标 `supported_endpoint_types`，多数 claude/glm/kimi
   * 都是 `["anthropic","openai"]` 两者都支持。只看信封会把这种网关一律报成
   * "openai 单一"，于是 anthropic chip 永远点不亮 —— 那正是本次要修的 bug。
   *
   * 所以：优先聚合每个模型的 `supported_endpoint_types`（只认我们支持的
   * anthropic/openai 两种）得到网关支持的协议全集；网关不给这个字段时（老网关）
   * 才回退到 `viaHeader`（能用哪种头连通就至少支持那个），不假装支持没验证过的。
   *
   * `provider`（推荐默认）：网关支持 anthropic 就优先 anthropic（claude 类走原生
   * 协议信息更全），否则 openai。
   */
  private async parseModels(
    response: Response,
    viaHeader: ModelProvider,
  ): Promise<{
    provider: ModelProvider
    providers: ModelProvider[]
    modelProviders: Record<string, ModelProvider[]>
    models: string[]
  } | null> {
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null
    if (body === null || !Array.isArray(body.data)) return null

    const items = body.data as unknown[]
    const modelProviders: Record<string, ModelProvider[]> = {}
    const gatewayProviders = new Set<ModelProvider>()

    for (const item of items) {
      if (typeof item !== "object" || item === null) continue
      const id = (item as { id?: unknown }).id
      if (typeof id !== "string") continue
      const rawTypes = (item as { supported_endpoint_types?: unknown }).supported_endpoint_types
      if (Array.isArray(rawTypes)) {
        // 只留我们支持的两种协议（网关可能还标 gemini/image-generation 等，忽略）。
        const supported = rawTypes.filter(
          (t): t is ModelProvider => t === "anthropic" || t === "openai",
        )
        if (supported.length > 0) {
          modelProviders[id] = supported
          for (const p of supported) gatewayProviders.add(p)
        }
      }
    }

    const models = items
      .map((item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : null,
      )
      .filter((id): id is string => id !== null)
      .sort((a, b) => a.localeCompare(b))

    // 网关没给 supported_endpoint_types（老网关）→ 回退到连通的那个协议。
    if (gatewayProviders.size === 0) gatewayProviders.add(viaHeader)

    const providers = [...gatewayProviders].sort()
    // 推荐默认：支持 anthropic 就优先它（原生协议信息更全），否则 openai。
    const provider: ModelProvider = gatewayProviders.has("anthropic") ? "anthropic" : "openai"

    return { provider, providers, modelProviders, models }
  }

  /**
   * 把解析后的主网关写进 process.env 的**全部相关名**。
   *
   * 为什么连 `ANTHROPIC_*` 也写：`resolveGatewayModelConfig` 的优先级是
   * `ANTHROPIC_* > MYCONTEXT_LLM_*`（那是 opencode 自己的约定），只 seed
   * `MYCONTEXT_*` 会被真实 env 里残留的 `ANTHROPIC_*` 压过。文档已明说
   * 「它们本来就是同一个网关」，写成一致值是正确且符合原意的。
   *
   * ★ 只在解析值**非空**时写：空值不去 clobber 真实 env 里已有的
   * `ANTHROPIC_BASE_URL`（用户可能只配了那个而没配 MYCONTEXT_*）——
   * 那种情况应当让它继续透传，而不是被我们用空串盖掉。
   */
  seedProcessEnv(): void {
    const env = this.options.env ?? process.env
    const resolved = this.resolved()
    const set = (key: string, value: string): void => {
      if (value.trim() === "") return
      if (!this.envBeforeSeed.has(key)) this.envBeforeSeed.set(key, env[key])
      env[key] = value
    }
    set("MYCONTEXT_LLM_BASE_URL", resolved.llmBaseUrl)
    set("MYCONTEXT_LLM_API_KEY", resolved.llmApiKey)
    set("ANTHROPIC_BASE_URL", resolved.llmBaseUrl)
    set("ANTHROPIC_AUTH_TOKEN", resolved.llmApiKey)
    /**
     * ★ 模型名也要 seed —— 否则 `.env` 里那一行是句谎话。
     *
     * `resolveGatewayModelConfig`（opencode 子进程的模型配置）从 env 读
     * `MYCONTEXT_MODEL_MAIN`，而 `bootstrap/config.ts` **刻意不写 process.env**
     * （见它的文件头：为了让优先级判定只由 `loadConfig` 决定）。少了这一行，
     * dotenv 里的模型名就停在 `config.values` 里到不了子进程，于是子进程
     * 永远用写死的兜底默认值 —— 而"配了但不生效"是最难查的一类问题。
     *
     * 只是这还不够：env 是进程级全局状态，谁都能改，而"这一次 spawn 用哪个
     * 模型"该是个明确的输入。所以装配层另外把 `resolved().modelMain` 显式传给
     * 两处 spawn（见 `startup.ts` 的 `getModel`）—— 那条路不依赖"seed 过了"
     * 这个前提，而这一行让**没走那条路的调用方**（单测、脚本）也拿到正确值。
     */
    set("MYCONTEXT_MODEL_MAIN", resolved.modelMain)
    /**
     * ★ 主模型协议也 seed —— 与模型名同一个理由：opencode 子进程的
     * `resolveGatewayModelConfig` 从 env 读它来决定内联 provider 用
     * `@ai-sdk/anthropic` 还是 `@ai-sdk/openai-compatible`。没这一行的话
     * 用户在设置里切了 anthropic 也到不了子进程（除非 getModel 那条显式路
     * 也带上，见 startup.ts）。装配层同样会显式传，这一行是给单测/脚本兜底。
     */
    set("MYCONTEXT_MODEL_PROVIDER", resolved.mainProvider)
  }

  /** 订阅配置变化（LlmHolder 重配 / 向渲染层推事件）。返回取消订阅。 */
  onChange(listener: (resolved: ResolvedRuntimeConfig) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private readStored(): StoredOverrides {
    const raw = this.options.settings.get(SETTING_KEY)
    if (raw === null || raw === "") return {}
    try {
      const parsed = JSON.parse(raw) as StoredOverrides
      return typeof parsed === "object" && parsed !== null ? parsed : {}
    } catch {
      // 手改坏的库不该让配置读取抛 —— 回退空覆盖（即走默认层）。
      this.options.logger.warn("runtime config store unreadable, using defaults", {})
      return {}
    }
  }

  private writeSecret(secretKey: string, value: string | null | undefined): void {
    if (value === undefined) return
    // 空串/null 都视为清空：写空串（SecretStore.read 会把空当未配置）
    this.options.secretStore.write(secretKey, value ?? "")
  }

  /** loadConfig 的来源标记（default/dotenv/env）—— 视图直接用。 */
  private defaultSource(key: keyof LoadedConfig["values"]): FieldSource {
    const meta = this.options.defaults.meta[key as keyof LoadedConfig["meta"]]
    return (meta?.source ?? "default") as FieldSource
  }

  /**
   * 首次运行：若真源无存储值，而旧的隐藏高级面板里存过 baseUrl/apiKey，
   * 一次性搬进真源 —— 避免用户「在高级面板配过、升级后又要重配一遍」。
   */
  private adoptLegacyIfNeeded(): void {
    if (this.options.settings.get(SETTING_KEY) !== null) return
    const legacyRaw = this.options.settings.get(LEGACY_ADVANCED_KEY)
    if (legacyRaw === null) return
    try {
      const legacy = JSON.parse(legacyRaw) as { baseUrl?: unknown }
      const baseUrl = typeof legacy.baseUrl === "string" ? legacy.baseUrl.trim() : ""
      const legacyKey = this.options.secretStore.read(LEGACY_ADVANCED_API_KEY_SECRET)
      if (baseUrl === "" && (legacyKey === null || legacyKey === "")) return
      const adopted: StoredOverrides = baseUrl !== "" ? { llmBaseUrl: baseUrl } : {}
      this.options.settings.set(SETTING_KEY, JSON.stringify(adopted), new Date().toISOString())
      if (legacyKey !== null && legacyKey !== "") {
        this.options.secretStore.write(LLM_API_KEY_SECRET, legacyKey)
      }
      this.options.logger.info("adopted legacy advanced-ai gateway into runtime config", {
        hasBaseUrl: baseUrl !== "",
        hasApiKey: legacyKey !== null && legacyKey !== "",
      })
    } catch {
      // 旧值坏了就不搬 —— 用户在新面板重配即可。
    }
  }
}
