import { SkeletonPage } from "@/components/ui/PageSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** "Vem av dessa är du?" while it reads: the heading and a few name rows. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-[40rem]" gap="gap-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-[2.3rem] w-[min(18rem,70%)]" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </SkeletonPage>
  );
}
