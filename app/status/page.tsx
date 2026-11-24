import type { Metadata } from "next";
import { PublicShell } from "@/components/views/PublicShell";
import { StatusView } from "@/components/views/StatusView";

export const metadata: Metadata = { title: "Status" };

// Shell only. Task 13 reads live meetings and weekly minutes (org names only where
// show_on_status) and passes them as `data`.
export default function StatusPage() {
  return (
    <PublicShell signedIn={false}>
      <StatusView data={null} />
    </PublicShell>
  );
}
