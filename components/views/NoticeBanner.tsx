import { Banner } from "@/components/ui/Banner";
import type { Notice } from "@/lib/ui/messages";

export function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <Banner tone={notice.tone} title={notice.title} className="notice">
      {notice.text}
    </Banner>
  );
}
