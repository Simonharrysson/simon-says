/**
 * The /design preview (fake data, every UI state) is for development. It is a 404 in
 * production unless DESIGN_PREVIEW=1 is set (e.g. on a preview deployment).
 */
export function designPreviewEnabled(env: { NODE_ENV?: string; DESIGN_PREVIEW?: string }): boolean {
  return env.NODE_ENV !== "production" || env.DESIGN_PREVIEW === "1";
}
