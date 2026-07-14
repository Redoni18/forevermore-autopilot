# Owner Tasks — Phase 1 setup checklist

One sitting, phone or laptop. Verified against live platform docs on 2026-07-13.

**Total time (sections 1–7, the concrete click-through tasks): ~75 minutes.** Section 8 is ongoing content work, not a one-sitting task.

Do them in this order — 6 is needed first (Phase 1 build is already underway and blocked on it), 1 is the most time-sensitive (unclaimed handles can be taken by anyone), everything else can trail behind.

---

## 1. Claim @getforevermore on Instagram and TikTok

**Why it matters:** both handles are still unclaimed as of this writing. Every day they sit open is a day someone else — a squatter, a fan, a competitor — can take them. This blocks all brand presence and all later API work (the Meta and TikTok apps below both need a real, owned account to attach).

**Steps:**
- [ ] Instagram: open the app (or instagram.com) → search `getforevermore` → confirm it's still unclaimed.
- [ ] Tap **Sign up** → username `getforevermore`. If it's somehow taken by the time you do this, use the closest brand-safe fallback (`getforevermore.gifts`, `get.forevermore`) — do not compromise on spelling.
- [ ] Set profile photo (brand mark), display name "Forevermore", bio + link to getforevermore.com.
- [ ] TikTok: open the app (or tiktok.com) → **Sign up** → username `@getforevermore` (same fallback logic if taken).
- [ ] Set the same profile basics.

**→ hand back:** confirmed handles on both platforms (and the exact username you landed on, if a fallback was needed, so config/copy can be updated to match).

**Est. time:** 10 min

---

## 2. Convert the Instagram account to Professional (Business)

**Why it matters:** the Instagram publishing API (§3) only works against a Professional account — Business or Creator. Personal accounts can't be accessed by any official API at all. Pick **Business**, not Creator — that's what the Meta app setup below expects.

**Steps:**
- [ ] Open Instagram, logged in as `@getforevermore`.
- [ ] Tap your profile picture (bottom right) → your profile.
- [ ] Tap the ☰ menu (top right) → **Settings and activity**.
- [ ] Scroll to **For professionals** → tap **Account type and tools**.
- [ ] Tap **Switch to professional account** → **Continue** through the intro screens.
- [ ] Pick a category (e.g. "Entrepreneur" or "Product/service") → **Done**.
- [ ] When asked Creator vs Business, choose **Business** → **Next**.
- [ ] Confirm/edit the auto-filled contact info → **Next**.
- [ ] "Connect to a Facebook Page" is optional — skip it or connect one, either works for the Instagram Login API flow used below.

**→ hand back:** confirmation the account now shows as Business (not Creator, not Personal). No credential to store here.

**Est. time:** 5 min

