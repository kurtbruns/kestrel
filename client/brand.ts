// Publication identity for the sidebar brand: name, tagline, logo, and the From-name
// fallback.

import { publicationName } from "../shared/publication";
import type { SettingsResponse } from "../shared/settings";
import { appState } from "./state";
import { html, setHtml } from "./ui/html";

export interface Publication {
  name: string;
  tagline: string;
  logoUrl: string | null;
}

/**
 * The publication's name / tagline / logo come from the settings surface
 * (settings.publication). Each field falls back sensibly when unset: the name as the
 * email resolves it, and with none a placeholder only the publisher sees, and a neutral
 * initial tile for the logo.
 */
export function derivePublication(data: SettingsResponse | null): Publication {
  const p = data?.settings.publication;
  return {
    name: publicationName(p?.name || "", data?.deployment.from_address ?? "") || "Your publication",
    tagline: p?.tagline || "",
    logoUrl: p?.logo_url || null,
  };
}

export function renderSidebarBrand(): void {
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
      setHtml(logoEl, html`<img src="${pub.logoUrl}" alt="">`);
      logoEl.classList.remove("brand-logo-placeholder");
    } else {
      // Neutral placeholder tile: the publication's initial on the accent.
      logoEl.textContent = (pub.name.trim()[0] || "K").toUpperCase();
      logoEl.classList.add("brand-logo-placeholder");
    }
  }
}
