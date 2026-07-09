#!/usr/bin/env bash
# Download pristine Joomla full packages into the sources root, one folder per
# version (Joomla-<version>/), for the "vs Joomla" core-file diff.
#
#   JOOMLA_ROOT=./sample/joomla ./scripts/fetch-joomla.sh 3.9.21 4.4.4 5.2.6
#
# With no args a small default set is fetched. Requires: curl, unzip.
# Packages come from the official Joomla GitHub releases.
set -euo pipefail

ROOT="${JOOMLA_ROOT:-./sample/joomla}"
versions=("$@")
if [ ${#versions[@]} -eq 0 ]; then
  versions=(3.9.21 3.10.12 4.4.4 5.2.6)
fi

mkdir -p "$ROOT"
for v in "${versions[@]}"; do
  dest="$ROOT/Joomla-$v"
  if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
    echo "= Joomla-$v already present, skipping"
    continue
  fi
  url="https://github.com/joomla/joomla-cms/releases/download/$v/Joomla_$v-Stable-Full_Package.zip"
  tmp="$(mktemp -d)"
  echo "downloading $v"
  if ! curl -fSL "$url" -o "$tmp/j.zip"; then
    echo "  ! download failed for $v (verify the version / asset name at github.com/joomla/joomla-cms/releases)"
    rm -rf "$tmp"; continue
  fi
  mkdir -p "$dest"
  unzip -q "$tmp/j.zip" -d "$dest"
  rm -rf "$tmp"
  echo "  -> $dest"
done

echo "versions available in $ROOT:"
ls -1 "$ROOT"
