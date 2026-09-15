/**
 * 模型网关配置表单 —— 设置面板与 onboarding 第 2 步**共用**同一个组件。
 *
 * ## 为什么共用
 *
 * 两处改的是同一份配置（`RuntimeConfigService` 单一真源）。抄两份表单
 * 会在某天分叉：一处加了 KL 折叠区、另一处没有，而用户在两处看到的
 * 「同一个设置」长得不一样。共用组件从源头上避免这件事。
 *
 * ## ★★ 核心：一次「测试连接」同时解决三件事
 *
 * 首版这里是三个裸输入框 + 五六行说明小字，而它有一个**不说明就看不见**
 * 的问题：填错了不会当场报错 —— 模型名写错在几小时后的蒸馏/建图里表现为
 * `model_not_found`，密钥写错表现为 401，两者在界面上都**完全无声**。
 * 那正是本项目最怕的失效形态。
 *
 * `GET /v1/models` 一次请求同时给出：
 * ① 地址通不通、② 密钥对不对、③ **有哪些模型可选**。
 * 于是：
 * · 「配置正确吗」从"等几小时看有没有结论"变成"现在就有绿灯"；
 * · 模型名从**猜着填的输入框**变成**从列表里挑**（对齐本项目已有的
 *   `PersonaRuntimePanel` —— 那里的注释写着"给档位就是给建议"）。
 *
 * 探测前有内置推荐档位兜底，所以"还没测"时也不是空白。
 *
 * ## 用交互承载信息，而不是堆说明文字
 *
 * · 「配没配 key」→ `Tag`（状态圆点）。一个绿点比一句话快，且不占整行；
 * · 「地址/密钥对不对」→ 探测结果那一行（有颜色、有下一步动作）；
 * · 「有哪些模型」→ chips（选中态自解释，不需要"如 glm-5.2"这种提示）；
 * · 「KL 留空回退主配置」→ `Disclosure` 的 `hint` + placeholder **就是**
 *   会回退到的那个值（比一句「留空则…」直接）；
 * · 「KL 当前实际生效值」→ `Disclosure` 的 `summary`（收起时也可见）。
 *
 * ## 保存按钮的 dirty 态
 *
 * 没改任何东西时按钮 disabled。首版无论改没改都能点，点完还显示「已保存」
 * —— 那是**假反馈**：它让用户以为自己的某个改动生效了，而实际上什么都没提交。
 *
 * ## apiKey 的三态
 *
 * UI 不回显完整 key（Tag 只给后 4 位）。输入框空串 = **不改**（保留旧值），
 * 不是清空 —— placeholder 就写着这件事。
 *
 * ## 表单自己**不带**分区标题
 *
 * 两个调用方都已经有标题（设置页的 `Section` / onboarding 的页标题）。
 * 再挂一层就是同一件事说三四遍 —— 标题的责任留给容器。
 */
import { useState, type ReactNode } from "react"
import { Button, Disclosure, Field, Input, Switch, Tag, cn } from "@mycontext/design"
import {
  DEFAULT_EMBEDDING_DIM,
  type ModelProvider,
  type RuntimeConfigProbe,
  type RuntimeConfigView,
  type SaveRuntimeConfigInput,
} from "@mycontext/ipc-contract"
import { useProbeRuntimeConfig, useRuntimeConfig, useSaveRuntimeConfig } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface ModelConfigFormProps {
  /** onboarding 里保存成功后回调（用于记 stepDone）。设置面板不传。 */
  onSaved?: () => void
  /** 保存按钮文案覆盖（onboarding 用「保存并继续」）。 */
  saveLabel?: string
}

/**
 * 还没探测时的推荐模型档位。
 *
 * ★ 给档位而不是空输入框（与 `PersonaRuntimePanel` 同一个判断：
 * "给档位就是给建议"）。这几个是本机网关实测能用的：`glm-5.2` 是默认
 * （openai + anthropic 双协议都支持，主 LLM 与知识库抽取可以共用一个）。
 *
 * 探测成功后**用真实列表替换**它 —— 兜底值的作用只是"别让第一眼是空的"。
 */
const SUGGESTED_MODELS = ["glm-5.2", "claude-sonnet-4-6", "qwen3.7-plus"] as const
const SUGGESTED_EMBED = ["text-embedding-v4"] as const

