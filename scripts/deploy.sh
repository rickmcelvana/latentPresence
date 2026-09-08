#!/bin/sh
set -eu

# Deploy latentpresence.com and app.latentpresence.com to the server.
# Safe by default: rsync --dry-run unless called with --live.
# No host, user or path is committed; they come from the environment or .env.

# Everything below is relative to the repository root, so the script does the same
# thing wherever it is called from. Without this, running it from another directory
# would quietly sync whatever `site/` happened to be next to the caller.
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  # shellcheck disable=SC1091
  . ./.env
fi

missing=""
[ -n "${DEPLOY_HOST:-}" ] || missing="$missing DEPLOY_HOST"
[ -n "${DEPLOY_SITE_PATH:-}" ] || missing="$missing DEPLOY_SITE_PATH"
[ -n "${DEPLOY_APP_PATH:-}" ] || missing="$missing DEPLOY_APP_PATH"

if [ -n "$missing" ]; then
  echo "Error: not set:$missing" >&2
  echo "Export them, or add them to .env (see .env.example)." >&2
  exit 1
fi

live="no"
if [ "${1:-}" = "--live" ] || [ "${1:-}" = "--no-dry-run" ]; then
  live="yes"
fi

site_source="site/"
app_source="apps/web/dist/"

# rsync --delete against a missing source empties the live directory, so neither
# side is allowed to be absent. Written as if/fi rather than `[ ... ] && echo`,
# which returns non-zero when false and would exit here through `set -e` instead
# of through the line that means to.
if [ ! -d "$site_source" ]; then
  echo "Error: $site_source does not exist." >&2
  exit 1
fi

if [ ! -d "$app_source" ]; then
  echo "Error: $app_source does not exist. Run 'pnpm build' first." >&2
  exit 1
fi

# Built as positional parameters rather than a string, so every argument stays
# quoted. An unquoted "$flags" would be one empty argument when it is empty, which
# rsync reads as an empty path.
set -- -av --delete
[ "$live" = "yes" ] || set -- "$@" --dry-run

echo "Deploying:"
echo "  $site_source -> $DEPLOY_HOST:$DEPLOY_SITE_PATH"
echo "  $app_source  -> $DEPLOY_HOST:$DEPLOY_APP_PATH"
[ "$live" = "yes" ] || echo "  (dry run)"

rsync "$@" "$site_source" "$DEPLOY_HOST:$DEPLOY_SITE_PATH"
rsync "$@" "$app_source" "$DEPLOY_HOST:$DEPLOY_APP_PATH"

if [ "$live" = "yes" ]; then
  echo "Done."
else
  echo "Dry run complete. Pass --live to write changes."
fi
