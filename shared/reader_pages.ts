// The pages a reader can land on, grouped by the journey that reaches them (SPEC §5, §7),
// as Settings' Reader pages section lists them and `GET /api/reader-pages/:journey/:state`
// renders them. One list for both ends, so the editor can't offer a page the Worker
// doesn't render.

/** Where a reader meets a page: under the app's origin, or under the archive's (origin
 *  and base path), and the rest of the address. Shown to the publisher, never fetched. */
export interface ReaderPageAddress {
  base: "app" | "archive";
  path: string;
}

/** One page or state a reader can land on. `offPath` marks one a reader reaches only when
 *  something goes wrong or there is nothing yet (an expired link, a publication that has
 *  sent no post). */
export interface ReaderPageState {
  id: string;
  label: string;
  offPath?: true;
  at: ReaderPageAddress;
}

const SUBSCRIBE: ReaderPageAddress = { base: "app", path: "/subscribe" };
const CONFIRM: ReaderPageAddress = { base: "app", path: "/confirm?token=…" };
const UNSUBSCRIBE: ReaderPageAddress = { base: "app", path: "/unsubscribe?token=…" };

/** Every journey a reader takes, in the order they take them, with each page and state
 *  it can land on. A state's `id` is its path segment; `label` is how Settings names it.
 *  A journey's `flow` says how its main-path pages relate: `steps` a reader takes in
 *  order, or `peers` a reader moves between. */
export const READER_JOURNEYS = [
  {
    id: "subscribe",
    label: "Subscribe",
    flow: "steps",
    states: [
      { id: "form", label: "Form", at: SUBSCRIBE },
      { id: "check-inbox", label: "Check your inbox", at: SUBSCRIBE },
      { id: "not-an-email", label: "Not an email", offPath: true, at: SUBSCRIBE },
    ],
  },
  {
    id: "confirm",
    label: "Confirm",
    flow: "steps",
    states: [
      { id: "ready", label: "Ready", at: CONFIRM },
      { id: "confirmed", label: "Confirmed", at: CONFIRM },
      { id: "expired", label: "Expired", offPath: true, at: CONFIRM },
      { id: "invalid", label: "Invalid link", offPath: true, at: CONFIRM },
    ],
  },
  {
    id: "unsubscribe",
    label: "Unsubscribe",
    flow: "steps",
    states: [
      { id: "ask", label: "Ask", at: UNSUBSCRIBE },
      { id: "done", label: "Unsubscribed", at: UNSUBSCRIBE },
      { id: "invalid", label: "Invalid link", offPath: true, at: UNSUBSCRIBE },
    ],
  },
  {
    id: "reading",
    label: "Reading",
    flow: "peers",
    states: [
      { id: "landing", label: "Landing page", at: { base: "app", path: "/" } },
      { id: "archive", label: "Archive", at: { base: "archive", path: "" } },
      // The sample post's slug, as the Worker's preview renders it.
      { id: "post", label: "Post page", at: { base: "archive", path: "/sample-post" } },
      // A publication with nothing sent yet: what its first visitors get.
      {
        id: "landing-empty",
        label: "Landing, no posts yet",
        offPath: true,
        at: { base: "app", path: "/" },
      },
      {
        id: "archive-empty",
        label: "Archive, no posts yet",
        offPath: true,
        at: { base: "archive", path: "" },
      },
      {
        id: "not-found",
        label: "Nothing here yet",
        offPath: true,
        at: { base: "archive", path: "/…" },
      },
    ],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  flow: "steps" | "peers";
  states: readonly ReaderPageState[];
}[];

export type ReaderJourney = (typeof READER_JOURNEYS)[number];
export type ReaderJourneyId = ReaderJourney["id"];

/** The path of one page's preview. */
export function readerPagePath(journey: string, state: string): string {
  return `/api/reader-pages/${encodeURIComponent(journey)}/${encodeURIComponent(state)}`;
}

/** The journey and state a pair of path segments names, or null for one the list lacks. */
export function findReaderPage(
  journey: string,
  state: string,
): { journey: ReaderJourney; state: ReaderPageState } | null {
  const j = READER_JOURNEYS.find((x) => x.id === journey);
  const s = j?.states.find((x) => x.id === state);
  return j && s ? { journey: j, state: s } : null;
}
