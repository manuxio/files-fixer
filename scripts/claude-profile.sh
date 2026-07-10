#!/usr/bin/env bash
#
# claude — profile-selecting launcher.
#
# Installed as /usr/local/bin/claude (ahead of the real CLI, which is moved to
# claude-bin). Every time you run `claude` you pick which profile directory to
# use; the choice is exported as CLAUDE_CONFIG_DIR so Claude Code keeps that
# profile's config + credentials fully separate from the others.
#
# Pick the profile with (first match wins):
#   1. CLAUDE_PROFILE env var            (used by the web shell — no prompt)
#   2. a leading   --profile N / -P N    argument
#   3. a leading   bare number  1|2|3
#   4. an interactive menu               (when stdin/stdout are a TTY)
#   5. profile 1                         (non-interactive fallback)
#
# Anything after the profile selector is passed straight through to Claude Code,
# e.g.  `claude 2 --version`  or  `claude --profile 3 -p "hello"`.
set -euo pipefail

REAL_CLAUDE="${CLAUDE_BIN:-claude-bin}"
PROFILES_ROOT="${CLAUDE_PROFILES_ROOT:-/claude-profiles}"
PROFILE_COUNT="${CLAUDE_PROFILE_COUNT:-3}"

profile="${CLAUDE_PROFILE:-}"

# 2 + 3: consume a leading profile selector from the argument list.
if [ -z "$profile" ] && [ "$#" -gt 0 ]; then
  case "$1" in
    --profile|-P)
      profile="${2:-}"; shift 2 || shift $# ;;
    --profile=*)
      profile="${1#*=}"; shift ;;
    [0-9]|[0-9][0-9])
      profile="$1"; shift ;;
  esac
fi

# 4: interactive menu.
if [ -z "$profile" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    echo "Select a Claude profile:" >&2
    i=1
    while [ "$i" -le "$PROFILE_COUNT" ]; do
      echo "  $i) profile #$i   ($PROFILES_ROOT/$i)" >&2
      i=$((i + 1))
    done
    printf "Profile [1-%s]: " "$PROFILE_COUNT" >&2
    read -r profile
  else
    profile=1   # 5: non-interactive fallback
  fi
fi

# Validate: must be an integer in range.
case "$profile" in
  ''|*[!0-9]*) echo "claude: invalid profile '$profile'" >&2; exit 2 ;;
esac
if [ "$profile" -lt 1 ] || [ "$profile" -gt "$PROFILE_COUNT" ]; then
  echo "claude: profile must be 1..$PROFILE_COUNT (got $profile)" >&2
  exit 2
fi

export CLAUDE_CONFIG_DIR="$PROFILES_ROOT/$profile"
mkdir -p "$CLAUDE_CONFIG_DIR"

exec "$REAL_CLAUDE" "$@"
