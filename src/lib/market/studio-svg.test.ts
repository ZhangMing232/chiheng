/**
 * 这个文件是干什么的：
 * 钉住 SVG 渲染层的两条硬纪律（都是 resvg 静默失败逼出来的）：
 * 1. **找不到字体 → 抛错**，不许渲染出空图
 * 2. **渲染出空图 → 抛错**（字体文件存在但字形没生效时就是空图）
 * 外加：字体候选按优先级挑第一个存在的。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_PNG_MAX_BYTES,
  FONT_CANDIDATES,
  FONT_PROBE_TEXT,
  pickFont,
  probeFont,
  renderSvg,
} from "@/lib/market/studio-svg";

test("pickFont：按优先级挑第一个存在的", () => {
  const chosen = pickFont(FONT_CANDIDATES, (p) => p === FONT_CANDIDATES[2]!.file);
  assert.equal(chosen?.family, FONT_CANDIDATES[2]!.family);
});

test("pickFont：一个都不存在返回 null（调用方负责抛错）", () => {
  assert.equal(pickFont(FONT_CANDIDATES, () => false), null);
});

test("🔴 找不到字体必须抛错，不能渲染出空图", async () => {
  await assert.rejects(
    () => renderSvg("<svg/>", [{ file: "/不存在的字体.ttf", family: "Nope" }]),
    /找不到可用的中文字体/,
  );
});

test("🔴 字体存在但字形没生效（渲染出空图）也要抛错", async () => {
  // 用一个真实存在但不含中文字形的字体文件（macOS 的 Apple Color Emoji 之类不行，
  // 这里用项目里肯定有的一个非中文字体）→ 渲染中文得空图
  const notCjk = [{ file: "/System/Library/Fonts/Geneva.ttf", family: "Geneva" }];
  const exists = (p: string) => p === notCjk[0]!.file;
  if (!exists(notCjk[0]!.file)) return; // 机器上没这个字体就跳过
  await assert.rejects(
    () => renderSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#111"/><text x="10" y="60" font-family="Geneva" font-size="40" fill="#fff">${FONT_PROBE_TEXT}</text></svg>`, notCjk),
    /空图|字形/,
  );
});

test("probeFont：本机应该能画出中文（部署前的第一道检查）", async () => {
  const r = await probeFont();
  assert.equal(r.ok, true, `本机字体探针失败：${r.why}`);
  assert.ok(r.bytes > EMPTY_PNG_MAX_BYTES, `字节数 ${r.bytes} 太小，可能空图`);
});

test("renderSvg：正常 SVG 渲染出真 PNG", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><rect width="640" height="200" fill="#171b26"/><text x="30" y="120" font-family="Hiragino Sans GB" font-size="56" fill="#fff">${FONT_PROBE_TEXT}</text></svg>`;
  const out = await renderSvg(svg);
  assert.ok(out.png.byteLength > EMPTY_PNG_MAX_BYTES);
  assert.ok(out.font.family.length > 0);
  assert.ok(out.ms >= 0);
});

test("renderPosterPayload：真图渲染成功，返回可用的 dataURL", async () => {
  const { renderPosterPayload } = await import("@/lib/market/studio-svg");
  const r = await renderPosterPayload(
    {
      title: "主力净流入 TOP",
      layout: "ranking",
      items: [
        { name: "天娱数科", value: "+11.2亿", color: "#ff5c5c", note: "+10.00%" },
        { name: "兆易创新", value: "+3.1亿", color: "#ff5c5c" },
      ],
      dist: { label: "前 3 名合计 / 其余全部", top: 320247, rest: 334200 },
      footNote: "上涨 2135 · 下跌 2887",
    },
    "vertical",
  );
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.ok(r.dataUrl.startsWith("data:image/png;base64,"), "要能直接塞进 <img src>");
  const bytes = Buffer.from(r.dataUrl.split(",")[1]!, "base64");
  assert.ok(bytes.byteLength > 5000, `PNG 只有 ${bytes.byteLength} 字节，可能空图`);
  assert.ok(r.font.length > 0, "要说清用的哪个字体");
});

test("renderPosterPayload：没有字体时给明确错误（不是空图）", async () => {
  const { renderPosterPayload } = await import("@/lib/market/studio-svg");
  const r = await renderPosterPayload({ title: "测试", layout: "ranking" }, "vertical", [
    { file: "/不存在的字体.ttf", family: "Nope" },
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes("字体"), `错误要说清是字体问题：${r.error}`);
});
