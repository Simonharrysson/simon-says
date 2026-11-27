import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";

/** Privat while it reads: the header, then the contexts. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-[40rem]" gap="gap-8">
      <SkeletonHeader meta={2} action titleWidth="w-[min(10rem,60%)]" />
      <SkeletonPanel rows={3} />
    </SkeletonPage>
  );
}
