#!/usr/bin/env bash
set -euo pipefail
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
owner=${GITHUB_REPOSITORY_OWNER,,}
for component in server web; do
  image="ghcr.io/$owner/nexum-$component"
  immutable="$image:sha-$SOURCE_SHA"
  # Only a definitive missing manifest permits first publication. Authentication
  # or network failures must not turn into overwrites of existing SHA tags.
  if docker manifest inspect "$immutable" > /dev/null 2> manifest-error.txt; then
    docker pull "$immutable"
    revision=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$immutable")
    [[ "$revision" == "$SOURCE_SHA" ]]
    echo "Preserving existing immutable image: $immutable"
  elif grep -Eqi 'manifest unknown|no such manifest|manifest_unknown' manifest-error.txt; then
    docker tag "nexum-$component:tested" "$immutable"
    docker push "$immutable"
  else
    cat manifest-error.txt >&2
    exit 1
  fi
done
# Both immutable images must be available before either stable tag advances.
# Registries cannot atomically update two packages; rerun to recover a failed
# second promotion. The validated marker is written only after both succeed.
for component in server web; do
  image="ghcr.io/$owner/nexum-$component"
  docker tag "$image:sha-$SOURCE_SHA" "$image:stable"
  docker push "$image:stable"
  digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$image:sha-$SOURCE_SHA")
  echo "- $image:stable / sha-$SOURCE_SHA: $digest" >> "$GITHUB_STEP_SUMMARY"
done
git fetch --no-tags origin "$SOURCE_SHA"
git push origin "$SOURCE_SHA:refs/tags/validated/$SOURCE_SHA-$GITHUB_SHA"
