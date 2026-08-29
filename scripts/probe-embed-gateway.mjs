#!/usr/bin/env node
/**
 * CDP 探针：验 **embedding 四项可独立配置** 这一轮改动在**真应用**里成立。
 *
 * ## 为什么必须有这个探针
 *
 * 这一轮把 embedding 的地址/密钥/维度/dimensions 开关从「写死 + 从 KL 那份推导」
 * 改成「设置面板里可配」。单测锁住了 service 层的解析语义，但证明不了
 * 那几个控件**真的画在了界面上、真的能存、存完读回来还是那个值**。
 *
 * 而这些失败形态恰恰都是无声的：
 *
 * · contract 加了字段但 UI 漏挂 → 界面上**根本没有**那个折叠区，
 *   而应用照常跑（没人会报错）；
 * · i18n 少一个 key → 标题显示成 `model.embed.title` 这种原样 key，
 *   界面还是"能用"的；
 * · save 的三态写错（`false` 被当成"没填"）→ 点了关、存完再读回来又是开。
 *   这一条单测里已经锁了，但界面到 IPC 之间还有一层（草稿状态、submit 组包），
 *   那一层错了单测同样看不见；
 * · **密钥漏了**（只能配地址）→ 指到别的 host 必然 401，而那个 401 只表现为
 *   建图时 embedding 批次反复重试退避，界面上一样无声。
 *
 * ## ★ 四类断言
 *
 * ① 设置页上**有**「向量服务单独用别的地址」这个折叠区（且标题不是原样 key）；
 * ② 四个控件都在：地址 / 密钥 / 维度 / dimensions 开关，且回退态显示「跟随知识库」
 *    而不是「已配置」（后者是假反馈 —— 让人以为自己单独配过一把）；
 * ③ **读接口返回了新字段**（embedBaseUrl / embedApiKey / embeddingDim /
 *    embedSendDimensions），且 `klEffective.embedBaseUrl` 给出实际生效地址；
 * ④ **存得进、读得回**：dimensions 开关存成 `false`、维度存成非默认值、
 *    密钥存一个假值再清空 —— 都直接打在 IPC 上，验的是那条三态语义。
 *
 * ★★ ④ 会**真的改一次本机配置**，所以跑完**改回原值**（脚本自己兜底还原）。
 * 密钥那一轮在「用户自己填过」时**整轮跳过** —— 明文读不回来，覆盖了就还不回去。
 * 除此之外只读。不碰任何采集数据。
 *
 * ★ 不回传任何真实地址/密钥：所有判据都在页内 evaluate 里算成布尔或长度，
 *   只把布尔与数字带回来（真实网关地址属于内部系统信息，见 CLAUDE.md 1.1）。
 *
 * 用法：先带 --remote-debugging-port=<port> 起应用，再跑本脚本。
 *   pnpm dev -- --remote-debugging-port=9412
 *   node scripts/probe-embed-gateway.mjs 9412
 */
const PORT = process.argv[2] ?? "9412"

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

/**
 * 打开设置弹窗。
 *
 * ★★ 「设置」**不在侧栏里** —— 它是用户菜单（左下角头像那个按钮）里的一项，
 * 打开的是 `settings-dialog.tsx` 那个弹窗（`modules.tsx:31` 的注释写明了
 * 这件事：ModuleId 里根本没有它）。
 *
 * 探针第一版直接找侧栏里叫"设置"的按钮，于是报"侧栏里没找到设置入口" ——
 * **那是探针自己的问题，不是应用的**（与 probe-data-plane-v2 里那次
 * "第一版写的是设置而拓扑卡在运行状态"是同一类自伤）。记在这里是因为
 * 下一个人照抄 openModule() 会再踩一次。
 *
 * 所以要两步：先点开用户菜单，再点菜单里的"设置"。
 */
