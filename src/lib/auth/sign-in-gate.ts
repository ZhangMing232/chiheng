/**
 * 这个文件是干什么的：
 * 把「还在查登录 / 已登录 / 未登录」三种状态算清楚，给页面闸门用。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

export type SignInGateState = "pending" | "signed_in" | "signed_out";

export type SignInGateInput = {
  isPending: boolean;
  hasUser: boolean;
};

export function resolveSignInGateState(
  input: SignInGateInput,
): SignInGateState {
  if (input.isPending) return "pending";
  return input.hasUser ? "signed_in" : "signed_out";
}
