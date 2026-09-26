#!/usr/bin/env bash
# Publish the source bundle verified by this main-branch CircleCI pipeline.
set -euo pipefail
set +x

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "${CIRCLE_BRANCH:-}" == main && -z "${CIRCLE_TAG:-}" ]] || fail 'Hermes releases require a main-branch pipeline.'
[[ "${RELEASE_VERSION:-}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'An explicit stable release-version is required.'
[[ "${CIRCLE_SHA1:-}" == "$(git rev-parse HEAD)" ]] || fail 'Checkout does not match the pipeline commit.'
[[ "$(cat dist/hermes/commit.txt)" == "$CIRCLE_SHA1" ]] || fail 'Hermes artifacts belong to a different commit.'

git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
git merge-base --is-ancestor "$CIRCLE_SHA1" origin/main || fail 'Release commit is not on main.'

release_tag="hermes-v$RELEASE_VERSION"
asset="datool-hermes-$RELEASE_VERSION.zip"
release_tmp=$(mktemp -d)
trap 'rm -rf "$release_tmp"' EXIT
# Rebuild for byte comparison, but upload the original tested workspace artifacts.
python3 scripts/package-hermes-plugin.py --tag "$release_tag" --output-dir "$release_tmp/rebuilt"
cmp "dist/hermes/$asset" "$release_tmp/rebuilt/$asset"
cmp "dist/hermes/$asset.sha256" "$release_tmp/rebuilt/$asset.sha256"
(cd dist/hermes && sha256sum --check "$asset.sha256")

verify_tag() {
  local tag_refs tag_commit
  tag_refs=$(git ls-remote --tags origin "refs/tags/$release_tag" "refs/tags/$release_tag^{}")
  tag_commit=$(printf '%s\n' "$tag_refs" | awk 'NR == 1 { commit = $1 } /\^\{\}$/ { commit = $1 } END { print commit }')
  [[ "$tag_commit" == "$CIRCLE_SHA1" ]] || fail 'Hermes tag does not match the tested commit.'
}

tag_refs=$(git ls-remote --tags origin "refs/tags/$release_tag")
if [[ -n "$tag_refs" ]]; then verify_tag; fi
[[ -n "${GH_TOKEN:-}" ]] || fail 'GH_TOKEN is required from the restricted datool-hermes context.'
export GH_REPO="${CIRCLE_PROJECT_USERNAME:?}/${CIRCLE_PROJECT_REPONAME:?}"
if [[ -z "$tag_refs" ]]; then
  # Create an immutable target before publishing; an existing ref is never moved.
  gh api "repos/$GH_REPO/git/refs" --method POST \
    -f "ref=refs/tags/$release_tag" -f "sha=$CIRCLE_SHA1" > /dev/null
fi
verify_tag

# Existing releases fail here; never overwrite their assets. Downloads are checked
# while the new release is still a draft, before exposing it to clients.
gh release create "$release_tag" "dist/hermes/$asset" "dist/hermes/$asset.sha256" \
  --verify-tag --target "$CIRCLE_SHA1" --draft --latest=false \
  --title "Datool Hermes $RELEASE_VERSION" \
  --notes-file integrations/hermes/RELEASE_NOTES.md
verify_downloads() {
  local destination="$1"
  gh release download "$release_tag" --pattern "$asset" --pattern "$asset.sha256" --dir "$destination"
  cmp "dist/hermes/$asset" "$destination/$asset"
  cmp "dist/hermes/$asset.sha256" "$destination/$asset.sha256"
  (cd "$destination" && sha256sum --check "$asset.sha256")
}
verify_downloads "$release_tmp/draft"
verify_tag
gh release edit "$release_tag" --draft=false --latest=false
verify_tag
verify_downloads "$release_tmp/published"
