#!/usr/bin/env bash
# Test resolve-source.sh logic with local bare remotes.
# Tests: clean merge, already-current no-op, conflict no-push,
#        preserve patch commits, push race failure.
set -euo pipefail

TMPDIR_BASE=$(mktemp -d /tmp/resolve-test-XXXXXX)
PASS_FILE="$TMPDIR_BASE/pass"
FAIL_FILE="$TMPDIR_BASE/fail"
echo 0 > "$PASS_FILE"
echo 0 > "$FAIL_FILE"
cleanup() { rm -rf "$TMPDIR_BASE"; }
trap cleanup EXIT

pass() {
  echo "  PASS: $1"
  local n; n=$(cat "$PASS_FILE"); echo $(( n + 1 )) > "$PASS_FILE"
}
fail() {
  echo "  FAIL: $1"
  local n; n=$(cat "$FAIL_FILE"); echo $(( n + 1 )) > "$FAIL_FILE"
}

# ── Helper: create a bare repo with a main branch and initial commit ───
setup_repo() {
  local name="$1"
  local dir="$TMPDIR_BASE/$name"
  mkdir -p "$dir"
  git init --bare "$dir" >/dev/null 2>&1
  local wt="$TMPDIR_BASE/${name}-init"
  git clone "$dir" "$wt" >/dev/null 2>&1
  (
    cd "$wt"
    git checkout -b main >/dev/null 2>&1
    echo "initial" > file.txt
    git add file.txt
    git commit -m "initial commit" >/dev/null 2>&1
    git push -u origin main >/dev/null 2>&1
  )
  rm -rf "$wt"
  (cd "$dir" && git symbolic-ref HEAD refs/heads/main) >/dev/null 2>&1
  echo "$dir"
}

# ── Helper: add commits to a branch via a worktree ─────────────────────
add_commits() {
  local repo="$1" branch="$2" count="$3" prefix="$4"
  local wt="$TMPDIR_BASE/${branch}-wt-$$"
  git clone "$repo" "$wt" >/dev/null 2>&1
  (
    cd "$wt"
    git checkout -b "$branch" 2>/dev/null || git checkout "$branch" >/dev/null 2>&1
    for i in $(seq 1 "$count"); do
      echo "${prefix}-$i" >> file.txt
      git add file.txt
      git commit -m "${prefix} commit $i" >/dev/null 2>&1
    done
    git push -u origin "$branch" >/dev/null 2>&1
  )
  rm -rf "$wt"
}

echo "=== Test 1: Clean merge ==="
echo "  Upstream has 2 new commits, patches has 2 patch commits."
echo "  Expect: merge succeeds, patches pushed with all commits."

BARE=$(setup_repo test1)
add_commits "$BARE" upstream-sync 2 upstream
(
  git clone "$BARE" "$TMPDIR_BASE/test1-patches" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test1-patches"
  git checkout -b patches main >/dev/null 2>&1
  echo "patch-1" > patch-file.txt
  git add patch-file.txt
  git commit -m "patch commit 1" >/dev/null 2>&1
  echo "patch-2" >> patch-file.txt
  git add patch-file.txt
  git commit -m "patch commit 2" >/dev/null 2>&1
  git push origin patches >/dev/null 2>&1
)

(
  git clone "$BARE" "$TMPDIR_BASE/test1-ci" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test1-ci"

  upstream_sha=$(git rev-parse origin/upstream-sync)
  git fetch --no-tags origin patches >/dev/null 2>&1
  remote_sha=$(git rev-parse FETCH_HEAD)

  if git merge-base --is-ancestor "$upstream_sha" "$remote_sha" 2>/dev/null; then
    fail "upstream should NOT be ancestor yet"
  else
    git checkout -b local-patches "$remote_sha" >/dev/null 2>&1
    if git merge --no-edit "$upstream_sha" >/dev/null 2>&1; then
      pass "merge succeeded"
      merged_log=$(git log --oneline HEAD)
      git push origin "local-patches:refs/heads/patches" >/dev/null 2>&1

      if echo "$merged_log" | grep -q "patch commit 1"; then
        pass "patch commit 1 preserved"
      else
        fail "patch commit 1 not found"
      fi
      if echo "$merged_log" | grep -q "patch commit 2"; then
        pass "patch commit 2 preserved"
      else
        fail "patch commit 2 not found"
      fi
      if echo "$merged_log" | grep -q "upstream commit 1"; then
        pass "upstream commit 1 included"
      else
        fail "upstream commit 1 not found"
      fi
    else
      fail "merge failed unexpectedly"
    fi
  fi
)

echo ""
echo "=== Test 2: Already-current no-op ==="
echo "  Upstream already included in patches."
echo "  Expect: no merge needed."

BARE=$(setup_repo test2)
add_commits "$BARE" upstream-sync 2 upstream
(
  git clone "$BARE" "$TMPDIR_BASE/test2-patches" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test2-patches"
  git checkout -b patches main >/dev/null 2>&1
  git merge --no-edit origin/upstream-sync >/dev/null 2>&1
  echo "patch-only" > patch-file.txt
  git add patch-file.txt
  git commit -m "patch commit" >/dev/null 2>&1
  git push origin patches >/dev/null 2>&1
)

(
  git clone "$BARE" "$TMPDIR_BASE/test2-ci" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test2-ci"

  upstream_sha=$(git rev-parse origin/upstream-sync)
  git fetch --no-tags origin patches >/dev/null 2>&1
  remote_sha=$(git rev-parse FETCH_HEAD)

  if git merge-base --is-ancestor "$upstream_sha" "$remote_sha" 2>/dev/null; then
    pass "correctly detected upstream already included"
  else
    fail "upstream should be ancestor"
  fi
)

