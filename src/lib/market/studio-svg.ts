/**
 * 这个文件是干什么的：
 * 自媒体图文的 **SVG 渲染层**（L1 改造的落点）。用 @resvg/resvg-js 把 SVG
 * 模板渲染成 PNG——比 canvas 手画强在：声明式（不用算坐标）、条件渲染
 * （字段没值就不画那一条）、CSS 类的排版能力。
 *
 * 你需要知道的（**都是实测踩过的**）：
 * 1. **字体缺失时 resvg 静默不画文字**——不报错、不抛异常，PNG 里只有背景色，
 *    看起来像"渲染成功但图是空的"。实测：给一个不存在的字体路径，
 *    输出 961B 的纯背景 PNG。**所以这里必须自己探 + 自己验**。
 * 2. **macOS 上的中文字体路径**（实测本机可用）：
 *    Hiragino Sans GB / Arial Unicode MS / Heiti SC / Songti SC。
 *    ⚠️ **PingFang.ttc 在本机不存在**（我第一次就踩了：以为它一定在，
 *    结果整张图只有背景）。所以候选表里不写它。
 * 3. **resvg 是原生模块，只能在服务端跑**。所以 SVG 路线意味着「图由服务端
 *    渲染后返回」——好处是能按 spec 哈希缓存；代价是多一次网络往返。
 * 4. 首次渲染要加载字体库，约 1.2 秒；之后同进程内很快。
 *
 * 依赖：@resvg/resvg-js（arm64 原生二进制，实测装得上）。
 */

import { existsSync } from "node:fs";

/** 一个字体候选：文件路径 + 字体家族名（SVG font-family 用）。 */
export type FontChoice = { file: string; family: string };

/**
 * 字体候选表。**顺序即优先级**。
 *
 * 第一个是 macOS 的冬青黑体简体（项目 CSS 里的 fallback 也列了它），
 * 后两个是 macOS 一定有的（宋体/黑体），最后是 Linux 的 Noto CJK——
 * 将来部署到服务器时用得上（服务器上没有 macOS 字体）。
 */