export function ModelConfigForm({ onSaved, saveLabel }: ModelConfigFormProps) {
  const { t } = useDynamicTranslation("settings")
  const config = useRuntimeConfig()
  const save = useSaveRuntimeConfig()
  const probe = useProbeRuntimeConfig()

  // 受控草稿：null = 未编辑（显示当前值）。apiKey 单独用空串草稿（不回显）。
  const [llmBaseUrl, setLlmBaseUrl] = useState<string | null>(null)
  const [modelMain, setModelMain] = useState<string | null>(null)
  const [embedModel, setEmbedModel] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState("")
  /** 主模型协议草稿。null = 未编辑（用探测识别值或已存值）。 */
  const [mainProvider, setMainProvider] = useState<ModelProvider | null>(null)
  const [klBaseUrl, setKlBaseUrl] = useState<string | null>(null)
  const [klModel, setKlModel] = useState<string | null>(null)
  const [klApiKey, setKlApiKey] = useState("")
  /** 知识库协议草稿。null = 未编辑（用探测识别值或已存值）。 */
  const [klProvider, setKlProvider] = useState<ModelProvider | null>(null)
  /**
   * embedding 三项草稿。null = 未编辑。
   *
   * ★ 维度用**字符串**草稿而不是 number：输入框中间态（清空成 ""、正在敲 "20"）
   * 用 number 表达不了 —— 拿 `parseInt` 边敲边转会把 "" 变成 NaN、把 "20" 提交成
   * 一个用户还没敲完的值。所以草稿存原文，提交时才转（转不出整数就当"不改"）。
   */
  const [embedBaseUrl, setEmbedBaseUrl] = useState<string | null>(null)
  /** embedding 专用密钥草稿。空串 = **不改**（与其它两把 key 同语义，UI 不回显）。 */
  const [embedApiKey, setEmbedApiKey] = useState("")
  const [embedDimText, setEmbedDimText] = useState<string | null>(null)
  const [embedSendDims, setEmbedSendDims] = useState<boolean | null>(null)
  /** 模型名手输模式（探测列表里没有想要的那个时） */
  const [customModel, setCustomModel] = useState(false)
  /**
   * embedding 也必须能手输。
   *
   * 自建服务的模型 id 往往不在主网关 `/models` 里；原来这里没有「其它」入口，
   * 界面只剩 `text-embedding-v4` 一个可点档位，用户为了保存其它模型配置时很容易
   * 把它一并写回数据库。与主模型分开记草稿，避免切主模型时碰到 embedding。
   */
  const [customEmbedModel, setCustomEmbedModel] = useState(false)
  /**
   * 探测是**针对哪组凭据**跑的。
   *
   * ★ 防假反馈：探测成功给了绿灯后，用户又改了地址/密钥 —— 那条绿灯就
   * **不再代表当前输入**了（它测的是改之前那组）。而 `probe.data` 会一直留着。
   * 记下"探测时用的地址 + 有没有带 key"，当前草稿与之不一致时就不显示旧结果。
   * 这与本组件反对的"保存按钮假反馈"是同一条原则：结论必须对应当前状态。
   */
  const [probedAgainst, setProbedAgainst] = useState<{ baseUrl: string; withKey: boolean } | null>(
    null,
  )

  const current: RuntimeConfigView | undefined = config.data
  if (current === undefined) return null

  const baseUrlValue = llmBaseUrl ?? current.llmBaseUrl.value
  const modelValue = modelMain ?? current.modelMain.value
  const embedValue = embedModel ?? current.embedModel.value

  /**
   * 有没有未保存的改动。
   *
   * 没有就把保存按钮禁掉 —— 否则点一下会显示「已保存」而其实什么都没提交
   * （假反馈）。apiKey 的非空草稿也算改动（它的空串语义是"不改"）。
   */
  const dirty =
    llmBaseUrl !== null ||
    modelMain !== null ||
    mainProvider !== null ||
    embedModel !== null ||
    embedBaseUrl !== null ||
    embedApiKey !== "" ||
    embedDimText !== null ||
    embedSendDims !== null ||
    klBaseUrl !== null ||
    klModel !== null ||
    klProvider !== null ||
    apiKey !== "" ||
    klApiKey !== ""

  const submit = (): void => {
    const patch: SaveRuntimeConfigInput = {}
    if (llmBaseUrl !== null) patch.llmBaseUrl = llmBaseUrl
    if (modelMain !== null) patch.modelMain = modelMain
    if (mainProvider !== null) patch.mainProvider = mainProvider
    if (embedModel !== null) patch.embedModel = embedModel
    if (embedBaseUrl !== null) patch.embedBaseUrl = embedBaseUrl
    // 空串 = 不改（与另外两把 key 同语义：UI 不回显旧值，"没填"必须与"清空"可区分）
    if (embedApiKey !== "") patch.embedApiKey = embedApiKey
    /**
     * 维度：空串 = 清空（回退内置默认）→ 传 `null`；否则转整数。
     * 转不出整数（用户敲了非数字）就**不提交这一项** —— 静默丢掉一个坏值比
     * 存进去一个 NaN 好，而 `type=number` + min/max 已经在输入侧拦了大部分。
     */
    if (embedDimText !== null) {
      if (embedDimText.trim() === "") patch.embeddingDim = null
      else {
        const parsed = Number.parseInt(embedDimText, 10)
        if (Number.isInteger(parsed) && parsed > 0) patch.embeddingDim = parsed
      }
    }
    if (embedSendDims !== null) patch.embedSendDimensions = embedSendDims
    // 空串 = 不改（UI 不回显旧 key）
    if (apiKey !== "") patch.llmApiKey = apiKey
    if (klBaseUrl !== null) patch.klLlmBaseUrl = klBaseUrl
    if (klModel !== null) patch.klModelMain = klModel
    if (klApiKey !== "") patch.klLlmApiKey = klApiKey
    if (klProvider !== null) patch.klProvider = klProvider
    save.mutate(patch, {
      onSuccess: () => {
        // 草稿清空 → dirty 回到 false（保存后按钮自然禁掉）
        setApiKey("")
        setKlApiKey("")
        setLlmBaseUrl(null)
        setModelMain(null)
        setMainProvider(null)
        setEmbedModel(null)
        setCustomEmbedModel(false)
        setEmbedBaseUrl(null)
        setEmbedApiKey("")
        setEmbedDimText(null)
        setEmbedSendDims(null)
        setKlBaseUrl(null)
        setKlModel(null)
        setKlProvider(null)
        onSaved?.()
      },
    })
  }

  /** 探测用**草稿值**：先测通再存才是自然顺序。 */
  const runProbe = (): void => {
    setProbedAgainst({ baseUrl: baseUrlValue, withKey: apiKey !== "" })
    probe.mutate({
      ...(baseUrlValue.trim() === "" ? {} : { baseUrl: baseUrlValue }),
      ...(apiKey === "" ? {} : { apiKey }),
    })
  }

  /**
   * 探测结果是否**仍对应当前输入**。
   *
   * 探完之后改了地址、或加/去了 key，旧结果就过期了 —— 这时不展示它，
   * 也不拿它的模型列表去覆盖推荐档位（否则会拿"上一次网关"的列表给"这一次地址"挑）。
   */
  const probeFresh =
    probedAgainst !== null &&
    probedAgainst.baseUrl === baseUrlValue &&
    probedAgainst.withKey === (apiKey !== "")

  const result: RuntimeConfigProbe | undefined = probeFresh ? probe.data : undefined
  /** 探到的列表优先；没探过用推荐档位。 */
  const modelOptions =
    result?.ok === true && result.models.length > 0
      ? result.models
      : (SUGGESTED_MODELS as readonly string[])
  const embedOptions =
    result?.ok === true && result.models.length > 0
      ? result.models.filter((id) => /embed/i.test(id))
      : (SUGGESTED_EMBED as readonly string[])

  /**
   * 某个**具体模型**支持哪些协议（读探测到的 `modelProviders`）。
   *
   * 探到该模型的 `supported_endpoint_types` 就用它；探不到（老网关不给、或
   * 没探过）回退到**网关级**支持集。这让"选了只支持 openai 的模型"时
   * anthropic chip 能标灰，而不是拿网关整体的支持集去糊每个模型。
   */
  const providersForModel = (model: string): readonly ModelProvider[] => {
    const per = result?.ok === true ? result.modelProviders[model] : undefined
    if (per !== undefined && per.length > 0) return per
    return result?.ok === true && result.providers.length > 0
      ? result.providers
      : (["openai", "anthropic"] as const)
  }

  /**
   * 某个模型的**推荐协议**：它支持 anthropic 就选 anthropic（claude 类走原生协议
   * 信息更全），否则 openai。这就是"从列表里选一个模型 → 自动选好它的协议"。
   */
  const preferredProviderFor = (model: string): ModelProvider =>
    providersForModel(model).includes("anthropic") ? "anthropic" : "openai"

  /**
   * 知识库那一路**实际会用**的协议：
   * 用户手动切的 > 新鲜探测下**所选 kl 模型**的推荐协议 > 已存值。
   *
   * ★ 从"网关级识别值"改成"按所选模型"：同一个网关里有的模型只支持 openai、
   * 有的两者都支持，拿网关级的一个值套所有模型是错的。用户手选仍然优先
   * （`klProvider !== null`），选模型时会把手选清掉（见 onPick），于是自动重算。
   */
  const klModelValue = klModel ?? current.klModelMain.value
  const effectiveKlProvider: ModelProvider =
    klProvider ??
    (result?.ok === true && klModelValue.trim() !== ""
      ? preferredProviderFor(klModelValue)
      : null) ??
    current.klEffective.provider

  /**
   * 主模型实际会用的协议：用户手动切的 > 新鲜探测下**所选主模型**的推荐协议 > 已存值。
   */
  const effectiveMainProvider: ModelProvider =
    mainProvider ??
    (result?.ok === true && modelValue.trim() !== "" ? preferredProviderFor(modelValue) : null) ??
    current.mainProvider.value

  /**
   * 探测识别到的网关**支持的协议集**（网关级，用于顶部 tag）。没探过（或探测没给
   * 协议信息）时两个都摆出来 —— 让用户仍能手选，只是没有"这个网关支持哪些"的确证。
   */
  const supportedProviders: readonly ModelProvider[] =
    result?.ok === true && result.providers.length > 0 ? result.providers : ["openai", "anthropic"]

  return (
    <div className="flex flex-col gap-[var(--gap-section-lg)]">
      <section className="flex flex-col gap-[var(--gap-section-sm)]">
        <Field label={t("model.provider.baseUrl")}>
          {(attributes) => (
            <Input
              {...attributes}
              value={baseUrlValue}
              onChange={(event) => setLlmBaseUrl(event.target.value)}
              placeholder="https://…"
            />
          )}
        </Field>

        {/* key 的状态跟在 label 右边（Tag），不再单独占一行描述 */}
        <div className="flex flex-col gap-[var(--gap-component-sm)]">
          <div className="flex items-center gap-2">
            <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("model.provider.apiKey")}
            </span>
            <KeyTag field={current.llmApiKey} />
          </div>
          <Input
            type="password"
            aria-label={t("model.provider.apiKey")}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t("model.provider.apiKeyPlaceholder")}
          />
        </div>

        {/*
          ★ 测试连接。放在"地址 + 密钥"之后、"选模型"之前 —— 这个顺序
          就是操作顺序：填好凭证 → 测通 → 从探到的列表里挑模型。
        */}
        <div className="flex items-center gap-3">
          <Button size="sm" variant="secondary" disabled={probe.isPending} onClick={runProbe}>
            {probe.isPending ? t("model.probe.testing") : t("model.probe.test")}
          </Button>
          <ProbeResult result={result} failed={probeFresh && probe.isError} />
        </div>

        {/*
          模型选择：chips（探到的列表 / 推荐档位）+ 「其它」手输。
          选中态自己就说明了"现在用哪个"，不需要「如 glm-5.2」这类提示。
        */}
        <div className="flex flex-col gap-[var(--gap-component-sm)]">
          <div className="flex items-center gap-2">
            <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("model.provider.modelMain")}
            </span>
            {result?.ok === true && result.models.length > 0 && (
              <Tag size="sm" status="accent">
                {t("model.probe.fromGateway", { count: result.models.length })}
              </Tag>
            )}
            {/* 探测识别到的网关**支持的协议集** —— 让用户看见这网关到底支持哪些 */}
            {result?.ok === true && result.providers.length > 0 && (
              <Tag size="sm" status="default">
                {t("model.probe.detectedProtocol", {
                  provider: result.providers.map((p) => t(`model.provider.${p}`)).join(" / "),
                })}
              </Tag>
            )}
          </div>
          <ChipPicker
            options={modelOptions}
            value={modelValue}
            onPick={(next) => {
              setModelMain(next)
              setCustomModel(false)
              // ★ 选了模型就把手动协议清掉 → effectiveMainProvider 自动取该模型的
              // 推荐协议（有 anthropic 选 anthropic）。用户之后仍可再手动切。
              setMainProvider(null)
            }}
            otherLabel={t("model.other")}
            custom={customModel || !modelOptions.includes(modelValue)}
            onCustom={() => setCustomModel(true)}
          />
          {(customModel || !modelOptions.includes(modelValue)) && (
            <Input
              aria-label={t("model.provider.modelMain")}
              value={modelValue}
              onChange={(event) => setModelMain(event.target.value)}
              placeholder="glm-5.2"
            />
          )}
          {/*
            ★ 探测成功、且当前模型名**不在**网关返回的列表里 → 明确警告。
            这正是本组件要防的那个静默失效：模型名对不上，几小时后的蒸馏/建图
            才以 `model_not_found` 报错，界面当下无声。既然刚探到了真实列表，
            就能当场指出"这个名字网关不认识"，把无声变成可见。
            只在 result.ok（真拿到列表）时判 —— 没探过不知道网关有什么，不妄断。
          */}
          {result?.ok === true &&
            result.models.length > 0 &&
            modelValue.trim() !== "" &&
            !result.models.includes(modelValue) && (
              <span className="typography-caption-400 text-[var(--status-warning)]">
                {t("model.probe.modelNotListed")}
              </span>
            )}
        </div>

        {/*
          ★ 主模型协议选择器 —— 现在可切（去掉了原来那句"不可切换"）。
          opencode 子进程按它选 @ai-sdk/anthropic / @ai-sdk/openai-compatible 内联
          provider，直连 LlmClient 按它走 /v1/messages / /v1/chat/completions。
          两个 chip 亮不亮由**所选模型**的 supported_endpoint_types 决定（不是网关整体）——
          选了只支持 openai 的模型时 anthropic chip 就标灰。
        */}
        <ProviderPicker
          label={t("model.provider.protocol")}
          hint={t("model.provider.mainProtocolHint")}
          value={effectiveMainProvider}
          supported={providersForModel(modelValue)}
          onPick={setMainProvider}
          openaiLabel={t("model.provider.openai")}
          anthropicLabel={t("model.provider.anthropic")}
          unsupportedLabel={t("model.provider.unsupported")}
        />

        <div className="flex flex-col gap-[var(--gap-component-sm)]">
          <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
            {t("model.provider.embedModel")}
          </span>
          <ChipPicker
            options={
              embedOptions.length > 0 ? embedOptions : (SUGGESTED_EMBED as readonly string[])
            }
            value={embedValue}
            onPick={(next) => {
              setEmbedModel(next)
              setCustomEmbedModel(false)
            }}
            otherLabel={t("model.other")}
            custom={customEmbedModel || !embedOptions.includes(embedValue)}
            onCustom={() => setCustomEmbedModel(true)}
          />
          {(customEmbedModel || !embedOptions.includes(embedValue)) && (
            <Input
              aria-label={t("model.embed.customModel")}
              value={embedValue}
              onChange={(event) => setEmbedModel(event.target.value)}
              placeholder="qwen3-embedding-4b"
            />
          )}
          {/*
            ★ 探测成功、拿到了真实列表、而列表里**一个 embedding 模型都没有** → 明说。
            实测遇到过这种网关：`/models` 12 个模型全是 chat/image/audio，
            `/embeddings` 对任何模型名都回 `Model not exist.`。那种网关上 LLM 能用、
            建图必卡在算向量这一步，而在此之前界面上完全看不出来 —— 用户只会
            看到"建图很慢"然后一直失败。既然刚探到了列表，就当场把它说出来，
            并指向下面那个折叠区（embedding 可以单独指到别的服务）。
          */}
          {result?.ok === true && result.models.length > 0 && embedOptions.length === 0 && (
            <span className="typography-caption-400 text-[var(--status-warning)]">
              {t("model.embed.noneOnGateway")}
            </span>
          )}
        </div>
      </section>

      {/*
        embedding 专用网关。折叠，因为绝大多数人不需要动它 ——
        · `hint` 说「留空 = 用知识库那个地址」；
        · `summary` 给**实际生效**的地址 + 维度（收起时也看得见）。
      */}
      <Disclosure
        title={t("model.embed.title")}
        hint={t("model.embed.hint")}
        summary={`${current.klEffective.embedBaseUrl || "—"} · ${current.embeddingDim.value}`}
      >
        <div className="flex flex-col gap-[var(--gap-section-sm)]">
          <Field label={t("model.embed.baseUrl")} description={t("model.embed.baseUrlHint")}>
            {(attributes) => (
              <Input
                {...attributes}
                value={embedBaseUrl ?? current.embedBaseUrl.value}
                onChange={(event) => setEmbedBaseUrl(event.target.value)}
                // placeholder 就是留空会回退到的那个值（KL 地址归一化后的形态）
                placeholder={current.klEffective.embedBaseUrl || "https://…/v1"}
              />
            )}
          </Field>

          {/*
            ★ 密钥必须跟着地址一起可配：地址指到别的 host 时，主/KL 那把 key
            对新 host 基本必然 401，而那个 401 只表现为建图时 embedding 批次
            反复重试退避 —— 界面上无声。Tag 的「跟随知识库」表示当前在回退。
          */}
          <div className="flex flex-col gap-[var(--gap-component-sm)]">
            <div className="flex items-center gap-2">
              <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
                {t("model.provider.apiKey")}
              </span>
              <KeyTag
                field={current.embedApiKey}
                fallbackLabel={t("model.embed.inherited")}
                inheritedLabel={t("model.embed.inherited")}
              />
            </div>
            <Input
              type="password"
              aria-label={t("model.embed.apiKey")}
              value={embedApiKey}
              onChange={(event) => setEmbedApiKey(event.target.value)}
              placeholder={t("model.provider.apiKeyPlaceholder")}
            />
          </div>

          <Field label={t("model.embed.dim")} description={t("model.embed.dimHint")}>
            {(attributes) => (
              <Input
                {...attributes}
                type="number"
                min={1}
                max={8192}
                value={embedDimText ?? String(current.embeddingDim.value)}
                onChange={(event) => setEmbedDimText(event.target.value)}
                placeholder={String(DEFAULT_EMBEDDING_DIM)}
              />
            )}
          </Field>

          {/* 开关自带可见 label；说明另起一行（`title` 只在悬停时出现，不能当唯一载体）。 */}
          <div className="flex flex-col gap-[var(--gap-component-sm)]">
            <Switch
              checked={embedSendDims ?? current.embedSendDimensions.value}
              onChange={setEmbedSendDims}
              ariaLabel={t("model.embed.sendDimensions")}
              label={t("model.embed.sendDimensions")}
            />
            <span className="typography-caption-400 text-[var(--text-base-secondary)]">
              {t("model.embed.sendDimensionsHint")}
            </span>
          </div>
        </div>
      </Disclosure>

      {/*
        KL 专用网关。
        · `hint` 说「留空 = 用上面的」—— 折叠标题下一行，正是帮人决定要不要展开；
        · `summary` 给当前**实际生效**值 —— 收起时也看得见，看个值不用先展开。
      */}
      <Disclosure
        title={t("model.kl.title")}
        hint={t("model.kl.hint")}
        summary={`${current.klEffective.model || "—"} · ${t(
          `model.provider.${current.klEffective.provider}`,
        )}`}
      >
        <div className="flex flex-col gap-[var(--gap-section-sm)]">
          <Field label={t("model.provider.baseUrl")}>
            {(attributes) => (
              <Input
                {...attributes}
                value={klBaseUrl ?? current.klLlmBaseUrl.value}
                onChange={(event) => setKlBaseUrl(event.target.value)}
                // placeholder 就是会回退到的那个值 —— 比一句「留空则…」更直接
                placeholder={baseUrlValue || "https://…"}
              />
            )}
          </Field>

          {/*
            ★ 协议选择器 —— 知识库那一路真能切协议（传给 kl 的 KL_LLM_PROVIDER）。
            两个 chip 亮不亮由**所选 kl 模型**的 supported_endpoint_types 决定，点击可覆盖。
            这就是「OpenAI 兼容网关被当 Anthropic 发 → 404」那个报错的用户侧修复。
          */}
          <ProviderPicker
            label={t("model.provider.protocol")}
            hint={t("model.kl.protocolHint")}
            value={effectiveKlProvider}
            supported={
              klModelValue.trim() !== "" ? providersForModel(klModelValue) : supportedProviders
            }
            onPick={setKlProvider}
            openaiLabel={t("model.provider.openai")}
            anthropicLabel={t("model.provider.anthropic")}
            unsupportedLabel={t("model.provider.unsupported")}
          />

          <div className="flex flex-col gap-[var(--gap-component-sm)]">
            <div className="flex items-center gap-2">
              <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
                {t("model.provider.apiKey")}
              </span>
              <KeyTag field={current.klLlmApiKey} fallbackLabel={t("model.kl.inherited")} />
            </div>
            <Input
              type="password"
              aria-label={t("model.provider.apiKey")}
              value={klApiKey}
              onChange={(event) => setKlApiKey(event.target.value)}
              placeholder={t("model.provider.apiKeyPlaceholder")}
            />
          </div>

          <div className="flex flex-col gap-[var(--gap-component-sm)]">
            <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("model.provider.modelMain")}
            </span>
            <ChipPicker
              options={modelOptions}
              value={klModel ?? current.klModelMain.value}
              onPick={(next) => {
                setKlModel(next)
                // ★ 选了 kl 模型就把手动协议清掉 → effectiveKlProvider 自动取该模型的
                // 推荐协议（有 anthropic 选 anthropic）。用户之后仍可再手动切。
                setKlProvider(null)
              }}
              // 空值 = 跟随主配置，所以这里多一个「跟随」档
              inheritLabel={t("model.kl.inherited")}
              onInherit={() => setKlModel("")}
            />
          </div>
        </div>
      </Disclosure>

      <div className="flex items-center gap-3">
        <Button size="sm" disabled={save.isPending || !dirty} onClick={submit}>
          {saveLabel ?? t("model.save")}
        </Button>
        {/* 只在**真的存过**之后显示，且改动后（dirty）就撤掉 —— 不给假反馈 */}
        {save.isSuccess && !dirty && (
          <Tag size="sm" status="success" showIndicator>
            {t("model.saved")}
          </Tag>
        )}
      </div>

      {/*
        ★★ 这里展示 RuntimeConfigService 已解析完所有层级后的值，不复用状态页的
        LoadedConfig 表。后者只知道「内置默认 / .env / 环境变量」，不知道数据库
        用户覆盖，正是 `text-embedding-v4` 看起来像最终值的根因。

        摘要刻意只读 `current`，不把未保存草稿算进去：标题与说明都写明「已保存」，
        用户点保存、query 失效并重读主进程之后，这里才变化，因此不会给假反馈。
      */}
      <EffectiveConfigSummary config={current} />
    </div>
  )
}