echo ""
echo "=== Test 3: Conflict no-push ==="
echo "  Upstream and patches modify the same file."
echo "  Expect: merge fails, no push."

BARE=$(setup_repo test3)
add_commits "$BARE" upstream-sync 2 upstream
(
  git clone "$BARE" "$TMPDIR_BASE/test3-patches" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test3-patches"
  git checkout -b patches main >/dev/null 2>&1
  echo "conflicting patch" >> file.txt
  git add file.txt
  git commit -m "conflicting patch commit" >/dev/null 2>&1
  git push origin patches >/dev/null 2>&1
)

(
  git clone "$BARE" "$TMPDIR_BASE/test3-ci" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test3-ci"

  upstream_sha=$(git rev-parse origin/upstream-sync)
  git fetch --no-tags origin patches >/dev/null 2>&1
  remote_sha=$(git rev-parse FETCH_HEAD)

  pre_sha=$(git rev-parse origin/patches)

  git checkout -b local-patches "$remote_sha" >/dev/null 2>&1
  if git merge --no-edit "$upstream_sha" >/dev/null 2>&1; then
    fail "merge should have conflicted"
  else
    pass "merge correctly failed with conflicts"
    post_sha=$(git rev-parse origin/patches)
    if [[ "$pre_sha" == "$post_sha" ]]; then
      pass "conflicting branch was not pushed"
    else
      fail "branch was pushed despite conflict"
    fi
  fi
)

echo ""
echo "=== Test 4: Push race failure ==="
echo "  Remote advances between fetch and push."
echo "  Expect: push fails."

BARE=$(setup_repo test4)
add_commits "$BARE" upstream-sync 2 upstream
(
  git clone "$BARE" "$TMPDIR_BASE/test4-patches" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test4-patches"
  git checkout -b patches main >/dev/null 2>&1
  echo "race-patch" > patch-file.txt
  git add patch-file.txt
  git commit -m "race patch commit" >/dev/null 2>&1
  git push origin patches >/dev/null 2>&1
)

(
  git clone "$BARE" "$TMPDIR_BASE/test4-ci" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test4-ci"

  upstream_sha=$(git rev-parse origin/upstream-sync)
  git fetch --no-tags origin patches >/dev/null 2>&1
  remote_sha=$(git rev-parse FETCH_HEAD)

  git checkout -b local-patches "$remote_sha" >/dev/null 2>&1
  git merge --no-edit "$upstream_sha" >/dev/null 2>&1

  # Simulate concurrent push
  (
    git clone "$BARE" "$TMPDIR_BASE/test4-racer" >/dev/null 2>&1
    cd "$TMPDIR_BASE/test4-racer"
    git checkout -b patches origin/patches >/dev/null 2>&1
    echo "concurrent change" > race-file.txt
    git add race-file.txt
    git commit -m "concurrent commit" >/dev/null 2>&1
    git push origin patches >/dev/null 2>&1
  )

  if git push origin "local-patches:refs/heads/patches" >/dev/null 2>&1; then
    fail "push should have failed due to concurrent update"
  else
    pass "push correctly failed due to concurrent update"
  fi
)

echo ""
echo "=== Test 5: Preserve patch commits (detailed) ==="
echo "  After merge, all original patch commits must be in history."

BARE=$(setup_repo test5)
add_commits "$BARE" upstream-sync 3 upstream
(
  git clone "$BARE" "$TMPDIR_BASE/test5-patches" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test5-patches"
  git checkout -b patches main >/dev/null 2>&1
  echo "fix-a" > fix-a.txt
  git add fix-a.txt
  git commit -m "PATCH: fix A" >/dev/null 2>&1
  echo "fix-b" > fix-b.txt
  git add fix-b.txt
  git commit -m "PATCH: fix B" >/dev/null 2>&1
  echo "fix-c" > fix-c.txt
  git add fix-c.txt
  git commit -m "PATCH: fix C" >/dev/null 2>&1
  git push origin patches >/dev/null 2>&1
)

(
  git clone "$BARE" "$TMPDIR_BASE/test5-ci" >/dev/null 2>&1
  cd "$TMPDIR_BASE/test5-ci"

  upstream_sha=$(git rev-parse origin/upstream-sync)
  git fetch --no-tags origin patches >/dev/null 2>&1
  remote_sha=$(git rev-parse FETCH_HEAD)

  git checkout -b local-patches "$remote_sha" >/dev/null 2>&1
  git merge --no-edit "$upstream_sha" >/dev/null 2>&1
  git push origin "local-patches:refs/heads/patches" >/dev/null 2>&1

  # Use HEAD log (we're on local-patches which has the merged result)
  merged_log=$(git log --oneline HEAD)

  for msg in "PATCH: fix A" "PATCH: fix B" "PATCH: fix C"; do
    if echo "$merged_log" | grep -qF "$msg"; then
      pass "'$msg' preserved in merged history"
    else
      fail "'$msg' missing from merged history"
    fi
  done

  if echo "$merged_log" | grep -q "upstream commit"; then
    pass "upstream commits included in merged history"
  else
    fail "upstream commits missing from merged history"
  fi
)

TOTAL_PASS=$(cat "$PASS_FILE")
TOTAL_FAIL=$(cat "$FAIL_FILE")
echo ""
echo "========================================="
echo "Results: $TOTAL_PASS passed, $TOTAL_FAIL failed"
echo "========================================="
[[ "$TOTAL_FAIL" == 0 ]]
