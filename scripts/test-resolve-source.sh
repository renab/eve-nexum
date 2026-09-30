#!/usr/bin/env bash
# Test resolve-source.sh by invoking the actual production script against
# local bare remotes.  Does NOT duplicate resolve-source.sh logic.
#
# Tests: clean merge, already-current no-op, conflict no-push,
#        patch preservation, concurrent push rejection.
set -euo pipefail

# ── Test-only Git identity (independent of global config) ─────────────────
# These must match what resolve-source.sh derives from GITHUB_ACTOR="test-ci"
# so the merge-commit author check (Test 1) passes.
export GIT_AUTHOR_NAME="test-ci"
export GIT_AUTHOR_EMAIL="test-ci@users.noreply.github.com"
export GIT_COMMITTER_NAME="test-ci"
export GIT_COMMITTER_EMAIL="test-ci@users.noreply.github.com"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVE_SCRIPT="$SCRIPT_DIR/resolve-source.sh"

if [[ ! -x "$RESOLVE_SCRIPT" ]]; then
  echo "ERROR: $RESOLVE_SCRIPT not found or not executable"
  exit 1
fi

TMPDIR_BASE=$(mktemp -d /tmp/resolve-test-XXXXXX)
PASS=0; FAIL=0
cleanup() { rm -rf "$TMPDIR_BASE"; }
trap cleanup EXIT

pass() { echo "  PASS: $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  FAIL: $1"; FAIL=$(( FAIL + 1 )); }

# ── Helper: create an upstream bare repo with main + commits ────────────
setup_upstream() {
  local suffix="$1" count="$2" prefix="$3"
  local dir="$TMPDIR_BASE/upstream-${suffix}"
  git init --bare "$dir" >/dev/null 2>&1
  local wt="$TMPDIR_BASE/upstream-${suffix}-wt"
  git clone "$dir" "$wt" >/dev/null 2>&1
  (
    cd "$wt"
    git checkout -b main >/dev/null 2>&1
    echo "initial" > file.txt
    git add file.txt
    git commit -m "initial commit" >/dev/null 2>&1
    for i in $(seq 1 "$count"); do
      echo "${prefix}-$i" >> file.txt
      git add file.txt
      git commit -m "${prefix} commit $i" >/dev/null 2>&1
    done
    git push -u origin main >/dev/null 2>&1
  )
  rm -rf "$wt"
  (cd "$dir" && git symbolic-ref HEAD refs/heads/main) >/dev/null 2>&1
  echo "$dir"
}

# ── Helper: create an origin bare repo from upstream, reset main to initial ──
# This ensures origin/main is at the initial commit, so upstream/main
# has newer commits that need to be merged into patches.
setup_origin() {
  local suffix="$1" upstream_bare="$2"
  local dir="$TMPDIR_BASE/origin-${suffix}"
  git clone --bare "$upstream_bare" "$dir" >/dev/null 2>&1
  (cd "$dir" && git symbolic-ref HEAD refs/heads/main) >/dev/null 2>&1
  # Reset origin/main to the initial commit (root of history)
  local initial_sha
  initial_sha=$(git -C "$dir" rev-list --max-parents=0 refs/heads/main)
  git -C "$dir" update-ref refs/heads/main "$initial_sha"
  echo "$dir"
}

# ── Helper: add commits to a branch in a bare repo via a worktree ───────
add_branch_commits() {
  local repo="$1" branch="$2" count="$3" prefix="$4" file="$5"
  local wt="$TMPDIR_BASE/wt-${branch}-$$"
  git clone "$repo" "$wt" >/dev/null 2>&1
  (
    cd "$wt"
    git checkout -b "$branch" 2>/dev/null || git checkout "$branch" >/dev/null 2>&1
    for i in $(seq 1 "$count"); do
      echo "${prefix}-$i" >> "$file"
      git add "$file"
      git commit -m "${prefix} commit $i" >/dev/null 2>&1
    done
    git push -u origin "$branch" >/dev/null 2>&1
  )
  rm -rf "$wt"
}

