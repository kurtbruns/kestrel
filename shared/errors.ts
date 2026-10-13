// The API's error body (docs/API.md, "Refusals"): every non-2xx JSON answer carries a code,
// a message written to be shown as it stands, and, for a refusal about the request, the
// field it is about. The Worker builds it and the editor reads it; one definition, so the
// compiler holds both ends.

/** A refusal's JSON body. A refusal about a resource's state adds its own fields beside these. */
export interface ApiErrorBody {
  /** The machine-readable code, such as `bad_request` or `fire_at_too_soon`. */
  error: string;
  /** The server's words for it. Absent on an unexpected 500, which has none to give, and on
   *  a few bare refusals (an unauthenticated 401, an unknown route's 404). */
  message?: string;
  /** The request field the refusal is about, dotted for a nested one (`publication.name`). */
  field?: string;
}
