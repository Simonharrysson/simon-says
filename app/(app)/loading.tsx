import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton while a logged-in page reads its data. */
export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-gutter" aria-busy="true" aria-live="polite">
      <span className="sr-only">Laddar…</span>
      <Skeleton className="h-10 w-[min(20rem,70%)]" />
      <Skeleton className="h-4 w-48" />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-6 max-[56rem]:grid-cols-[minmax(0,1fr)]">
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    </div>
  );
}
