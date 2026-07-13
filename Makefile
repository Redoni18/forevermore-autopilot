.PHONY: tick plan generate digest publish metrics reflect doctor review ls install-launchd install-tick uninstall-launchd logs db-up db-apply db-fresh station

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