# ── Helper: run resolve-source.sh against origin bare repo ──────────────
# upstream_bare is used as the UPSTREAM_URL override.
# Stores exit code in $TMPDIR_BASE/last-rc. Echoes clone path to stdout.
run_resolve() {
  local origin_url="$1" source_branch="$2" upstream_url="$3"
  local event_name="${4:-manual}" github_sha="${5:-test00000000000000000000000000000000000000}"
  local output_file="$TMPDIR_BASE/github-output"
  : > "$output_file"

  local clone="$TMPDIR_BASE/ci-runner"
  rm -rf "$clone"
  git clone "$origin_url" "$clone" >/dev/null 2>&1
  if ! (
    cd "$clone"
    SOURCE_BRANCH="$source_branch" \
    UPSTREAM_URL="$upstream_url" \
    EVENT_NAME="$event_name" \
    GITHUB_SHA="$github_sha" \
    GITHUB_OUTPUT="$output_file" \
    GITHUB_ACTOR="test-ci" \
    bash "$RESOLVE_SCRIPT" >&2
  ); then
    echo "1" > "$TMPDIR_BASE/last-rc"
  else
    echo "0" > "$TMPDIR_BASE/last-rc"
  fi
  echo "$clone"
}

get_output_sha() {
  grep '^sha=' "$TMPDIR_BASE/github-output" | tail -1 | cut -d= -f2
}
get_output_build() {
  grep '^build=' "$TMPDIR_BASE/github-output" | tail -1 | cut -d= -f2
}
remote_ref_sha() {
  git -C "$1" rev-parse "refs/heads/$2" 2>/dev/null || echo ""
}

##############################################################################
echo "=== Test 1: Clean merge ==="
echo "  Upstream has 2 new commits, patches has 2 patch commits."
echo "  Expect: merge succeeds, patches pushed with all commits."

UPSTREAM_BARE=$(setup_upstream t1 2 upstream)
ORIGIN_BARE=$(setup_origin t1 "$UPSTREAM_BARE")

# Create patches branch on origin with diverging commits (non-conflicting file)
add_branch_commits "$ORIGIN_BARE" patches 2 patch patch-file.txt

pre_upstream=$(remote_ref_sha "$ORIGIN_BARE" upstream-sync)
pre_patches=$(remote_ref_sha "$ORIGIN_BARE" patches)

CLONE=$(run_resolve "$ORIGIN_BARE" patches "$UPSTREAM_BARE" manual)
rc=$(cat "$TMPDIR_BASE/last-rc")

if [[ "$rc" == "0" ]]; then
  pass "resolve-source.sh exited 0"
else
  fail "resolve-source.sh exited $rc (expected 0)"
fi

output_sha=$(get_output_sha)
if [[ -n "$output_sha" && "$output_sha" =~ ^[0-9a-f]{40}$ ]]; then
  pass "GITHUB_OUTPUT contains valid sha: ${output_sha:0:8}..."
else
  fail "GITHUB_OUTPUT sha missing or invalid: '$output_sha'"
fi

post_upstream=$(remote_ref_sha "$ORIGIN_BARE" upstream-sync)
post_patches=$(remote_ref_sha "$ORIGIN_BARE" patches)

if [[ -n "$post_upstream" ]]; then
  if [[ -z "$pre_upstream" || "$post_upstream" != "$pre_upstream" ]]; then
    pass "upstream-sync ref set: ${post_upstream:0:8}..."
  else
    fail "upstream-sync ref did not change"
  fi
else
  fail "upstream-sync ref not created"
fi

if [[ "$post_patches" != "$pre_patches" ]]; then
  pass "patches ref advanced (${pre_patches:0:8} -> ${post_patches:0:8})"
else
  fail "patches ref did not advance"
fi

# Verify merged history contains all commits
merged_log=$(git -C "$CLONE" log --oneline HEAD)
for msg in "patch commit 1" "patch commit 2" "upstream commit 1" "upstream commit 2"; do
  if echo "$merged_log" | grep -qF "$msg"; then
    pass "'$msg' in merged history"
  else
    fail "'$msg' missing from merged history"
  fi
done

