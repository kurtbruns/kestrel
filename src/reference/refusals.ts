/**
 * Every code the API refuses with, and the status it carries. A route's `errors` names its
 * codes from this list, so the reference can't document a code the API never gives, and the
 * status is read from here rather than restated on each route. docs/API.md ("Refusing")
 * groups the same codes by the client's next move; a spec holds the two to the same codes.
 */
export const REFUSAL_STATUS = {
  bad_request: 400,
  subject_required: 400,
  fire_at_too_soon: 400,
  slug_invalid: 400,
  unrecognized_format: 400,
  invalid_field: 400,
  too_many_rows: 400,
  unauthorized: 401,
  forbidden: 403,
  cross_site_request: 403,
  not_found: 404,
  stale_revision: 409,
  active_send_exists: 409,
  cursor_ahead: 409,
  plan_stale: 409,
  slug_taken: 409,
  run_in_progress: 409,
  settings_changed: 409,
  conflict: 409,
  remake_too_close: 409,
  remake_required: 409,
  attestation_required: 409,
  sends_acknowledgement_required: 409,
  erasure_acknowledgement_required: 409,
  window_closed: 409,
  send_canceled: 409,
  post_not_draft: 409,
  not_wedged: 409,
  slug_permanent: 409,
  erasure_marker: 409,
  provider_not_connected: 409,
  body_too_large: 413,
  unsupported_media_type: 415,
  base_required: 428,
  internal_error: 500,
  invalid_config: 500,
  schema_behind: 500,
  settings_corrupt: 500,
  notify_failed: 502,
  confirmation_not_sent: 502,
} as const satisfies Record<string, number>;

/** A code the API refuses with: the `error` of a refusal's body. */
export type RefusalCode = keyof typeof REFUSAL_STATUS;
