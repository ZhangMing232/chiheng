/**
 * 这个文件是干什么的：
 * 自媒体图文的配图，一套「可换内容」的现代财经海报画笔。
 * 不绑定某一种内容：外部传一个 spec（标题 + 条目列表），就画成一张深色行情风格的图。
 *
 * 你需要知道的：
 * - 深色底 + 大标题 + 排名列表 + 大数字，对标行情 App / 财经大 V 的图。
 * - 红涨绿跌：红 #ff5c5c、绿 #2dd4a0；金色 #f5b544 做名次和品牌点缀。
 * - 抖音 = 1080×1920（9:16），公众号 = 1080×1440（3:4）。
 */

const BG_TOP = "#171b26";
const BG_BOTTOM = "#0b0d13";
const CARD = "#1e2432";
const INK = "#f5f6f8";
const MUTED = "#828b9e";
const RED = "#ff5c5c";
const GREEN = "#2dd4a0";
const GOLD = "#f5b544";

const FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif';

export type StudioFormat = "vertical" | "square";

/** 一条内容。value 是右边大数字，color 红/绿/中性，note 可选（小字说明）。 */
export type StudioItem = { name: string; value: string; color: string; note?: string };

/** 一张图文海报的内容规格。 */
export type StudioSpec = { title: string; subtitle?: string; items: StudioItem[] };

function canvasOf(format: StudioFormat): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; W: number; H: number } {
  const W = 1080;
  const H = format === "vertical" ? 1920 : 1440;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布不可用");
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, BG_TOP);
  grad.addColorStop(1, BG_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  return { canvas, ctx, W, H };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function headline(at: number): string {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).formatToParts(new Date(at));
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month}月${day}日`;
}

/** 画一张图文海报。 */
export function drawStudioPoster(spec: StudioSpec, format: StudioFormat, at = Date.now()): { canvas: HTMLCanvasElement; filename: string } {
  const { canvas, ctx, W } = canvasOf(format);
  const pad = 72;

  // 顶栏：日期 + 品牌
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  ctx.font = `26px ${FONT}`;
  ctx.fillText(headline(at), pad, 92);
  ctx.textAlign = "right";
  ctx.fillStyle = GOLD;
  ctx.font = `bold 28px ${FONT}`;
  ctx.fillText("赤轨", W - pad, 92);

  // 大标题
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `bold 64px ${FONT}`;
  ctx.fillText(spec.title, pad, 180);

  // 副标题
  let y = 240;
  if (spec.subtitle) {
    ctx.fillStyle = MUTED;
    ctx.font = `30px ${FONT}`;
    ctx.fillText(spec.subtitle, pad, y);
    y += 60;
  }

  // 排名列表
  const rowH = 112;
  for (let i = 0; i < spec.items.length; i += 1) {
    const item = spec.items[i];
    const ry = y + i * rowH;
    ctx.fillStyle = CARD;
    roundRect(ctx, pad, ry, W - pad * 2, rowH - 16, 20);
    ctx.fill();

    // 名次（金色）
    ctx.textAlign = "left";
    ctx.fillStyle = GOLD;
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillText(String(i + 1).padStart(2, "0"), pad + 32, ry + 66);

    // 名字
    ctx.fillStyle = INK;
    ctx.font = `bold 36px ${FONT}`;
    ctx.fillText(item.name, pad + 120, ry + 66);

    // note（小字，放名字下面）
    if (item.note) {
      ctx.fillStyle = MUTED;
      ctx.font = `24px ${FONT}`;
      ctx.fillText(item.note, pad + 120, ry + 98);
    }

    // 数值（右对齐，红绿）
    ctx.textAlign = "right";
    ctx.fillStyle = item.color;
    ctx.font = `bold 40px ${FONT}`;
    ctx.fillText(item.value, W - pad - 32, ry + 66);
  }

  // 底部免责
  const footY = y + spec.items.length * rowH + 40;
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  ctx.font = `24px ${FONT}`;
  ctx.fillText("数据不构成投资建议", pad, footY);

  return { canvas, filename: `赤轨-${headline(at)}-${format === "vertical" ? "抖音" : "公众号"}.png` };
}

// ── 给内容构造器用的颜色 + 格式化工具 ──
export const STUDIO_RED = RED;
export const STUDIO_GREEN = GREEN;
export const STUDIO_INK = INK;

export function studioTone(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return INK;
  return n > 0 ? RED : GREEN;
}

export function studioAbsWan(wan: number): string {
  const abs = Math.abs(wan);
  if (!Number.isFinite(abs)) return "—";
  if (abs >= 10000) return `${(abs / 10000).toFixed(1)}亿`;
  if (abs >= 100) return `${Math.round(abs)}万`;
  return `${abs.toFixed(1)}万`;
}

export function studioPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
