/**
 * 头像批量补齐：撞到**整轮性**的权限墙就停，别把每个人都试一遍。
 *
 * ## ★★★ 用户报的现象
 *
 * 「为什么我钉钉渠道获取下头像失败」+ 一段日志 —— 17 秒里 15 次
 * `listGroupMembersByUids error`，全是同一个错。
 *
 * 每个人要 2-3 次子进程调用，串行跑。而这一批里第 1 个人失败的原因
 * （这份客户端对这个企业没开通该能力）**对第 60 个人一模一样成立** ——
 * 同一个 OAuth 客户端、同一个企业。于是继续循环的收益恒为零，
 * 代价是几十次子进程 + 十几秒卡顿，而用户看到的只是
 * 「刷新头像转了很久然后什么都没变」。
 *
 * ## ★★ 判据是"整轮属性 vs 个人属性"，不是"有多严重"
 *
 * 这是这一组用例真正要锁住的东西。`failed`（子进程超时、网络抖动）
 * 看起来也很严重，但它是**可重试**的、确实可能只影响一个人 ——
 * 对它短路会把一次抖动变成"整批放弃"，而 `mediaAvatarsFetch` 的注释
 * 里明确说要避免"一个人的超时带走整批"。
 *
 * 所以短路只对 `not_permitted` 生效。这两个方向都要有用例，
 * 否则最省事的实现（"失败就停"）会悄悄通过。
 */
import { describe, expect, it } from "vitest"
import {
  AVATAR_REASON_PRIORITY,
  isWholeRoundAvatarWall,
  worseAvatarReason,
  type AvatarMissReasonName,
} from "@main/ipc/register.js"

describe("★★★ 整轮性权限墙才短路", () => {
  it("★★★ `not_permitted` → 停（这是那 15 次子进程的成因）", () => {
    /**
     * 反证：把 `isWholeRoundAvatarWall` 改成恒 `false` ⇒ 这一条转红，
     * 而那正是改动前的行为（循环跑完全部 60 个人）。
     */
    expect(isWholeRoundAvatarWall("not_permitted")).toBe(true)
  })

  it("★★★ `failed` → **不停**（可重试，可能只影响一个人）", () => {
    /**
     * ## 这一条是上一条的必要配对
     *
     * 只写上一条的话，最省事的实现是 `reason !== null` 就停 ——
     * 而那会让一次子进程超时（下一个人本来会成功）变成"整批放弃"。
     *
     * 反证：把判据改成 `reason !== null` ⇒ 这一条转红。
     */
    expect(isWholeRoundAvatarWall("failed")).toBe(false)
  })

  it("★★ 三个「用户什么都做不了」的都不停（它们不是故障）", () => {
    /**
     * `not_set`（对方没设头像）、`not_reachable`（没有共同群）、
     * `not_attempted`（我们缺花名没去查）—— 这三个是**常态**，
     * 一批 60 人里出现几十个都很正常。对它们短路等于"第一个人没设头像，
     * 剩下 59 个就都不查了"。
     */
    for (const reason of ["not_set", "not_reachable", "not_attempted"] as const) {
      expect(isWholeRoundAvatarWall(reason)).toBe(false)
    }
  })

  it("★ 还没有任何失败（null）→ 当然不停", () => {
    expect(isWholeRoundAvatarWall(null)).toBe(false)
  })
})

describe("★★ 报给用户的原因取**最可执行**的那个", () => {
  it("★★★ 一批里既有「没设头像」又有「没权限」→ 报没权限", () => {
    /**
     * ## 为什么是"可执行"而不是"最后一个"
     *
     * 「对方没设头像」用户什么都做不了；「这份客户端没权限」的出路很明确
     * （换一份自备客户端）。报前者等于把唯一有用的信息丢掉。
     *
     * ★ 顺序两个方向都试：只试一个方向的话，一个"取 max 而不是 min"的
     * 实现会有一半概率通过。
     */
    expect(worseAvatarReason("not_set", "not_permitted")).toBe("not_permitted")
    expect(worseAvatarReason("not_permitted", "not_set")).toBe("not_permitted")
  })

  it("★★ 不认识的原因忽略，不许把已有的判据冲掉", () => {
    /**
     * 契约以后可能加新的 reason 值，而这一层收到一个它不认识的串时
     * **不能**把 `reason` 置空 —— 那会让一个真实的权限墙在界面上消失。
     *
     * ★ `null` 也算不认识（成功那一路不带 reason）。
     */
    expect(worseAvatarReason("not_permitted", "something-new")).toBe("not_permitted")
    expect(worseAvatarReason("not_permitted", null)).toBe("not_permitted")
  })

  it("★ 优先级表本身：not_permitted 最前，not_set 最后", () => {
    /**
     * 这张表的**顺序就是判据**，所以单独锁两头。
     *
     * ★ 它原来埋在一个 IPC handler 的闭包里，一条用例都碰不到 ——
     * 提到模块级导出正是为了这个。
     */
    expect(AVATAR_REASON_PRIORITY[0]).toBe("not_permitted")
    expect(AVATAR_REASON_PRIORITY.at(-1)).toBe("not_set")
  })
})

describe("★★★ 模拟那一轮：15 个人，第 1 个撞墙", () => {
  it("★★★ 只试 1 个人，剩下 14 个跳过（不是 15 次子进程）", () => {
    /**
     * 这一条把两个判据**合起来**跑一遍循环的形状 —— 因为缺陷是它们
     * 组合起来的结果，而单看任何一个都不显眼。
     *
     * ★ 跳过的人**不计入 failed**：我们没试过，报成失败会让
     * "取不到几个"这个数字失真（用户会以为那 14 个人各自都有问题）。
     */
    const people = Array.from({ length: 15 }, (_, i) => `DFAKE${i}`)
    let tried = 0
    let failed = 0
    let skipped = 0
    let reason: AvatarMissReasonName | null = null

    for (const _person of people) {
      if (isWholeRoundAvatarWall(reason)) {
        skipped += 1
        continue
      }
      tried += 1
      // 真机上每个人都会撞同一面墙 —— 第一个就够了
      failed += 1
      reason = worseAvatarReason(reason, "not_permitted")
    }

    expect(tried).toBe(1)
    expect(skipped).toBe(14)
    expect(failed).toBe(1)
    expect(reason).toBe("not_permitted")
  })

  it("★★ 而全是 `failed`（抖动）时 15 个人**都要试**", () => {
    /**
     * 配对：抖动不是整轮属性。这一条保证短路没有顺手把"重试有意义"
     * 那条路也砍掉 —— 那会让一次网络波动导致整批头像永久缺失
     * （因为 `failed` 的 miss 记录有冷却期）。
     */
    const people = Array.from({ length: 15 }, (_, i) => `DFAKE${i}`)
    let tried = 0
    let reason: AvatarMissReasonName | null = null

    for (const _person of people) {
      if (isWholeRoundAvatarWall(reason)) continue
      tried += 1
      reason = worseAvatarReason(reason, "failed")
    }

    expect(tried).toBe(15)
    expect(reason).toBe("failed")
  })
})