export const FONT_CANDIDATES: FontChoice[] = [
  { file: "/System/Library/Fonts/Hiragino Sans GB.ttc", family: "Hiragino Sans GB" },
  { file: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", family: "Arial Unicode MS" },
  { file: "/System/Library/Fonts/STHeiti Medium.ttc", family: "Heiti SC" },
  { file: "/System/Library/Fonts/Supplemental/Songti.ttc", family: "Songti SC" },
  { file: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", family: "Noto Sans CJK SC" },
  { file: "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", family: "Noto Sans CJK SC" },
];

/**
 * 从候选里挑第一个存在的字体文件。
 *
 * 纯函数（存在性判断由参数注入）——好测，不用真文件系统。
 * 全都不存在时返回 null，**调用方必须抛错，不许继续渲染**。
 */
export function pickFont(
  candidates: readonly FontChoice[],
  exists: (path: string) => boolean = existsSync,
): FontChoice | null {
  for (const c of candidates) {
    if (exists(c.file)) return c;
  }
  return null;
}

/** 探针用的文字：中日韩字符 + 数字 + 英文（覆盖我们要用的字形范围）。 */
export const FONT_PROBE_TEXT = "中文字体测试 主力净流入 12.9亿";

/**
 * 空图判定：只画背景的 PNG 大约 961B；真正画了字至少 5KB。
 * 用字节数当粗判据（够用且不引 PNG 解码依赖）。
 */
export const EMPTY_PNG_MAX_BYTES = 3000;

export type RenderResult = {
  png: Uint8Array;
  font: FontChoice;
  /** 渲染耗时（ms）——首次含字体库加载 */
  ms: number;
};

/** 内部：真正调 resvg（动态 import，让没装依赖时错误信息更清楚）。 */
async function renderWithResvg(svg: string, font: FontChoice): Promise<Uint8Array> {
  const { Resvg } = await import("@resvg/resvg-js");
  const r = new Resvg(svg, {
    font: {
      fontFiles: [font.file],
      defaultFontFamily: font.family,
      // 不读系统字体：只认我们显式给的文件（macOS 上系统字体很多，
      // 全读进来会让首次渲染慢好几秒）
      loadSystemFonts: false,
    },
  });
  return r.render().asPng();
}

/**
 * 把 SVG 渲染成 PNG。
 *
 * **两道保险**（都是因为 resvg 静默失败）：
 * 1. 找不到字体文件 → 直接抛错，带上候选路径（让人能自己装字体）
 * 2. 渲染出来是空图（只有背景）→ 抛错，提示字体可能没真正生效
 *    （字体文件存在但字形缺失时就是这种结果）
 */
export async function renderSvg(svg: string, candidates: readonly FontChoice[] = FONT_CANDIDATES): Promise<RenderResult> {
  const font = pickFont(candidates);
  if (!font) {
    throw new Error(
      `找不到可用的中文字体文件。已试：${candidates.map((c) => c.file).join("、")}。` +
        `macOS 自带上面几种，Linux 需要装 fonts-noto-cjk。`,
    );
  }
  const started = Date.now();
  const png = await renderWithResvg(svg, font);
  if (png.byteLength < EMPTY_PNG_MAX_BYTES) {
    throw new Error(
      `SVG 渲染出来是空图（${png.byteLength}B < ${EMPTY_PNG_MAX_BYTES}B）：` +
        `字体 ${font.family} 存在但字形没生效。换一个字体文件或检查字体是否损坏。`,
    );
  }
  return { png, font, ms: Date.now() - started };
}

/**
 * 探针：验这套字体在本机真能画出中文。
 *
 * 单独一个函数，因为这是**部署前的第一道检查**——服务器上没字体的话，
 * 应该在这里就报错，而不是等用户看到一张空图。
 */
export async function probeFont(candidates: readonly FontChoice[] = FONT_CANDIDATES): Promise<{
  ok: boolean;
  font: FontChoice | null;
  bytes: number;
  why: string | null;
}> {
  const font = pickFont(candidates);
  if (!font) {
    return { ok: false, font: null, bytes: 0, why: "没有可用的字体文件" };
  }
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><rect width="640" height="200" fill="#171b26"/><text x="30" y="120" font-family="${font.family}" font-size="56" fill="#fff">${FONT_PROBE_TEXT}</text></svg>`;
    const png = await renderWithResvg(svg, font);
    if (png.byteLength < EMPTY_PNG_MAX_BYTES) {
      return { ok: false, font, bytes: png.byteLength, why: `字体 ${font.family} 存在但渲染出空图` };
    }
    return { ok: true, font, bytes: png.byteLength, why: null };
  } catch (error) {
    return { ok: false, font, bytes: 0, why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 渲染一张海报（纯逻辑，不碰 HTTP）。
 *
 * 抽出来是为了能直接测：**API route 只是 HTTP 外壳**，真正的逻辑在这里，
 * 逻辑有测试覆盖，外壳薄到不会藏 bug。
 */
export async function renderPosterPayload(
  spec: { title: string; layout: string; [k: string]: unknown },
  format: "vertical" | "square",
  candidates: readonly FontChoice[] = FONT_CANDIDATES,
): Promise<
  | { ok: true; dataUrl: string; ms: number; font: string }
  | { ok: false; error: string }
> {
  try {
    const font = pickFont(candidates);
    if (!font) {
      return {
        ok: false,
        error:
          "服务端没有可用的中文字体（macOS 缺系统字体或 Linux 缺 fonts-noto-cjk）。" +
          `已试：${candidates.map((c) => c.file).join("、")}`,
      };
    }
    // 动态 import 避免循环依赖（studio-card → studio-poster → studio-layout）
    const { specToSvg } = await import("./studio-card.ts");
    const svg = specToSvg(spec as never, format, font.family);
    const out = await renderSvg(svg, candidates);
    return {
      ok: true,
      dataUrl: `data:image/png;base64,${Buffer.from(out.png).toString("base64")}`,
      ms: out.ms,
      font: font.family,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
