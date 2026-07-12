.PHONY: plan generate digest publish metrics reflect doctor review ls install-launchd uninstall-launchd logs db-up db-apply db-fresh station

# Autopilot task runners (thin wrappers over bin/autopilot.mjs)

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
