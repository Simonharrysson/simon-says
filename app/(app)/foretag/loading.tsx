import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";

/** Företag while it reads: your companies, then Skapa ett företag. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-[40rem]" gap="gap-8">
      <SkeletonHeader meta={1} titleWidth="w-[min(10rem,60%)]" />
      <SkeletonPanel rows={1} />
    </SkeletonPage>
  );
}
