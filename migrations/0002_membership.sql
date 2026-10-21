-- 会员体系（design/MEMBERSHIP.md）：user 表加 plan 字段。
-- 词表：free（默认）/ pro-monthly / pro-yearly / lifetime / admin。
-- 只能由服务端脚本或支付回调写入（Better Auth additionalFields input:false），
-- 用户自己改不了。TEXT 而非枚举——后续加档位不用改表。
alter table "user" add column if not exists "plan" text not null default 'free';
create index if not exists "user_plan_idx" on "user" ("plan");
