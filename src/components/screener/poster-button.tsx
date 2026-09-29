/**
 * 这个文件是干什么的：
 * 「生成汇总图」按钮。点一下把当前内容画成一张图，可以预览、保存或关掉。
 *
 * 你需要知道的：
 * 生成图片不会改变买入价，也不会改账。关掉图片时会清掉临时链接。
 */

import { useState } from "react";

type Poster = { url: string; filename: string; blob: Blob };

function drop(poster: Poster | null) {
  if (poster?.url.startsWith("blob:")) URL.revokeObjectURL(poster.url);
}

/** 按外面传入的画法生成一张 PNG。能分享就调系统分享，否则触发下载。 */
export function PosterButton({ draw }: { draw: () => { canvas: HTMLCanvasElement; filename: string } }) {
  const [poster, setPoster] = useState<Poster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  function close() {
    drop(poster);
    setPoster(null);
    setHint(null);
    setError(null);
  }

  function make() {
    try {
      const drawn = draw();
      drawn.canvas.toBlob((blob) => {
        if (!blob) {
          setError("汇总图没有生成");
          return;
        }
        drop(poster);
        setPoster({ url: URL.createObjectURL(blob), filename: drawn.filename, blob });
        setError(null);
        setHint(null);
      }, "image/png");
    } catch (err) {
      close();
      setError(err instanceof Error ? err.message : "汇总图没有生成");
    }
  }

  async function save() {
    if (!poster) return;
    const file = new File([poster.blob], poster.filename, { type: "image/png" });
    const share = navigator.share?.bind(navigator);
    const canShare = navigator.canShare?.({ files: [file] }) ?? false;
    if (share && canShare) {
      try {
        await share({ files: [file] });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    const link = document.createElement("a");
    link.href = poster.url;
    link.download = poster.filename;
    link.click();
    setHint("若没有开始下载，长按图片，选存储到照片。");
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={make} className="rounded-full border border-line bg-surface px-4 py-2 text-sm">
          生成汇总图
        </button>
        {poster ? (
          <>
            <button type="button" onClick={() => void save()} className="rounded-full border border-line bg-surface px-4 py-2 text-sm">
              保存图片
            </button>
            <button type="button" onClick={close} className="rounded-full border border-line px-4 py-2 text-sm text-muted">
              关闭
            </button>
          </>
        ) : null}
      </div>
      {error ? <p className="text-sm text-up">{error}</p> : null}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {poster ? <img src={poster.url} alt="汇总图" className="w-full rounded-xl border border-line" /> : null}
    </div>
  );
}
