/**
 * 文档覆盖面：`drained` 的**粒度**，与「不可用」不许被说成「在往回补」。
 *
 * ## ★★★ 用户报的问题（原话）
 *
 * 「钉钉这边显示的学习范围…关于文档感觉有点问题：
 *   文档：2026-05-18 起已有 291 篇，覆盖 62 天。**其中 0 天已采完**，
 *   62 天还在往回补。」
 *
 * 62 天一天都没采完 —— 而那个数字**永远不会动**。
 *
 * ## 实测根因（本机 vault）
 *
 * ```
 * sqlite> SELECT drained, count(*) FROM document_coverage GROUP BY drained;
 * 0|453          -- ★ 453 行全是 0，一行 1 都没有
 * ```
 *
 * `drained` 原来的判据是 `!listed.truncated` —— 而 `truncated` 是**整轮
 * 列举**的一个布尔，被摊到每个 (空间, 天) 上。它的四个来源里有一个是
 * `catch { truncated = true }`（某个子域没开通 / 无权限），那一处**每轮都命中**。
 * 于是"某一个空间读不到"把**全部** 453 行判成没采完。
 *
 * ## ★★ 为什么"显示不准"在这个仓库里算严重缺陷
 *
 * 「还在往回补」是一句**承诺**：它说再等等就会好。而 `unavailable` 是
 * 终态 —— 下一轮、下一天、下个月都是同一个结果。这正是 CLAUDE.md 第 4 节
 * 说的那类最贵的 bug 换了个位置出现：**一个永久失败被显示成"正在进行"**。
 * 用户能做的唯一一件有用的事（换一份有权限的客户端 / 去开通知识库）
 * 被那句话盖住了。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type { ChannelPlugin, DocumentListIncomplete, ParsedDocumentLike } from "@mycontext/channels"
import { DistillSourceRepository } from "@mycontext/store"
import { IngestService } from "@main/services/ingest.service.js"
import { DistillSourceService } from "@main/services/distill-source.service.js"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const CHANNEL = "dingtalk"

function doc(externalId: string, updatedAt: number): ParsedDocumentLike {
  return {
    externalId,
    origin: "wiki",
    title: `文档 ${externalId}`,
    docType: "ALIDOC",
    extension: "md",
    url: null,
    workspaceId: "spaceFAKE0001",
    updatedAt,
    createdAt: null,
    contentText: null,
  }
}

/**
 * 造一个 `documents.list()` 按指定成因返回"不完整"的渠道。
 *
 * ★ `incomplete` 与 `truncated` **两个都给**（形状照真实实现：
 * `truncated` 是存量字段，仍然为兼容留着）。这一点很关键 ——
 * 如果 fixture 只给新字段，那"实现有没有真的从看 truncated 改成看
 * incomplete"这件事就测不出来（旧判据会因为 truncated 缺失而恒真）。
 */
