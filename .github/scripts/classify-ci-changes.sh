#!/usr/bin/env bash
set -euo pipefail

# A missing comparison (manual dispatch, first push or rewritten history)
# gets the full matrix. Both sides of a rename must qualify as prose.
prose_diff() {
  local before=$1 after=$2 path
  [[ "$before" =~ ^[0-9a-f]{40}$ && "$after" =~ ^[0-9a-f]{40}$ ]] || return 1
  git merge-base --is-ancestor "$before" "$after" || return 1
  local paths="$RUNNER_TEMP/ci-changed-paths"
  git diff --no-renames --name-only -z "$before" "$after" > "$paths" || return 1
  [[ -s "$paths" ]] || return 1
  while IFS= read -r -d '' path; do
    case "$path" in
      docs/execution/*|docs/decisions/*|docs/greenfield-north-star-erp-platform-plan.md) return 1 ;;
      docs/*.md) ;;
      */*) return 1 ;;
      *.md) ;;
      *) return 1 ;;
    esac
  done < "$paths"
}

# A prose follow-up must not turn a failed or cancelled code push green.
# The previous successful PR run must have tested the same PR and base SHA.
previous_green() {
  local sha=$1
  timeout 120 gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?event=$GITHUB_EVENT_NAME&head_sha=$sha&status=success&per_page=100" |
    jq -e --arg title "$RUN_TITLE" --arg sha "$sha" \
      'any(.workflow_runs[]; .head_sha == $sha and .display_title == $title)' >/dev/null
}

prose_only=false
case "$GITHUB_EVENT_NAME" in
  pull_request)
    if [[ "$PR_ACTION" == synchronize ]]; then
      if prose_diff "$BEFORE" "$HEAD_SHA" && previous_green "$BEFORE"; then
        prose_only=true
      fi
    elif base=$(git merge-base "$BASE_SHA" "$HEAD_SHA") && prose_diff "$base" "$HEAD_SHA"; then
      prose_only=true
    fi
    ;;
  push)
    if prose_diff "$BEFORE" "$GITHUB_SHA" && previous_green "$BEFORE"; then
      prose_only=true
    fi
    ;;
esac
echo "prose_only=$prose_only" | tee -a "$GITHUB_OUTPUT"
