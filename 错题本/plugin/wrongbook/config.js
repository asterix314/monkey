// 错题本插件 · 配置 schema
//
// 设计意图：
//  · 字段名与冻结规划 与冻结规划逐字一致，不得改名 —— Cordis 在激活时会用这里导出的
//   Config 校验 profile 里的 config 行，改名等于换掉已冻结的接口。
//  · originals_root 是「原件根目录」的唯一来源。数据库只存相对路径（DESIGN §6.2），
//   所以这里是全部路径解析的锚点，必须是绝对路径；相对路径会被 CWD 影响，绝不允许。
//  · upload_max_bytes / identify_timeout_ms 有默认值（用户已确认 32 MiB / 10s），
//   允许覆盖但不会缺失。

import { isAbsolute } from 'node:path'
import { z } from 'zod'

// schema 会拼进 SQL 标识符位置（表名前缀）和连接参数的 search_path，所以必须收紧：
//  · 只允许小写 —— 不加 /i。大写标识符在未加引号时会被 PostgreSQL 折叠成小写，
//   允许大写等于允许「配置值与实际对象名不一致」这种静默歧义。
//  · 长度按 NAMEDATALEN-1 截断上限 63，超长标识符也会被静默截断。
//  · 用 ^...$ 即可：JS 的 $ 只匹配字符串末尾，不像 Perl / PCRE 那样还匹配
//   末尾换行之前（已用 node 实测 "app\n" 不通过），所以不存在换行绕过。
//   注意不能照搬 PCRE 的 \A...\z —— 在 JS 里这是 identity escape，
//   会被当成字面字符 A / z，连 "app" 都会被拒（实测）。
const schemaName = z
  .string()
  .regex(
    /^[a-z_][a-z0-9_]*$/,
    'config.schema 必须是合法的小写标识符（小写字母、数字、下划线，且以字母或下划线开头）',
  )
  .max(63, 'config.schema 超过 PostgreSQL 标识符长度上限 63')
  .default('app')

export const Config = z.object({
  host: z.string().min(1, 'config.host 必须是非空字符串').default('/var/run/postgresql'),
  port: z.number().int().min(1, 'config.port 必须在 1–65535').max(65535, 'config.port 必须在 1–65535').default(5432),
  database: z.string().min(1, 'config.database 必须是非空字符串').default('wrongbook'),
  user: z.string().min(1, 'config.user 必须是非空字符串').default('zch'),
  schema: schemaName,
  maxConnections: z
    .number()
    .int()
    .min(1, 'config.maxConnections 必须 ≥ 1')
    .max(100, 'config.maxConnections 不应超过 100')
    .default(4),
  originals_root: z
    .string()
    .min(1, 'config.originals_root 必须是非空字符串')
    // 绝对路径是硬约束：数据库里存的是相对路径，拼接基准一旦变成相对路径，
    // 同一条记录在不同进程 CWD 下就会指向不同文件，属于静默数据损坏。
    .refine((value) => isAbsolute(value), 'config.originals_root 必须是绝对路径')
    .default('/mnt/c/Users/Think/Pictures/错题本照片'),
  // 用户已确认的上限：单张 32 MiB = 33554432 字节
  upload_max_bytes: z
    .number()
    .int()
    .min(1, 'config.upload_max_bytes 必须 ≥ 1')
    .max(2 ** 31 - 1, 'config.upload_max_bytes 超出可表示范围')
    .default(33554432),
  identify_timeout_ms: z
    .number()
    .int()
    .min(1, 'config.identify_timeout_ms 必须 ≥ 1')
    .max(600000, 'config.identify_timeout_ms 不应超过 10 分钟')
    .default(10000),
})

/**
 * 把 profile 里的原始 config 行解析成完整配置。
 *
 * 即使框架已经用 Config 校验过一次，这里仍重新 parse：apply() 的参数在
 * 不同加载路径下可能是原始行（只有用户显式写下的字段），也可能已带默认值。
 * Config.parse 对两者都幂等，成本可忽略，但能保证下游永远拿到完整对象。
 *
 * @param {unknown} raw profile config 行
 * @returns {z.infer<typeof Config>} 补全默认值后的配置
 */
export function resolveConfig(raw) {
  const parsed = Config.safeParse(raw === undefined || raw === null ? {} : raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? '(config)' : issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`错题本插件配置无效：${detail}`)
  }
  return parsed.data
}
