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
node bin/autopilot.mjs pause     # or, over Discord: /pause
node bin/autopilot.mjs resume    #                   /resume

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

## Discord control channel (WAVE2 Phase 1)

The bot is the owner's phone-side surface: review cards with playable media,
tick summaries, failure/liveness/spend alerts, and inbound steering (`/new`,
`/rule`, `/pause`, freeform notes → suggestion box). It's a *projection of the
DB* — decisions run through the same `decide()`/store paths as the Station.
(Pivoted from Telegram 2026-07-14: Telegram signup carries a mandatory SMS fee
in this region; Discord's bot API is free.)

**Setup (one-time):** follow docs/OWNER_TASKS.md §6 (developer-portal app →
bot token + MESSAGE CONTENT intent → invite to your private server → copy
channel + user ids). Then create `~/.config/autopilot/bot.env` (chmod 600):
```
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=...
DISCORD_OWNER_ID=...
```
`make install-bot` (launchd, KeepAlive) — or `make bot` in the foreground to
test. Log: `logs/launchd-bot.log`.

**Runtime knobs (settings KV, editable live):**
- `/pause` · `/resume` → `kill_switch`.
- Quiet hours: `store.setSetting('quiet_hours', {start:'23:00', end:'08:00'})`
  (config default). Non-critical messages are held during the window and flush
  after; critical alerts (failure, escalation, spend cap, liveness) bypass it.
- Spend cap: `store.setSetting('daily_spend_cap_usd', 5)` (config default $5).

**Only one daemon per box.** It holds `state/bot.lock`; a second refuses.
Running the Mac and (Phase 2) the VPS daemons at once is safe at the Discord
level (gateway allows multiple sessions) but would double-send cards — the
ledger dedup prevents true duplicates, yet kill the Mac daemon
(`make uninstall-bot`) before the VPS takes over anyway.

**If the bot goes silent:** check `logs/launchd-bot.log`; confirm the env file
exists (launchd runs a login shell); a liveness alert fires if the *tick*
stalls; if the bot process itself died, launchd `KeepAlive` restarts it — look
for a crash loop in the log. Silent `CLAUDE_CODE_OAUTH_TOKEN` death is covered
by the liveness alert.

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

## VPS operations (WAVE2 Phase 2, §3.8)

Production home: one Hetzner CPX31 (Ubuntu 24.04, TZ Europe/Tirane), repo at
`/opt/autopilot`, env in `/etc/autopilot/autopilot.env` (0640 root:autopilot),
platform clone (read-only, ADR-001) at `/opt/forevermore`. Provisioning from
zero: `docs/OWNER_TASKS.md` §9 (server + hardening) and §10 (tunnel + Access).

### Services (systemd — units in ops/systemd/)

```bash
systemctl status autopilot-bot autopilot-station          # daemons
systemctl list-timers 'autopilot-*'                       # tick + backup
journalctl -u autopilot-tick -n 100 --no-pager            # last tick output
journalctl -u autopilot-bot -f                            # follow the bot
sudo systemctl restart autopilot-bot                      # after env changes
# per-run .jsonl logs still land in /opt/autopilot/logs/ exactly as on the Mac
```

Force one tick now: `sudo systemctl start autopilot-tick.service`
(or `/tick` in Discord).

### Env & token refresh on the box

All env lives in `/etc/autopilot/autopilot.env`. After edits:
`sudo systemctl restart autopilot-bot autopilot-station` (the tick picks env
up on its next run). `CLAUDE_CODE_OAUTH_TOKEN` (~1 year): SSH in as
`autopilot`, run `claude setup-token` (NEVER `--bare`), paste the new token
into the env file, restart nothing (the tick spawns `claude` fresh each run).

### Backups (nightly 03:30 → R2)

```bash
make backup-now       # manual dump + outbox/library sync (ops/vps/backup.sh)
make restore-drill    # newest R2 dump → scratch container → row-count check
bash ops/vps/restore.sh pg/autopilot-YYYYMMDD-HHMMSS.sql.gz   # specific dump
```

The drill NEVER touches live data. Promoting a restore to live (disaster
only): stop timers + daemons, `docker compose down && docker volume rm
forevermore-autopilot_autopilot-pgdata`, `docker compose up -d`,
`node db/apply.mjs`, then `gunzip -c dump.sql.gz | docker exec -i
autopilot-local-db psql -U postgres -d autopilot`, restart services.

### Cutover checklist (Mac → VPS, one sitting)

1. Mac: `launchctl unload ~/Library/LaunchAgents/co.getforevermore.autopilot.tick.plist`; wait until `state/tick.lock` is gone.
2. Final sync from the Mac:
   `docker exec autopilot-local-db pg_dump -U postgres --no-owner -x autopilot | gzip | ssh autopilot@VPS "gunzip | docker exec -i autopilot-local-db psql -U postgres -d autopilot"`
   (fresh DB on the VPS: `db-fresh` first), then
   `rsync -az outbox/ autopilot@VPS:/opt/autopilot/outbox/ && rsync -az library/ autopilot@VPS:/opt/autopilot/library/`
3. Mac: `make uninstall-bot` — never two gateways.
4. VPS: `sudo systemctl enable --now autopilot-bot autopilot-station autopilot-tick.timer autopilot-backup.timer`
5. Phone: `/status` answers; Station loads at the Access URL; `/tick` completes a full sweep.
6. Drills: stop `autopilot-tick.timer` >90 min → liveness alert → restart; `make backup-now` + `make restore-drill`.
7. Mac: `make uninstall-launchd` — the Mac is dev-only from here.
8. `/resume` in Discord when ready for the first unattended VPS tick.

---

## Switching runner: Mac → GitHub Actions

> **SUPERSEDED (2026-07-14):** WAVE2 §3.8 chose a Hetzner VPS instead — see
> "VPS operations" above. Kept for reference; do not wire the GHA scheduler.

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
