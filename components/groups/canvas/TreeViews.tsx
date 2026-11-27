"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { canvasArchive, canvasCreate, canvasPlace, canvasRename, canvasSavePositions, canvasSetHead, canvasSetParent } from "@/app/(app)/orgs/canvas-actions";
import { cn } from "@/lib/utils";
import type { CanvasApi, CanvasData } from "./types";

// Canvas or list. A phone (< 768 px) always gets the list (the same tree, the same actions) and
// never downloads the canvas; a desktop gets the canvas, lazily (React Flow is its own chunk), and
// may switch to the list (remembered per browser). Before hydration the list is hidden on desktop
// by CSS, so nothing jumps.

const GroupCanvas = dynamic(() => import("./GroupCanvas"), { ssr: false, loading: () => <CanvasSkeleton /> });

const SERVER_API: CanvasApi = {
  setParent: canvasSetParent,
  rename: canvasRename,
  create: canvasCreate,
  archive: canvasArchive,
  place: canvasPlace,
  savePositions: canvasSavePositions,
  setHead: canvasSetHead,
};

const WIDE = "(min-width: 768px)";
function subscribe(cb: () => void) {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const useWide = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );

const KEY = "tree-view";
type View = "canvas" | "list";

export function TreeViews({ list, data, api }: { list: ReactNode; data: CanvasData; api?: CanvasApi }) {
  const t = useTranslations("foretag.canvas");
  const wide = useWide();
  const [view, setView] = useState<View>("canvas");
  useEffect(() => {
    try {
      if (window.localStorage.getItem(KEY) === "list") setView("list");
    } catch {}
  }, []);
  const choose = (v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(KEY, v);
    } catch {}
  };
  const canvas = view === "canvas";

  return (
    <div className="flex flex-col gap-4" data-tree-view={wide ? view : "list"}>
      <div role="group" aria-label={t("views")} className="flex items-center gap-1 self-start rounded-md border border-line bg-surface p-0.5 max-md:hidden">
        {(["canvas", "list"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => choose(v)}
            className={cn(
              "min-h-8 rounded-[5px] px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
              view === v ? "bg-ink text-on-ink" : "text-ink-2 hover:bg-sunk hover:text-ink",
            )}
          >
            {v === "canvas" ? t("viewCanvas") : t("viewList")}
          </button>
        ))}
      </div>
      {canvas && (
        // Wider than the page column: the canvas wants room. Centred on the column, gutters kept.
        <div className="relative left-1/2 w-[min(calc(100vw-3rem),90rem)] -translate-x-1/2 max-md:hidden">
          {wide ? <GroupCanvas data={data} api={api ?? SERVER_API} /> : <CanvasSkeleton />}
        </div>
      )}
      <div className={cn("flex flex-col gap-6", canvas && "md:hidden")}>{list}</div>
    </div>
  );
}

function CanvasSkeleton() {
  const t = useTranslations("foretag.canvas");
  return (
    <div className="flex h-[min(72vh,52rem)] min-h-[32rem] items-center justify-center rounded-lg border border-line bg-board text-sm text-ink-3" role="status">
      {t("loading")}
    </div>
  );
}
