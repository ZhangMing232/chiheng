/**
 * 这个文件是干什么的：
 * 多人联机模块的出口，把点对点房间相关的东西从这里再导出。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

export { P2PRoom, defaultIceServers } from "./p2p";
export type {
  PeerInfo,
  P2PRoomOptions,
  SignalKind,
  PeerRow,
  SignalRow,
  RtcPollResponse,
} from "./p2p";
