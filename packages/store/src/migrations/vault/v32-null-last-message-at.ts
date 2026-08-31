/**
 * VAULT v32 — 把被写成 `0` 的 `last_message_at` 改回 `NULL`。
 *
 * ## ★★★ 它修的是一次**语义折叠**留下的存量数据
 *
 * `ConversationRepository.upsert` 曾经这样合并时间：
 *
 * ```sql
 * last_message_at = MAX(COALESCE(excluded.last_message_at, 0),
 *                       COALESCE(conversations.last_message_at, 0))
 * ```
 *
 * `COALESCE(…,0)` 的用意是让 `MAX` 能比较（SQLite 的 `MAX(NULL, 5)` 返回
 * NULL，会把已有时间抹掉）。但它把「**不知道**」与「**1970-01-01**」折成
 * 了同一个值。而会话目录是**反复**同步的，于是：
 *
 * ```
 * 第一次 INSERT（无时间）     → NULL   ← 对
 * 第二次 upsert（仍然无时间） → MAX(0,0) = 0
 * 渲染 0                     → 1970/1/1
 * ```
 *
 * 表现是侧栏里一排会话的时间列写着 `1970/1/1`，第二行是「还没有消息」。
 * 代码已修（见 `conversations.ts` 里 upsert 的注释），但**已经写进库的 0
 * 不会自己变回来** —— 所以要这一趟。
 *
 * ## ★★ 为什么可以放心把 0 当成「不知道」
 *
 * `last_message_at` 是**消息的发送时间**（毫秒 epoch）。0 意味着
 * 1970-01-01 00:00:00 UTC —— 那比任何 IM 产品的存在都早二十多年，
 * 不可能是一条真实消息的时间。所以在这一列上，0 只可能来自上面那个 bug。
 *
 * ★ 仍然写成 `= 0` 而不是 `<= 0` 或 `< 某个阈值`：只清**这个 bug 会产生的
 * 那个确切值**。挑一个"合理的下界"（比如 2010 年）去清，等于顺手删掉
 * 一批我没验证过成因的数据 —— 那超出了这次修复的范围。真有负数或
 * 1971 年的脏值，是另一个 bug，该单独查。
 *
 * ## 为什么不顺手重算一个真实时间
 *
 * 「从 `messages` 里取该会话最新一条的 `sent_at` 填进去」听起来更好，
 * 但这些行的特征恰恰是**一条消息都没有**（正因为没有消息才没有时间）。
 * 对它们来说 `NULL` 就是事实，不是缺失。
 *
 * ★ 而对那些**有**消息的会话，这一趟不该动它们 —— 它们的 0 不存在
 * （有消息就会带着真实时间进 upsert）。`WHERE last_message_at = 0`
 * 已经把范围限定住了。
 */
export const VAULT_0032_NULL_LAST_MESSAGE_AT = `
-- 0 在这一列上只可能来自那个已修的 COALESCE(…,0) bug（见文件头）：
-- 1970-01-01 早于任何 IM 产品，不可能是真实消息时间。
UPDATE conversations
   SET last_message_at = NULL
 WHERE last_message_at = 0;
`
