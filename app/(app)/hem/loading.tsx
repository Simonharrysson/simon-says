import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";

/** /hem while it reads: the header and intro, Mina uppgifter, Senaste mötena. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-[44rem]" gap="gap-10">
      <div className="flex flex-col gap-4">
        <SkeletonHeader meta={2} titleWidth="w-[min(16rem,70%)]" />
        <SkeletonPanel rows={4} titleWidth="w-40" />
      </div>
      <SkeletonPanel rows={3} titleWidth="w-36" />
    </SkeletonPage>
  );
}
