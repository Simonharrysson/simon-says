"use client";

import { useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * True when this component mounted in a client render (a link navigation, back/forward, a tab
 * switch, content arriving later), false when it was hydrated from the server's HTML. Frozen at
 * mount. Hydration reads the server snapshot (false), so a page load never animates its first
 * paint, and nothing differs between the server HTML and the hydrated tree.
 */
export function useMountedFresh(): boolean {
  const client = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [fresh] = useState(client);
  return fresh;
}
