// @ts-nocheck
// Publication identity for the sidebar brand: name, tagline, logo, and the From-name
// fallback.

import { esc } from "./helpers";
import { appState } from "./state";

// The publication's name / tagline / logo come from the settings surface
// (settings.publication). Each field falls back sensibly when unset: the name from
// the From: display name (the read-only deployment reflection) and a neutral initial
// tile for the logo.
export function parseFromName(fromAddress) {
  if (!fromAddress) {
    return null;
  }
  // "Display Name <addr@domain>" → "Display Name"; a bare address has no display name.
  const m = String(fromAddress).match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = m?.[1] ? m[1].trim() : "";
  return name || null;
}
export function derivePublication(data) {
  const s = data?.settings || {};
  const d = data?.deployment || {};
  const p = s.publication || {}; // the publication identity, edited in Settings
  return {
    name: p.name || parseFromName(d.fromAddress) || "Your publication",
    tagline: p.tagline || "",
    logoUrl: p.logoUrl || null,
  };
}
export function renderSidebarBrand() {
  const pub = derivePublication(appState.appConfig);
  const nameEl = document.getElementById("brandName");
  const tagEl = document.getElementById("brandTagline");
  const logoEl = document.getElementById("brandLogo");
  if (nameEl) {
    nameEl.textContent = pub.name;
  }
  if (tagEl) {
    tagEl.textContent = pub.tagline;
    tagEl.hidden = !pub.tagline;
  }
  if (logoEl) {
    if (pub.logoUrl) {
      logoEl.innerHTML = `<img src="${esc(pub.logoUrl)}" alt="">`;
      logoEl.classList.remove("brand-logo-placeholder");
    } else {
      // Neutral placeholder tile: the publication's initial on the accent.
      logoEl.textContent = (pub.name.trim()[0] || "K").toUpperCase();
      logoEl.classList.add("brand-logo-placeholder");
    }
  }
}
