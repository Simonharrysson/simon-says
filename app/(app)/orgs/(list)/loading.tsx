import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";

/** Föreningar while it reads: your föreningar, then Skapa en förening. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-[40rem]" gap="gap-8">
      <SkeletonHeader meta={1} titleWidth="w-[min(14rem,70%)]" />
      <SkeletonPanel rows={2} />
      <SkeletonPanel height="h-28" titleWidth="w-44" />
    </SkeletonPage>
  );
}