type RuntimeFieldSource = RuntimeConfigView["embedModel"]["source"]
type EffectiveFieldSource = RuntimeFieldSource | "inheritedMain" | "inheritedKl"

/** 主进程解析后的三条真实调用路径；密钥永远只显示可用/不可用。 */
function EffectiveConfigSummary({ config }: { config: RuntimeConfigView }) {
  const { t } = useDynamicTranslation("settings")
  const klBaseSource: EffectiveFieldSource =
    config.klLlmBaseUrl.value.trim() === "" ? "inheritedMain" : config.klLlmBaseUrl.source
  const klModelSource: EffectiveFieldSource =
    config.klModelMain.value.trim() === "" ? "inheritedMain" : config.klModelMain.source
  const klKeySource: EffectiveFieldSource =
    config.klLlmApiKey.configured || config.klLlmApiKey.source !== "default"
      ? config.klLlmApiKey.source
      : "inheritedMain"
  const embedBaseSource: EffectiveFieldSource =
    config.embedBaseUrl.value.trim() === "" ? "inheritedKl" : config.embedBaseUrl.source
  const embedKeySource: EffectiveFieldSource =
    config.embedApiKey.source === "user" ? "user" : "inheritedKl"

  return (
    <section
      aria-label={t("model.effective.title")}
      className="flex flex-col gap-[var(--gap-section-sm)] rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card-z0)] p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="typography-title-small-500 text-[var(--text-base-primary)]">
          {t("model.effective.title")}
        </h3>
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("model.effective.hint")}
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <EffectiveRouteCard title={t("model.effective.main")}>
          <EffectiveConfigLine
            label={t("model.effective.endpoint")}
            value={config.llmBaseUrl.value}
            source={config.llmBaseUrl.source}
          />
          <EffectiveConfigLine
            label={t("model.effective.model")}
            value={config.modelMain.value}
            source={config.modelMain.source}
          />
          <EffectiveConfigLine
            label={t("model.effective.protocol")}
            value={t(`model.provider.${config.mainProvider.value}`)}
            source={config.mainProvider.source}
          />
          <EffectiveConfigLine
            label={t("model.effective.key")}
            value={t(config.llmApiKey.configured ? "model.keyOn" : "model.keyOff")}
            source={config.llmApiKey.source}
          />
        </EffectiveRouteCard>

        <EffectiveRouteCard title={t("model.effective.knowledge")}>
          <EffectiveConfigLine
            label={t("model.effective.endpoint")}
            value={config.klEffective.baseUrl}
            source={klBaseSource}
          />
          <EffectiveConfigLine
            label={t("model.effective.model")}
            value={config.klEffective.model}
            source={klModelSource}
          />
          <EffectiveConfigLine
            label={t("model.effective.protocol")}
            value={t(`model.provider.${config.klEffective.provider}`)}
            source={config.klProvider.source}
          />
          <EffectiveConfigLine
            label={t("model.effective.key")}
            value={t(config.klEffective.apiKeyConfigured ? "model.keyOn" : "model.keyOff")}
            source={klKeySource}
          />
        </EffectiveRouteCard>

        <EffectiveRouteCard title={t("model.effective.embedding")}>
          <EffectiveConfigLine
            label={t("model.effective.endpoint")}
            value={config.klEffective.embedBaseUrl}
            source={embedBaseSource}
          />
          <EffectiveConfigLine
            label={t("model.effective.model")}
            value={config.embedModel.value}
            source={config.embedModel.source}
          />
          <EffectiveConfigLine
            label={t("model.effective.dimension")}
            value={String(config.embeddingDim.value)}
            source={config.embeddingDim.source}
          />
          <EffectiveConfigLine
            label={t("model.effective.sendDimensions")}
            value={t(
              config.embedSendDimensions.value ? "model.effective.send" : "model.effective.omit",
            )}
            source={config.embedSendDimensions.source}
          />
          <EffectiveConfigLine
            label={t("model.effective.key")}
            value={t(config.embedApiKey.configured ? "model.keyOn" : "model.keyOff")}
            source={embedKeySource}
          />
        </EffectiveRouteCard>
      </div>
    </section>
  )
}

function EffectiveRouteCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--bg-card-z1)] p-3">
      <h4 className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
        {title}
      </h4>
      <dl className="flex flex-col gap-2">{children}</dl>
    </div>
  )
}

function EffectiveConfigLine({
  label,
  value,
  source,
}: {
  label: string
  value: string
  source: EffectiveFieldSource
}) {
  const { t } = useDynamicTranslation("settings")
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5">
      <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">{label}</dt>
      <dd className="min-w-0 text-right">
        <span
          className="typography-caption-400 break-all text-[var(--text-base-secondary)]"
          title={value || undefined}
        >
          {value || "—"}
        </span>
      </dd>
      <dd className="col-start-2 flex justify-end">
        <Tag size="sm" status="default">
          {t(`model.effective.sources.${source}`)}
        </Tag>
      </dd>
    </div>
  )
}

/**
 * 「配没配 key」用一个 Tag 表达，不用一整行描述。
 *
 * 已配置显示后 4 位（够确认"是我那把 key"）；未配置是**中性灰**而非红色 ——
 * 没配 key 在 onboarding 里是正常的起始状态，一进来就看到红色
 * 会让人以为自己弄坏了什么。
 */
function KeyTag({
  field,
  fallbackLabel,
  inheritedLabel,
}: {
  field: RuntimeConfigView["llmApiKey"]
  fallbackLabel?: string
  /**
   * 「这一项自己没填，用的是回退来的那把」时显示的文案。
   *
   * ★ 为什么需要它：embedding 那把的 `configured` 报的是**回退解析后**
   * 有没有 key 可用（见 service 里 `embedApiKey` 那段）。只按 configured
   * 分两态的话，"跟随知识库那把"会显示成"已配置" —— 那是**假反馈**：
   * 用户会以为自己给 embedding 单独配过一把。给了这个 label 就三态：
   * 自己填了（后 4 位）/ 跟随（这个 label）/ 一把都没有（未配置）。
   */
  inheritedLabel?: string
}) {
  const { t } = useDynamicTranslation("settings")
  if (field.configured) {
    // 自己没填但有回退来的那把 —— 说"跟随"，不说"已配置"
    if (inheritedLabel !== undefined && field.source !== "user") {
      return (
        <Tag size="sm" status="default">
          {inheritedLabel}
        </Tag>
      )
    }
    return (
      <Tag size="sm" status="success" showIndicator>
        {field.tail === null ? t("model.keyOn") : t("model.keyTail", { tail: field.tail })}
      </Tag>
    )
  }
  return (
    <Tag size="sm" status="default">
      {fallbackLabel ?? t("model.keyOff")}
    </Tag>
  )
}

