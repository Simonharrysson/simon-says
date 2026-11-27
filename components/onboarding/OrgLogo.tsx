import { cn } from "@/lib/utils";

const sizes = { sm: "size-9 text-sm rounded-md", md: "size-12 text-lg rounded-lg", lg: "size-28 text-4xl rounded-lg" } as const;
/** Intrinsic size per size (the box's px), so the image reserves its space before it loads. */
const px = { sm: 36, md: 48, lg: 112 } as const;

/**
 * The förening's logo, or its first letter on ink when it has none. Shown only on the förening
 * page and in lists (never in the Docs). Decorative: the name is always written next to it.
 */
export function OrgLogo({ name, src, size = "sm", className }: { name: string; src?: string | null; size?: keyof typeof sizes; className?: string }) {
  const box = cn("grid flex-none place-items-center overflow-hidden", sizes[size], className);
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a private, member-checked route; next/image would proxy it
      <img src={src} alt="" aria-hidden="true" width={px[size]} height={px[size]} decoding="async" loading={size === "sm" ? "lazy" : undefined} className={cn(box, "bg-surface object-cover shadow-panel")} />
    );
  }
  return (
    <span className={cn(box, "bg-ink font-semibold text-on-ink")} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
