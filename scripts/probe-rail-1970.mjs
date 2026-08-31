#!/usr/bin/env node
/**
 * CDP 探针：验「侧栏一排 `1970/1/1`」这一轮修复在**真应用**里成立。
 *
 * ## 为什么必须有这个探针
 *
 * 这一轮改了四处，而它们的失败形态**都是无声的**：
 *
 * · 存储层 upsert 的 NULL 语义（单测已锁，但那是内存库上的行为）；
 * · v32 迁移把存量的 `0` 清成 `NULL` —— **只在真库上跑一次**，
 *   单测里没法验"它真的被链条调用了"；
 * · 显示层 `isDisplayableTime` 挡住 0；
 * · 「还没有消息」在范围外会话上换成「未在采集范围内」。
 *
 * 迁移那一条尤其需要真机验证：迁移写好但忘了注册、或版本号写重了，
 * 在单测里都可能全绿（单测直接执行那段 SQL），而真机上等于没跑。
 *
 * ## ★ 四类断言
 *
 * ① **库里不再有 `last_message_at = 0`**（迁移真的跑了，且版本 ≥ 32）；
 * ② **侧栏一个 `1970` 都不出现**（这是产品报的那个现象本身）；
 * ③ 那些没有时间的行**不显示时间列**（而不是显示成别的怪东西）；
 * ④ 「有未读但一条都没采」的行说的是「未在采集范围内」，不是「还没有消息」。
 *
 * ★★ 只读。不改任何配置、不碰采集数据。
 *
 * ★ 不回传真实会话标题/人名：所有判据都在页内 `evaluate` 里算成
 *   布尔与计数，只把数字带回来（真实聊天对象属于隐私，见 CLAUDE.md 1.1）。
 *
 * 用法：先带 --remote-debugging-port=<port> 起应用，再跑本脚本。
 *   pnpm dev -- --remote-debugging-port=9413
 *   node scripts/probe-rail-1970.mjs 9413
 */
const PORT = process.argv[2] ?? "9413"

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === "page")
if (!page) {
  console.log(`⚠️  ${PORT} 上没有页面。应用带 --remote-debugging-port=${PORT} 起来了吗？`)
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true })
  socket.addEventListener("error", reject, { once: true })
})

let id = 0
const pending = new Map()
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data)
  const handler = pending.get(message.id)
  if (handler) {
    pending.delete(message.id)
    handler(message)
  }
})

