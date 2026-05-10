#!/usr/bin/env bash
# Run the Maestro screenshot flow against the booted iOS Simulator.
#
# Maestro requires Java; it's installed via `brew install openjdk` but
# Homebrew doesn't link it into PATH by default (because Apple ships its
# own Java tooling on macOS). We prepend it here so the script is
# self-contained.
#
# Run:  ./scripts/brand/capture-via-maestro.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
exec /Users/aman.shrivastava/.maestro/bin/maestro test "$REPO/scripts/brand/capture.maestro.yml"
