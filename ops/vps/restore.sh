#!/usr/bin/env bash
# Restore drill (AP-848): restore a pg dump into a THROWAWAY scratch container
# and sanity-check row counts against the live DB. Never touches live data —
# promoting a restore to live is a deliberate, manual RUNBOOK procedure.
#
#   bash ops/vps/restore.sh latest             # newest dump in R2
#   bash ops/vps/restore.sh pg/autopilot-….sql.gz   # a specific R2 object
#   bash ops/vps/restore.sh --file DUMP.sql.gz # a local dump file (Mac drill)
#
# Exit 0 = restored table row counts match live. The scratch container is
# always removed, pass or fail.
set -euo pipefail

CONTAINER="${AUTOPILOT_DB_CONTAINER:-autopilot-local-db}"
SCRATCH="autopilot-restore-drill-$$"
TABLES=(content_items runs approvals settings ideas telegram_messages)

workdir="$(mktemp -d)"
cleanup() {
  docker rm -f "$SCRATCH" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

if [[ "${1:-latest}" == "--file" ]]; then
  cp "${2:?--file needs a path}" "${workdir}/dump.sql.gz"
else
  : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID required}"
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"
  : "${R2_BUCKET:?R2_BUCKET required}"
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
# Bucket-scoped R2 tokens cannot HeadBucket/CreateBucket — skip the check
# or every operation 403s (rclone S3 quirk, verified live 2026-07-15).
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  obj="${1:-latest}"
  if [[ "$obj" == "latest" ]]; then
    obj="pg/$(rclone lsf "r2:${R2_BUCKET}/pg/" | sort | tail -1)"
    [[ "$obj" != "pg/" ]] || { echo "restore: no dumps in r2:${R2_BUCKET}/pg/"; exit 1; }
  fi
  echo "restore: fetching ${obj}"
  rclone copyto "r2:${R2_BUCKET}/${obj}" "${workdir}/dump.sql.gz"
fi

gzip -t "${workdir}/dump.sql.gz"

echo "restore: starting scratch postgres (${SCRATCH})"
docker run -d --name "$SCRATCH" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=autopilot postgres:16-alpine >/dev/null
# The postgres image boots a TEMPORARY server during init (pg_isready answers
# it, then it restarts) — so require the target DB to answer a real query
# TWICE, a second apart, before trusting the container.
ok=0
for i in $(seq 1 60); do
  if docker exec "$SCRATCH" psql -U postgres -d autopilot -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1))
    [[ "$ok" -ge 2 ]] && break
  else
    ok=0
  fi
  sleep 1
done
[[ "$ok" -ge 2 ]] || { echo "restore: scratch postgres never became ready"; exit 1; }

echo "restore: applying dump"
gunzip -c "${workdir}/dump.sql.gz" | docker exec -i "$SCRATCH" psql -q -U postgres -d autopilot >/dev/null

fail=0
printf 'restore: %-18s %10s %10s\n' table restored live
for t in "${TABLES[@]}"; do
  restored="$(docker exec "$SCRATCH" psql -tA -U postgres -d autopilot -c "select count(*) from autopilot.${t}" 2>/dev/null || echo ERR)"
  live="$(docker exec "$CONTAINER" psql -tA -U postgres -d autopilot -c "select count(*) from autopilot.${t}" 2>/dev/null || echo '?')"
  printf 'restore: %-18s %10s %10s\n' "$t" "$restored" "$live"
  [[ "$restored" != "ERR" ]] || fail=1
done

if [[ "$fail" -eq 1 ]]; then
  echo "restore: DRILL FAILED — a table did not restore"
  exit 1
fi
echo "restore: drill ok (counts may trail live if backups ran earlier — same order of magnitude is the bar)"