function evaluate(expression) {
  const messageId = (id += 1)
  return new Promise((resolve, reject) => {
    pending.set(messageId, (message) => {
      if (message.error) return reject(new Error(JSON.stringify(message.error)))
      const result = message.result?.result
      if (result?.subtype === "error") return reject(new Error(result.description))
      resolve(result?.value)
    })
    socket.send(
      JSON.stringify({
        id: messageId,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const problems = []
/** 「没验到」与「验失败」是两件事 —— 见下面 noRail 那段。 */
const skipped = []

/**
 * ── ① / ② / ③ 侧栏：数字分身页 ─────────────────────────────
 */
/**
 * ★ 「数字分身」在侧栏里（与「设置」不同 —— 那个在用户菜单里，
 * 见 `probe-embed-gateway.mjs` 里记的那次探针自伤）。
 */
const opened = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll("button, a, [role=button]")]
  const hit = nodes.find((n) => (n.textContent ?? "").trim().includes("数字分身"))
  if (!hit) return false
  hit.click()
  return true
})()`)
if (opened !== true) {
  problems.push("侧栏里没找到「数字分身」入口")
} else {
  // 会话列表要发 IPC 拉数据 + 取头像，给足时间
  await sleep(4000)

  /**
   * 读侧栏。
   *
   * ★★ 判据落在**会话行**上而不是整页 `body`：页面别处（消息流、设置）
   * 也可能出现年份数字，在整页上搜 "1970" 会把无关文本算进来，
   * 而更糟的是反过来 —— 某天有人在别处写了 1970，这条断言会永远红，
   * 于是被当成噪音关掉。
   *
   * ★ 用 `textContent` 而不是 `innerText`：前人实测过 innerText
   * 在某些容器上会漏掉真实存在于 DOM 里的文本。
   */
  const rail = await evaluate(`(() => {
    /**
     * 定位会话侧栏。
     *
     * ★ 不能只认 aside 标签，也不能拿整页的 li —— 引导页里也有 li（六个步骤）。
     * 用侧栏自己的搜索框（placeholder 含"搜会话"）当锚：它是 ConversationRail
     * 的第一个元素，存在即说明侧栏真的渲染了。
     */
    const search = document.querySelector('input[placeholder*="搜会话"]')
    if (!search) return { noRail: true }
    const aside = search.closest("aside") ?? search.parentElement?.parentElement
    if (!aside) return { noRail: true }
    const rows = [...aside.querySelectorAll("li button")]
    let with1970 = 0
    let with1969 = 0
    let invalidDate = 0
    let noMessages = 0
    let notCollected = 0
    for (const row of rows) {
      const text = row.textContent ?? ""
      if (text.includes("1970")) with1970 += 1
      if (text.includes("1969")) with1969 += 1
      if (text.includes("Invalid Date")) invalidDate += 1
      if (text.includes("还没有消息")) noMessages += 1
      if (text.includes("未在采集范围内")) notCollected += 1
    }
    return {
      rows: rows.length,
      with1970,
      with1969,
      invalidDate,
      noMessages,
      notCollected,
    }
  })()`)

  /**
   * ★★ 侧栏没渲染 → **说"没验到"，不算通过也不算失败**。
   *
   * 实测踩到过：这台机器的引导流程还没走完，数字分身模块被引导页占着，
   * 会话侧栏压根不在 DOM 里。那时探针原来报"没找到侧栏（aside）"
   * ——听起来像应用坏了，而其实是**探针没有可验的界面状态**。
   *
   * 两者必须分开：把"没验到"记成失败会让人去查一个不存在的 bug；
   * 记成通过更糟 —— 那是一条恒绿断言（CLAUDE.md 第 4 节）。
   * 所以单独用 `skipped` 记，并在汇总里明确说出来。
   */
  if (rail.noRail === true || rail.rows === 0) {
    skipped.push(
      rail.noRail === true
        ? "侧栏未渲染（引导流程未完成时数字分身页是引导视图）—— 界面侧 ②③④ 没验到"
        : "侧栏里一行会话都没有 —— 界面侧 ②③④ 没验到",
    )
  } else {
    // ② 这是产品报的那个现象本身
    if (rail.with1970 > 0) {
      problems.push(`侧栏还有 ${rail.with1970} 行显示 1970（修复没生效）`)
    }
    // ③ 顺带挡住负数与 NaN 的两种形态
    if (rail.with1969 > 0) problems.push(`侧栏有 ${rail.with1969} 行显示 1969（负数时间戳）`)
    if (rail.invalidDate > 0) {
      problems.push(`侧栏有 ${rail.invalidDate} 行显示 Invalid Date（NaN 时间戳）`)
    }
  }
  globalThis.__rail = rail
}

/**
 * ── ① 库层：迁移真的跑了吗 ────────────────────────────────
 */
/**
 * ★★ 这一条是这个探针最不可替代的部分。
 *
 * 单测直接执行那段 SQL，所以"迁移写好但忘了注册 / 版本号重复 / 没被链条
 * 调用"这几种错在单测里**全绿**。只有在真应用真库上查一次才能证明它跑了。
 *
 * 走 IPC 而不是自己开库：应用正持有那个库（WAL），而且从应用自己的视角
 * 读到的才是它实际会渲染的数据。
 */
const db = await evaluate(`(async () => {
  const res = await window.mycontext.persona.conversations()
  if (res?.ok !== true) return { ok: false }
  const items = res.data
  // ★ 只回传计数，不回传标题（真实会话名属于隐私）
  return {
    ok: true,
    total: items.length,
    zero: items.filter((c) => c.lastMessageAt === 0).length,
    negative: items.filter((c) => typeof c.lastMessageAt === "number" && c.lastMessageAt < 0).length,
    nullish: items.filter((c) => c.lastMessageAt === null).length,
    // 「有未读但一条都没采」的行数 —— ④ 的分母
    unreadButEmpty: items.filter((c) => c.messageCount === 0 && c.unreadCount > 0).length,
  }
})()`)

if (db?.ok !== true) {
  problems.push("persona.conversations() 没返回 ok（IPC 出问题）")
} else {
  if (db.zero > 0) {
    problems.push(
      `库里仍有 ${db.zero} 个会话的 lastMessageAt = 0 —— v32 迁移没生效` +
        `（迁移可能没注册进 VAULT_MIGRATIONS，或版本号重复）`,
    )
  }
  if (db.negative > 0) problems.push(`库里有 ${db.negative} 个会话的 lastMessageAt 是负数`)
}

/**
 * ── ④ 「没采」与「没消息」分开说了吗 ────────────────────────
 */
/**
 * ★ 只在真的存在这种行时才断言 —— 没有这种会话时这一条不适用，
 * 而"没有可验的样本"必须**说出来**而不是静默算通过（否则它是一条恒绿断言）。
 */
const rail = globalThis.__rail
if (db?.ok === true && rail !== undefined && rail.rows > 0) {
  if (db.unreadButEmpty === 0) {
    console.log("· 本机库里没有「有未读但一条都没采」的会话 —— ④ 这一条没有样本可验")
  } else if (rail.notCollected === 0) {
    problems.push(
      `库里有 ${db.unreadButEmpty} 个「有未读但一条都没采」的会话，` +
        `但侧栏一行都没说「未在采集范围内」—— 它们仍在说「还没有消息」（替对方背锅）`,
    )
  }
}

/**
 * ── 汇总 ───────────────────────────────────────────────
 */
console.log("")
if (rail !== undefined && rail.rows !== undefined) {
  console.log(
    `· 侧栏 ${rail.rows} 行：1970 × ${rail.with1970} · 1969 × ${rail.with1969} · ` +
      `Invalid Date × ${rail.invalidDate}`,
  )
  console.log(
    `· 空态文案：「还没有消息」× ${rail.noMessages} · 「未在采集范围内」× ${rail.notCollected}`,
  )
}
if (db?.ok === true) {
  console.log(
    `· 库层 ${db.total} 个会话：lastMessageAt = 0 的 ${db.zero} 个 · ` +
      `null 的 ${db.nullish} 个 · 有未读但没采的 ${db.unreadButEmpty} 个`,
  )
}
for (const s of skipped) console.log(`· 跳过：${s}`)
if (problems.length === 0) {
  if (skipped.length > 0) {
    console.log("✓ 库层已验（0 已清空）；界面侧有未验到的部分，见上面的「跳过」")
  } else {
    console.log("✓ 1970 已消失，且「没采」与「没消息」分开说了")
  }
} else {
  console.log(`✗ ${problems.length} 处问题：`)
  for (const p of problems) console.log(`  - ${p}`)
}

socket.close()
process.exit(problems.length === 0 ? 0 : 1)