# Verify deterministic git identity on merge commit
merge_author=$(git -C "$CLONE" log -1 --format='%an <%ae>' HEAD)
if [[ "$merge_author" == "test-ci <test-ci@users.noreply.github.com>" ]]; then
  pass "merge commit has deterministic author identity"
else
  fail "merge commit author unexpected: '$merge_author'"
fi

##############################################################################
echo ""
echo "=== Test 2: Already-current no-op ==="
echo "  Upstream already included in patches."
echo "  Expect: no merge needed, sha = remote patches SHA."

UPSTREAM_BARE=$(setup_upstream t2 2 upstream)
ORIGIN_BARE=$(setup_origin t2 "$UPSTREAM_BARE")

# Pre-populate upstream-sync on origin (simulating prior sync)
git -C "$ORIGIN_BARE" update-ref refs/heads/upstream-sync "$(git -C "$UPSTREAM_BARE" rev-parse refs/heads/main)"

# Create patches that already include upstream (merge upstream into patches)
(
  git clone "$ORIGIN_BARE" "$TMPDIR_BASE/t2-patches-wt" >/dev/null 2>&1
  cd "$TMPDIR_BASE/t2-patches-wt"
  git checkout -b patches main >/dev/null 2>&1
  git fetch origin upstream-sync >/dev/null 2>&1
  git merge --no-edit origin/upstream-sync >/dev/null 2>&1
  echo "patch-only" > patch-file.txt
  git add patch-file.txt
  git commit -m "patch commit" >/dev/null 2>&1
  git push origin patches >/dev/null 2>&1
)
rm -rf "$TMPDIR_BASE/t2-patches-wt"

remote_patches_sha=$(remote_ref_sha "$ORIGIN_BARE" patches)

CLONE=$(run_resolve "$ORIGIN_BARE" patches "$UPSTREAM_BARE" manual)
rc=$(cat "$TMPDIR_BASE/last-rc")

if [[ "$rc" == "0" ]]; then
  pass "resolve-source.sh exited 0"
else
  fail "resolve-source.sh exited $rc (expected 0)"
fi

output_sha=$(get_output_sha)
if [[ "$output_sha" == "$remote_patches_sha" ]]; then
  pass "sha matches remote patches (no-op): ${output_sha:0:8}..."
else
  fail "sha $output_sha != remote patches $remote_patches_sha"
fi

build_val=$(get_output_build)
if [[ "$build_val" == "true" ]]; then
  pass "build=true (manual event)"
else
  fail "build='$build_val' (expected true)"
fi

##############################################################################
echo ""
echo "=== Test 3: Conflict no-push ==="
echo "  Upstream and patches modify the same file."
echo "  Expect: script exits non-zero, remote ref unchanged."

UPSTREAM_BARE=$(setup_upstream t3 2 upstream)
ORIGIN_BARE=$(setup_origin t3 "$UPSTREAM_BARE")

# Create patches that conflict with upstream (same file: file.txt)
add_branch_commits "$ORIGIN_BARE" patches 1 conflicting-patch file.txt

pre_patches=$(remote_ref_sha "$ORIGIN_BARE" patches)

CLONE=$(run_resolve "$ORIGIN_BARE" patches "$UPSTREAM_BARE" manual)
rc=$(cat "$TMPDIR_BASE/last-rc")

if [[ "$rc" != "0" ]]; then
  pass "resolve-source.sh exited non-zero ($rc) on conflict"
else
  fail "resolve-source.sh should have failed on conflict"
fi

post_patches=$(remote_ref_sha "$ORIGIN_BARE" patches)
if [[ "$post_patches" == "$pre_patches" ]]; then
  pass "remote patches ref unchanged after conflict"
else
  fail "remote patches ref changed despite conflict (${pre_patches:0:8} -> ${post_patches:0:8})"
fi

##############################################################################
echo ""
echo "=== Test 4: Patch preservation ==="
echo "  3 patch commits must survive merge with 3 upstream commits."

UPSTREAM_BARE=$(setup_upstream t4 3 upstream)
ORIGIN_BARE=$(setup_origin t4 "$UPSTREAM_BARE")

