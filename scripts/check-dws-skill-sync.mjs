#!/usr/bin/env node
/**
 * 门禁：随包分发的渠道 CLI skill 与**当前二进制内嵌的那份**一致 —— 净化之后一致。
 *
 * 「同步过了」与「忘了同步」**外观完全相同** —— agent 照常工作，
 * 只是用的是旧版本的命令说明（而那些命令可能已经改了参数，
 * 表现是 `unknown subcommand` 或参数被静默忽略）。
 * 有同步脚本而无漂移门禁，与 `check-kl-skill-sync` 是同一类静默失败。
 *
 * ## ★★ 判据是"把内嵌源按同一套映射净化，再与产物比"
 *
 * `sync:dws-skill` 不是纯拷贝 —— 它去商标、给 SKILL.md 加宿主适配前言。
 * 于是产物与源**必然**逐字节不同。拿原文比的话这个门禁**永远红**，
 * 而错误信息会说"请运行 pnpm sync:dws-skill"，跑了也还是红 ——
 * 那种门禁的下场是被加进忽略列表，连带真的漂移也不再有人看。
 * （与 `check-kl-skill-sync.mjs` 里那段同一个理由。）
 *
 * 于是三件事同时被锁住：
 *   ① 二进制升级了但没重跑同步 → 红；
 *   ② 产物里**残留商标**（有人手改了产物）→ 红；
 *   ③ 有人改了映射但没重跑同步 → 红（因为净化后的源变了）。
 *
 * ## ★ 二进制不在时**跳过而不失败**
 *
 * 与 `check:no-local-data` 同一个处理：同事/CI 上可能没跑过 `prepare:bin`
 * （二进制不入 git，走 npm + 解包缓存）。在那种机器上红了只会教人忽略它。
 *
 * ★★ 所以它绿了**不等于**同步过了 —— 只有在准备过二进制的机器上跑过才算。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { mkdirSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, relative, resolve } from "node:path"
import { findResidual, transformFor } from "./lib/dws-skill-sanitize.mjs"

const root = resolve(import.meta.dirname, "..")

function platformSuffix() {
  return `${process.platform}-${process.arch}`
}

const binary = join(root, "apps/desktop/resources/bin", `dws-${platformSuffix()}`)
const targets = Object.freeze({
  mono: join(root, "apps/desktop/resources/skills/dws-mono"),
  multi: join(root, "apps/desktop/resources/skills/dws-multi"),
})

if (!existsSync(binary)) {
  console.log("渠道 CLI skill 同步检查跳过：二进制尚未准备（跑 pnpm prepare:bin）")
  process.exit(0)
}

const TEXT_EXT = /\.(md|txt|json|yml|yaml|sh|py|ts|js|mjs)$/i

/** 递归收集 `rel → 内容`（文本按 utf8，其余按 base64）。 */
function collect(dir, base = dir, into = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      collect(full, base, into)
      continue
    }
    const rel = relative(base, full)
    into.set(
      rel,
      TEXT_EXT.test(name) ? readFileSync(full, "utf8") : readFileSync(full).toString("base64"),
    )
  }
  return into
}

const problems = []
const tmpRoot = join(root, ".dws-skill-check-tmp")

for (const [mode, target] of Object.entries(targets)) {
  if (!existsSync(target)) {
    problems.push(`产物目录不存在：${relative(root, target)}（跑 pnpm sync:dws-skill）`)
    continue
  }

  const tmpHome = join(tmpRoot, mode)
  rmSync(tmpHome, { recursive: true, force: true })
  mkdirSync(tmpHome, { recursive: true })
  const run = spawnSync(
    binary,
    ["skill", "setup", "--mode", mode, "--target", "opencode", "--yes"],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: tmpHome, DWS_CONFIG_DIR: join(tmpHome, ".dws") },
      timeout: 120_000,
    },
  )
  if (run.status !== 0) {
    problems.push(`解出内嵌 skill 失败（mode=${mode}）：${run.stderr || run.stdout}`)
    continue
  }
  const sourceDir = join(tmpHome, ".config/opencode/skills")
  const source = collect(sourceDir)
  const produced = collect(target)

  for (const [rel, raw] of source) {
    const got = produced.get(rel)
    if (got === undefined) {
      problems.push(`${mode}：产物缺文件 ${rel}`)
      continue
    }
    const want = TEXT_EXT.test(rel) ? transformFor(rel, raw) : raw
    if (got !== want) problems.push(`${mode}：内容与净化后的内嵌源不一致 ${rel}`)
  }
  for (const rel of produced.keys()) {
    if (!source.has(rel)) problems.push(`${mode}：产物多出文件 ${rel}（内嵌源里没有）`)
  }

  // ② 残留检查：产物里不许再有商标字样（与"指纹不一致"是两件事）
  for (const [rel, content] of produced) {
    if (!TEXT_EXT.test(rel)) continue
    for (const { kind, key } of findResidual(content)) {
      problems.push(`${mode}：产物残留${kind}（${key.slice(0, 2)}…）${rel}`)
    }
  }
}
rmSync(tmpRoot, { recursive: true, force: true })

if (problems.length > 0) {
  console.error("渠道 CLI skill 同步检查失败：")
  for (const line of problems.slice(0, 20)) console.error(`  ✗ ${line}`)
  if (problems.length > 20) console.error(`  …还有 ${String(problems.length - 20)} 条`)
  console.error("\n跑 `pnpm sync:dws-skill` 重新同步。")
  process.exit(1)
}

console.log("渠道 CLI skill 与内嵌源一致（净化后），且无商标残留。")
