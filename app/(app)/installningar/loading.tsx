import { SkeletonHeader, SkeletonPage, SkeletonPanel } from "@/components/ui/PageSkeleton";

/** Konto while it reads: the account's stacked panels. */
export default function Loading() {
  return (
    <SkeletonPage width="max-w-[40rem]">
      <SkeletonHeader titleWidth="w-[min(9rem,60%)]" />
      <SkeletonPanel height="h-16" titleWidth="w-36" />
      <SkeletonPanel height="h-20" titleWidth="w-24" />
      <SkeletonPanel height="h-28" titleWidth="w-28" />
    </SkeletonPage>
  );
}
