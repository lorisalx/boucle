#!/usr/bin/env bash
# Compile BoucleApp et l'emballe en Boucle.app (bundle Dock + menu bar).
# Usage : ./build.sh [--run]
set -euo pipefail
cd "$(dirname "$0")"

CONFIG=release
APP="Boucle.app"
BIN_NAME="BoucleApp"

echo "▸ swift build ($CONFIG)…"
swift build -c "$CONFIG"
BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)/$BIN_NAME"

echo "▸ assemblage de $APP…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN_PATH" "$APP/Contents/MacOS/$BIN_NAME"
cp Info.plist "$APP/Contents/Info.plist"

# Signature avec une identité STABLE (pas ad-hoc). C'est la clé pour que macOS
# conserve les permissions TCC (micro + enregistrement d'écran → audio système)
# d'un build à l'autre : le « designated requirement » reste constant. Une
# signature ad-hoc change de cdhash à chaque compilation → macOS voit une
# « nouvelle app », redemande les permissions à chaque fois, et l'audio système
# finit par échouer (→ tout se retrouve étiqueté « Moi »).
# Override possible via $BOUCLE_SIGN_IDENTITY ; sinon on prend la 1re identité
# de code-signing du trousseau (typiquement le certif « Apple Development »).
IDENTITY="${BOUCLE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | grep -oE '[0-9A-F]{40}' | head -1)}"
if [[ -n "$IDENTITY" ]]; then
    echo "▸ codesign (identité stable $IDENTITY)…"
    codesign --force --deep --sign "$IDENTITY" "$APP"
else
    echo "⚠︎ Aucune identité de code-signing trouvée — repli ad-hoc."
    echo "  macOS redemandera les permissions micro/écran à CHAQUE build."
    echo "  Crée un certif 'Apple Development' (Xcode ▸ Settings ▸ Accounts) pour régler ça."
    codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
fi

echo "✓ $APP prêt."
if [[ "${1:-}" == "--run" ]]; then
    echo "▸ lancement…"
    open "$APP"
fi
