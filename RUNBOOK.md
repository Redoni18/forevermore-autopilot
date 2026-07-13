# Autopilot Runbook

Operational guide for the standalone Forevermore Autopilot system. All procedures assume you're in the repo root
(`/Users/redonemini/Desktop/Code/Personal/forevermore-autopilot`). See `docs/ADR-001-standalone.md` for architecture.

## Quick reference

- **Status:** `make doctor` or `node bin/autopilot.mjs doctor`
- **Database:** `make db-up` (start), `make db-apply` (migrate)
- **Tail logs:** `make logs`
- **Sweep everything now:** `make tick` — plan today + redraft/render/QA every
  slot date carrying in-flight work + digest. This is the loop behind the
  station's "Request changes": the launchd agent (`make install-tick`,
  `co.getforevermore.autopilot.tick`, every 30 min + at load) runs exactly this,
  so redrafts come back to the review feed unattended. Overlap-safe (pid
  lockfile under `state/`), kill-switch aware.
- **Trigger one stage manually:** `make generate` (or plan/digest/publish/metrics/reflect)
- **Review UI:** `make station` → http://127.0.0.1:4600
- **Emergency pause:** Edit `.env` set `KILL_SWITCH=true`, or see [Kill switch](#kill-switch) below

---

## Kill switch

Halts all scheduled stages within one cron tick (typically <1 minute).

### Mac (launchd)

```bash
# Option 1: the kill switch (halts every stage within one tick, survives restarts)
node bin/autopilot.mjs pause     # or, over Telegram: /pause
node bin/autopilot.mjs resume    #                    /resume

# Option 1b: env-forced pause (belt-and-braces) — the code reads AUTOPILOT_KILL_SWITCH,
# NOT KILL_SWITCH. Set it in the daemon's process env.
export AUTOPILOT_KILL_SWITCH=true

# Option 2: Unload plists (immediate, survives restarts)
launchctl unload ~/Library/LaunchAgents/co.getforevermore.autopilot.*.plist

# To resume
launchctl load ~/Library/LaunchAgents/co.getforevermore.autopilot.*.plist
```

### GitHub Actions

```bash
# Disable scheduled workflows via repo settings (Settings → Actions → Disable all workflows)
# Or trigger workflow_dispatch manually once only, then re-enable
```

---

## Mac asleep — missed run recovery

If the Mac was asleep during a scheduled run, launchd skips it (no catch-up). Recover manually:

```bash
# Check what was missed (view logs)
make logs

# Manually trigger the missed stage
make generate                              # or plan/digest/publish/metrics/reflect

# To force-wake a specific launchd job without waiting for schedule:
launchctl kickstart -p system/co.getforevermore.autopilot.generate
```

---

## Database management

Autopilot has its own Postgres database (never shared with the platform).

### Docker Compose startup

```bash
make db-up                    # Start the container (docker compose up -d)
make db-apply                 # Apply migrations
make db-fresh                 # Wipe and re-apply migrations (destructive)
```

**Connection:**
- Default: `postgres://postgres:autopilot@127.0.0.1:5433/autopilot`
- Override via `AUTOPILOT_DB_URL` in `.env`

### Connection issues

**"connection refused on port 5433"**
```bash
docker ps | grep autopilot              # Check if container is running
make db-up                              # Start it
```

**"column X does not exist"**
```bash
make db-apply                           # Re-apply schema
# If still broken, check docker logs:
docker compose logs autopilot-db
```

---

## Token refresh & expiry alerts

### Instagram (Meta Graph API)

Token type: long-lived user token (~60 days) or system-user token (non-expiring).

**Refresh procedure (ticket AP-701):**
- User token: re-run Meta app OAuth flow → update `META_IG_TOKEN`
- System-user token: no refresh needed (preferred for M1+)

**Check expiry:**
```bash
make doctor                        # Shows IG token status
```

**If expired:** digest and publish stages fail with 400 errors. Update `.env` `META_IG_TOKEN` and re-run.

### TikTok (Content API)

Token type: OAuth refresh token (stored in `.env`).

**Refresh procedure (ticket AP-702):**
- System auto-refreshes on each publish run
- If refresh fails (invalid secret), re-run OAuth flow in AP-702 docs → update `TIKTOK_REFRESH_TOKEN`

**Check validity:**
```bash
make doctor                        # Shows TikTok token status
```

### Resend (email delivery)

API key has no expiry; check quota via Resend dashboard.

**If digest emails fail:** Verify `RESEND_API_KEY` in `.env` and check account status at https://resend.com.

---

## Telegram control channel (WAVE2 Phase 1)

The bot is the owner's phone-side surface: review cards with playable media,
tick summaries, failure/liveness/spend alerts, and inbound steering (`/new`,
`/rule`, `/pause`, freeform notes → suggestion box). It's a *projection of the
DB* — decisions run through the same `decide()`/store paths as the Station.

**Setup (one-time):**
1. `@BotFather` → `/newbot` → copy the token.
2. Message the new bot once; it echoes your numeric chat id (or use `@userinfobot`).
3. Put the secrets where the daemon can read them (they are NOT in the committed
   plist). On the Mac, create `~/.config/autopilot/telegram.env` (chmod 600):
   ```
   TELEGRAM_ENABLED=true
   TELEGRAM_BOT_TOKEN=123456:AA...
   TELEGRAM_CHAT_ID=900900900
   ```
4. `make install-telegram` (launchd, KeepAlive) — or `make telegram` in the
   foreground to test. Log: `logs/launchd-telegram.log`.

**Runtime knobs (settings KV, editable live):**
- `/pause` · `/resume` → `kill_switch`.
- Quiet hours: `store.setSetting('quiet_hours', {start:'23:00', end:'08:00'})`
  (config default). Non-critical messages are held during the window and flush
  after; critical alerts (failure, escalation, spend cap, liveness) bypass it.
- Spend cap: `store.setSetting('daily_spend_cap_usd', 5)` (config default $5).

**Only one poller per bot token.** The daemon holds `state/telegram.lock`; a
second poller on the same box refuses. Running the Mac and (Phase 2) the VPS at
once triggers a Telegram 409 alert — that's the cutover guard, not a bug. Kill
the Mac daemon (`make uninstall-telegram`) before the VPS takes over.

**If the bot goes silent:** check `logs/launchd-telegram.log`; confirm the token
env is present (`launchctl` runs a login shell); a liveness alert should fire if
the *tick* stalls, but if the bot process itself died, launchd `KeepAlive`
restarts it — look for a crash loop in the log. The OAuth token for the brain
(`CLAUDE_CODE_OAUTH_TOKEN`) dying silently is covered by the liveness alert.

---

## Stuck item unlock

An item stuck in `drafting` or `rendering` status (crashed mid-stage) blocks its slot. Unlock:

### File-mode (M0)

```bash
# Find the stuck item
ls -la outbox/

# Check its status
cat outbox/<item-id>/item.json | grep status

# Remove the lock file (if present)
rm -f outbox/<item-id>/.lock

# Re-trigger the stuck stage
make generate                              # Retries the item
```

### Supabase (M1+)

```bash
# Query the item status
pnpm supabase query "SELECT id, status FROM autopilot.content_items WHERE status='rendering' LIMIT 5;"

# Update status back to 'drafted' to retry
# (requires service-role key; use Supabase Studio UI if unsure)
```

---

## Switching runner: Mac → GitHub Actions

The system ships with launchd (M0–M1 default). To migrate to GitHub Actions:

### Prerequisites

1. **Repository secrets** (Settings → Secrets and variables → Actions):
   - `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `META_IG_TOKEN`, `TIKTOK_*`, `RESEND_API_KEY`, `AP_HMAC_SECRET`

2. **Disable launchd:**
   ```bash
   launchctl unload ~/Library/LaunchAgents/co.getforevermore.autopilot.*.plist
   ```

3. **Deploy workflow:**
   - Copy `ops/github/autopilot.yml` → `.github/workflows/autopilot.yml`
   - Commit and push
   - Verify workflow is enabled (Settings → Actions → All workflows)

### Verification

- GHA workflows trigger on schedule (check Actions tab)
- Jobs run ubuntu-latest; logs available per run
- First publish stage: check email digest arrives; verify IG/TikTok drafts present

### Fallback to Mac

If GHA has issues, re-enable launchd:
```bash
launchctl load ~/Library/LaunchAgents/co.getforevermore.autopilot.*.plist
```

---

## Log locations

### Mac (launchd)

```
logs/launchd-<stage>.log   # Per-stage logs (append-mode)
logs/<YYYYMMDD>_<stage>.jsonl  # Structured run logs (if enabled)
```

**Tail in real time:**
```bash
make logs
```

### GitHub Actions

- All logs in repo's Actions tab (workflow runs)
- Downloadable as ZIP per run
- Mirrored to Supabase Storage (M1+) for archival

---

## Health check — `make doctor`

Runs diagnostic queries to verify system readiness:

```bash
make doctor
```

**Checks:**
- Chrome/Brave installed and reachable
- Remotion CLI (`npx remotion --version`)
- `claude` CLI installed and authenticated (if using claude-cli driver)
- Supabase connection + permissions (M1)
- Instagram token valid + account accessible
- TikTok token valid + refresh works
- Resend API key active
- Outbox/logs directories writable
- `.env` file present and parseable

**Output:** Green (✓) or red (✗) per check; errors include remediation hints.

---

## Troubleshooting

### "stage failed: Chrome not found"

Autopilot uses headless Chrome (Brave on mac). Install:
```bash
brew install brave-browser

# Or set explicit path in .env:
echo "CHROME_PATH=/Applications/Brave\ Browser.app/Contents/MacOS/Brave\ Browser" >> .env
```

### "generation produced invalid JSON"

Brain output schema mismatch (usually transient). Check logs:
```bash
tail -50 logs/launchd-generate.log
```

If persistent, file ticket with log excerpt.

### "IG media creation timeout (120s)"

Large video files or network issues. Retry manually; if consistent, check:
- Video file size <1 GB (IG limit)
- Network throughput to supabase storage
- IG API rate limits (100 posts/24h)

### "TikTok inbox video upload stalled"

Common after token rotation. Verify:
```bash
make doctor     # Check TikTok token status
```

If token is invalid, re-run token setup (AP-702) and update `.env`.

---

## Migration & rollback

### Schema rollback (if DB push had issues)

Requires owner approval (D-4 decision). See `supabase/migrations/` for rollback instructions.

### GHA cron drift (stuck/late stages)

GitHub's cron can have ±5min drift. If critical:
1. Trigger manually via workflow_dispatch (Actions tab → Run workflow)
2. File GitHub issue if >1 incident/week

---

## Platform link broken

Autopilot connects to the Forevermore platform checkout via `FOREVERMORE_ROOT` to read the marketing kit and template catalog.

**Error: "ideas.json not found" or similar path errors**

1. Check `FOREVERMORE_ROOT` is set correctly:
   ```bash
   echo $FOREVERMORE_ROOT
   # Should be: ../forevermore (relative) or /full/path/to/forevermore (absolute)
   ```

2. Verify the platform repo exists at that path:
   ```bash
   ls -la $FOREVERMORE_ROOT/marketing/02-idea-database/
   ```

3. If missing, update `.env`:
   ```bash
   echo "FOREVERMORE_ROOT=/path/to/forevermore" >> .env
   ```

4. Run `make doctor` to verify the link:
   ```bash
   make doctor       # Shows platform connection status
   ```

---

## Contacts

- **Owner:** see `CLAUDE.md` `userEmail` (redonemini18@gmail.com)
- **Docs:** `docs/PRD.md` (normative), `docs/TICKETS.md` (breakdown), `docs/ADR-001-standalone.md` (architecture)
- **Issues:** file under Epic H (Hardening) or open an issue in the repo
