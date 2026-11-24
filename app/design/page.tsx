import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DesignGallery } from "@/components/design/DesignGallery";
import { lookupView } from "@/components/design/registry";
import { designPreviewEnabled } from "@/lib/design-guard";

// Read the env per request, so the 404 isn't frozen into a static build.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Designsystem", robots: { index: false, follow: false } };

export default async function DesignPage({ searchParams }: { searchParams: Promise<{ vy?: string }> }) {
  if (!designPreviewEnabled({ NODE_ENV: process.env.NODE_ENV, DESIGN_PREVIEW: process.env.DESIGN_PREVIEW })) notFound();
  const { vy } = await searchParams;
  if (vy && !lookupView(vy)) notFound();
  return <DesignGallery view={vy ?? null} />;
}
