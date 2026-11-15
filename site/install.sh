#!/bin/bash
# Installs Matters on a Mac (ADR 0139):
#
#   curl -fsSL https://getmatters.app/install.sh | bash
#
# It downloads the release the site offers, checks it, puts Matters.app in /Applications and
# opens it.
#
# Read this before you run it. A file fetched with curl is not marked as "from the internet", so
# macOS does not check the app when it first opens and shows no warning. This script does its own
# checks instead: the SHA-256 of the disk image against the release's SHA256SUMS.txt, the
# signature seal of the app, and, when the GitHub CLI (gh) is installed, the record that the
# image was built by this project's release workflow.
#
# Settings, all optional:
#   MATTERS_VERSION=0.1.0-alpha.5   a version other than the one the site offers
#   MATTERS_INSTALL_DIR=~/Applications   where Matters.app goes (default: /Applications)
#   MATTERS_NO_OPEN=1               do not open the app at the end
#   MATTERS_NO_ATTESTATION=1        do not ask gh for the build record

set -euo pipefail

REPO="milolabs/matters-app"
SITE="https://getmatters.app"
WORKFLOW="$REPO/.github/workflows/release.yml"

say() { printf '\342\206\222 %s\n' "$*"; }
ok() { printf '\342\234\223 %s\n' "$*"; }
fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

tmp=""
volume=""
dest=""
lock=""     # a folder in $dest that says an install is under way there; ours once we made it
incoming="" # the new app, copied beside the old one
previous="" # the old app, moved aside until the new one is in place
cleanup() {
  set +e # every step below runs, whatever the one before it did
  if [ -n "$volume" ] && [ -d "$volume" ]; then
    hdiutil detach "$volume" -quiet 2>/dev/null || hdiutil detach "$volume" -force -quiet 2>/dev/null || true
  fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
  # Stopped half way: the old app goes back where it was.
  if [ -n "$previous" ] && [ -e "$previous" ] && [ ! -e "$dest/Matters.app" ]; then
    mv "$previous" "$dest/Matters.app" || true
  fi
  if [ -n "$incoming" ]; then rm -rf "$incoming"; fi
  if [ -n "$lock" ]; then rmdir "$lock" 2>/dev/null || true; fi
}

# Is the copy in $dest running? Only that copy: a Matters started from somewhere else is left alone.
# grep reads the whole list (no -q): stopping at the first match could break the pipe under ps,
# and with pipefail that would read as "not running".
running() { ps -axo comm= | grep -F "$dest/Matters.app/Contents/" > /dev/null; }

fetch() { # fetch <url> <file> [curl options]
  local url="$1" file="$2"
  shift 2
  curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$@" --output "$file" "$url"
}

