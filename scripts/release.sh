#!/usr/bin/env bash
# Cut a release. Local phase: bump, date the Unreleased CHANGELOG section,
# check, commit "Release v…", tag, open the next Unreleased section, push
# main and the tag. The tag push triggers the release workflow, which verifies
# the exact tag and creates the GitHub Release.
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "usage: mise run release <major.minor.patch>, for example: mise run release 0.0.1" >&2
	exit 1
fi

cd "$(git rev-parse --show-toplevel)"
name="$(node -p 'require("./package.json").name')"
tag="v$version"
repo="$(git remote get-url origin | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##')"

echo "== guards =="
if [[ -n "$(git status --porcelain)" ]]; then
	echo "working tree is not clean; commit or stash first" >&2
	exit 1
fi
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
	echo "tag $tag already exists" >&2
	exit 1
fi
git fetch --quiet origin main
if ! git merge-base --is-ancestor origin/main HEAD; then
	echo "main is behind origin/main; rebase first" >&2
	exit 1
fi
if ! awk '
	/^## \[Unreleased\]/ {found=1; next}
	found && /^## / {exit}
	found && NF {content=1}
	END {exit !content}
' CHANGELOG.md; then
	echo "CHANGELOG.md has no '## [Unreleased]' entry with content; write and commit it first" >&2
	exit 1
fi
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated" >&2; exit 1; }

echo "== bump to $version =="
npm version "$version" --no-git-tag-version
date="$(date -u +%Y-%m-%d)"
awk -v heading="## [$version] - $date" '
	!done && /^## \[Unreleased\]/ {print heading; done=1; next}
	{print}
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

echo "== checks =="
npm test
npm run typecheck
npm run build

git add package.json package-lock.json CHANGELOG.md
command git commit -m "Release $tag"
git tag "$tag"

echo "== open the next cycle =="
awk '
	!done && /^## \[/ {print "## [Unreleased]"; print ""; done=1}
	{print}
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
git add CHANGELOG.md
command git commit -m "Add [Unreleased] section for next cycle"

git push origin main "$tag"

echo "released $name@$version as $tag"
echo "the tag-triggered release workflow verifies the tag and creates the GitHub Release"
echo "install with: pi install git:github.com/$repo@$tag"