/**
 * 探测结果那一行。
 *
 * ★ 失败时给的是**可照做的下一步**，不是网关的英文报文：
 * 401 该去换密钥、DNS 失败该去查地址 —— 两者的动作完全不同，
 * 所以 reason 分类在主进程就做好了（见 RuntimeConfigService.probe）。
 * 原文放进 `title`（悬停可见），不怼到界面上。
 */
function ProbeResult({
  result,
  failed,
}: {
  result: RuntimeConfigProbe | undefined
  failed: boolean
}) {
  const { t } = useDynamicTranslation("settings")
  // IPC 本身失败（极少见）也要有话说，不能静默
  if (failed) {
    return (
      <Tag size="sm" status="error" showIndicator>
        {t("model.probe.reason.unreachable")}
      </Tag>
    )
  }
  if (result === undefined) return null
  if (result.ok) {
    return (
      <Tag size="sm" status="success" showIndicator>
        {t("model.probe.ok", { count: result.models.length })}
      </Tag>
    )
  }
  return (
    <span
      className="typography-caption-400 text-[var(--status-error)]"
      title={result.detail ?? undefined}
    >
      {t(`model.probe.reason.${result.reason ?? "unreachable"}`)}
    </span>
  )
}

/**
 * 协议选择器（openai / anthropic 两个 chip）。
 *
 * ★ 两个 chip 都**始终显示**，但网关探测确认不支持的那个标灰、点了给一行提示 ——
 * 而不是把它藏掉。藏掉的话用户会以为"这网关只有一个协议"，而这正是之前那个
 * 误导性 bug 的另一种形态。显示 + 标注既诚实又不挡手（没探过时两个都可点）。
 */
