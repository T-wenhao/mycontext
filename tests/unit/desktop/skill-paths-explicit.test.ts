/**
 * 门禁：`skills.paths` 必须**逐个列出 skill 目录**，不许给它们的父目录。
 *
 * ## ★★★ 这条测试锁的是一个"看起来一样"的错误
 *
 * 原来两处（搜问与数字分身）都往 `skills.paths` 里 push
 * `resources/skills` 这个**父目录**，而注释写的判据是
 * 「opencode 扫 `<path>/<name>/SKILL.md`，一层」。
 *
 * 那个判据是错的。真进程实测（opencode 1.18.11，日志 `message=init count=N`）：
 *
 * | `skills.paths`                   | count |
 * |----------------------------------|-------|
 * | 不给（只有内置）                 | 1     |
 * | `skills/`（父目录）              | 16    |
 * | `skills/` + `skills/dws-multi`   | 16    |
 * | `skills/kl` + `skills/dws-multi` | 15    |
 * | `skills/kl` + `skills/dws-mono`  | 3     |
 *
 * 16 = 1 内置 + kl + mono 1 个 + multi 13 个 —— **它是递归扫的**
 * （另造 `a/b/c/skillx/SKILL.md` 同样被扫到，深度不限）。
 *
 * 于是给父目录的后果有两个，且都**不报错**：
 * ① mono 与 multi **同时**挂上（两份 2.6MB / 3.3MB 的命令说明进上下文，
 *    skill 名不冲突所以 agent 不去重）—— 「切 mono」这个开关什么也没改变；
 * ② 数字分身侧还多一重：它的 PATH 里没有裸 `dws`（shim 只接了搜问），
 *    于是 agent 照着 skill 调命令、每条都 command not found，
 *    最后给一个"查不到"的降级答案。
 *
 * 这两个后果都与"配置正确"外观相同，所以判据必须写成测试而不是注释。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "../../..")

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8")
}

describe("skills.paths 逐个列目录（不给父目录）", () => {
  it("★ 搜问：按 mono/multi 选一套，且 kl 单独一条", () => {
    const source = read("apps/desktop/src/main/services/search.service.ts")
    // 选中那套：三元表达式里两个目录名都在
    expect(source).toContain('dwsMode === "mono" ? "dws-mono" : "dws-multi"')
    // kl 是独立一条（而不是靠父目录带出来）
    expect(source).toMatch(/join\(skillsDir,\s*"kl"\)/)
    /**
     * ★ 不许把 `skillsDir` 本身推进 skillPaths —— 那正是回退的形状。
     * 判据写成"数组字面量里不出现裸 skillsDir"：`[skillsDir,` 或 `[skillsDir]`。
     */
    expect(source).not.toMatch(/skillPaths\s*=\s*\[\s*skillsDir\b/)
    expect(source).not.toMatch(/\[\s*skillsDir\s*,/)
  })

  it("★ 数字分身：只挂 kl（渠道 skill 目前只接搜问）", () => {
    const source = read("apps/desktop/src/main/services/persona.service.ts")
    expect(source).toMatch(/const klDir = join\(this\.options\.skillsDir, "kl"\)/)
    // 回退形状：直接 push 父目录
    expect(source).not.toMatch(/paths\.push\(this\.options\.skillsDir\)/)
  })

  /**
   * ★ mono 与 multi **都要随包**（用户可切换），所以两个目录都得在
   * 打包配置的覆盖范围内。这里只断言那条 extraResources 仍指着父目录 ——
   * 打包是"全都带上"，运行时才"选一套"，两者是不同的判据。
   */
  it("打包仍带上整个 skills 目录（两套都要在包里）", () => {
    const yml = read("apps/desktop/electron-builder.yml")
    expect(yml).toContain("from: apps/desktop/resources/skills")
  })
})