function setup(incomplete: DocumentListIncomplete | null) {
  const clock = new ManualClock(NOW)
  const items = [doc("docFAKE0001", NOW - 3 * DAY), doc("docFAKE0002", NOW - 4 * DAY)]
  const plugin = {
    meta: { id: CHANNEL },
    ingest: {
      probe: async () => null,
      pull: async () => ({
        conversations: [],
        messages: [],
        nextCursor: null,
        hasMore: false,
        itemCount: 0,
        rawPayload: "{}",
      }),
    },
    documents: {
      list: async () => ({
        items: [...items],
        nextToken: null,
        hasMore: false,
        truncated: incomplete !== null,
        incomplete,
        rawPayload: JSON.stringify({ items: items.length }),
      }),
      body: async () => ({ contentText: null, rawPayload: null }),
      readableExtensions: ["md"],
    },
  } as unknown as ChannelPlugin

  const vault = openTestVault()
  const service = new IngestService({
    db: vault.db,
    clock,
    logger: createLogger("test-doc-drained", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()
  new DistillSourceRepository(vault.db).upsert(
    "doc",
    { enabled: true, scope: { since: NOW - 30 * DAY } },
    NOW,
  )
  return { vault, service, clock }
}

/** `document_coverage` 里 drained=1 的行数 / 总行数。 */
function drainedRows(vault: TestVault): { drained: number; total: number } {
  const row = vault.db
    .prepare<
      [],
      { drained: number; total: number }
    >("SELECT sum(drained) AS drained, count(*) AS total FROM document_coverage")
    .get()
  return { drained: row?.drained ?? 0, total: row?.total ?? 0 }
}

describe("★★★ 列举完整 → 那几天记成已采完（改动前恒为 0）", () => {
  it("★★★ `incomplete: null` ⇒ 覆盖面行 drained=1", async () => {
    const { vault, service } = setup(null)

    await service.tickDocuments()

    const rows = drainedRows(vault)
    /**
     * ★ 先断言"真的写了行"—— 否则下面那条在 0 行时会**恒绿**
     * （sum(drained)=0 === total=0）。这一轮已经踩过一次同形的坑
     * （覆盖面断言用 `.get()` 读第一行，闸门坏了照样绿）。
     */
    expect(rows.total).toBeGreaterThan(0)
    /**
     * 反证：把 `drained` 的判据改回 `!listed.truncated` ⇒ 这一条仍然绿
     * （完整时两个判据同值）。真正区分两者的是下面 `unavailable` 那一组
     * ——所以这一条的作用是"别把 drained 写死成 0"，配对才完整。
     */
    expect(rows.drained).toBe(rows.total)
    vault.close()
  })
})

describe("★★★ 「某个空间不可用」不许把**全部**天数判成没采完", () => {
  it("★★★ `unavailable` ⇒ 覆盖面行 drained=0（这是那 453 行的成因）", async () => {
    const { vault, service } = setup("unavailable")

    await service.tickDocuments()

    const rows = drainedRows(vault)
    expect(rows.total).toBeGreaterThan(0)
    /**
     * ★★ 这一条**不是**在说"这个行为是对的"—— 恰恰相反，它锁住的是
     * "我们仍然如实记账"：列举确实不完整，所以不能说采完了。
     *
     * 真正的修法在**读出口**：把"为什么不完整"一路带到界面
     * （见下面那一组），让用户看到的是「读不到 + 出路」而不是
     * 「62 天还在往回补」。
     *
     * ★ 换句话说：库这一层保持保守（0），界面那一层负责说清成因。
     * 反过来（库里写 1 装作采完了）是在库里制造一个谎。
     */
    expect(rows.drained).toBe(0)
    vault.close()
  })

  it("★★★ 成因一路传到读出口：`incomplete === 'unavailable'`", async () => {
    const { vault, service, clock } = setup("unavailable")

    await service.tickDocuments()

    /**
     * ★★ 这一条是这个文件的**核心**：它验的是那条**接线**。
     *
     * `IngestService` 知道成因（内存里），而覆盖面读出口在
     * `DistillSourceService`（只读 SQLite）。两者之间靠 `startup.ts` 注入的
     * `documentsIncomplete` 回调连起来 —— 而"忘了接线"这个缺陷不会报错，
     * 它只会让界面永远显示 `null`（也就是退回改动前的"还在往回补"）。
     *
     * 反证：把这里的 `documentsIncomplete` 去掉 ⇒ 返回 `null` ⇒ 转红。
     */
    const distill = new DistillSourceService({
      clock,
      logger: createLogger("test-doc-coverage", { level: "error" }),
      plugin: { meta: { id: CHANNEL } } as unknown as ChannelPlugin,
      primaryChannelId: CHANNEL,
      documentsIncomplete: (channelId) =>
        channelId === CHANNEL ? service.documentsIncompleteReason : null,
    })
    // ★ 库是 `attach()` 挂的（不是构造选项）—— 不挂的话 `chatCoverage`
    // 走"库没就绪"那条早退，恒返回 incomplete: null，用例会**因为错的原因**变绿
    distill.attach(vault.db)

    const view = distill.chatCoverage({
      channelId: CHANNEL,
      domain: "doc",
      fromDay: "1970-01-01",
      toDay: "2999-12-31",
    })

    expect(view.incomplete).toBe("unavailable")
    /** ★ 同时确认它**不是**把整块读空了 —— 条数照样要在。 */
    expect(view.localCount).toBeGreaterThan(0)
    vault.close()
  })

  it("★★ 而 `chat` / `minutes` 域恒为 null（这个字段只属于文档）", async () => {
    const { vault, service, clock } = setup("unavailable")

    await service.tickDocuments()

    const distill = new DistillSourceService({
      clock,
      logger: createLogger("test-doc-coverage", { level: "error" }),
      plugin: { meta: { id: CHANNEL } } as unknown as ChannelPlugin,
      primaryChannelId: CHANNEL,
      documentsIncomplete: () => service.documentsIncompleteReason,
    })
    distill.attach(vault.db)

    /**
     * 这一条是上一条的**配对**：最省事的实现是"在 `chatCoverage` 顶层
     * 统一塞一个 incomplete" —— 而那会让**消息**那一行也说
     * 「有一部分读不到（没开通或没权限）」，而消息压根不是这么回事
     * （它按会话翻页，齐没齐由 `drained` 逐天回答）。
     *
     * ★ 注意这里的 `documentsIncomplete` 回调**不看域**（故意的）：
     * 判据必须在服务内部按 `input.domain` 分派，而不是靠调用方自律。
     */
    for (const domain of ["chat", "minutes"] as const) {
      const view = distill.chatCoverage({
        channelId: CHANNEL,
        domain,
        fromDay: "1970-01-01",
        toDay: "2999-12-31",
      })
      expect(view.incomplete).toBeNull()
    }
    vault.close()
  })
})

describe("★★ 三种成因必须**分开**（出路完全不同）", () => {
  it("★★ `more-spaces` / `space-truncated` 原样传出，不折成 unavailable", async () => {
    /**
     * ## 为什么这一条重要
     *
     * 三种成因对用户的意义完全不同：
     *
     * · `more-spaces` / `space-truncated` → **等**就行（下一轮继续翻）；
     * · `unavailable` → 等一辈子也没用，得换客户端 / 去开通。
     *
     * 把前两种折成 `unavailable` 会让一次正常的分页中途显示成
     * 「你没权限」，而用户可能真的去改了权限配置 —— 那是把人引到
     * 一件完全无关的事上。
     *
     * ★ 反向（把 unavailable 折成 more-spaces）就是我们要修的原缺陷。
     */
    for (const reason of ["more-spaces", "space-truncated"] as const) {
      const { vault, service, clock } = setup(reason)
      await service.tickDocuments()

      const distill = new DistillSourceService({
        clock,
        logger: createLogger("test-doc-coverage", { level: "error" }),
        plugin: { meta: { id: CHANNEL } } as unknown as ChannelPlugin,
        primaryChannelId: CHANNEL,
        documentsIncomplete: () => service.documentsIncompleteReason,
      })
      distill.attach(vault.db)
      const view = distill.chatCoverage({
        channelId: CHANNEL,
        domain: "doc",
        fromDay: "1970-01-01",
        toDay: "2999-12-31",
      })

      expect(view.incomplete).toBe(reason)
      vault.close()
    }
  })
})
