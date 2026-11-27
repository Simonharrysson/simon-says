import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";

/** Any signed-in page without a skeleton of its own, while it reads its data. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-page">
      <SkeletonHeader meta={1} />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-6 max-[56rem]:grid-cols-[minmax(0,1fr)]">
        <SkeletonPanel rows={4} />
        <SkeletonPanel height="h-24" />
      </div>
    </SkeletonPage>
  );
}