# Everything runs from here, called on the last line: a download of this script that was cut
# short runs nothing.
main() {
  [ "$(uname -s)" = "Darwin" ] || fail "Matters runs on macOS only, for now."
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ] ||
    fail "Matters needs a Mac with Apple silicon, for now."

  tmp="$(mktemp -d)"
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP # a stop from outside still goes through cleanup

  # Which version: the one named, or the one the site's download button offers.
  local tag="${MATTERS_VERSION:-}"
  if [ -z "$tag" ]; then
    fetch "$SITE/release.json" "$tmp/release.json" || fail "could not read $SITE/release.json."
    tag="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$tmp/release.json" | head -n 1)"
    [ -n "$tag" ] || fail "there is no release to install yet. See https://github.com/$REPO/releases"
  fi
  tag="v${tag#v}"
  # The version becomes part of an address and a file name: it must look like a version.
  printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$' ||
    fail "\"$tag\" is not a version."

  local version="${tag#v}"
  local image="Matters-$version-arm64.dmg"
  local base="https://github.com/$REPO/releases/download/$tag"

  dest="${MATTERS_INSTALL_DIR:-/Applications}"
  [ -d "$dest" ] || fail "$dest is not a folder."
  # The folder as the system names it: no "..", no trailing slash, no link. The check for a
  # running copy compares paths, so it needs the same spelling the system uses.
  dest="$(cd "$dest" && pwd -P)" || fail "could not open the install folder."
  [ -w "$dest" ] || fail "you cannot write to $dest. Set MATTERS_INSTALL_DIR to a folder of your own, such as ~/Applications."
  if running; then fail "Matters is running. Quit it, then run this again."; fi

  # One install into a folder at a time. mkdir either makes the folder or fails: there is no
  # moment in which two runs both have it.
  if ! mkdir "$dest/.Matters.app.lock" 2> /dev/null; then
    fail "another install into $dest is under way. If none is, remove $dest/.Matters.app.lock and run this again."
  fi
  lock="$dest/.Matters.app.lock"

  say "Downloading Matters $version"
  fetch "$base/$image" "$tmp/$image" --progress-bar || fail "could not download $base/$image"
  fetch "$base/SHA256SUMS.txt" "$tmp/SHA256SUMS.txt" || fail "could not download the checksums."

  # The line for the image, checked by shasum itself. No line, or a different sum: stop.
  grep -F "  $image" "$tmp/SHA256SUMS.txt" > "$tmp/sum.txt" || fail "SHA256SUMS.txt does not list $image."
  (cd "$tmp" && shasum -a 256 -c sum.txt > /dev/null 2>&1) ||
    fail "the download does not match its checksum. Nothing was installed."
  ok "The checksum matches"

  # Where it was built. The checksum only says the download is whole; this says whose it is.
  if [ -n "${MATTERS_NO_ATTESTATION:-}" ]; then
    :
  elif command -v gh > /dev/null 2>&1; then
    fetch "$base/$image.intoto.jsonl" "$tmp/$image.intoto.jsonl" || fail "could not download the build record."
    if gh attestation verify "$tmp/$image" --repo "$REPO" --signer-workflow "$WORKFLOW" \
      --bundle "$tmp/$image.intoto.jsonl" < /dev/null > "$tmp/attestation.txt" 2>&1; then
      ok "Built by the release workflow of $REPO"
    else
      cat "$tmp/attestation.txt" >&2
      fail "gh could not confirm where this build comes from. Nothing was installed. (MATTERS_NO_ATTESTATION=1 skips this check.)"
    fi
  else
    say "Not checked: where it was built. With the GitHub CLI installed, this script checks that too."
  fi

  volume="$tmp/volume"
  hdiutil attach "$tmp/$image" -nobrowse -readonly -noautoopen -mountpoint "$volume" > /dev/null ||
    fail "could not open the disk image."
  [ -d "$volume/Matters.app" ] || fail "the disk image holds no Matters.app."

  say "Installing into $dest"
  # Copied beside the old one and checked first, so a failure leaves the old one in place.
  local replaced=""
  # What a run that was killed outright may have left: its old app goes back first.
  if [ -e "$dest/.Matters.app.previous" ] && [ ! -e "$dest/Matters.app" ]; then
    mv "$dest/.Matters.app.previous" "$dest/Matters.app"
  fi
  rm -rf "$dest/.Matters.app.installing" "$dest/.Matters.app.previous"
  incoming="$dest/.Matters.app.installing"
  ditto "$volume/Matters.app" "$incoming" || fail "could not copy the app to $dest."
  codesign --verify --deep --strict "$incoming" 2> /dev/null ||
    fail "the app's signature does not hold. Nothing was installed."
  # Again, now: Matters may have been started while this was downloading.
  if running; then fail "Matters is running. Quit it, then run this again. Nothing was installed."; fi
  # The old app is moved aside, not deleted, until the new one is in its place. If this stops
  # in between, cleanup moves it back.
  if [ -e "$dest/Matters.app" ]; then
    replaced=1
    previous="$dest/.Matters.app.previous"
    mv "$dest/Matters.app" "$previous" || fail "could not move the old Matters aside. Nothing was installed."
  fi
  mv "$incoming" "$dest/Matters.app" || fail "could not put the new Matters in place. The old one is back."
  incoming=""
  if [ -n "$previous" ]; then
    rm -rf "$previous"
    previous=""
  fi

  if [ -n "${MATTERS_NO_OPEN:-}" ]; then
    ok "Installed $dest/Matters.app"
  else
    open "$dest/Matters.app"
    ok "Opened $dest/Matters.app"
  fi
  if [ -n "$replaced" ]; then
    echo "  It replaced the Matters that was there. macOS may ask for your login password once,"
    echo "  so the new build can read the mail passwords the old one stored."
  fi
}

main "$@"
