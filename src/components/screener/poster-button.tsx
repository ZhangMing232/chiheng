import { useState } from "react";

export function PosterButton({ draw }: { draw: () => { canvas: HTMLCanvasElement; filename: string } }) {
  const [poster, setPoster] = useState<{ url: string; filename: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function make() {
    try {
      const drawn = draw();
      setPoster({ url: drawn.canvas.toDataURL("image/png"), filename: drawn.filename });
      setError(null);
    } catch (err) {
      setPoster(null);
      setError(err instanceof Error ? err.message : "汇总图没有生成");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={make} className="rounded-full border border-line bg-surface px-4 py-2 text-sm">
          生成汇总图
        </button>
        {poster ? (
          <a href={poster.url} download={poster.filename} className="text-sm text-muted">
            保存图片
          </a>
        ) : null}
      </div>
      {error ? <p className="text-sm text-up">{error}</p> : null}
      {poster ? <img src={poster.url} alt="汇总图" className="w-full rounded-xl border border-line" /> : null}
    </div>
  );
}
