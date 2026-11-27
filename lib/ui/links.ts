// Which in-app links navigate client-side (next/link: the header stays, the route's skeleton
// shows at once, prefetch) and which stay full page loads. Pure.
//
// Full loads, on purpose:
// - route handlers (/api, /auth, /sprak) and the login (OAuth redirects);
// - /meetings/…: the start screen and the live page own the microphone. Entering and leaving
//   them with a real page load guarantees the recorder is torn down (LiveMeeting itself leaves
//   with window.location.assign for the same reason);
// - /join and /mejl: reached from invite and email links, with their own sign-in flows.

const FULL_LOAD = /^\/(api|auth|sprak|login|meetings|join|mejl)(\/|\?|#|$)/;

/** Same-origin app route that may use client-side navigation. */
export function isClientRoute(href: string | undefined | null): href is string {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return false;
  return !FULL_LOAD.test(href);
}
