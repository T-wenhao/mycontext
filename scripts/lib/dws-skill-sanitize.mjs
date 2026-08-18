#!/usr/bin/env node
/**
 * 随包分发的**渠道 CLI skill**（mono / multi）的去商标映射与宿主适配前言，
 * 以及"有没有漏"的判据。
 *
 * `sync-dws-skill.mjs`（生产者）与 `check-dws-skill-sync.mjs`（门禁）共用这一份 ——
 * 与 `kl-skill-sanitize.mjs` 同一个理由：两处各写一份映射的结局是它们迟早
 * 不一致，而那时门禁会**永远红**且原因指向"忘了同步"（真实原因是两份映射差一个字）。
 *
 * ## 为什么需要这一步
 *
 * skill 源是**渠道 CLI 二进制内嵌的**（`dws skill setup` 从 `//go:embed` 解出），
 * 而这份产物会通过 `extraResources` **打进 .app 分发给用户**
 * （`apps/desktop/resources/skills/` → `Resources/skills/`），
 * 于是同一段文字换了受众：从"上游自己的文档"变成"随我们产品外发的内容"。
 *
 * ★ 与 kl 那份的**一处不同**：这里**没有真名要脱敏**（实测 260 个文件里
 * 命令示例用的是 `13800138000` / `张三` 这类明显编造的值）。所以这份表
 * 只处理商标与宿主适配，不含 hash 姓名表。将来若上游加进真名，
 * 照 `kl-skill-sanitize.mjs` 那套 hash 表补上 —— **不要**在这里写明文真名。
 */

/**
 * 商标字样 → 中性表述。
 *
 * ★ 键按片段拼装：直接写字面量的话**本文件自己**会被 `check:trademarks` 命中
 * （那个脚本的 FORBIDDEN 也是这么写的，理由相同 —— 见它的注释）。
 *
 * ## ★★ 为什么是"换"而不是"删整段"
 *
 * 这几处都出现在 `dev connect`（把 IM 机器人接到某个桌面 agent）的渠道枚举里。
 * 删掉整行会让那张表变成一份**不完整的枚举** —— agent 照着它去调
 * `--channel <不在表里的值>` 会被 CLI 拒绝，而它无从知道自己漏了哪个。
 * 换成中性代号则保留"这里有 N 个渠道可选"这个真实结构。
 *
 * ★ 顺序有意义：长键必须排在短键**前面**。`q+oderwork` 含 `q+oder` 作为前缀，
 * 先替短的会把长的切成 `<中性名>work`，于是它再也匹配不到长键 ——
 * 那是一个静默的错替换（产物看起来干净，门禁也过，但内容是错的）。
 * 下面 `replaceTrademarks` 靠 `Object.keys` 的插入序保证这一点。
 */
export const TRADEMARK_TO_NEUTRAL = Object.freeze({
  ["Q" + "oderWork"]: "DesktopAgentB",
  ["Q" + "oderWake"]: "DesktopAgentC",
  ["q" + "oderwork"]: "desktop-agent-b",
  ["Q" + "oder"]: "DesktopAgentA",
  ["q" + "oder"]: "desktop-agent-a",
})

/** 有没有残留商标（门禁与同步脚本共用的判据）。 */
export function findResidual(text) {
  const hits = []
  for (const key of Object.keys(TRADEMARK_TO_NEUTRAL)) {
    if (text.includes(key)) hits.push({ kind: "商标", key })
  }
  return hits
}

function replaceTrademarks(text) {
  let out = text
  // 插入序 = 长键优先（见 TRADEMARK_TO_NEUTRAL 上那段 ★）
  for (const [from, to] of Object.entries(TRADEMARK_TO_NEUTRAL)) {
    out = out.split(from).join(to)
  }
  return out
}

