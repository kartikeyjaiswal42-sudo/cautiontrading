#!/bin/bash
# Deploy CautionTrading to GitHub via SSH (main + gh-pages static frontend)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
REPO="git@github.com:kartikeyjaiswal42-sudo/cautiontrading.git"
SSH="ssh -i $HOME/.ssh/id_ed25519_github -o IdentitiesOnly=yes"

echo "→ Pushing main branch via SSH…"
GIT_SSH_COMMAND="$SSH" git push "$REPO" main

echo "→ Building gh-pages static site from public/…"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if git ls-remote --heads "$REPO" gh-pages | grep -q gh-pages; then
  GIT_SSH_COMMAND="$SSH" git clone --depth 1 -b gh-pages "$REPO" "$WORK/site"
else
  GIT_SSH_COMMAND="$SSH" git clone --depth 1 "$REPO" "$WORK/site"
  cd "$WORK/site"
  git checkout --orphan gh-pages
  git reset --hard
fi

cd "$WORK/site"
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$ROOT/public/." .
touch .nojekyll

git add -A
if git diff --staged --quiet; then
  echo "   gh-pages unchanged"
else
  git commit -m "deploy: publish static frontend $(date +%Y-%m-%d)"
  GIT_SSH_COMMAND="$SSH" git push "$REPO" gh-pages
fi

echo ""
echo "✓ GitHub updated via SSH"
echo "  Repo:  https://github.com/kartikeyjaiswal42-sudo/cautiontrading"
echo "  Pages: https://kartikeyjaiswal42-sudo.github.io/cautiontrading/"
echo ""
echo "Note: GitHub Pages serves the UI only. The alert engine + API need the"
echo "Node server (npm start locally, or Render with Turso env vars for 24/7)."
