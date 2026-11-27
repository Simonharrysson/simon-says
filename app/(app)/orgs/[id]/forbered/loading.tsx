import { SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** A narrow förening flow (förbered, kom igång, protokoll) while it reads. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-[40rem]" gap="gap-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-[2.3rem] w-[min(18rem,70%)]" />
      </div>
      <SkeletonPanel height="h-40" titleWidth="w-40" />
    </SkeletonPage>
  );
}
