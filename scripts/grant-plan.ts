/**
 * 这个文件是干干什么：
 * 人工授予/变更会员档位（design/MEMBERSHIP.md §三 v1 的授予通道）。
 *
 * 为什么要有它：支付渠道拍板前，有人付款（爱发电/微信转账）后老板手动开会员，
 * 就跑这个脚本。它直接写 Better Auth 的 user 表——plan 字段客户端写不进来
 * （additionalFields input:false），只有这条路和未来的支付回调能改。
 *
 * 用法（项目根目录，PATH 带 node）：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/grant-plan.ts <邮箱> <档位>
 * 档位词表见 src/lib/auth/plan.ts：free / pro-monthly / pro-yearly / lifetime / admin
 *
 * 限制：只对部署形态（DATABASE_URL 指向 Neon）有意义。本机 serve 走内存
 * PGLite，重启即清空，授予了也留不住——本机调试注册登录直接起服务即可，
 * 不用跑这个脚本。
 */

import { Pool } from "pg";

const [, , email, plan] = process.argv;

const VALID = ["free", "pro-monthly", "pro-yearly", "lifetime", "admin"] as const;

if (!email || !plan) {
  console.error("用法: grant-plan.ts <邮箱> <档位: free|pro-monthly|pro-yearly|lifetime|admin>");
  process.exit(1);
}
if (!(VALID as readonly string[]).includes(plan)) {
  console.error(`未知档位「${plan}」，合法值：${VALID.join(" / ")}`);
  process.exit(1);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "没有 DATABASE_URL——本机 serve 走内存 PGLite，重启即清空，授予留不住。\n" +
      "部署形态（Vercel+Neon，或本地起 Postgres 并 export DATABASE_URL）下才能用这个脚本。",
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const found = await pool.query<{ id: string; name: string; plan: string }>(
    'select id, name, "plan" from "user" where email = $1',
    [email],
  );
  if (found.rows.length === 0) {
    console.error(`找不到用户 ${email}——对方得先在 /login 注册过。`);
    process.exit(1);
  }
  const user = found.rows[0];
  if (user.plan === plan) {
    console.log(`${email}（${user.name}）已经是 ${plan}，无需变更。`);
    process.exit(0);
  }
  await pool.query('update "user" set "plan" = $1, "updatedAt" = now() where id = $2', [
    plan,
    user.id,
  ]);
  console.log(`✅ ${email}（${user.name}）：${user.plan} → ${plan}`);
} finally {
  await pool.end();
}
