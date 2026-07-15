#!/usr/bin/env bash
# Nightly backup (AP-848): pg_dump (gzipped) + incremental outbox/ + library/
# sync to Cloudflare R2, with 14-day dump retention. Also runnable by hand:
#
#   bash ops/vps/backup.sh                 # dump + sync to R2 (needs R2_* env)
#   bash ops/vps/backup.sh --local DIR     # dump into DIR, skip R2 entirely
#                                          # (used by the Mac-side drill test)
#
# R2 auth is pure env (no rclone.conf): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
# R2_SECRET_ACCESS_KEY, R2_BUCKET — see .env.example. pg_dump runs INSIDE the
# DB container (same trick as db/apply.mjs), so no local pg client is needed.
set -euo pipefail

CONTAINER="${AUTOPILOT_DB_CONTAINER:-autopilot-local-db}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="autopilot-${STAMP}.sql.gz"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

LOCAL_DIR=""
if [[ "${1:-}" == "--local" ]]; then
  LOCAL_DIR="${2:?--local needs a directory}"
  mkdir -p "$LOCAL_DIR"
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "backup: dumping ${CONTAINER}:autopilot → ${DUMP}"
# --no-owner/-x: owners + grants are environment concerns (db/apply.mjs's
# migrations re-establish them); backups carry schema + data only, so a
# restore into a fresh container is silent.
docker exec "$CONTAINER" pg_dump -U postgres --no-owner -x autopilot | gzip > "${workdir}/${DUMP}"
gzip -t "${workdir}/${DUMP}"
echo "backup: dump ok ($(du -h "${workdir}/${DUMP}" | cut -f1))"

if [[ -n "$LOCAL_DIR" ]]; then
  cp "${workdir}/${DUMP}" "${LOCAL_DIR}/${DUMP}"
  echo "backup: local mode — wrote ${LOCAL_DIR}/${DUMP}, skipping R2"
  exit 0
fi

: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"
: "${R2_BUCKET:?R2_BUCKET required}"

# rclone remote "r2" defined entirely via env — nothing written to disk.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
# Bucket-scoped R2 tokens cannot HeadBucket/CreateBucket — skip the check
# or every operation 403s (rclone S3 quirk, verified live 2026-07-15).
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

rclone copyto "${workdir}/${DUMP}" "r2:${R2_BUCKET}/pg/${DUMP}"
echo "backup: uploaded pg/${DUMP}"

rclone delete --min-age "${RETENTION_DAYS}d" "r2:${R2_BUCKET}/pg/" || true
echo "backup: pruned dumps older than ${RETENTION_DAYS}d"

# Media/data dirs: incremental sync (cheap after the first run). outbox is the
# render archive; library is the capture masters — both irreplaceable.
for dir in outbox library; do
  if [[ -d "$dir" ]]; then
    rclone sync "$dir" "r2:${R2_BUCKET}/${dir}" --exclude "*.lock"
    echo "backup: synced ${dir}/"
  fi
done

echo "backup: done"
