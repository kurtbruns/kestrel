// The pages a reader can land on, grouped by the journey that reaches them (SPEC §5, §7),
// as Settings' Reader pages section lists them and `GET /api/reader-pages/:journey/:state`
// renders them. One list for both ends, so the editor can't offer a page the Worker
// doesn't render.

/** Every journey a reader takes, in the order they take them, with each page and state
 *  it can land on. A state's `id` is its path segment; `label` is how Settings names it. */
export const READER_JOURNEYS = [
  {
    id: "subscribe",
    label: "Subscribe",
    states: [
      { id: "form", label: "Form" },
      { id: "check-inbox", label: "Check your inbox" },
      { id: "not-an-email", label: "Not an email" },
    ],
  },
  {
    id: "confirm",
    label: "Confirm",
    states: [
      { id: "ready", label: "Ready" },
      { id: "confirmed", label: "Confirmed" },
      { id: "expired", label: "Expired" },
      { id: "invalid", label: "Invalid link" },
    ],
  },
  {
    id: "unsubscribe",
    label: "Unsubscribe",
    states: [
      { id: "ask", label: "Ask" },
      { id: "done", label: "Unsubscribed" },
      { id: "invalid", label: "Invalid link" },
    ],
  },
  {
    id: "reading",
    label: "Reading",
    states: [
      { id: "landing", label: "Landing page" },
      { id: "archive", label: "Archive" },
      { id: "post", label: "Post page" },
      { id: "not-found", label: "Nothing here yet" },
    ],
  },
] as const;

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
): { journey: ReaderJourney; state: ReaderJourney["states"][number] } | null {
  const j = READER_JOURNEYS.find((x) => x.id === journey);
  const s = j?.states.find((x) => x.id === state);
  return j && s ? { journey: j, state: s } : null;
}
