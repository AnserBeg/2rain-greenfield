#!/usr/bin/env bash
set -euo pipefail

readonly gitleaks_image='ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f'
readonly synthetic_rule_id='north-star-synthetic-test-secret'
readonly history_cutoff='c870dd5fc6d37dd0a45cf61be1b802bcdc4f3e36'

repository_root=$(git rev-parse --show-toplevel)
common_git_directory=$(git rev-parse --path-format=absolute --git-common-dir)
evidence_directory=${SECURITY_EVIDENCE_DIR:-"$repository_root/test-results/security"}
mkdir -p "$evidence_directory"
evidence_directory=$(cd "$evidence_directory" && pwd -P)

dependency_report="$evidence_directory/dependency-audit.json"
dependency_stderr="$evidence_directory/dependency-audit.stderr"
clean_report="$evidence_directory/gitleaks-clean.json"
negative_report="$evidence_directory/gitleaks-negative.json"
summary_report="$evidence_directory/summary.json"

history_scope=${SECURITY_HISTORY_SCOPE:-all}
history_options=''
case "$history_scope" in
  all) ;;
  ancestry | remainder)
    # The pinned Gitleaks version normally passes --full-history --all
    # --diff-filter=tuxdb. Divide that same history into the cutoff's
    # ancestors and everything reachable outside them.
    git merge-base --is-ancestor "$history_cutoff" HEAD
    total_commits=$(git rev-list --count --all)
    ancestor_commits=$(git rev-list --count "$history_cutoff")
    remaining_commits=$(git rev-list --count --all "^$history_cutoff")
    if ((ancestor_commits + remaining_commits != total_commits)); then
      printf 'Secret scan ranges do not cover the Git history.\n' >&2
      exit 1
    fi
    if [[ $history_scope == ancestry ]]; then
      history_options="--full-history --diff-filter=tuxdb $history_cutoff"
    else
      history_options="--full-history --all --diff-filter=tuxdb ^$history_cutoff"
    fi
    printf 'Security history scope %s covers one part of %d commits.\n' \
      "$history_scope" "$total_commits"
    ;;
  *)
    printf 'Unknown security history scope %s.\n' "$history_scope" >&2
    exit 1
    ;;
esac

printf '[]\n' >"$clean_report"
printf '[]\n' >"$negative_report"

docker_mounts=(
  --volume "$repository_root:$repository_root:ro"
  --volume "$evidence_directory:$evidence_directory:rw"
)

case "$common_git_directory/" in
  "$repository_root/"*) ;;
  *) docker_mounts+=(--volume "$common_git_directory:$common_git_directory:ro") ;;
esac

run_gitleaks() {
  local target=$1
  local report=$2
  local history=$3
  shift 3

  local git_options=()
  if [[ -n $history ]]; then
    git_options=(--log-opts "$history")
  fi

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    "${docker_mounts[@]}" \
    "$@" \
    --workdir "$repository_root" \
    "$gitleaks_image" \
    git \
    "${git_options[@]}" \
    --no-banner \
    --no-color \
    --redact=100 \
    --config "$repository_root/.github/security/gitleaks.toml" \
    --report-format json \
    --report-path "$report" \
    "$target"
}

set +e
corepack pnpm audit --audit-level=high --json >"$dependency_report" 2>"$dependency_stderr"
dependency_status=$?

run_gitleaks "$repository_root" "$clean_report" "$history_options"
clean_status=$?
set -e

negative_fixture=$(mktemp -d /tmp/north-star-secret-scan-XXXXXX)
cleanup() {
  rm -rf -- "$negative_fixture"
}
trap cleanup EXIT

git -C "$negative_fixture" init --quiet
git -C "$negative_fixture" config user.name 'North Star security fixture'
git -C "$negative_fixture" config user.email 'security-fixture@example.invalid'

synthetic_prefix='NORTH_STAR_TEST_SECRET_'
synthetic_suffix='0123456789ABCDEF0123456789ABCDEF'
printf '%s%s\n' "$synthetic_prefix" "$synthetic_suffix" \
  >"$negative_fixture/credential.txt"
git -C "$negative_fixture" add credential.txt
git -C "$negative_fixture" commit --quiet --message 'plant synthetic secret fixture'

set +e
run_gitleaks \
  "$negative_fixture" \
  "$negative_report" \
  "" \
  --volume "$negative_fixture:$negative_fixture:ro"
negative_status=$?
set -e

negative_rule_detected=false
if grep --fixed-strings --quiet "\"RuleID\": \"$synthetic_rule_id\"" "$negative_report"; then
  negative_rule_detected=true
fi

printf '{\n  "dependencyAuditExitCode": %d,\n  "cleanSecretScanExitCode": %d,\n  "negativeSecretScanExitCode": %d,\n  "negativeRuleDetected": %s\n}\n' \
  "$dependency_status" \
  "$clean_status" \
  "$negative_status" \
  "$negative_rule_detected" \
  >"$summary_report"

gate_failed=false

if [[ $dependency_status -ne 0 ]]; then
  printf 'Dependency audit failed (exit %d); see %s.\n' \
    "$dependency_status" "$dependency_report" >&2
  gate_failed=true
fi

if [[ $clean_status -ne 0 ]]; then
  printf 'Clean-repository secret scan failed (exit %d); see %s.\n' \
    "$clean_status" "$clean_report" >&2
  gate_failed=true
fi

if [[ $negative_status -ne 1 || $negative_rule_detected != true ]]; then
  printf 'Negative secret fixture did not produce the required scanner finding; see %s.\n' \
    "$negative_report" >&2
  gate_failed=true
fi

if [[ $gate_failed == true ]]; then
  exit 1
fi

printf 'Security scans passed; evidence written to %s.\n' "$evidence_directory"
