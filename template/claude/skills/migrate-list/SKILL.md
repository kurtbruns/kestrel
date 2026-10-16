---
name: migrate-list
description: Bring a subscriber list from another newsletter service into this Kestrel instance, converting its export to Kestrel's import format by a method that checks itself, then planning and committing it through the API with the publisher's attestation. Use when the person asks to import their subscribers, move their list from Sendy, migrate from Mailchimp, Substack, Buttondown, ConvertKit, or another service, or upload a CSV of readers.
argument-hint: "[path to the export]"
---

# Migrate a list

An import adds people to the list, and a wrong guess about who agreed to be emailed can't be taken back. So this skill holds no facts about any service's export, which change without notice. It holds a method that checks itself against the file in hand and against Kestrel's own plan.

The authority on the import format is the "The file format" section of the publisher's page "Bring your existing list": `GET /api/docs/your-list.md` on the instance, or `node_modules/@kurtbruns/kestrel/docs/publishing/01-your-list.md`. If anything here seems to disagree with it or with the API, they win; say so.

## Before you start

- **Read the truth from the instance, every time.** Call `GET /api/imports/format` and `GET /api/reference/imports.md` at the start of each migration. They give the columns, the values each takes, the outcomes, the attestation, and this deployment's `limits`. Never write the format from memory, or from this file.
- **Explain it in Kestrel's words.** For what to tell the publisher about the format, the row limit, and the Workers Free advice, read the rest of that page, above "The file format", with this deployment's numbers from `GET /api/imports/format`. Use them rather than your own account of the format.
- **Convert to the format the route names as `preferred`,** the full CSV. Fall back to a plain list only when the export holds nothing but addresses, and tell the publisher what a plain list loses, from the route's own `loses`.
- **Work outside the repository.** Make a working folder outside this repository, such as `~/kestrel-migration/`, for the export, the converter, its tests, and the converted pieces. They hold real addresses, so nothing from the list is ever committed here. A fixture that must be committed uses made-up rows only.

## Rules that never change

- **`opt_in` is `unknown` unless the file states how consent was collected.** A column that says double or single opt-in sets it; a service's reputation or default doesn't, and a code (`1`, `2`) counts only once the publisher confirms what it means.
- **Never invent a time.** A date with no time of day isn't an instant: leave the column empty and keep the date in `evidence`.
- **A time without a zone needs the publisher's answer.** Ask which zone the service wrote it in. With no answer, leave the column empty and keep the value in `evidence`. A Unix timestamp already is an instant, but what it records (a signup, a last change) is still the publisher's to say.
- **`evidence` is verbatim.** The source's consent-relevant columns, under their own names, with their values as written, as strings: a signup IP, a form, a join date, the source's own status flags. A blank value is left out; nothing is reformatted or added. A row's evidence fits in `limits.max_evidence_bytes`; when it wouldn't, the publisher chooses which columns to keep.
- **`origin` is the old service,** as a short lowercase name the format accepts. If neither the export nor the publisher has said which service, ask.
- **Every input row is accounted for:** as an output row, as a repeat Kestrel folds together, or as a drop reported by row number. A row is dropped only when the publisher says so, such as a kind they chose to leave behind. Write each address as the source has it: Kestrel trims and lowercases it, folds an address's repeats together, and reports an invalid one, so its plan's counts check the converter's. Never filter or dedupe rows yourself.
- **What a value means is the publisher's call** when the file doesn't say: a blank status, a "cleaned" or "inactive" state, a bounce count. Ask; never pick.

## The loop

1. **Inspect.** Read the header and a sample of every file, including its last rows, and count its rows. List each column with what it seems to hold, and how it maps to the format's columns or to `evidence`, or is left out (a name, a custom field). Ask the publisher about every ambiguity at once, before converting anything: what each distinct status means (or each combination, when the status is spread across flag columns), what each time column records and its zone, what a blank or a code means, whether an address listed twice with different states is one person, which columns to keep as evidence, and the origin. Point to any row that breaks a column's pattern. Say now how many pieces the import will take (step 5).

