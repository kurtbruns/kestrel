// The API's error body (docs/API.md, "Refusals"): every non-2xx JSON answer carries a code,
// a message written to be shown as it stands, and, for a refusal about the request, the
// field it is about. The Worker builds it and the editor reads it; one definition, so the
// compiler holds both ends.

/** A refusal's JSON body. A refusal about a resource's state adds its own fields beside these. */
export interface ApiErrorBody {
  /** The machine-readable code, such as `bad_request` or `fire_at_too_soon`. */
  error: string;
  /** The server's words for it. Absent on an unexpected 500, which has none to give, and on
   *  a few bare refusals (an unknown route's 404). */
  message?: string;
  /** The request field the refusal is about, dotted for a nested one (`publication.name`). */
  field?: string;
}

/**
 * Why an admin 401 can't be fixed by signing in again, when it can't (SPEC §11):
 * `access_not_configured`, a deployment with no Access, which lets no request in; and
 * `access_unidentified`, an Access login that carries neither a person's email nor a
 * service token's Client ID, which some other kind of Access policy let in. Any other 401
 * carries no reason.
 */
export type UnauthorizedReason = "access_not_configured" | "access_unidentified";

/** An admin 401's body: `unauthorized`, with a `reason` only when signing in again can't help. */
export interface UnauthorizedBody {
  error: "unauthorized";
  message: string;
  reason?: UnauthorizedReason;
}

/** The reason a body gives, when it is an admin 401 that gives one. */
export function unauthorizedReason(data: unknown): UnauthorizedReason | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const d = data as { error?: unknown; reason?: unknown };
  if (d.error !== "unauthorized") {
    return null;
  }
  return d.reason === "access_not_configured" || d.reason === "access_unidentified"
    ? d.reason
    : null;
}
