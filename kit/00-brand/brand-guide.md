<!--
  RECONSTRUCTED 2026-07-13 after kit loss — owner review pending.

  The untracked marketing/ kit was deleted by a `git clean -fd` in the platform
  repo (~17:21, 2026-07-13); no backup exists. This brand guide was rebuilt from
  first-party evidence, in priority order:
    1. The verbatim brand law already encoded in this repo's lint engine
       (src/lint/rules/{noun-law,price-law,banned-lexicon,off-limits-claims,
       style}.mjs) and operationalised in prompts/copywriter.md — these cite the
       exact §/row of the lost guide they enforce, so they ARE the contract.
    2. Approved, shipped voice in outbox/*/item.json captions + overlays.
    3. First-party product copy in the platform checkout (READ-ONLY): the
       dashboard hero, pricing, and terms pages (getforevermore.co).
    4. docs/PRD.md brand statements.

  HARD CONTRACT (do not break without updating the consumers):
    - src/brain/assemble.mjs#extractBrandSections injects §1–3 VERBATIM into
      every generation prompt and stops at the "## 4." heading. Keep headings
      "## 1.", "## 2.", "## 3." and the exact "## 4. Visual language" boundary.
    - test/brain/assemble.test.mjs asserts these strings survive verbatim in
      §1–3: "Made, not generated.", "$15 per gift", "Give them a whole world.".
    - The lint rules key off the price forms, banned list, noun law, off-limits
      claims, and the all-caps badge whitelist below — change wording here and
      the machine-checkable law drifts from the human law.

  Where the original wording could not be recovered exactly, the phrasing is
  pulled conservatively from approved outbox captions and live product copy.
-->

# Forevermore brand guide

**Give them a whole world.** This is the law the employee writes to. §1–3 are
injected verbatim into every generation prompt and are enforced by the lint
engine; they override anything a playbook rule, idea, or task ever says.

## 1. What we are

Forevermore turns someone's photos and words into a small, hand-built **world**
the person they love can step inside — sent like a message, and theirs to keep.

**Give them a whole world.** Not a card. A place.

**Two nouns, used the site's way.** It is a **gift** when we talk about money,
and a **world** when we talk about the thing itself. Senders **build** a world;
recipients **open** or **step into** one. Never call it an "experience", a
"platform", a "product", or "content" — those words are for other companies.
"Card" and "slideshow" exist only as the thing we're not ("not a card", "not a
slideshow"), and only ever as that contrast.

**Made, not generated.** The worlds are hand-built and the sender fills them
with their own real photos and words. We never say — or imply — that a world was
AI-generated, and we never mention AI, machine generation, or any model by name.
"Made, not generated." is the line; hold it.

**Who it's for.** People giving a gift for a real occasion — a birthday, an
anniversary, a wedding morning, a long-distance "just because". We write in
first-person POV or as the person who made the gift. We never speak as a quoted
stranger or an invented customer.

## 2. Claims & price law

**Prices — exact language only.** Only these three forms may ever appear in a
caption, overlay, or CTA:

| Row | Say exactly |
| --- | --- |
| Price, standard | **$15 per gift** |
| Price, premium | **$45 per gift** |
| Price, custom | **from $250** |

No other figure as a price. No strike-throughs, no "was/now", no fake discounts,
no invented "$40 credit pack" in a post (credit-pack pricing lives on the site,
not in captions). "$250" only ever appears with its "from" prefix.

**Ownership, the way the site says it.** Pay once — there is no subscription.
The gift is **theirs to keep**; once opened, **it stays theirs**. Approved
verbatims: "Pay once. It's theirs forever." / "theirs to keep" / "it stays
theirs".

**Recipient effort — the approved verbatim.** "No app. No account. No download."
There is nothing for the recipient to install; they open a link and they're in.

**⚠️ Claims OFF LIMITS in ads until the product catches up.** These features do
not exist yet, so we never state or imply them:

- **Scheduled / dated delivery.** No "arrives on the day", "schedule it for", or
  "delivers it on the day".
- **A downloadable keepsake copy.** There is no export. Never promise a
  "keepsake copy" or that the world is downloadable. ("No download" is only ever
  used as the negation above.)
- **Recipient replies or reactions.** The recipient cannot reply to, react to,
  or send anything back through the gift.
- **"Forever" as a legal guarantee.** Say "theirs to keep" / "it stays theirs",
  never "guaranteed forever" or "never goes away".
- **Invented proof.** No made-up stats ("10,000 happy customers"), no fake
  testimonials.
- **Fake urgency.** No "limited spots", "only N left", countdowns, or "last
  chance". Real, dated occasions are fine; manufactured scarcity is not.

## 3. Voice

**Sentence case always** — headlines and captions are never Title Cased, and we
never write ALL-CAPS body copy. Write it like you'd text someone you love, then
tidy it. **Contractions always.**

**Exclamation points: never** in body copy or CTAs.

**Specific over clever.** A true-feeling, concrete detail beats a clever line
every time — "he'd rather mine blocks than answer my texts", the burnt pancake,
the "MAYA ONLY" door plate. Never a generic promise ("the perfect gift"), never
a pun. If you use the word "memories", pair it with something concrete; never
ship "preserve your memories forever" as a stand-alone cliché.

**Banned words — verbatim, never use any of these:** unleash, elevate,
seamless, unlock, empower, journey, solution, game-changer, revolutionary,
cutting-edge, unforgettable, "take it to the next level", and the pattern
"Introducing X — the ultimate Y". No rocket or sparkle-emoji spam. These are
banned even as literal in-world mechanics (no "unlock the vault" even in a
mining world) — reword instead.

**Demo names only** (never a real customer): June, Maya, "Mum", "the boys".

## 4. Visual language

The all-caps ban has exactly one carve-out: tiny tracked badges. The only
approved all-caps chips are **MOST LOVED**, **1 OF 1**, **WOW**, and **THE
FOREVERMORE WAY** — and only as a badge, never as a sentence. Everything else on
screen follows the sentence-case voice law in §3.

Feed images are JPEG; reels and stories are 9:16. Overlays stay clear of the
platform UI safe areas (TikTok: bottom 320px, right 140px). Every piece closes
on the coin + getforevermore.co end card.

## 5. Social-specific conventions

- **Hashtags.** TikTok: 3–5 tags, inside the caption, no hashtag wall.
  Instagram: under ~8, emotional line first, tags last.
- **The hook** is the on-screen text in the first 2 seconds and carries the
  whole post: ≤110 characters, a concrete POV or tension the world resolves.
- **CTA.** Coin + getforevermore.co (on TikTok raw-native formats, pin the link
  in a comment instead).
- **Links** carry UTM tags:
  `getforevermore.co?utm_source={platform}&utm_medium=organic&utm_campaign={pillar}&utm_content={item_id}`.