/**
 * ★★★ 我们这套部署与上游假设不符的地方 —— 注入在 SKILL.md **正文之前**。
 *
 * 与 kl 那份的 `HOST_PREAMBLE` 同一个手法，但要说的事完全不同。
 * 三条都是**实测锁定**的宿主约束，不写的话 agent 会反复撞墙然后给降级答案：
 *
 * ① **裸 `dws` 是可用的，不要去找二进制路径。** 磁盘上的文件名是
 *    `dws-darwin-arm64`（`resources/bin/`），而 skill 正文通篇写裸 `dws`。
 *    宿主在 spawn 时前插了一个提供裸 `dws` 的 shim 目录（见
 *    `search.service.ts` 的 PATH 构造），所以裸 `dws` 命中的是那个 shim。
 *    agent 若自己去 `ls resources/bin` 拼绝对路径，会被权限层拒（只放行 `dws`）。
 *
 * ② **不要用管道、重定向或其他命令。** `bash` 白名单只放行 `kl` 与 `dws`
 *    （`KL_SKILL_PERMISSION`），`dws ... | jq` 整条不匹配那个 glob → 直接不执行。
 *    上游正文里有 `| jq` 的例子，是它对自己环境的合理假设。
 *    输出量用 CLI 自己的 `--fields` / `--compact` / `--limit` 控制。
 *
 * ③ **不要跑 `scripts/` 下的 python 脚本。** mono 那份带 33 个 `.py`
 *    （`python scripts/xxx.py`），而 `python` 不在 bash 白名单里 —— 恒被拒。
 *    上游自己也写了"脚本只用于明确覆盖的复合任务，优先 Shortcut"，
 *    所以这里把它收紧成"只用 Shortcut / 原子命令"。
 *
 * ★ 与 kl 那份一样**不放宽白名单来迁就文档** —— 正确做法是告诉 agent
 * 别生成那种形态。
 */
const HOST_PREAMBLE = `<!-- 由 sync:dws-skill 注入：本宿主（MyContext 桌面端）的运行环境与上游假设不同 -->
# 在这个宿主里怎么调渠道 CLI（先读这一段，它覆盖下文的调用约定）

这份 skill 跑在 MyContext 桌面端的 agent 里。宿主已经把可用的 \`dws\`
放进 PATH，所以：

- **直接用裸 \`dws\`** —— \`dws chat message list --format json\` 这样。
  不要去找二进制的绝对路径、不要 \`ls\` bin 目录：权限层只放行 \`dws\`
  这个名字，带路径的写法会被**直接拒绝执行**。
- **不要用管道、重定向或任何其他命令**（\`| jq\`、\`| head\`、\`2>&1\`、
  \`cat\`、\`pwd\` …）。权限层只放行 \`dws\` 与 \`kl\` 本身，带管道的整条命令
  会被**直接拒绝**。输出太长时用 CLI 自己的参数（\`--fields\`、\`--compact\`、
  \`--limit\`、\`--page\`），而不是截断。
- **不要跑 \`scripts/\` 下的 python 脚本** —— \`python\` 不在放行名单里，恒失败。
  用 Shortcut（\`dws <service> +<verb>\`）或原子命令代替。
- 登录态由宿主维护，**不需要** \`dws auth login\`（也不要试图切换身份）。

下文是上游原文，其中的调用方式与脚本用法按上面这几条替换。

---

`

/** 注入标记：幂等判据（已注入过的文本再跑一次不变）。 */
const PREAMBLE_MARKER = "由 sync:dws-skill 注入"

/**
 * 给外发的 SKILL.md 加宿主适配前言。
 *
 * ## ★★★ 必须插在 **frontmatter 之后**，不能拼在文件最前面
 *
 * 这是 kl 那份踩过的坑，原文照抄过来（因为这里同样是 SKILL.md）：
 * SKILL.md 的开头**不是正文**，是 `---` 包起来的 YAML frontmatter
 * （`name` / `description` 在里面）。拼在最前面会把 frontmatter 挤到文件中间，
 * 于是 opencode 解析这个 skill **直接失败并丢掉它** —— 且**没有**任何警告
 * （目录对、文件也扫到了，是解析阶段被丢的）。表现是"agent 说它没有这个能力"，
 * 全程零报错。
 */
function withHostPreamble(text) {
  if (text.includes(PREAMBLE_MARKER)) return text
  // frontmatter：文件必须以 `---\n` 开头，且有第二个 `---` 收尾
  if (!text.startsWith("---\n")) return HOST_PREAMBLE + text
  const end = text.indexOf("\n---", 4)
  if (end === -1) return HOST_PREAMBLE + text
  const cut = text.indexOf("\n", end + 1) + 1
  return text.slice(0, cut) + "\n" + HOST_PREAMBLE + text.slice(cut)
}

/**
 * 一个文件的完整变换（同步脚本与门禁**必须**共用这一个函数）。
 *
 * @param rel 相对 skill 根的路径（判"是不是 SKILL.md"用）
 */
export function transformFor(rel, text) {
  const sanitized = replaceTrademarks(text)
  // ★ 判据是 basename：mono 是 `SKILL.md`，multi 是 `<skill>/SKILL.md`
  const isSkillDoc = rel === "SKILL.md" || rel.endsWith("/SKILL.md")
  return isSkillDoc ? withHostPreamble(sanitized) : sanitized
}