async function openSettingsDialog() {
  // 第一步：点左下角用户按钮（它带 aria-haspopup，是菜单触发器）
  const menuOpened = await evaluate(`(() => {
    const trigger = document.querySelector("[aria-haspopup=menu]")
    if (!trigger) return false
    trigger.click()
    return true
  })()`)
  if (menuOpened !== true) return "没找到用户菜单触发器（左下角那个按钮）"
  await sleep(500)
  // 第二步：点菜单里的"设置"（menuitem，不是 button）
  const clicked = await evaluate(`(() => {
    const items = [...document.querySelectorAll("[role=menuitem], button, [role=button]")]
    const hit = items.find((n) => (n.textContent ?? "").trim() === "设置")
    if (!hit) return false
    hit.click()
    return true
  })()`)
  if (clicked !== true) return "用户菜单里没有「设置」这一项"
  await sleep(1200)
  /**
   * ★★ 第三步：切到「模型」那一栏。
   *
   * 设置面板打开后默认停在「通用」，而 `ModelConfigForm` 挂在 `model` 那一栏
   * （`settings-view.tsx:925`，栏目定义在 `:154`）。探针第二版漏了这一步，
   * 于是报"没找到向量服务折叠区" —— 又是一次探针自伤：那个折叠区确实
   * 不在 DOM 里，因为**整栏都没渲染**。
   */
  const switched = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll("button, [role=tab], [role=button], a")]
    const hit = nodes.find((n) => (n.textContent ?? "").trim() === "模型")
    if (!hit) return false
    hit.click()
    return true
  })()`)
  if (switched !== true) return "设置面板里没有「模型」那一栏"
  return true
}

const problems = []

/**
 * ── ① / ② 界面：折叠区与三个控件 ───────────────────────────
 */
/**
 * ★ 模型配置表单（`model-config-form.tsx`）由设置弹窗与 onboarding 第 2 步共用，
 * 设置弹窗是常态入口。
 */
const opened = await openSettingsDialog()
if (opened !== true) {
  problems.push(opened)
} else {
  await sleep(2500)

  /**
   * 展开那个折叠区。
   *
   * ★ 它是原生 details/summary（Disclosure 组件），折叠时**内容不在 DOM 里** ——
   * 不展开就读不到里面的三个控件（前人在 probe-data-plane-v2 里踩过这个坑，
   * 报的是"页面上没有 xx"而其实是探针没展开）。
   * ★ 直接置 open=true 比 click 稳：click 会 toggle，已展开时反而关掉。
   *
   * ★★ 这段说明必须写在注入块**外面**：注入给 CDP 的模板字符串里出现一个
   * 裸反引号就会把模板提前截断，而报错指向模板开始那一行
   * （`check-probe-templates.mjs` 存在的全部理由；前人在那个文件里记了
   * 三次踩坑）。所以下面注入块里的注释一律不用反引号。
   */
  const expanded = await evaluate(`(() => {
    const node = [...document.querySelectorAll("details")]
      .find((n) => (n.textContent ?? "").includes("向量服务单独用别的地址"))
    if (!node) return false
    node.open = true
    return true
  })()`)
  if (expanded !== true) {
    problems.push("设置页上没找到「向量服务单独用别的地址」折叠区（UI 没挂上，或 i18n key 缺）")
  } else {
    await sleep(600)
    /**
     * 读三个控件是否都在。
     *
     * ★ 判据用 label 文案定位，而不是 DOM 结构 —— 结构会随设计调整变，
     *   而"这三件事能不能配"是这一轮要验的语义。
     * ★★ 只回传布尔与数量，不回传输入框里的**值**（那是真实网关地址）。
     */
    const ui = await evaluate(`(() => {
      const text = document.body.textContent ?? ""
      // i18n 漏 key 时 t() 会原样吐出 key（含点号），据此判"文案真的翻出来了"
      const rawKeys = ["model.embed.title", "model.embed.dim", "model.embed.sendDimensions",
        "model.embed.apiKey", "model.embed.inherited"]
        .filter((k) => text.includes(k))
      // ★ 只在那个折叠区里数控件 —— 在整页上数会把主配置那两个 password 框
      //   也算进来，于是"向量密钥框漏了"这条断言恒绿（自欺）。
      const box = [...document.querySelectorAll("details")]
        .find((n) => (n.textContent ?? "").includes("向量接口地址"))
      const scoped = box ?? document.createElement("div")
      const inputs = [...scoped.querySelectorAll("input")]
      return {
        hasDimLabel: text.includes("向量维度"),
        hasBaseUrlLabel: text.includes("向量接口地址"),
        hasSwitchLabel: text.includes("dimensions"),
        // 维度是 type=number
        numberInputs: inputs.filter((n) => n.type === "number").length,
        // 密钥是 type=password（同一个折叠区里）
        passwordInputs: inputs.filter((n) => n.type === "password").length,
        // 开关是 role=switch（design 包的 Switch）
        switches: scoped.querySelectorAll("[role=switch]").length,
        // 回退态的标记：没单独填 key 时应当显示"跟随知识库"而不是"已配置"
        hasInheritTag: (scoped.textContent ?? "").includes("跟随知识库"),
        rawKeys,
      }
    })()`)
    if (ui.hasBaseUrlLabel !== true) problems.push("没有「向量接口地址」输入框")
    if (ui.hasDimLabel !== true) problems.push("没有「向量维度」输入框")
    if (ui.numberInputs < 1) problems.push("维度不是数字输入框（type=number 一个都没有）")
    if (ui.switches < 1) problems.push("没有 dimensions 开关（role=switch 一个都没有）")
    /**
     * ★ 密钥输入框必须在。地址能配而密钥不能 = 指到别的 host 必然 401，
     * 而那个 401 只表现为建图时 embedding 批次反复重试退避（界面无声）。
     */
    if (ui.passwordInputs < 1) {
      problems.push("向量折叠区里没有密钥输入框（type=password）")
    }
    if (ui.hasInheritTag !== true) {
      problems.push("没有「跟随知识库」标记 —— 用户看不出当前用的是回退来的那把 key")
    }
    if (ui.rawKeys.length > 0) {
      problems.push(`i18n 漏 key，界面上显示成原样：${ui.rawKeys.join(", ")}`)
    }
  }
}

/**
 * ── ③ 读接口真的带上了新字段 ─────────────────────────────
 */
const view = await evaluate(`(async () => {
  const res = await window.mycontext.runtimeConfig.read()
  if (res?.ok !== true) return { ok: false }
  const v = res.data
  return {
    ok: true,
    // 只回传"有没有这个字段"与类型，不回传地址明文
    hasEmbedBaseUrl: typeof v.embedBaseUrl?.value === "string",
    dimType: typeof v.embeddingDim?.value,
    dim: v.embeddingDim?.value,
    sendDimsType: typeof v.embedSendDimensions?.value,
    sendDims: v.embedSendDimensions?.value,
    // 实际生效地址：只报"非空"与长度，不报内容
    effectiveEmbedNonEmpty: (v.klEffective?.embedBaseUrl ?? "") !== "",
    // 用户自己填过没有（source=user 才是填过）
    embedBaseSource: v.embedBaseUrl?.source,
    /**
     * embedding 密钥：只回传"有没有可用的一把"与来源，绝不回传 tail/明文。
     * source=default 表示当前在跟随 KL 那把（不是"没配"）。
     */
    embedKeyConfigured: v.embedApiKey?.configured,
    embedKeySource: v.embedApiKey?.source,
    hasEmbedKeyField: typeof v.embedApiKey?.configured === "boolean",
  }
})()`)

if (view?.ok !== true) {
  problems.push("runtimeConfig.read() 没返回 ok（IPC 或 schema 出问题）")
} else {
  if (view.hasEmbedBaseUrl !== true) problems.push("read() 里没有 embedBaseUrl 字段")
  if (view.dimType !== "number") problems.push(`embeddingDim 不是 number（是 ${view.dimType}）`)
  if (view.sendDimsType !== "boolean") {
    problems.push(`embedSendDimensions 不是 boolean（是 ${view.sendDimsType}）`)
  }
  if (view.hasEmbedKeyField !== true) problems.push("read() 里没有 embedApiKey 字段")
}

/**
 * ── ④ 存得进、读得回（含 false 的三态语义）───────────────────
 */
/**
 * ★★ 这一段会**真的改本机配置**。所以先记下原值，跑完无条件还原
 * （包括断言失败的路径 —— 用 try/finally）。
 *
 * ★ 为什么要打在 IPC 上而不是只看 UI：`false` 那条三态语义
 * （undefined 不改 / null 清空 / false 是有效值）横跨 UI 草稿 → contract
 * → service → 落库四层，单测只覆盖了后两层。
 */
const before = await evaluate(`(async () => {
  const res = await window.mycontext.runtimeConfig.read()
  if (res?.ok !== true) return null
  return {
    dim: res.data.embeddingDim.value,
    sendDims: res.data.embedSendDimensions.value,
    dimIsUser: res.data.embeddingDim.source === "user",
    sendIsUser: res.data.embedSendDimensions.source === "user",
    // ★ 用户自己填过 embedding 密钥吗 —— 填过就**跳过**密钥那一轮，
    //   因为我们无法读回明文、也就无法还原它（覆盖等于弄坏用户的配置）。
    embedKeyIsUser: res.data.embedApiKey.source === "user",
  }
})()`)

if (before === null) {
  problems.push("读不到当前配置，跳过写回测试")
} else {
  try {
    // 存一个与当前不同的维度 + 把开关反过来
    const probeDim = before.dim === 1024 ? 1536 : 1024
    const probeSend = !before.sendDims
    const saved = await evaluate(`(async () => {
      const res = await window.mycontext.runtimeConfig.save({
        embeddingDim: ${probeDim},
        embedSendDimensions: ${probeSend},
      })
      return res?.ok === true
    })()`)
    if (saved !== true) {
      problems.push("save() 没返回 ok")
    } else {
      const after = await evaluate(`(async () => {
        const res = await window.mycontext.runtimeConfig.read()
        if (res?.ok !== true) return null
        return {
          dim: res.data.embeddingDim.value,
          sendDims: res.data.embedSendDimensions.value,
          dimSource: res.data.embeddingDim.source,
          sendSource: res.data.embedSendDimensions.source,
        }
      })()`)
      if (after === null) problems.push("写回后读不到配置")
      else {
        if (after.dim !== probeDim) {
          problems.push(`维度没存进去：存了 ${probeDim}，读回 ${after.dim}`)
        }
        // ★★ 这一条就是那个"false 会不会被当成没填"的判据
        if (after.sendDims !== probeSend) {
          problems.push(
            `dimensions 开关没存进去：存了 ${probeSend}，读回 ${after.sendDims}` +
              `（若存 false 却读回 true，就是把 false 当成了「没填」）`,
          )
        }
        if (after.dimSource !== "user") {
          problems.push(`存过之后 source 应该是 user，实际是 ${after.dimSource}`)
        }
      }
      /**
       * ★★ 密钥也走一次写→读。
       *
       * 判据只看 `source` 从 default 翻成 user、以及 `configured` 为真 ——
       * **不比对值本身**（read() 按设计不回显明文，只给后 4 位）。
       * 写一个明显是假的探测值，跑完立刻清空回"跟随"。
       *
       * ★ 用户自己填过就整轮跳过：明文读不回来 → 覆盖后无法还原 → 等于
       * 探针弄坏了用户的密钥。宁可少验一条，不动别人的凭据。
       */
      if (before.embedKeyIsUser === true) {
        console.log("· 你已单独配过向量密钥 —— 跳过密钥写回测试（覆盖后无法还原）")
      } else {
        const keyRound = await evaluate(`(async () => {
        const w = await window.mycontext.runtimeConfig.save({ embedApiKey: "sk-PROBE-FAKE-0001" })
        if (w?.ok !== true) return { saved: false }
        const r = await window.mycontext.runtimeConfig.read()
        if (r?.ok !== true) return { saved: true, read: false }
        return {
          saved: true,
          read: true,
          source: r.data.embedApiKey.source,
          configured: r.data.embedApiKey.configured,
          // 后 4 位应当是我们刚写的那个假值的尾巴（证明它真存进了 keychain）
          tailMatches: r.data.embedApiKey.tail === "0001",
        }
      })()`)
        if (keyRound?.saved !== true) problems.push("embedApiKey 存不进去（save 没返回 ok）")
        else if (keyRound.read !== true) problems.push("写完 embedApiKey 后读不到配置")
        else {
          if (keyRound.source !== "user") {
            problems.push(`存了 embedApiKey 之后 source 应该是 user，实际是 ${keyRound.source}`)
          }
          if (keyRound.configured !== true)
            problems.push("存了 embedApiKey 但 configured 仍为 false")
          if (keyRound.tailMatches !== true) {
            problems.push("embedApiKey 的后 4 位与刚写入的不符（可能没真的落到 keychain）")
          }
        }
        // 立刻清空这把探测用的假 key → 回到"跟随知识库"
        const cleared = await evaluate(`(async () => {
        const w = await window.mycontext.runtimeConfig.save({ embedApiKey: null })
        if (w?.ok !== true) return null
        const r = await window.mycontext.runtimeConfig.read()
        return r?.ok === true ? r.data.embedApiKey.source : null
      })()`)
        if (cleared !== "default") {
          problems.push(`清空 embedApiKey 后应回到 default（跟随），实际是 ${String(cleared)}`)
        }
      }
    }
  } finally {
    /**
     * 还原。原来是 user 覆盖就存回原值；原来是默认（没填过）就传 null 清空 ——
     * 传原值会把"没填过"变成"填了一个恰好等于默认的值"，那是**留下痕迹**。
     */
    const restored = await evaluate(`(async () => {
      const res = await window.mycontext.runtimeConfig.save({
        embeddingDim: ${before.dimIsUser ? before.dim : "null"},
        embedSendDimensions: ${before.sendIsUser ? before.sendDims : "null"},
      })
      return res?.ok === true
    })()`)
    console.log(restored === true ? "· 已还原本机配置" : "⚠️  还原失败，请手工检查设置页")
  }
}

/**
 * ── 汇总 ───────────────────────────────────────────────
 */
console.log("")
if (view?.ok === true) {
  console.log(`· 读接口字段齐全（dim=${view.dim} · sendDimensions=${view.sendDims}）`)
  console.log(
    `· embedding 实际生效地址：${view.effectiveEmbedNonEmpty ? "已解析（非空）" : "空（未配网关）"}` +
      ` · 来源=${view.embedBaseSource}`,
  )
  console.log(
    `· embedding 密钥：${view.embedKeyConfigured === true ? "有可用的一把" : "一把都没有"}` +
      ` · 来源=${view.embedKeySource}（default = 跟随知识库那把）`,
  )
}
if (problems.length === 0) {
  console.log("✓ embedding 四项（地址/密钥/维度/dimensions）在真应用里可读可写可配")
} else {
  console.log(`✗ ${problems.length} 处问题：`)
  for (const p of problems) console.log(`  - ${p}`)
}

socket.close()
process.exit(problems.length === 0 ? 0 : 1)
