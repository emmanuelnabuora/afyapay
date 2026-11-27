#!/usr/bin/env bash
# Backup and restore drill (E10). Dumps SOURCE_URL, restores it into an EMPTY
# scratch database at TARGET_URL, then proves the copy is whole: same tables,
# same row counts, the append-only triggers are back, and the migration
# history matches. Times each step and prints a summary to paste into
# docs/pilot-readiness/restore-drill.md.
#
#   SOURCE_URL=postgres://...afyapay_dev TARGET_URL=postgres://...afyapay_restore_drill scripts/restore-drill.sh
#
# Never point TARGET_URL at a database you care about: the drill refuses a
# target that already has tables. It refuses non-local hosts unless
# ALLOW_REMOTE=1, which the staging drill on Render needs (synthetic data only).
set -euo pipefail

: "${SOURCE_URL:?set SOURCE_URL}"
: "${TARGET_URL:?set TARGET_URL}"
if [[ "${ALLOW_REMOTE:-0}" != 1 ]]; then
  for url in "$SOURCE_URL" "$TARGET_URL"; do
    [[ "$url" =~ @(localhost|127\.0\.0\.1)[:/] ]] || { echo "Refusing non-local database (set ALLOW_REMOTE=1 for staging)." >&2; exit 1; }
  done
fi
[[ "$SOURCE_URL" != "$TARGET_URL" ]] || { echo "Source and target must differ." >&2; exit 1; }

DUMP="$(mktemp -d)/afyapay.dump"
now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", b - a }'; }
q() { psql "$1" -X -At -v ON_ERROR_STOP=1 -c "$2"; }

existing=$(q "$TARGET_URL" "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")
[[ "$existing" == 0 ]] || { echo "Target already has $existing tables. Use an empty scratch database." >&2; exit 1; }

COUNTS="select table_schema||'.'||table_name from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema') order by 1"
row_counts() {
  local url=$1
  for t in $(q "$url" "$COUNTS"); do echo "$t $(q "$url" "select count(*) from $t")"; done
}

t0=$(now)
pg_dump "$SOURCE_URL" --format=custom --no-owner --no-privileges --file="$DUMP"
t1=$(now)
pg_restore --dbname="$TARGET_URL" --no-owner --no-privileges --exit-on-error "$DUMP"
t2=$(now)

src_counts=$(row_counts "$SOURCE_URL")
dst_counts=$(row_counts "$TARGET_URL")
src_trg=$(q "$SOURCE_URL" "select count(*) from pg_trigger where not tgisinternal")
dst_trg=$(q "$TARGET_URL" "select count(*) from pg_trigger where not tgisinternal")
t3=$(now)

tables=$(echo "$src_counts" | wc -l)
rows=$(echo "$src_counts" | awk '{ s += $2 } END { print s }')
ok=yes
if [[ "$src_counts" != "$dst_counts" ]]; then ok=no; diff <(echo "$src_counts") <(echo "$dst_counts") || true; fi
[[ "$src_trg" == "$dst_trg" ]] || { ok=no; echo "Triggers differ: source $src_trg, restored $dst_trg"; }

# The ledger must still refuse updates after a restore (append-only is in the database).
ledger_table=$(q "$TARGET_URL" "select table_schema||'.'||table_name from information_schema.tables where table_schema='ledger' and table_type='BASE TABLE' order by 1 limit 1")
if [[ -n "$ledger_table" ]]; then
  if psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 -c "begin; delete from $ledger_table; rollback;" >/dev/null 2>&1; then
    ok=no; echo "Append-only check FAILED: delete on $ledger_table was allowed after restore."
  else
    echo "Append-only check passed: delete on $ledger_table is refused after restore."
  fi
fi

cat <<EOF

Restore drill summary
  dump size        $(du -h "$DUMP" | cut -f1)
  tables           $tables
  rows             $rows
  triggers         $dst_trg of $src_trg
  dump time        $(secs "$t0" "$t1") s
  restore time     $(secs "$t1" "$t2") s
  verify time      $(secs "$t2" "$t3") s
  total            $(secs "$t0" "$t3") s
  result           $([[ $ok == yes ]] && echo "PASS: restored copy matches source" || echo "FAIL")
EOF
rm -rf "$(dirname "$DUMP")"
[[ $ok == yes ]]
