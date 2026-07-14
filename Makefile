.PHONY: tick plan generate digest publish metrics reflect doctor render-proof review ls install-launchd install-tick uninstall-launchd logs db-up db-apply db-fresh station bot install-bot uninstall-bot install-systemd uninstall-systemd backup-now restore-drill

# Autopilot task runners (thin wrappers over bin/autopilot.mjs)

# The employee's heartbeat: plan today + sweep ALL in-flight work (redrafts,
# renders, QA) across every slot date + digest. launchd runs this every 30m.
tick:
	node bin/autopilot.mjs tick

plan:
	node bin/autopilot.mjs run plan

generate:
	node bin/autopilot.mjs run generate

digest:
	node bin/autopilot.mjs run digest

publish:
	node bin/autopilot.mjs run publish

metrics:
	node bin/autopilot.mjs run metrics

reflect:
	node bin/autopilot.mjs run reflect

doctor:
	node bin/autopilot.mjs doctor

# §3.9 render-parity proof: re-renders one real poster + one real video item
# from kit/ into a temp dir and lints both. Run before/after any render-env
# change (VPS: AUTOPILOT_REMOTION_GL=swangle).
render-proof:
	node bin/render-proof.mjs

review:
	node bin/autopilot.mjs review

ls:
	node bin/autopilot.mjs ls

# launchd management

# Install ONLY the tick heartbeat (recommended): it subsumes plan/generate/
# render/qa/digest and stays quiet when the queue is empty. install-launchd
# also loads plists for stages that don't exist yet (metrics/publish/reflect)
# which log daily failures — avoid until wave 2 ships them.
install-tick:
	cp ops/launchd/co.getforevermore.autopilot.tick.plist ~/Library/LaunchAgents/
	launchctl unload ~/Library/LaunchAgents/co.getforevermore.autopilot.tick.plist 2>/dev/null || true
	launchctl load ~/Library/LaunchAgents/co.getforevermore.autopilot.tick.plist
	@echo "✓ tick agent loaded — fires every 30 minutes + at load; log: logs/launchd-tick.log"

install-launchd:
	@echo "Installing launchd plists..."
	cp ops/launchd/*.plist ~/Library/LaunchAgents/
	@for plist in ~/Library/LaunchAgents/co.getforevermore.autopilot.*.plist; do \
		launchctl load "$$plist" 2>/dev/null && echo "✓ Loaded $$plist" || echo "✗ Failed to load $$plist"; \
	done

uninstall-launchd:
	@echo "Uninstalling launchd plists..."
	@for plist in ~/Library/LaunchAgents/co.getforevermore.autopilot.*.plist; do \
		if [ -f "$$plist" ]; then \
			launchctl unload "$$plist" 2>/dev/null && echo "✓ Unloaded $$plist" || echo "✗ Failed to unload $$plist"; \
			rm "$$plist"; \
		fi; \
	done

# Logging & inspection

logs:
	@echo "=== Recent autopilot logs ==="
	@for log in logs/launchd-*.log; do \
		if [ -f "$$log" ]; then \
			echo ""; \
			echo "--- $$log (last 20 lines) ---"; \
			tail -20 "$$log"; \
		fi; \
	done

# Database management (standalone: Autopilot's own Postgres)

db-up:
	docker compose up -d

db-apply:
	node db/apply.mjs

db-fresh:
	node db/apply.mjs --fresh

station:
	node review/server.mjs

# Discord control channel (WAVE2 Phase 1, pivoted from Telegram). Needs
# DISCORD_ENABLED=true + DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID +
# DISCORD_OWNER_ID in the process env.
bot:
	node bin/autopilot.mjs bot

install-bot:
	cp ops/launchd/co.getforevermore.autopilot.bot.plist ~/Library/LaunchAgents/
	launchctl unload ~/Library/LaunchAgents/co.getforevermore.autopilot.bot.plist 2>/dev/null || true
	launchctl load ~/Library/LaunchAgents/co.getforevermore.autopilot.bot.plist
	@echo "✓ bot daemon loaded (KeepAlive) — log: logs/launchd-bot.log"
	@echo "  the plist reads DISCORD_* from ~/.config/autopilot/bot.env — create it first"

uninstall-bot:
	launchctl unload ~/Library/LaunchAgents/co.getforevermore.autopilot.bot.plist 2>/dev/null || true
	rm -f ~/Library/LaunchAgents/co.getforevermore.autopilot.bot.plist
	@echo "✓ bot daemon unloaded"

# ── VPS (systemd) ─────────────────────────────────────────────────────────
# Install copies units only; enabling is a deliberate cutover step (RUNBOOK).

install-systemd:
	@[ "$$(uname)" = "Linux" ] || { echo "install-systemd targets the VPS (Linux)"; exit 1; }
	sudo cp ops/systemd/autopilot-*.service ops/systemd/autopilot-*.timer /etc/systemd/system/
	sudo systemctl daemon-reload
	@echo "✓ units installed — at cutover: sudo systemctl enable --now autopilot-bot autopilot-station autopilot-tick.timer autopilot-backup.timer"

uninstall-systemd:
	@[ "$$(uname)" = "Linux" ] || { echo "uninstall-systemd targets the VPS (Linux)"; exit 1; }
	sudo systemctl disable --now autopilot-bot autopilot-station autopilot-tick.timer autopilot-backup.timer 2>/dev/null || true
	sudo rm -f /etc/systemd/system/autopilot-*.service /etc/systemd/system/autopilot-*.timer
	sudo systemctl daemon-reload
	@echo "✓ units removed"

backup-now:
	bash ops/vps/backup.sh

restore-drill:
	bash ops/vps/restore.sh latest