2. **Once they've answered, hand-convert one row of each kind,** one per distinct combination of status, opt-in, suppression, and time shape, plus each oddity you found (a repeat, an address with spaces or capitals, an invalid one, a quoted comma). Show each beside its source line and get the publisher's approval before writing code.

3. **Write the converter** in the working folder. Its first tests are the approved rows, each source line in and the exact output line expected, plus a test for every edge case found while inspecting. Write the CSV as the format's reference page says (RFC 4180, UTF-8), with a header of every column the format lists, in its order, as the CSV template does. The converter reports, per input file: rows read, rows written, rows dropped with their numbers and why, the invalid rows, the repeats, and the distinct valid addresses by the status their rows claim. Judge an address valid as Kestrel does: once trimmed and lowercased, it has no spaces, one `@`, and a dot after it. Only a valid address's repeats count as repeats.

4. **Scale up in steps,** such as the first 100 rows, then all of them. At every step the tests pass, rows read equal rows written plus rows dropped, and anything surprising goes to the publisher with the source lines that show it.

5. **Split to the deployment's limits:** `limits.max_rows` from the format route (with `max_rows_reason` when it's lower than the format's own), and `limits.max_body_bytes`. Each piece keeps the header, all of an address's rows (trimmed and lowercased) go in the same piece, and each piece is its own import. Remind the publisher how many pieces there are, and that each that confirms anyone needs their attestation.

6. **For each piece, in order, plan it** with `POST /api/imports/plan`. Planning writes nothing. Check that Kestrel's counts match the converter's for that piece: `file.rows` equals the rows written, `file.addresses` the distinct valid addresses, `counts.invalid` the invalid rows, and `counts.merged` the repeats. The confirmed counts should follow from what the rows claim and the list as it stands, per the format route's `outcomes`, and each row in the plan's `rows` (every row that won't be confirmed) should have the outcome you predicted. Read any you didn't predict, and resolve the difference before going on: a mismatch is a bug in the converter or a question for the publisher, never something to explain away.

7. **If `sends_growing` isn't empty, stop here,** before asking for an attestation, and handle it as the next section says.

8. **Put the plan to the publisher:** the counts by outcome, the confirmed rows by opt-in and origin, the invalid and left-out rows, and anything the plan warns about. When the plan returns `attestation`, put its `text` to them exactly as returned, word for word, and ask whether it's true. Commit only on their yes, given for this piece.

9. **Commit that piece** with `POST /api/imports`, sending the plan's body, its `plan_hash`, and, when the plan returned an attestation, `attestation` with its `version` and `accepted: true`. Report the answer's counts and any `differed` rows. Then plan the next piece: a plan made before another import commits is refused as `plan_stale`, so plan each piece only after the one before it has committed. On `plan_stale`, plan again and put the new plan to the publisher.

## When the plan or the commit says more

- **`sends_growing` isn't empty:** a scheduled send would reach the people this import adds. Never send `acknowledge_sends` yourself, whatever token you hold: only the publisher acknowledges a growing send, in the dashboard. Tell the publisher which send and how many it gains. They can finish this piece in the dashboard, which asks them to acknowledge it, or cancel or wait out the send and import with nothing scheduled, which is simpler.
- **`workers_plan_advice` isn't null:** relay its words as they stand, before asking for the attestation. On the Workers Free plan's limits, this piece leaves the list past about 1,000 confirmed subscribers, what the free plan suits, and past about 5,000 one send can use up the day's database writes and stop the newsletter until midnight UTC. Recommend the move to Workers Paid it names, before the next piece if the list is still growing. It never refuses the import, and the pieces needn't wait for another day.
- **A refusal:** read its `error` and `message`, and its `row`, `column`, and `allowed` when it has them. A problem in the file is fixed in the converter and its tests, never in the piece by hand; then run the step again.

Finish by reporting, across all the pieces: rows read, rows dropped and why, and the counts by outcome as committed. Then tell the publisher where the working folder is and that it holds their readers' addresses, and offer to delete it. Delete it only on their yes, since it may hold their only copy of the export.
