#!/usr/bin/env node
/**
 * 把**渠道 CLI 自带的 skill**（mono + multi）同步进随包分发的资源目录，
 * **并做外发前的净化**。
 *
 * ## ★★★ 源是「二进制内嵌」，不是某个本地 checkout
 *
 * 上游把 skill 用 `//go:embed all:mono all:multi` 编进二进制，并提供
 * `dws skill setup --mode <mono|multi>` 从内嵌源解出来。所以这里调的是
 * **我们自己随包的那份二进制**（`resources/bin/dws-<平台>`）。
 *
 * 为什么不是拿 `~/gits/<上游仓库>/skills` 拷：
 *
 * · **版本必然一致。** skill 与二进制同源，`prepare:bin` 升了二进制、
 *   重跑一次同步就是配套的那份 skill。而按本地 checkout 拷的话，
 *   checkout 的 commit 与 npm 包里的二进制版本**没有任何机制保证一致** ——
 *   于是 skill 里写着一条二进制上不存在的命令（或反过来），
 *   而 agent 只会得到 `unknown subcommand`，日志里看不出是版本错配。
 * · **别人 clone 下来就能跑。** 不需要额外克隆一个仓库到某个约定路径。
 *   （上游自己的 `--source` 与 `DWS_SKILL_SOURCE` 仍可覆盖，见下。）
 *
 * ★ 上游那份**一个字都不改** —— 我们只改自己解出来的这份副本。
 *
 * ## 为什么要"同步"而不是运行时直接调 `dws skill setup`
 *
 * 上游那个命令是往**用户家目录**的 16 个 agent 目录里写（先删再覆盖），
 * 还写 `~/.dws/`。我们刻意不让它碰用户家目录（同 `dws-resolver.mjs` 里
 * "为什么不用它自己的 postinstall"那段）。这里把它的输出**引到我们自己的
 * 资源目录**，再走 `skills.paths` 指过去。
 *
 * 有同步脚本就必须有**漂移门禁**（`check-dws-skill-sync.mjs`）：
 * 「同步过了」与「忘了同步」外观完全相同 —— agent 照常工作，
 * 只是用的是旧版命令说明。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, relative, resolve } from "node:path"
import { findResidual, transformFor } from "./lib/dws-skill-sanitize.mjs"

const root = resolve(import.meta.dirname, "..")

/**
 * 平台后缀。与 `packages/runtime-env/src/binaries.ts` 的 `platformSuffix()`
 * 同一套拼法（node 的 arch 名，不是 Go 的 amd64）。
 */
function platformSuffix() {
  return `${process.platform}-${process.arch}`
}

const binary = join(root, "apps/desktop/resources/bin", `dws-${platformSuffix()}`)
/** mono / multi 各自的产物目录。**并存**，运行时按设置项选一个（默认 multi）。 */
const targets = Object.freeze({
  mono: join(root, "apps/desktop/resources/skills/dws-mono"),
  multi: join(root, "apps/desktop/resources/skills/dws-multi"),
})

if (!existsSync(binary)) {
  console.error(
    [
      `未找到渠道 CLI 二进制：${binary}`,
      "先跑 `pnpm prepare:bin` 把它准备好（skill 源内嵌在这个二进制里）。",
    ].join("\n"),
  )
  process.exit(1)
}

/**
 * 只对**文本**做替换，其余按字节拷。与 kl 那份同一条判据。
 *
 * 二进制里做字符串替换会破坏文件，所以扩展名不认识时原样拷 ——
 * 但同时提示一声，因为那意味着净化没覆盖它。
 */
const TEXT_EXT = /\.(md|txt|json|yml|yaml|sh|py|ts|js|mjs)$/i

/**
 * 用 `dws skill setup` 把内嵌 skill 解到一个临时 HOME 下。
 *
 * ## ★★ 为什么改 HOME 而不是用 `--target .`
 *
 * `--target .` 在 `--help` 的可选值里**列着**，但实测直接报
 * `不支持的 --target 值: .` —— 上游那条路是坏的（v1.0.57）。
 * 而 `--target opencode` 走 `$HOME/.config/opencode/skills`，把 HOME
 * 指到一个临时目录就等于"解到我指定的地方"，不碰真实家目录。
 *
 * ★ 顺带把 `DWS_CONFIG_DIR` 也指进临时目录：那个命令会写 `~/.dws/logs`，
 * 不隔离的话它会往真实家目录里写日志（我们不希望一次构建动用户的东西）。
 */
function extractEmbedded(mode, tmpHome) {
  rmSync(tmpHome, { recursive: true, force: true })
  mkdirSync(tmpHome, { recursive: true })
  const result = spawnSync(
    binary,
    ["skill", "setup", "--mode", mode, "--target", "opencode", "--yes"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmpHome,
        DWS_CONFIG_DIR: join(tmpHome, ".dws"),
      },
      timeout: 120_000,
    },
  )
  if (result.status !== 0) {
    console.error(`解出内嵌 skill 失败（mode=${mode}）：`)
    console.error(result.stderr || result.stdout || `退出码 ${String(result.status)}`)
    process.exit(1)
  }
  const out = join(tmpHome, ".config/opencode/skills")
  if (!existsSync(out)) {
    console.error(`解出内嵌 skill 后没找到产物目录：${out}`)
    process.exit(1)
  }
  return out
}

/** 净化并拷进目标目录。返回 {textFiles, binaryFiles, replaced}。 */
function sanitizeInto(source, target) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  let textFiles = 0
  let binaryFiles = 0
  const replaced = new Set()

  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const rel = relative(source, full)
      const dest = join(target, rel)
      if (statSync(full).isDirectory()) {
        mkdirSync(dest, { recursive: true })
        walk(full)
        continue
      }
      mkdirSync(dirname(dest), { recursive: true })
      if (!TEXT_EXT.test(name)) {
        cpSync(full, dest)
        binaryFiles += 1
        continue
      }
      const original = readFileSync(full, "utf8")
      for (const { kind } of findResidual(original)) replaced.add(kind)
      writeFileSync(dest, transformFor(rel, original), "utf8")
      textFiles += 1
    }
  }
  walk(source)
  return { textFiles, binaryFiles, replaced }
}

const tmpRoot = join(root, ".dws-skill-tmp")
let totalText = 0
let totalBinary = 0
const allReplaced = new Set()

for (const [mode, target] of Object.entries(targets)) {
  const source = extractEmbedded(mode, join(tmpRoot, mode))
  const { textFiles, binaryFiles, replaced } = sanitizeInto(source, target)
  totalText += textFiles
  totalBinary += binaryFiles
  for (const kind of replaced) allReplaced.add(kind)
  console.log(`已同步 ${mode}：${target}`)
  console.log(`  文本 ${String(textFiles)} 个（已净化）／其他 ${String(binaryFiles)} 个`)
}
rmSync(tmpRoot, { recursive: true, force: true })

console.log(`合计文本 ${String(totalText)} 个／其他 ${String(totalBinary)} 个`)
if (allReplaced.size > 0) {
  console.log(`  ★ 已替换：${[...allReplaced].join("、")}（映射见 lib/dws-skill-sanitize.mjs）`)
}
if (totalBinary > 0) {
  console.log("  ⚠ 有非文本文件未经净化检查 —— 确认它们不含个人数据或商标。")
}
