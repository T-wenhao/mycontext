/**
 * VAULT v32 —— 把存量的 `last_message_at = 0` 清成 `NULL`。
 *
 * ## 为什么光修 upsert 不够
 *
 * 那个 `COALESCE(…, 0)` 的写法已经在真机上跑了很多个版本，库里**已经**存着
 * 一批 0（表现是侧栏一排 `1970/1/1`）。代码修好之后这些行不会自己变回来：
 * 一个"从来没有过消息"的会话，之后每一轮 upsert 都是 `MAX(NULL, 0)` ——
 * 新写法会老老实实保留那个已有的 0（它不知道那是脏值）。
 *
 * 所以必须有一趟迁移显式清掉。这一组锁的就是它真的清了、且只清该清的。
 *
 * ## 测试怎么模拟"旧库"
 *
 * `openTestVault()` 会把所有迁移（含 v32）跑完，所以没法用它造一个
 * "v31 状态的库"。改成**迁移跑完之后再手写一个 0 进去**，然后单独执行
 * v32 的 SQL —— 验的是那段 SQL 的行为本身，与它在链条里的位置无关。
 */
import { describe, expect, it } from "vitest"
import { ConversationRepository, VAULT_MIGRATIONS } from "@mycontext/store"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

/**
 * 从**注册表**里取那一段 SQL，而不是深 import 那个文件。
 *
 * ★ 这样顺带断言了"它真的注册进 VAULT_MIGRATIONS 了" —— 一个写好但忘了
 * 注册的迁移在真机上等于不存在，而深 import 的写法会让这种漏注册全绿通过。
 */
const V32 = VAULT_MIGRATIONS.find((m) => m.version === 32)
if (V32 === undefined) throw new Error("v32 没有注册进 VAULT_MIGRATIONS")
const VAULT_0032_NULL_LAST_MESSAGE_AT = V32.sql

const CHANNEL = "dingtalk"

/** 造一个会话，并**直接写库**把 last_message_at 设成指定值（模拟旧库的脏数据）。 */
function seedRaw(vault: TestVault, externalId: string, lastMessageAt: number | null): void {
  new ConversationRepository(vault.db).upsert({
    id: `conv-${externalId}`,
    channelId: CHANNEL,
    externalId,
    type: "group",
    title: "沙箱项目群",
    createdAt: 1_700_000_000_000,
  })
  vault.db
    .prepare("UPDATE conversations SET last_message_at = ? WHERE external_id = ?")
    .run(lastMessageAt, externalId)
}

function read(vault: TestVault, externalId: string): number | null {
  const row = new ConversationRepository(vault.db).findByExternalId(CHANNEL, externalId)
  expect(row).not.toBeNull()
  return row!.lastMessageAt
}

describe("VAULT v32 · 清掉 last_message_at = 0", () => {
  it("★ 0 → NULL（侧栏那一排 1970 的来源）", () => {
    const vault = openTestVault()
    seedRaw(vault, "cidFAKE0001==", 0)
    expect(read(vault, "cidFAKE0001==")).toBe(0) // 反证起点：脏值确实在
    vault.db.exec(VAULT_0032_NULL_LAST_MESSAGE_AT)
    expect(read(vault, "cidFAKE0001==")).toBeNull()
    vault.close()
  })

  /**
   * ★★ 不许碰真实时间。
   *
   * 这一趟的边界很重要：它只清"这个 bug 会产生的那个确切值"。若判据写成
   * `<= 0` 或某个"合理下界"，就会顺手删掉一批成因不明的数据 ——
   * 那超出了这次修复的范围。
   */
  it("★★ 有真实时间的行完全不动", () => {
    const vault = openTestVault()
    seedRaw(vault, "cidFAKE0002==", 1_780_000_000_000)
    seedRaw(vault, "cidFAKE0003==", 1) // 1ms —— 荒谬但不是这个 bug 造的
    vault.db.exec(VAULT_0032_NULL_LAST_MESSAGE_AT)
    expect(read(vault, "cidFAKE0002==")).toBe(1_780_000_000_000)
    expect(read(vault, "cidFAKE0003==")).toBe(1)
    vault.close()
  })

  it("已经是 NULL 的行保持 NULL（幂等）", () => {
    const vault = openTestVault()
    seedRaw(vault, "cidFAKE0004==", null)
    vault.db.exec(VAULT_0032_NULL_LAST_MESSAGE_AT)
    vault.db.exec(VAULT_0032_NULL_LAST_MESSAGE_AT) // 跑两遍
    expect(read(vault, "cidFAKE0004==")).toBeNull()
    vault.close()
  })

  it("混合库：只有 0 那些被清", () => {
    const vault = openTestVault()
    seedRaw(vault, "cidFAKE0005==", 0)
    seedRaw(vault, "cidFAKE0006==", 1_780_000_000_000)
    seedRaw(vault, "cidFAKE0007==", 0)
    vault.db.exec(VAULT_0032_NULL_LAST_MESSAGE_AT)
    expect(read(vault, "cidFAKE0005==")).toBeNull()
    expect(read(vault, "cidFAKE0006==")).toBe(1_780_000_000_000)
    expect(read(vault, "cidFAKE0007==")).toBeNull()
    vault.close()
  })
})
