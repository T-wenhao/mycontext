/**
 * @vitest-environment jsdom
 *
 * 覆盖面「齐没齐」那一句：**文档域不按天说**，而「不可用」要说出路。
 *
 * ## ★★★ 用户报的问题（原话）
 *
 * 「文档：2026-05-18 起已有 291 篇，覆盖 62 天。其中 **0 天已采完**，
 *   62 天还在往回补。」
 *
 * ## 为什么那句话必须整个删掉，而不是把 0 修成别的数
 *
 * 文档是**按空间**翻页的（`wiki node list` 递归 + drive 游标），
 * 一天不存在"翻完"这件事。而 `drained` 却存在每个 (空间, 天) 上，
 * 它的值来自**整轮列举**的一个布尔 —— 于是文档的 `drainedDays` 只有
 * 两种取值：0（不完整）或 dayCount（完整），**完全由 `incomplete` 决定**。
 *
 * 换句话说「62 天还在往回补」里那个 62 是一个空间维度的事实被伪装成了
 * 时间维度的进度。用户会等一个不存在的进度条走完。
 *
 * ## ★★ 三种成因的出路完全不同
 *
 * · `unavailable`（没开通 / 无权限）→ **终态**，等一辈子没用，得换客户端；
 * · `more-spaces` / `space-truncated` → 下一轮会继续；
 * · `null` → 能列到的都列完了。
 *
 * 混成一句「还在往回补」就是把一个永久失败显示成"正在进行" ——
 * 与头像的 `not_permitted`、消费者的 `unwired` 同一个形状。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { CoverageDomain } from "@mycontext/ipc-contract"
import { ScopeCoverage } from "@renderer/features/shell/scope-coverage"

afterEach(cleanup)

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

/**
 * 渲染一行覆盖面。
 *
 * ★ `drainedDays: 0` + `dayCount: 62` 照抄用户看到的那个真实状态
 * （453 行全 drained=0 → 一天都没采完）。这是缺陷的**输入**，
 * 所以三个域都用同一份数字 —— 差别必须只来自域与 `incomplete`。
 */
function setup(domain: CoverageDomain, incomplete: string | null) {
  const chatCoverage = vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      data: {
        days: [],
        localCount: 291,
        dayCount: 62,
        drainedDays: 0,
        pendingConversations: 0,
        incomplete,
      },
    }),
  )
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = { distill: { chatCoverage } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  render(<ScopeCoverage channelId="dingtalk" rangeDays={90} customRange={null} domain={domain} />, {
    wrapper,
  })
  return { chatCoverage }
}

/** 等到那一行渲染出来，返回整块文字。 */
async function textOf(domain: CoverageDomain, incomplete: string | null): Promise<string> {
  setup(domain, incomplete)
  /**
   * ★ 等的是**数据到了**，而不是"body 非空"。
   *
   * 后者会在 loading 那一帧就满足（渲染的是「正在统计已有的…」），
   * 于是所有断言都在拿 loading 文案比对 —— 五条全红，而红的原因
   * 与被测的判据毫无关系。这个坑值得记一句：等待条件写松了，
   * 测的就是另一个状态。
   */
  await waitFor(() => {
    expect(document.body.textContent ?? "").toContain("{{days}}")
  })
  /**
   * ★ 渲染层的 i18n 是**不做插值**的桩：渲染出来的是 `defaultValue` 的
   * 字面量（含 `{{label}}` 这种未替换的占位符）。所以这一层能锁的是
   * **走了哪一支**（每支的文案里都有一个独有的词），
   * 而不是"最终那句中文长什么样"。
   *
   * 判据用独有词而不是完整文案：完整文案会因为改一个标点就全红，
   * 而那时红的不是缺陷。
   */
  return document.body.textContent ?? ""
}

describe("★★★ 文档域：一句都不提「天」", () => {
  it("★★★ `unavailable` → 说「读不到」+ 出路，**不说**「往回补」", async () => {
    const text = await textOf("doc", "unavailable")

    // 说清是读不到（而不是"在补"）
    expect(text).toContain("读不到")
    /**
     * ★★★ 这一条是这个文件的核心断言。
     *
     * 反证：把 `progressText` 的 `unavailable` 那一支去掉 ⇒ 落到
     * `pendingDays !== 0` 那支 ⇒ 渲染出「还在往回补」⇒ 转红。
     */
    expect(text).not.toContain("往回补")
    // ★ 也不许出现天数对（62 / 0 都是伪装成进度的空间事实）
    expect(text).not.toContain("天已采完")
  })

  it("★★★ `more-spaces` → 说「还有更多没列到」，仍然不提天数", async () => {
    const text = await textOf("doc", "more-spaces")

    expect(text).toContain("没列到")
    /**
     * ★★ 这一条抓的是我第一版**只修了 unavailable** 那个漏洞。
     *
     * 那一版里 `more-spaces` 落到 `pendingDays !== 0` 那支，于是照样渲染
     * 「其中 0 天已采完，62 天还在往回补」—— 用户报的那句话一字不差
     * 还在。而 `more-spaces` 下 `drained` 也是全 0（判据是
     * `incomplete === null`），所以这不是一个假想的分支。
     */
    expect(text).not.toContain("往回补")
    expect(text).not.toContain("天已采完")
  })

  it("★★ `null`（列全了）→ 说「都已列完」，也不提天数", async () => {
    const text = await textOf("doc", null)

    expect(text).toContain("都已列完")
    /**
     * ★ 这一条是必要的配对：最省事的实现是"文档域一律说还有更多没列到"，
     * 而那会让一个**已经列全**的组织永远看到一句"下一轮继续"。
     */
    expect(text).not.toContain("没列到")
    // ★ 「这些天都已采完」也不行 —— 文档没有"天翻完"这件事
    expect(text).not.toContain("这些天")
  })
})

describe("★★★ 而聊天 / 听记**保留**天数对（它们真的按天回溯）", () => {
  it("★★★ chat 域 → 仍然是「其中 N 天已采完，M 天还在往回补」", async () => {
    const text = await textOf("chat", null)

    /**
     * ## 为什么这一条是必要的配对
     *
     * 最省事的"修法"是把天数对整个删掉 —— 而那会连**正确**的那两域
     * 一起改坏。聊天是按会话逐天回溯的（每个会话都有自己的水位），
     * 「哪几天已经翻到没有更多」是一个真实且有用的事实。
     *
     * 反证：把 `domain === "doc"` 这个判据去掉（三域走同一支）⇒ 这条转红。
     */
    expect(text).toContain("往回补")
    vi.restoreAllMocks()
  })

  it("★★ minutes 域也一样（它按天翻会议列表）", async () => {
    const text = await textOf("minutes", null)
    expect(text).toContain("往回补")
  })
})
