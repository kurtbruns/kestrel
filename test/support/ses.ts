/**
 * Amazon SES as the specs meet it: the SendBulkEmail and SendEmail endpoints, a `fetch`
 * stand-in that answers each recipient, and SES's simple substitution of an inline
 * template, so a spec can read back the email each recipient of a request would get. A
 * SendEmail request is read as a bulk request of one entry, so specs treat both alike.
 */
import { vi } from "vitest";

export const SES_BULK_ENDPOINT =
  "https://email.us-east-1.amazonaws.com/v2/email/outbound-bulk-emails";
export const SES_SINGLE_ENDPOINT = "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails";

export interface BulkEntry {
  Destination: { ToAddresses: string[] };
  ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: string } };
  ReplacementHeaders: { Name: string; Value: string }[];
}

export interface BulkRequest {
  FromEmailAddress: string;
  ConfigurationSetName?: string;
  DefaultContent: {
    Template: {
      TemplateContent: { Subject: string; Html: string; Text: string };
      TemplateData: string;
    };
  };
  BulkEmailEntries: BulkEntry[];
  /** Which endpoint took it: SendBulkEmail, or SendEmail read as one entry. */
  endpoint: "bulk" | "single";
}

interface SingleRequest {
  FromEmailAddress: string;
  ConfigurationSetName?: string;
  Destination: { ToAddresses: string[] };
  Content: {
    Template: {
      TemplateContent: { Subject: string; Html: string; Text: string };
      TemplateData: string;
      Headers: { Name: string; Value: string }[];
    };
  };
}

/** One entry's result, as SES gives it. */
export interface EntryAnswer {
  Status: string;
  MessageId?: string;
  Error?: string;
}

/** An accepted entry, with a message id of its own, as SES gives each one. */
export const entryOk = (): EntryAnswer => ({ Status: "SUCCESS", MessageId: crypto.randomUUID() });

export async function readBulkRequest(input: unknown): Promise<BulkRequest> {
  const req = input as Request;
  const body = JSON.parse(await req.clone().text());
  if (req.url === SES_BULK_ENDPOINT) {
    return { ...(body as Omit<BulkRequest, "endpoint">), endpoint: "bulk" };
  }
  const single = body as SingleRequest;
  return {
    FromEmailAddress: single.FromEmailAddress,
    ConfigurationSetName: single.ConfigurationSetName,
    DefaultContent: {
      Template: { TemplateContent: single.Content.Template.TemplateContent, TemplateData: "{}" },
    },
    BulkEmailEntries: [
      {
        Destination: single.Destination,
        ReplacementEmailContent: {
          ReplacementTemplate: { ReplacementTemplateData: single.Content.Template.TemplateData },
        },
        ReplacementHeaders: single.Content.Template.Headers,
      },
    ],
    endpoint: "single",
  };
}

/**
 * SES's simple substitution of an inline template: each `{{tag}}` becomes its value, never
 * read again. A tag the data lacks throws, since SES drops such a message (a rendering
 * failure). Strict on purpose: anything else in braces throws too, so a spec proves the
 * template holds nothing an engine could read another way.
 */
export function sesSubstitute(template: string, data: Record<string, string>): string {
  const TAG = /\{\{(\w+)\}\}/g;
  if (/[{}\\]/.test(template.replace(TAG, ""))) {
    throw new Error(`template carries a brace or backslash outside a tag: ${template}`);
  }
  // One pass: a value put in is never read again for tags.
  return template.replace(TAG, (_m, tag: string) => {
    const value = data[tag];
    if (value === undefined) {
      throw new Error(`rendering failure: no data for {{${tag}}}`);
    }
    return value;
  });
}

/** The email entry `i` of a request delivers, as SES would build it. */
export function deliveredBy(req: BulkRequest, i: number) {
  const entry = req.BulkEmailEntries[i]!;
  const data = JSON.parse(
    entry.ReplacementEmailContent.ReplacementTemplate.ReplacementTemplateData,
  );
  const content = req.DefaultContent.Template.TemplateContent;
  return {
    to: entry.Destination.ToAddresses,
    subject: sesSubstitute(content.Subject, data),
    html: sesSubstitute(content.Html, data),
    text: sesSubstitute(content.Text, data),
    headers: Object.fromEntries(entry.ReplacementHeaders.map((h) => [h.Name, h.Value])),
  };
}

/**
 * Answer every request through `fetch`: `entry` decides each recipient's result, unless
 * `whole` answers the request as a whole (an error response, say). Records each request,
 * and how many times each address was accepted.
 */
export function answerSes(
  entry: (to: string) => EntryAnswer = () => entryOk(),
  whole: () => Response | null = () => null,
) {
  const requests: BulkRequest[] = [];
  const mailed = new Map<string, number>();
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const req = await readBulkRequest(input);
    requests.push(req);
    const refused = whole();
    if (refused) {
      return refused;
    }
    const results = req.BulkEmailEntries.map((e) => {
      const to = e.Destination.ToAddresses[0]!;
      const answer = entry(to);
      if (answer.Status === "SUCCESS") {
        mailed.set(to, (mailed.get(to) ?? 0) + 1);
      }
      return answer;
    });
    if (req.endpoint === "single") {
      // SendEmail answers one message: its id, or an error response for a refusal.
      const [only] = results;
      return only?.Status === "SUCCESS"
        ? new Response(JSON.stringify({ MessageId: only.MessageId }), { status: 200 })
        : new Response(JSON.stringify({ __type: "MessageRejected", message: only?.Error ?? "" }), {
            status: 400,
          });
    }
    return new Response(JSON.stringify({ BulkEmailEntryResults: results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { spy, requests, mailed };
}
