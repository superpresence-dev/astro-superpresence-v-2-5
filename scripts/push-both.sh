#!/usr/bin/env bash
# Push `main` to two remotes whose histories differ on purpose: the first keeps
# your own commits as they are, the second needs every commit re-authored (for
# example an organisation repo that must show only the organisation account).
# A plain `git push` to the second one is rejected, and `--force` would wipe
# its history. This script never forces.
#
#   scripts/push-both.sh            # push
#   scripts/push-both.sh --dry-run  # show what would be pushed, change nothing
#
# Identities come from `.push-both.env` (git-ignored), or the environment:
#
#   FIRST_REMOTE=origin          FIRST_GH_USER=your-personal-login
#   SECOND_REMOTE=company        SECOND_GH_USER=org-login
#   SECOND_NAME="org-login"      SECOND_EMAIL="id+org-login@users.noreply.github.com"
#
# The `gh` account that was active when the script started is restored on exit.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
[ -f .push-both.env ] && . ./.push-both.env

: "${FIRST_REMOTE:=origin}" "${SECOND_REMOTE:=company}"
: "${FIRST_GH_USER:?set FIRST_GH_USER in .push-both.env}" "${SECOND_GH_USER:?set SECOND_GH_USER in .push-both.env}"
: "${SECOND_NAME:?set SECOND_NAME in .push-both.env}" "${SECOND_EMAIL:?set SECOND_EMAIL in .push-both.env}"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

die() { echo "push-both: $*" >&2; exit 1; }
say() { echo "push-both: $*"; }

[ "$(git branch --show-current)" = "main" ] || die "run it on main (now on $(git branch --show-current))"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean; commit or stash first"
command -v gh >/dev/null || die "gh (GitHub CLI) is required to switch accounts"

START_USER="$(gh api user --jq .login 2>/dev/null || true)"
TMP="push-both-tmp-$$"
cleanup() {
  git checkout -q main 2>/dev/null || true
  git branch -D "$TMP" >/dev/null 2>&1 || true
  if [ -n "$START_USER" ]; then gh auth switch -u "$START_USER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

as() { [ "$(gh api user --jq .login)" = "$1" ] || gh auth switch -u "$1" >/dev/null; }

fetch_both() {
  as "$FIRST_GH_USER"
  git fetch -q "$FIRST_REMOTE"
  as "$SECOND_GH_USER"
  git fetch -q "$SECOND_REMOTE"
}
fetch_both
MAIN_TREE="$(git rev-parse 'main^{tree}')"

# --- first remote: must be a plain fast-forward ---------------------------------
git merge-base --is-ancestor "$FIRST_REMOTE/main" main \
  || die "$FIRST_REMOTE/main is not an ancestor of main (diverged). Resolve by hand; nothing was pushed."
FIRST_NEW="$(git rev-list --count "$FIRST_REMOTE/main..main")"

# --- second remote: find the commit it already has, by content ------------------
SECOND_TREE="$(git rev-parse "$SECOND_REMOTE/main^{tree}")"
if [ "$SECOND_TREE" = "$MAIN_TREE" ]; then
  SECOND_NEW=0
else
  BASE="$(git rev-list main | while read -r c; do
    [ "$(git rev-parse "$c^{tree}")" = "$SECOND_TREE" ] && { echo "$c"; break; }
  done)"
  [ -n "$BASE" ] || die "no commit on main has the same content as $SECOND_REMOTE/main; its history holds content main never had. Nothing was pushed."
  [ -z "$(git rev-list --merges "$BASE..main")" ] || die "merge commits between $BASE and main; rebase cannot carry them. Keep main linear."
  SECOND_NEW="$(git rev-list --count "$BASE..main")"
fi

say "$FIRST_REMOTE: $FIRST_NEW commit(s) to push as they are"
say "$SECOND_REMOTE: $SECOND_NEW commit(s) to re-author as $SECOND_NAME and push"
if [ "$DRY" = 1 ]; then say "dry run: nothing pushed"; exit 0; fi
[ "$FIRST_NEW" -gt 0 ] || [ "$SECOND_NEW" -gt 0 ] || { say "both remotes are up to date"; exit 0; }

# --- second remote: re-author on top of its own history, then fast-forward ------
if [ "$SECOND_NEW" -gt 0 ]; then
  git checkout -q -b "$TMP" main
  GIT_SEQUENCE_EDITOR=: git -c user.name="$SECOND_NAME" -c user.email="$SECOND_EMAIL" \
    rebase --onto "$SECOND_REMOTE/main" "$BASE" \
    --exec 'git commit --amend --no-edit --reset-author -q' >/dev/null
  [ "$(git rev-parse 'HEAD^{tree}')" = "$MAIN_TREE" ] || die "re-authored branch differs from main in content; nothing was pushed to $SECOND_REMOTE."
  [ "$(git log --format='%an' "$SECOND_REMOTE/main..HEAD" | sort -u)" = "$SECOND_NAME" ] || die "some re-authored commit still has another author; nothing was pushed to $SECOND_REMOTE."
  as "$SECOND_GH_USER"
  git push "$SECOND_REMOTE" "$TMP:main"
  git checkout -q main
  git branch -D "$TMP" >/dev/null
fi

# --- first remote -----------------------------------------------------------------
if [ "$FIRST_NEW" -gt 0 ]; then
  as "$FIRST_GH_USER"
  git push "$FIRST_REMOTE" main
fi

fetch_both
say "done. $FIRST_REMOTE/main $(git rev-parse --short "$FIRST_REMOTE/main")  $SECOND_REMOTE/main $(git rev-parse --short "$SECOND_REMOTE/main")  (same content: $([ "$(git rev-parse "$FIRST_REMOTE/main^{tree}")" = "$(git rev-parse "$SECOND_REMOTE/main^{tree}")" ] && echo yes || echo NO))"
