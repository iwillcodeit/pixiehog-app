/** Value persisted under `pxhog_anonymous_key`: the consent state the last event was sent with. */
export type AnonymousMarker = 'true' | 'false' | null;

export type AnonymousTransitionInput = {
  /** Consent-derived flag for the current event / boot. */
  anonymous: boolean;
  /** Marker read from localStorage; `null` when never written (first visit, or storage cleared). */
  marker: AnonymousMarker;
  /** `distinct_id` currently held in the shared posthog-js persistence blob, if any. */
  storedDistinctId: unknown;
};

export type AnonymousTransition = {
  /** Wipe the shared persistence blob (`resetPosthog`) before sending anything. */
  reset: boolean;
  /** Marker value to write, `null` when it already matches and no write is needed. */
  marker: 'true' | 'false' | null;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Anonymous ids — the pixel's `uuidv7()` and posthog-js's own anonymous `distinct_id` — are UUIDs.
 * Anything else (an email set by the pixel's `setDistinctId`, a customer id set by the theme's
 * `posthog.identify`) is an identified id.
 */
export function isIdentifiedDistinctId(distinctId: unknown): boolean {
  return typeof distinctId === 'string' && distinctId !== '' && !UUID_REGEX.test(distinctId);
}

export type IdentifyCustomerInput = {
  anonymous: boolean;
  /** Logged-in customer's email, if any. */
  email: string | null | undefined;
  /** `distinct_id` currently held in the shared posthog-js persistence blob. */
  currentDistinctId: unknown;
  /**
   * `true` before each event: only promote an anonymous (UUID) id, never replace an identity already
   * set mid-page (e.g. a different email submitted at checkout, which the handler identified). `false`
   * at boot, where the logged-in account wins (shared device: previous customer's id is replaced).
   */
  fromAnonymousOnly: boolean;
};

/** Whether the logged-in customer must be identified (by email) before the next event is sent. */
export function shouldIdentifyCustomer(input: IdentifyCustomerInput): boolean {
  if (!input.email || input.anonymous || input.currentDistinctId === input.email) {
    return false;
  }
  return !(input.fromAnonymousOnly && isIdentifiedDistinctId(input.currentDistinctId));
}

/**
 * Decide what to do with persisted identity when an event is about to be sent.
 *
 * Reset (full blob wipe) is required when the visitor is anonymous and either
 * - the marker says the previous event was identified (`'false'` → consent withdrawn), or
 * - the blob still holds an identified `distinct_id`, whatever the marker says. The marker alone is
 *   not enough: it is `null` on a fresh sandbox and stays `'true'` when the theme's posthog-js
 *   identified the visitor without going through the pixel, and in both cases anonymous events
 *   would otherwise be sent under that identity.
 *
 * A UUID `distinct_id` never triggers a reset: that is the normal anonymous state, and wiping it
 * would also drop the theme's `$sesid` / `$device_id` for every consent-refused visitor on every
 * event. Pure so it is unit-testable outside the pixel sandbox.
 */
export function decideAnonymousTransition(input: AnonymousTransitionInput): AnonymousTransition {
  const expectedMarker = input.anonymous ? 'true' : 'false';
  const reset =
    input.anonymous && (input.marker === 'false' || isIdentifiedDistinctId(input.storedDistinctId));
  return {
    reset,
    marker: input.marker === expectedMarker ? null : expectedMarker,
  };
}
