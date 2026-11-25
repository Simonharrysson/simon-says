// What the live page does after Avsluta (or an automatic stop), as a testable function
// (final-wave C6 + residual R1/R3): post every waiting line, then POST /end, which answers at
// once (the final pass runs on the server after the response).

/** The slice of LiveStream the end flow needs. */
export interface DrainingStream {
  readonly pending: number;
  /** The last post got 401/403: the queue waits for a new sign-in. */
  readonly signedOut: boolean;
  drain(maxMs: number): Promise<number>;
}

export type EndOutcome =
  /** /end accepted (or there is nothing left to end): load the meeting's page. */
  | { kind: "navigate" }
  /** Network error, timeout or 5xx on /end: offer "Försök igen", stay on the page. */
  | { kind: "end_failed" }
  /** Signed out with lines still unsent: they need a new sign-in to be saved (R3). */
  | { kind: "signed_out"; unsent: number };

export interface EndFlowOptions {
  stream: DrainingStream | null;
  /** POST /end; resolves with the HTTP status, rejects on network error or timeout. */
  postEnd: () => Promise<number>;
  drainRoundMs: number;
  onPending?: (count: number) => void;
  /** Skip the wait for unsent lines and end with what the server has ("Avsluta utan dem"). */
  endWithoutUnsent?: boolean;
}

export async function runEndFlow(o: EndFlowOptions): Promise<EndOutcome> {
  const s = o.stream;
  if (s && !o.endWithoutUnsent) {
    // Each round is bounded (15 s per post, drainRoundMs per round). Offline it keeps going; the
    // server drops our queue once the meeting is over (meeting_not_live), so it ends. Signed out
    // it can't succeed: stop and say so instead of looping (R3).
    while (s.pending > 0) {
      o.onPending?.(s.pending);
      await s.drain(o.drainRoundMs);
      if (s.pending > 0 && s.signedOut) {
        o.onPending?.(0);
        return { kind: "signed_out", unsent: s.pending };
      }
    }
  }
  o.onPending?.(0);
  let status: number;
  try {
    status = await o.postEnd();
  } catch {
    return { kind: "end_failed" };
  }
  // 2xx: ending (or already ended). 404/403: nothing this page can end. 401: signed out.
  if (status === 401) return { kind: "signed_out", unsent: s?.pending ?? 0 };
  if (status >= 500) return { kind: "end_failed" };
  return { kind: "navigate" };
}
