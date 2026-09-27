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
  # Local patches are explicit and never reset or silently discarded.
  git fetch --no-tags origin "refs/heads/$SOURCE_BRANCH"
  sha=$(git rev-parse FETCH_HEAD)
  git merge-base --is-ancestor "$upstream_sha" "$sha" || {
    echo '::error::Merge upstream-sync into the configured SOURCE_BRANCH before publishing.'
    exit 1
  }
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
