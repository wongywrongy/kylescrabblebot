#!/usr/bin/env bash
# Keep ramsay seated for a tournament: the runner exits on disconnect, so restart it until it stops on its own.
# Usage: ./tournament.sh <TOURNAMENT_ID>
set -u
cd "$(dirname "$0")"
[ $# -eq 1 ] || { echo "usage: $0 <TOURNAMENT_ID>" >&2; exit 2; }
export BOT_NAME="${BOT_NAME:-ramsay}" TOURNAMENT_ID="$1" VERSION="${VERSION:-tournament-$1}"
export STRATEGY=trained-market WORD_STRATEGY=hold7 MAX_MATCHES=0 TARGET_RANK=0
log="runs/tournament-$1.log"
while :; do
  echo "$(date -u +%FT%TZ) starting" >> "$log"
  npm start >> "$log" 2>&1; rc=$?
  [ $rc -eq 0 ] && { echo "$(date -u +%FT%TZ) runner stopped cleanly" >> "$log"; break; }
  echo "$(date -u +%FT%TZ) runner exited $rc, restarting in 5s" >> "$log"
  sleep 5
done
