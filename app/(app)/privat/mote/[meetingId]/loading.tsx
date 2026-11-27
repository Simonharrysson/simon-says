import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";

/** A context or meeting page while it reads: back link, header, its panels. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-[44rem]">
      <SkeletonHeader back meta={1} />
      <SkeletonPanel rows={2} />
      <SkeletonPanel rows={3} />
    </SkeletonPage>
  );
}