# Create patches with 3 commits on separate files (non-conflicting)
(
  git clone "$ORIGIN_BARE" "$TMPDIR_BASE/t4-patches-wt" >/dev/null 2>&1
  cd "$TMPDIR_BASE/t4-patches-wt"
  git checkout -b patches main >/dev/null 2>&1
  echo "fix-a" > fix-a.txt && git add fix-a.txt && git commit -m "PATCH: fix A" >/dev/null 2>&1
  echo "fix-b" > fix-b.txt && git add fix-b.txt && git commit -m "PATCH: fix B" >/dev/null 2>&1
  echo "fix-c" > fix-c.txt && git add fix-c.txt && git commit -m "PATCH: fix C" >/dev/null 2>&1
  git push origin patches >/dev/null 2>&1
)
rm -rf "$TMPDIR_BASE/t4-patches-wt"

CLONE=$(run_resolve "$ORIGIN_BARE" patches "$UPSTREAM_BARE" manual)
rc=$(cat "$TMPDIR_BASE/last-rc")

if [[ "$rc" != "0" ]]; then
  fail "resolve-source.sh exited $rc (expected 0)"
else
  pass "resolve-source.sh exited 0"
fi

merged_log=$(git -C "$CLONE" log --oneline HEAD)
for msg in "PATCH: fix A" "PATCH: fix B" "PATCH: fix C"; do
  if echo "$merged_log" | grep -qF "$msg"; then
    pass "'$msg' preserved"
  else
    fail "'$msg' missing from merged history"
  fi
done

if echo "$merged_log" | grep -q "upstream commit"; then
  pass "upstream commits included"
else
  fail "upstream commits missing"
fi

##############################################################################
echo ""
echo "=== Test 5: Concurrent push rejection ==="
echo "  Remote advances between merge and push via test hook."
echo "  Expect: push fails, script exits non-zero."

UPSTREAM_BARE=$(setup_upstream t5 2 upstream)
ORIGIN_BARE=$(setup_origin t5 "$UPSTREAM_BARE")

# Create patches that merge cleanly (separate file) — race happens at push time
add_branch_commits "$ORIGIN_BARE" patches 1 race-patch patch-file.txt

pre_patches=$(remote_ref_sha "$ORIGIN_BARE" patches)

# Test hook: resolve-source.sh pauses before push while HOOK_FILE exists.
HOOK_FILE="$TMPDIR_BASE/t5-push-hook"
: > "$HOOK_FILE"
export TEST_PUSH_HOOK="$HOOK_FILE"

# Background watcher: wait, create concurrent commit, push to origin.
(
  trap 'rm -f "$HOOK_FILE"' EXIT
  sleep 3
  RACER="$TMPDIR_BASE/t5-racer"
  rm -rf "$RACER"
  git clone "$ORIGIN_BARE" "$RACER" >/dev/null 2>&1
  cd "$RACER"
  git checkout -b patches origin/patches >/dev/null 2>&1
  echo "concurrent" > race.txt && git add race.txt
  git commit -m "concurrent commit" >/dev/null 2>&1
  # Push to origin (bare repo) to advance the patches ref
  git push origin patches >/dev/null 2>&1
) &
WATCHER_PID=$!

CLONE=$(run_resolve "$ORIGIN_BARE" patches "$UPSTREAM_BARE" manual)
rc=$(cat "$TMPDIR_BASE/last-rc")
unset TEST_PUSH_HOOK

rm -f "$HOOK_FILE"
wait "$WATCHER_PID" 2>/dev/null || true

if [[ "$rc" != "0" ]]; then
  pass "resolve-source.sh exited non-zero ($rc) on concurrent push"
else
  fail "resolve-source.sh should have failed on concurrent push"
fi

post_patches=$(remote_ref_sha "$ORIGIN_BARE" patches)
if [[ "$post_patches" != "$pre_patches" ]]; then
  pass "remote patches advanced by concurrent push (not our script)"
else
  fail "remote patches unchanged — concurrent push may not have happened"
fi

##############################################################################
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "========================================="
[[ "$FAIL" == 0 ]]
