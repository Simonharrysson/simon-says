import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** The förening page while it reads: header with logo, the tab bar, then Möten's panels. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-page">
      <SkeletonHeader back logo meta={1} action />
      <div className="-mt-2 flex gap-1 border-b border-line">
        {["w-14", "w-16", "w-24"].map((w) => (
          <span key={w} className="inline-flex min-h-10 items-center px-3 max-md:min-h-11">
            <Skeleton className={`h-4 ${w}`} />
          </span>
        ))}
      </div>
      <SkeletonPanel height="h-28" titleWidth="w-28" />
      <SkeletonPanel rows={5} titleWidth="w-20" />
    </SkeletonPage>
  );
}