function ProviderPicker({
  label,
  hint,
  value,
  supported,
  onPick,
  openaiLabel,
  anthropicLabel,
  unsupportedLabel,
}: {
  label: string
  hint: string
  value: ModelProvider
  /** 探测确认网关支持的协议集（没探过时传两个都在，等于不限制）。 */
  supported: readonly ModelProvider[]
  onPick: (next: ModelProvider) => void
  openaiLabel: string
  anthropicLabel: string
  /** 选了一个网关不支持的协议时的提示文案。 */
  unsupportedLabel: string
}) {
  const options: { id: ModelProvider; label: string }[] = [
    { id: "openai", label: openaiLabel },
    { id: "anthropic", label: anthropicLabel },
  ]
  // 当前选中的协议不在网关支持集里 → 给一行警告（与 modelNotListed 同一个防法）。
  const pickedUnsupported = supported.length > 0 && !supported.includes(value)
  return (
    <div className="flex flex-col gap-[var(--gap-component-sm)]">
      <span className="typography-body-small-400 text-[var(--text-base-secondary)]">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const isSupported = supported.length === 0 || supported.includes(option.id)
          return (
            <Chip key={option.id} selected={value === option.id} onClick={() => onPick(option.id)}>
              {/* 网关明确不支持的那个：标一个「!」提示它没被验证过，但仍可点 */}
              {isSupported ? option.label : `${option.label} !`}
            </Chip>
          )
        })}
      </div>
      {pickedUnsupported ? (
        <span className="typography-caption-400 text-[var(--status-warning)]">
          {unsupportedLabel}
        </span>
      ) : (
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{hint}</span>
      )}
    </div>
  )
}

