/**
 * @vitest-environment jsdom
 *
 * 自建 embedding 模型必须能手输，且最终生效摘要必须来自 RuntimeConfigService
 * 的解析视图，而不是状态页只含 default/.env/env 的基础注入表。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { SaveRuntimeConfigInput } from "@mycontext/ipc-contract"
import { ModelConfigForm } from "@renderer/features/settings/model-config-form"

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

afterEach(cleanup)

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })

function installApi(initialEmbedModel = "text-embedding-v4"): {
  saved: SaveRuntimeConfigInput[]
} {
  const saved: SaveRuntimeConfigInput[] = []
  let embedModel = initialEmbedModel
  let embedSource: "user" | "default" = initialEmbedModel.startsWith("qwen") ? "user" : "default"
  let mainModel = "glm-5.2"

  const api = {
    runtimeConfig: {
      read: () =>
        ok({
          llmBaseUrl: { value: "https://main.example.com/v1", source: "env" as const },
          llmApiKey: { configured: true, tail: null, source: "env" as const },
          modelMain: { value: mainModel, source: "default" as const },
          mainProvider: { value: "openai" as const, source: "default" as const },
          embedModel: { value: embedModel, source: embedSource },
          klLlmBaseUrl: { value: "", source: "default" as const },
          klLlmApiKey: { configured: false, tail: null, source: "default" as const },
          klModelMain: { value: "", source: "default" as const },
          klProvider: { value: "openai" as const, source: "default" as const },
          embedBaseUrl: { value: "http://127.0.0.1:8000/v1", source: "user" as const },
          embedApiKey: { configured: true, tail: "qwen", source: "user" as const },
          embeddingDim: { value: 2048, source: "user" as const },
          embedSendDimensions: { value: false, source: "user" as const },
          klEffective: {
            baseUrl: "https://main.example.com/v1",
            baseUrlSource: "inheritedMain" as const,
            model: mainModel,
            modelSource: "inheritedMain" as const,
            apiKeyConfigured: true,
            apiKeySource: "inheritedMain" as const,
            provider: "openai" as const,
            providerSource: "default" as const,
            embedBaseUrl: "http://127.0.0.1:8000/v1",
            embedBaseUrlSource: "user" as const,
            embedModel,
            embedModelSource: embedSource,
            embedApiKeyConfigured: true,
            embedApiKeySource: "user" as const,
            embeddingDim: 2048,
            embeddingDimSource: "user" as const,
            sendDimensions: false,
            sendDimensionsSource: "user" as const,
          },
        }),
      save: (input: SaveRuntimeConfigInput) => {
        saved.push(input)
        if (input.embedModel !== undefined) {
          embedModel = input.embedModel
          embedSource = "user"
        }
        if (input.modelMain !== undefined) mainModel = input.modelMain
        return ok({ appliedNow: true, needsRestart: ["klServer" as const] })
      },
      probe: () =>
        ok({
          ok: true as const,
          reason: null,
          provider: "openai" as const,
          providers: ["openai" as const],
          modelProviders: {} as Record<string, ("openai" | "anthropic")[]>,
          detail: null,
          models: ["glm-5.2"],
        }),
      onChanged: () => () => undefined,
    },
  }
  Object.defineProperty(window, "mycontext", { configurable: true, value: api })
  return { saved }
}

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>
        <ModelConfigForm />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe("★★ 自建 embedding 模型与最终生效配置", () => {
  it("★★ 可手输 qwen 模型，保存只提交 embedModel", async () => {
    const api = installApi()
    renderForm()
    await screen.findByRole("region", { name: "最终生效配置" })

    // 主模型和向量模型各有一个「其它」；后者才是本测试的入口。
    const otherButtons = screen.getAllByRole("button", { name: "其它…" })
    fireEvent.click(otherButtons.at(-1)!)
    const input = screen.getByRole("textbox", { name: "向量模型（手动填写）" })
    fireEvent.change(input, { target: { value: "qwen3-embedding-4b" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(api.saved).toEqual([{ embedModel: "qwen3-embedding-4b" }]))
  })

  it("★★ 当前是自建模型时，改主模型不会把 embedding 默认值一并写回", async () => {
    const api = installApi("qwen3-embedding-4b")
    renderForm()
    await screen.findByRole("region", { name: "最终生效配置" })

    const otherButtons = screen.getAllByRole("button", { name: "其它…" })
    fireEvent.click(otherButtons[0]!)
    const input = screen.getByRole("textbox", { name: "主模型" })
    fireEvent.change(input, { target: { value: "custom-main" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(api.saved).toEqual([{ modelMain: "custom-main" }]))
  })

  it("★ 摘要展示数据库覆盖后的模型、地址、维度、参数和来源", async () => {
    installApi("qwen3-embedding-4b")
    renderForm()
    const summary = await screen.findByRole("region", { name: "最终生效配置" })
    const content = within(summary)

    expect(content.getByText("qwen3-embedding-4b")).toBeTruthy()
    expect(content.getByText("http://127.0.0.1:8000/v1")).toBeTruthy()
    expect(content.getByText("2048")).toBeTruthy()
    expect(content.getByText("不发送")).toBeTruthy()
    expect(content.getAllByText("设置保存").length).toBeGreaterThan(0)
    expect(content.getAllByText("跟随主配置").length).toBeGreaterThan(0)
  })
})
