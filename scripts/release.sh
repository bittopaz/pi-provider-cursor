#!/usr/bin/env bash
# Cut a release end to end over git distribution: bump, check, push, wait for
# CI, smoke the pushed commit through an isolated pi -e git: session, then
# tag. The tag stays last, after the artifact is proven installable.
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
if ! grep -q "^## \[$version\]" CHANGELOG.md; then
	echo "CHANGELOG.md has no '## [$version]' entry; write and commit it first" >&2
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
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated" >&2; exit 1; }

if [[ "$(node -p 'require("./package.json").version')" != "$version" ]]; then
	echo "== bump to $version =="
	npm version "$version" --no-git-tag-version
fi

echo "== checks =="
npm test
npm run typecheck
npm run build

if [[ -n "$(git status --porcelain)" ]]; then
	git add package.json package-lock.json
	command git commit -m "Release $version"
fi
git push origin main
sha="$(git rev-parse HEAD)"

echo "== wait for CI on $sha =="
run_id=""
for _ in $(seq 1 20); do
	run_id="$(gh run list --workflow=ci.yml --commit "$sha" --limit 1 -R "$repo" --json databaseId --jq '.[0].databaseId // empty')"
	[[ -n "$run_id" ]] && break
	sleep 3
done
if [[ -z "$run_id" ]]; then
	echo "no CI run appeared for $sha" >&2
	exit 1
fi
gh run watch "$run_id" --exit-status --interval 15 -R "$repo"

echo "== smoke pi -e git:github.com/$repo@$sha =="
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
if [[ ! -f "$HOME/.pi/agent/auth.json" ]]; then
	echo "smoke needs $HOME/.pi/agent/auth.json; pi hides providers that have no credential" >&2
	exit 1
fi
cp "$HOME/.pi/agent/auth.json" "$smoke_dir/"
if ! out="$(PI_CODING_AGENT_DIR="$smoke_dir" PI_SKIP_VERSION_CHECK=1 pi -e "git:github.com/$repo@$sha" --list-models cursor/ 2>&1)" || ! grep -q 'grok-4.6' <<<"$out"; then
	echo "smoke failed: git install of $sha did not list the cursor provider" >&2
	echo "$out" | tail -20 >&2
	exit 1
fi

echo "== tag =="
git tag "$tag"
git push origin "$tag"

echo "== github release =="
notes="$(awk -v v="$version" '
	index($0, "## [" v "]") == 1 {found=1; next}
	found && /^## / {exit}
	found {print}
' CHANGELOG.md | sed -e '1{/^$/d;}')"
gh release create "$tag" -R "$repo" --title "$tag" --notes "$notes" --verify-tag

echo "released $name@$version as $tag"
echo "install with: pi install git:github.com/$repo@$tag"
