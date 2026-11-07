# Keyword and language lists

Read this when a diff holds a literal list of words, path fragments or language-specific strings used to **classify** input.

Such a list works for exactly the languages, spellings and conventions someone remembered to type, and everywhere else it degrades **silently**: no error, no failing test, just quietly worse output for every user outside the list. That invisibility is why it gets flagged in cleanup rather than found at runtime.

The question to ask: *what happens on a site, customer, or locale nobody on the team speaks?* If the answer is "it still runs, just worse", replace it.

Prefer, in order:

1. **Match the shape of the data, not its name.** The thing you are looking for usually has a form that survives translation: an e-mail address, a phone number, a time range, a currency amount, a postal code, a VAT-shaped token, an ISO date. Score or filter on those instead of on what the page or field calls itself.
2. **Use structure you already have.** URL path depth, `<html lang>`, `hreflang`, JSON-LD, HTTP headers, MIME type, DOM or document position, crawl/insertion order, counts and ratios. These are free, deterministic, and language-neutral.
3. **Ask the model.** If a cheap LLM call already runs in this pipeline, a keyword list is doing badly, and untestably, what the model does well. Let the prompt classify and keep the deterministic code for the parts that must be exact.
4. **Derive from a source of truth.** Prisma enums, curated language-code lists, `Intl` / ICU data, a typed registry. Never a hand-written parallel list.

**When a list is fine.** The test is whether it enumerates a *closed set defined by a spec or by our own product* rather than a guess about the world:

- ISO 639/3166 codes, Prisma enums, currency codes
- file extensions, MIME types, HTTP methods, protocol tokens, reserved slugs
- our own route names, event names, queue names, secret keys, feature flags
- a specific vendor's documented error codes or webhook types

Those are facts with an authority you can point at, and a missing entry is a bug someone can find. Keep them `as const satisfies Record<Union, …>` so the compiler enforces completeness. A list of "words that probably mean contact page" has no such authority and no such check.

**Red flags when reviewing a diff:**

- one array mixing two or more languages (`'opening'` next to `'åbningstider'`)
- a comment along the lines of "add more as we expand" or "covers our main markets"
- `.includes()` / `.some()` over the list against a URL, title, or free text
- an identifier ending in `_HINTS`, `_KEYWORDS`, `_TERMS`, `_PATTERNS` used to classify rather than to parse
- a list that would need a translator, not an engineer, to extend correctly

**Worked example (website import).** Choosing which crawled pages to read a company's business details from started as `CONTACT_PAGE_HINTS = ['contact', 'kontakt', 'about', 'om-os', 'impressum', 'åbningstider', ...]`, matched against URL and title. It was replaced by a score over distinct e-mail addresses, `tel:` links, phone-shaped numbers (eight digits or more, so prices and years do not count), and opening-hours ranges such as `08.00-17.00`, with path depth and crawl order as tie-breaks. Those signals are identical in Danish, Portuguese, Japanese and Polish, so a new country needs no code change, and the ranking became unit-testable across languages instead of only against the ones in the array.