Verified against: [Meta Business Help Center — set up a professional account](https://www.facebook.com/business/help/502981923235522)

---

## 3. Create the Meta developer app (self-use Instagram publishing)

**Why it matters:** this is what lets the pipeline post to Instagram programmatically. Kept in Development Mode with only your own account as a tester, this needs **no App Review** — App Review is only required to let *other people's* accounts use the app, which will never happen here.

**Steps:**
- [ ] Go to developers.facebook.com on a desktop browser → log in → become a developer if prompted.
- [ ] **My Apps** → **Create App**.
- [ ] Meta will ask "What do you want your app to do?" (app type picker). Choose **Business** — it's the type meant for apps that manage a business/creator presence, which matches self-use publishing. ("Consumer" and "Other" also exist; Business is correct here.)
- [ ] Name it something like "Forevermore Autopilot Publisher". Attach it to a Business Portfolio if the wizard asks (create one if you don't have one — it's free and just an admin container).
- [ ] In the App Dashboard, find **Add Product** (left sidebar or the Products section on the dashboard home) → add **Instagram**. This surfaces the "Instagram API with Instagram Login" setup — do **not** pick the Facebook-Login variant.
- [ ] Confirm the app-mode toggle at the top of the dashboard reads **Development**. Leave it there — do not switch to Live. Development Mode + your own account as tester is the entire self-use path; there is nothing further to submit.
- [ ] Left sidebar → **Instagram** → **API setup with Instagram Login**.
- [ ] Click **Add an Instagram Account** → log in with `@getforevermore`'s Instagram Business credentials when prompted. In Meta's current flow this single login both grants your account the Instagram Tester role *and* connects it — you shouldn't need a separate invite step.
  - If instead it only creates a pending invite: go to **App Roles → Roles** in the dashboard, confirm `@getforevermore` is listed under **Instagram Testers**, then on Instagram (app or instagram.com) go to your profile → **Settings and activity** → **Apps and websites** → **Tester invites** tab → **Accept**. Come back to the dashboard afterward.
- [ ] Back in the API setup panel, confirm the account now shows as connected, with content-publish permission listed.
- [ ] Click **Generate token** next to the connected account. **Copy it immediately — Meta will not show it again.** This is your long-lived (60-day) token carrying `instagram_business_content_publish` scope.
- [ ] Note the Instagram User ID shown next to the connected account.

**→ hand back:** `META_IG_TOKEN=<token>` and `META_IG_USER_ID=<id>` for `.env`. Also send the App ID and whether the dashboard mentioned a specific expiry date, so the refresh job can be scheduled correctly.

**Est. time:** 20–25 min

**Flag — brief vs. current UI:** the WAVE2 brief describes three distinct steps (add as Instagram Tester via Roles → accept the invite in the IG app → separately request a token). Meta's current dashboard has streamlined this into one "Add an Instagram Account" login inside **API setup with Instagram Login**, which appears to grant the tester role and issue a ready-to-use long-lived token in a single click-through. Functionally the same outcome, fewer manual steps than the brief assumes — not a blocker, just noted so it isn't mistaken for a missed step if the separate Roles/invite screens look empty.

Verified against:
- https://developers.facebook.com/docs/instagram-platform/overview/
- https://developers.facebook.com/docs/instagram-platform/reference/access_token/
- https://developers.facebook.com/docs/instagram-platform/app-review/
- https://developers.facebook.com/docs/development/create-an-app/app-dashboard/app-types/

---

## 4. Create the TikTok developer app

**Why it matters:** this issues the credentials the pipeline needs to talk to TikTok at all — even in Phase 1's inbox-upload (`FILE_UPLOAD`) mode, which needs no audit.

**Steps:**
- [ ] Go to developers.tiktok.com → sign up / log in to create a developer account.
- [ ] Click the profile icon (top right) → **Manage apps**.
- [ ] Click **Connect an app** to register a new one.
- [ ] If asked to "Select the app owner," your individual account is fine — no organization required for self-use → **Confirm**.
- [ ] Fill in **Basic Information**: app icon (1024×1024 px, PNG/JPG), name (e.g. "Forevermore Autopilot"), category, description.
- [ ] Under **Platforms**, add **Web** and enter `getforevermore.com` as the official website URL (required by the form even though you're only using inbox-upload for now).
- [ ] In **Products**, click **Add products** → select **Content Posting API**.
- [ ] Leave the Direct Post / domain-verification settings alone for now — those are only needed to unlock public direct posting later (Phase 3 audit), not for inbox-upload mode.
- [ ] Set up a sandbox: from **Manage apps** → your app → **Create Sandbox** → name it (e.g. `forevermore-dev`).
- [ ] Under that sandbox's **Target Users**, add your own TikTok account (`@getforevermore`) so it can authenticate against the sandbox during dev testing.
- [ ] Copy the **Client key** and **Client secret** from the app's Basic Information / Credentials panel.

**→ hand back:** `TIKTOK_CLIENT_KEY=<key>` and `TIKTOK_CLIENT_SECRET=<secret>` for `.env`.

**Est. time:** 15–20 min

**Current unaudited-client semantics (verified 2026-07-13, matches the brief's design):** an unaudited API client can post for at most 5 distinct users per rolling 24h, and every post it creates lands as `SELF_ONLY` (private draft/inbox), regardless of the account's own privacy setting — the account owner must open the TikTok app and tap publish themselves. This is exactly the inbox-upload + Telegram-nudge flow the brief specifies for v1; no change needed.

Verified against:
- https://developers.tiktok.com/doc/getting-started-create-an-app
- https://developers.tiktok.com/doc/content-posting-api-get-started
- https://developers.tiktok.com/blog/introducing-sandbox

### Later — Phase 3, audit submission (do not do yet)

Only relevant once Phase 3 (publishing) starts and you're ready to unlock direct public posting.

- [ ] Record a screen-capture demo of the full OAuth + post flow. Critical UX requirement: the privacy-level picker must be populated live from `/v2/post/publish/creator_info/query/` and selected by the user — never pre-select or hardcode "Everyone"/`PUBLIC_TO_EVERYONE`, TikTok rejects audits that default it (and the available options differ per account, e.g. private accounts don't get the public option at all).
- [ ] Confirm getforevermore.com has a live Privacy Policy URL and Terms of Service URL — the site's existing legal pages qualify, no new pages needed.
- [ ] From the app's **App review** tab: attach the demo video (up to 5 videos, 50 MB each), paste the privacy policy + ToS URLs, describe the Content Posting API use case → **Submit for review**.
- [ ] Typical turnaround 5–10 business days as of 2026 — re-check TikTok's current stated SLA before submitting, it has moved before.

**→ hand back:** nothing yet. Flag when ready to submit; the brief (§3.6/§4 Phase 3) tracks the actual submission as engineering work, not an owner task.

Verified against: https://developers.tiktok.com/doc/content-sharing-guidelines

---

## 5. Cloudflare R2 (needed by Phase 2/3, not urgent today)

**Why it matters:** publish media (rendered posters/videos) needs to sit at a public URL for Instagram's container flow to fetch from, and R2 also backs the nightly Postgres backup once the VPS (Phase 2) is live. Not blocking Phase 1 — do it whenever convenient before Phase 2 provisioning.

**Steps:**
- [ ] Log into (or create) a Cloudflare account at dash.cloudflare.com.
- [ ] Left sidebar → **Storage & databases** → **R2** → **Overview** → **Create bucket**.
- [ ] Name it `forevermore-autopilot-media` (Location: Automatic is fine) → **Create bucket**.
- [ ] On the R2 Overview page, under **Account details**, click **Manage** next to **API Tokens**.
- [ ] **Create Account API token** (not User token — an account token keeps working even if your personal Cloudflare login changes).
- [ ] Permissions: **Object Read & Write**, scoped to **Apply to specific buckets only** → select `forevermore-autopilot-media`.
- [ ] Leave TTL as **Forever** (or set an expiry if you'd rather rotate manually later) → **Create Account API Token**.
- [ ] Copy the **Access Key ID** and **Secret Access Key** immediately — Cloudflare will not show the secret again.
- [ ] Note your **Account ID** (shown on the R2 Overview page / Account Home right rail) — it's also the subdomain in the S3-compatible endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

**→ hand back:** R2 account id, access key id, secret access key, and the bucket name (`forevermore-autopilot-media`) for `.env`. Mark this "needed by Phase 2/3" — no rush.

**Est. time:** 10 min

Verified against:
- https://developers.cloudflare.com/r2/get-started/
- https://developers.cloudflare.com/r2/api/tokens/

---

## 6. Discord bot (NEEDED FIRST — Phase 1 is built against it)

**Why it matters:** this is the entire point of Phase 1 — a bot that talks to you from your phone. Discord replaced Telegram (2026-07-14) because Telegram signup carries a mandatory SMS-verification fee in this region; Discord signup and its bot API are free everywhere.

**Steps (all free — no Nitro, no payment anywhere):**
- [ ] Create/log into a Discord account (discord.com or the app) — free signup, email-verified.
- [ ] Create your private server: in the Discord app, the **+** button in the server list → **Create My Own** → **For me and my friends** → name it e.g. `Forevermore HQ`. You'll be the only human in it.
- [ ] (Recommended) rename the default `#general` channel to `#autopilot`.
- [ ] Go to **discord.com/developers/applications** → **New Application** → name it `Forevermore Autopilot`.
- [ ] Left sidebar → **Bot**. Click **Reset Token** → copy the token (shown once — this is `DISCORD_BOT_TOKEN`).
- [ ] Same page, scroll to **Privileged Gateway Intents** → toggle **MESSAGE CONTENT INTENT** ON → Save. (Required so the bot can read your commands; free for bots in under 100 servers.)
- [ ] Left sidebar → **OAuth2** → **URL Generator**: check the **bot** scope; under Bot Permissions check **View Channels**, **Send Messages**, **Attach Files**, **Read Message History**. Copy the generated URL, open it in your browser, and invite the bot to your new server.
- [ ] In the Discord app: **User Settings → Advanced → Developer Mode ON**. Then right-click the `#autopilot` channel → **Copy Channel ID** (this is `DISCORD_CHANNEL_ID`), and right-click your own name → **Copy User ID** (this is `DISCORD_OWNER_ID`).

**→ hand back:** `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_OWNER_ID` → put them in `~/.config/autopilot/bot.env` (see RUNBOOK "Discord control channel").

**Est. time:** 10 min

Verified against: https://discord.com/developers/docs (applications + gateway intents)

---

## 7. GitHub: create the private remote

**Why it matters:** right now this repo's only copy is this laptop. One drive failure and everything — code, history, the whole autopilot — is gone. This is a five-minute insurance policy.

**Steps:**
- [ ] Go to github.com/new, logged in as `Redoni18`.
- [ ] Owner: `Redoni18`. Repository name: `forevermore-autopilot`.
- [ ] Visibility: **Private**.
- [ ] Leave **Add a README file**, **Add .gitignore**, and **Choose a license** all unchecked — the repo already has all its history locally; initializing any of these remotely creates a conflicting history that has to be reconciled before the first push.
- [ ] **Create repository**.

**→ hand back:** nothing to copy — just confirm it exists at `github.com/Redoni18/forevermore-autopilot`. Claude will ask before the first push (it's an external service, per the engineering ground rules).

**Est. time:** 5 min

---

## 8. Ongoing: capture more library masters

**Why it matters:** `library/manifest.json` currently has capture masters for only 6 worlds — `blockheart-mine`, `gone-fishing`, `love-letters`, `passport`, `pocket-pal`, `prize-claw`. The showcase-reel video format (HookCard + two-image ShowcaseCard) can only render for a world that has a capture master, so most worlds never get a showcase-style video and silently fall back to a plainer render. This isn't a one-click task — it's a standing reminder to keep feeding the library as new worlds ship.

**Steps (whenever a new world's checkout flow is finalized):**
- [ ] Record a short screen-capture "master" of the real product experience for that world, using the same capture approach as the existing 6 masters.
- [ ] Check `library/manifest.json`'s existing entries first for the expected clip format/duration/resolution before recording, so the new master matches.
- [ ] Drop the new master into `library/` following the existing folder convention — the next tick's showcase-gate logic picks it up automatically.

**→ hand back:** nothing to `.env` — this is content, not credentials.

**Est. time:** ongoing, not counted in the one-sitting total above.
