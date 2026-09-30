#!/usr/bin/env bash
set -euo pipefail

git check-ref-format "refs/heads/$SOURCE_BRANCH"
git remote add upstream https://github.com/GQuantrill/eve-nexum.git
git fetch --no-tags upstream main
upstream_sha=$(git rev-parse FETCH_HEAD)
old=$(git ls-remote --heads origin refs/heads/upstream-sync | cut -f1)
if [[ -n "$old" ]]; then
  git fetch --no-tags origin upstream-sync
  git merge-base --is-ancestor "$old" "$upstream_sha" || {
    echo '::error::Upstream history diverged. Inspect it manually; sync will never force-push.'
    exit 1
  }
fi
git push origin "$upstream_sha:refs/heads/upstream-sync"
if [[ "$SOURCE_BRANCH" == upstream-sync ]]; then
  sha=$upstream_sha
else
  # Fetch the current patches branch from origin.
  git fetch --no-tags origin "refs/heads/$SOURCE_BRANCH"
  remote_sha=$(git rev-parse FETCH_HEAD)

  # If upstream is already an ancestor of patches, nothing to merge.
  if git merge-base --is-ancestor "$upstream_sha" "$remote_sha"; then
    echo "Upstream $upstream_sha already included in patches $remote_sha — no merge needed."
    sha=$remote_sha
  else
    # Auto-merge latest upstream into patches, preserving all patch commits.
    echo "Merging upstream $upstream_sha into patches $remote_sha ..."
    git checkout -b "local-$SOURCE_BRANCH" "$remote_sha"
    if ! git merge --no-edit "$upstream_sha"; then
      echo '::error::Merge conflict merging upstream into patches.'
      echo '::error::Resolve conflicts manually, push the fixed branch, then rerun this workflow.'
      # Show which files conflicted.
      git diff --name-only --diff-filter=U 2>/dev/null || true
      exit 1
    fi
    merged_sha=$(git rev-parse HEAD)

    # Push non-force: fail if the remote advanced concurrently.
    if ! git push origin "local-$SOURCE_BRANCH:refs/heads/$SOURCE_BRANCH"; then
      echo '::error::Push failed — remote patches branch advanced concurrently.'
      exit 1
    fi
    echo "Patches merged and pushed: $merged_sha"
    sha=$merged_sha
  fi
fi
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
echo "sha=$sha" >> "$GITHUB_OUTPUT"
marker="refs/tags/validated/$sha-$GITHUB_SHA"
if [[ "$EVENT_NAME" == schedule ]] && [[ -n "$(git ls-remote origin "$marker")" ]]; then
  echo 'build=false' >> "$GITHUB_OUTPUT"
  echo "Already validated and promoted $sha with automation $GITHUB_SHA."
else
  echo 'build=true' >> "$GITHUB_OUTPUT"
fi
