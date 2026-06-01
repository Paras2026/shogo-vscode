#!/usr/bin/env bash
# Rebuilds the shogo-vscode folder structure from this gist's flat files.
# Usage: bash unpack.sh   (run inside the cloned gist folder)
set -e
mkdir -p shogo-vscode/src shogo-vscode/media shogo-vscode/.vscode
for f in *; do
  case "$f" in
    unpack.sh|README.md) continue;;
  esac
  dest="shogo-vscode/$(echo "$f" | sed 's|__|/|g')"
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
done
echo "Done. Now run:"
echo "  cd shogo-vscode && npm install && npm run package"
echo "  code --install-extension shogo-vscode-0.0.1.vsix"
