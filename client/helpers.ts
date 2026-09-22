// Small view helpers: toasts, badges, dates, address parsing, the clipboard, and the modal.

import { type Html, html, setHtml } from "./html";
import { toasts } from "./shell";

export function toast(msg: string): void {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  toasts.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  // Linger long enough to read a sentence-length confirmation ("Test sent to 2
  // addresses") before it fades; the removal trails the fade-out transition.
  setTimeout(() => t.classList.remove("show"), 3600);
  setTimeout(() => t.remove(), 3900);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy to clipboard");
  }
}

/** A status pill; the status doubles as its class. */
export const badge = (status: string): Html => html`<span class="badge ${status}">${status}</span>`;

/** A short local date-time, or an em dash for none. */
export const fmt = (ms: number | null | undefined): string =>
  ms
    ? new Date(ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

/**
 * Split a free-text recipient list (newlines or commas) into unique addresses.
 * Server-side validation is authoritative; this just tidies the Send-test input.
 */
export function parseAddresses(text: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(text || "").split(/[\n,]+/)) {
    const a = part.trim();
    if (!a.includes("@")) {
      continue;
    }
    const key = a.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** A Date as the value of a `datetime-local` input, in local time. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * A countdown that gets coarser the further out the fire time is: it ticks seconds
 * only inside the last few minutes (the imminent / send-now cancel window), then
 * counts down by the minute, by the hour within a day, and by whole days beyond, so
 * a send scheduled days away reads "Sends in 2 days", not a ticking "47h 47m".
 */
export function untilStr(fireAt: number): string {
  const d = fireAt - Date.now();
  if (d <= 0) {
    return "Sending now…";
  }
  const s = Math.floor(d / 1000);
  const min = Math.floor(s / 60);
  const hr = Math.floor(min / 60);
  if (s < 300) {
    return min > 0 ? `Sends in ${min}m ${String(s % 60).padStart(2, "0")}s` : `Sends in ${s}s`;
  }
  if (min < 60) {
    return `Sends in ${min}m`;
  }
  if (hr < 24) {
    const rm = min % 60;
    return rm > 0 ? `Sends in ${hr}h ${rm}m` : `Sends in ${hr}h`;
  }
  const days = Math.round(hr / 24);
  return `Sends in ${days} day${days === 1 ? "" : "s"}`;
}

export interface Modal {
  el: HTMLElement;
  close: () => void;
}

/** A modal over a backdrop; a click outside or Escape closes it. The content is markup. */
export function modal(content: Html): Modal {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  setHtml(back, html`<div class="modal" role="dialog" aria-modal="true">${content}</div>`);
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("click", (e) => {
    if (e.target === back) {
      close();
    }
  });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });
  return { el: back, close };
}