/**
 * 档位选择器（chips）。
 *
 * 对齐 `PersonaRuntimePanel` 的 `LimitRow`：**给档位就是给建议**。
 * 空输入框会让用户去想"填什么合法"，而这里选中态本身就是答案。
 *
 * 列表可能很长（网关实测 68 个模型），所以 `flex-wrap` + 滚动上限。
 */
function ChipPicker({
  options,
  value,
  onPick,
  otherLabel,
  custom = false,
  onCustom,
  inheritLabel,
  onInherit,
}: {
  options: readonly string[]
  value: string
  onPick: (next: string) => void
  /** 传了才显示「其它」（切到手输） */
  otherLabel?: string
  custom?: boolean
  onCustom?: () => void
  /** 传了才显示「跟随主配置」档（KL 用，空值即继承） */
  inheritLabel?: string
  onInherit?: () => void
}) {
  return (
    <div className="flex max-h-[136px] flex-wrap gap-1.5 overflow-y-auto">
      {inheritLabel !== undefined && onInherit !== undefined && (
        <Chip selected={value === ""} onClick={onInherit}>
          {inheritLabel}
        </Chip>
      )}
      {options.map((option) => (
        <Chip key={option} selected={!custom && value === option} onClick={() => onPick(option)}>
          {option}
        </Chip>
      ))}
      {otherLabel !== undefined && onCustom !== undefined && (
        <Chip selected={custom} onClick={onCustom}>
          {otherLabel}
        </Chip>
      )}
    </div>
  )
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "typography-caption-400 cursor-pointer rounded-[var(--radius-sm)] px-2 py-1 transition-colors duration-150",
        "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]",
        selected
          ? "bg-[var(--overlay-on-container-selected)] text-[var(--text-base-primary)]"
          : "text-[var(--text-base-secondary)] hover:bg-[var(--overlay-on-container-hover)] hover:text-[var(--text-base-primary)]",
      )}
    >
      {children}
    </button>
  )
}
