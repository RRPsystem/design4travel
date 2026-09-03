// Deno-tests voor buildSystemPrompt en zijn TRAVEL CONTEXT-injectie.
//
// Doel: verifiëren dat de nieuwe TRAVEL CONTEXT-sectie:
//   - Ontbreekt als er geen travelContent is (backward-compat).
//   - Ontbreekt bij onherkenbare / lege inhoud (defensief).
//   - Aanwezig is + belangrijke velden bevat bij geldige TravelContent.

import { buildSystemPrompt } from "./prompts.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const OK_DOC = {
  version: "0.1.0",
  project: { documentType: "website", title: "Test" },
  pages: [{ id: "p1", root: { id: "r", type: "layout-column", props: {} } }],
};

const VALID_TRAVEL_CONTENT = {
  schema_version: "1.0",
  title: "Safari Zuid-Afrika & strand Mauritius",
  subtitle: "14 dagen dromen",
  intro: "Combineer de Big Five met witte stranden.",
  days: 14,
  nights: 13,
  countries: ["Zuid-Afrika", "Mauritius"],
  price: { amount: 4299, currency: "EUR", per: "person" },
  destinations: [
    { name: "Kruger National Park", country: "Zuid-Afrika", from_day: 3, to_day: 6 },
    { name: "Mauritius", country: "Mauritius", from_day: 8, to_day: 14 },
  ],
  hotels: [
    { day: 3, city: "Kruger", name: "Lion Sands Ivory Lodge", nights: 3 },
    { day: 8, city: "Belle Mare", name: "One&Only Le Saint Géran", nights: 6 },
  ],
  meta: { source_kind: "travel_compositor", source_id: "tc-12345", version: "v1" },
};

Deno.test("no TRAVEL CONTEXT section when travelContent is undefined", () => {
  const prompt = buildSystemPrompt(OK_DOC);
  assert(!prompt.includes("TRAVEL CONTEXT"), "expected no TRAVEL CONTEXT section");
  // Doc-state moet er nog steeds staan (regression-check).
  assert(prompt.includes("CURRENT DOCUMENT"), "doc-state still required");
});

Deno.test("no TRAVEL CONTEXT section when travelContent is null", () => {
  const prompt = buildSystemPrompt(OK_DOC, undefined, null);
  assert(!prompt.includes("TRAVEL CONTEXT"), "expected no TRAVEL CONTEXT section");
});

Deno.test("no TRAVEL CONTEXT section when travelContent is empty object", () => {
  const prompt = buildSystemPrompt(OK_DOC, undefined, {});
  assert(!prompt.includes("TRAVEL CONTEXT"), "empty object should be skipped");
});

Deno.test("no TRAVEL CONTEXT section when title is missing (defensive)", () => {
  const prompt = buildSystemPrompt(OK_DOC, undefined, { days: 5, countries: ["NL"] });
  assert(!prompt.includes("TRAVEL CONTEXT"), "title is required for the block");
});

Deno.test("TRAVEL CONTEXT section present with valid TravelContent", () => {
  const prompt = buildSystemPrompt(OK_DOC, undefined, VALID_TRAVEL_CONTENT);
  assert(prompt.includes("TRAVEL CONTEXT"), "section header missing");
  assert(
    prompt.includes("Safari Zuid-Afrika & strand Mauritius"),
    "title missing from prompt",
  );
  assert(prompt.includes("14 dagen"), "days missing");
  assert(prompt.includes("Zuid-Afrika, Mauritius"), "countries missing");
  assert(prompt.includes("4299 EUR per person"), "price missing");
  assert(prompt.includes("Kruger National Park"), "destination missing");
  assert(prompt.includes("Lion Sands Ivory Lodge"), "hotel missing");
});

Deno.test("TRAVEL CONTEXT sits BEFORE the authoritative doc-state block", () => {
  const prompt = buildSystemPrompt(OK_DOC, undefined, VALID_TRAVEL_CONTENT);
  const travelIdx = prompt.indexOf("TRAVEL CONTEXT");
  const docIdx = prompt.indexOf("<authoritative_document_state>");
  assert(travelIdx >= 0 && docIdx >= 0, "both blocks expected");
  assert(travelIdx < docIdx, "TRAVEL CONTEXT must precede doc-state");
});

Deno.test("TRAVEL CONTEXT handles minimal content (title only)", () => {
  const prompt = buildSystemPrompt(OK_DOC, undefined, { title: "Minimale reis" });
  assert(prompt.includes("TRAVEL CONTEXT"), "should render with just a title");
  assert(prompt.includes("Minimale reis"), "title missing");
  assert(!prompt.includes("Bestemmingen ("), "no destinations block when none provided");
  assert(!prompt.includes("Hotels ("), "no hotels block when none provided");
});
