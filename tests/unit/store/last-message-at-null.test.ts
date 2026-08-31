/**
 * `last_message_at` 的 **NULL 语义**不许被折成 0。
 *
 * ## ★★★ 这里锁的是一个真实 bug：侧栏显示一排 `1970/1/1`
 *
 * `upsert` 曾经这样合并时间：
 *
 * ```sql
 * last_message_at = MAX(COALESCE(excluded.last_message_at, 0),
 *                       COALESCE(conversations.last_message_at, 0))
 * ```
 *
 * `COALESCE(…,0)` 的用意是让 `MAX` 能比较（SQLite 的 `MAX(NULL, 5)` 返回
 * NULL，会把已有时间抹掉）。但它把「**不知道**」与「**1970-01-01**」折成了
 * 同一个值，而这两件事在界面上的出路完全相反：前者该隐藏，后者是一个
 * 真实（虽然荒谬）的时间。
 *
 * ## ★★ 为什么第一版测试不可能发现它
 *
 * **第一次插入是对的**。只有第二次 upsert 才会把 NULL 变成 0：
 *
 * ```
 * INSERT（无时间）      → NULL   ← 任何"插一条查一下"的测试都会绿
 * upsert（仍然无时间）  → MAX(0, 0) = 0
 * ```
 *
 * 而会话目录是**反复**同步的（每轮采集都 upsert 一遍整个列表），所以真机上
 * 任何"从来没有过消息"的会话在第二轮之后必然显示 1970。
 *
 * 所以这一组的每个用例都**至少 upsert 两次** —— 这正是原来漏掉的判据。
 *
 * ## 它还连着另一个已知故障
 *
 * `stale-conversations-livelock.test.ts` 的文件头记了真机上一个
 * `last_msg_at = 0` 的「毒丸行」把对账窗口钉死在 7 天。那是同一个成因的
 * 另一个侧面 —— 0 不只是显示难看，它会被当成一个**极早的真实时间**参与计算。
 */
import { describe, expect, it } from "vitest"
import { ConversationRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CHANNEL = "dingtalk"
/** 假 cid（CLAUDE.md 1.2：结构照真、值全编）。 */
const CID = "cidFAKE0001=="

/** upsert 一次。`lastMessageAt` 传 undefined 表示"这一趟不知道时间"。 */
function upsert(
  repo: ConversationRepository,
  lastMessageAt: number | undefined,
  externalId = CID,
): void {
  repo.upsert({
    id: `conv-${externalId}`,
    channelId: CHANNEL,
    externalId,
    type: "group",
    title: "沙箱项目群",
    memberCount: 12,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    createdAt: 1_700_000_000_000,
  })
}

function read(repo: ConversationRepository, externalId = CID): number | null {
  const row = repo.findByExternalId(CHANNEL, externalId)
  expect(row).not.toBeNull()
  return row!.lastMessageAt
}

describe("conversations.last_message_at 的 NULL 语义", () => {
  /**
   * ★★★ 这一条就是那个 bug 的判据。改回 `COALESCE(…, 0)` 会让它红。
   */
  it("★★ 反复 upsert 一个没有时间的会话 → 始终是 null，不许变成 0", () => {
    const vault = openTestVault()
    const repo = new ConversationRepository(vault.db)

    upsert(repo, undefined)
    expect(read(repo)).toBeNull() // 第一次本来就是对的

    // ★ 第二次 —— 老实现在这里把 null 写成了 0
    upsert(repo, undefined)
    expect(read(repo)).toBeNull()

    // 再多几轮（真机上每轮采集都会 upsert 一遍）
    upsert(repo, undefined)
    upsert(repo, undefined)
    expect(read(repo)).toBeNull()

    vault.close()
  })

  it("null → 有时间：取到那个时间", () => {
    const vault = openTestVault()
    const repo = new ConversationRepository(vault.db)
    upsert(repo, undefined)
    upsert(repo, 1_780_000_000_000)
    expect(read(repo)).toBe(1_780_000_000_000)
    vault.close()
  })

  /**
   * ★ 有时间 → 这一趟不知道时间：**不许倒退**成 null。
   *
   * 会话目录那一路（群列表）压根没有时间字段，所以它每次都传 undefined。
   * 若让它覆盖，一个有消息的会话会在下一轮目录同步后丢掉时间 ——
   * 那正是原来 `MAX` + `COALESCE` 想防的事，新写法必须保住。
   */
  it("★ 已有时间 + 这趟没时间 → 保留原时间（不倒退）", () => {
    const vault = openTestVault()
    const repo = new ConversationRepository(vault.db)
    upsert(repo, 1_780_000_000_000)
    upsert(repo, undefined)
    expect(read(repo)).toBe(1_780_000_000_000)
    vault.close()
  })

  it("两边都有时间 → 取较大的那个（MAX 的原意）", () => {
    const vault = openTestVault()
    const repo = new ConversationRepository(vault.db)
    upsert(repo, 1_780_000_000_000)
    upsert(repo, 1_770_000_000_000) // 更早的一趟不该把时间拉回去
    expect(read(repo)).toBe(1_780_000_000_000)
    upsert(repo, 1_790_000_000_000) // 更晚的要生效
    expect(read(repo)).toBe(1_790_000_000_000)
    vault.close()
  })

  /**
   * 多个会话互不影响 —— 防"改成子查询后写串了行"这类错。
   */
  it("不同会话各自独立", () => {
    const vault = openTestVault()
    const repo = new ConversationRepository(vault.db)
    const other = "cidFAKE0002=="
    upsert(repo, undefined, CID)
    upsert(repo, 1_780_000_000_000, other)
    upsert(repo, undefined, CID)
    upsert(repo, undefined, other)
    expect(read(repo, CID)).toBeNull()
    expect(read(repo, other)).toBe(1_780_000_000_000)
    vault.close()
  })
})
