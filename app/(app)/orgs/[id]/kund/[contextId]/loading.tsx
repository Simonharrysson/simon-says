import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";

/** A Företag customer page while it reads: back link, header, meetings, tasks. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-[44rem]">
      <SkeletonHeader back meta={1} />
      <SkeletonPanel rows={3} />
      <SkeletonPanel rows={2} />
    </SkeletonPage>
  );
}
