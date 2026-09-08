#!/usr/bin/env bash
# Build Metrik Studio as an AppImage and install it into the KDE Plasma application menu (user scope, no root).
#
#   ./install.sh            build + install
#   ./install.sh --matte    also build the RVM matting Docker image (~8 GB, one-time)
#   ./install.sh --uninstall
#
# Installs: ~/.local/bin/metrik-studio (the AppImage), icons under ~/.local/share/icons/hicolor,
#           ~/.local/share/applications/metrik-studio.desktop
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

APP_ID="metrik-studio"
BIN_DIR="$HOME/.local/bin"
ICON_DIR="$HOME/.local/share/icons/hicolor"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP="$DESKTOP_DIR/$APP_ID.desktop"
TARGET="$BIN_DIR/$APP_ID"

log() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$TARGET" "$DESKTOP"
  for s in 16 24 32 48 64 128 256 512; do rm -f "$ICON_DIR/${s}x${s}/apps/$APP_ID.png"; done
  rm -f "$ICON_DIR/scalable/apps/$APP_ID.svg"
  command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
  log "Uninstalled."; exit 0
fi

# ── prerequisites ─────────────────────────────────────────────────────────────
command -v node >/dev/null || die "node is required (found none on PATH)"
command -v npm  >/dev/null || die "npm is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "node >= 20 required, found $(node -v)"
for t in ffmpeg ffprobe; do command -v "$t" >/dev/null || echo "  (warning) $t not on PATH — post pipeline needs it"; done
command -v docker >/dev/null || echo "  (warning) docker not on PATH — Kokoro TTS and matting need it"

# ── build ─────────────────────────────────────────────────────────────────────
log "Installing dependencies"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

log "Bundling app"
node build.mjs

log "Building AppImage"
npx electron-builder --linux AppImage
APPIMAGE="$(ls -t release/*.AppImage | head -1)"
[[ -f "$APPIMAGE" ]] || die "AppImage not produced"

# ── install ───────────────────────────────────────────────────────────────────
log "Installing $APPIMAGE → $TARGET"
mkdir -p "$BIN_DIR" "$DESKTOP_DIR"
install -m 755 "$APPIMAGE" "$TARGET"

log "Installing icons"
for s in 16 24 32 48 64 128 256; do
  mkdir -p "$ICON_DIR/${s}x${s}/apps"; install -m 644 "build/icon-$s.png" "$ICON_DIR/${s}x${s}/apps/$APP_ID.png"
done
mkdir -p "$ICON_DIR/512x512/apps" "$ICON_DIR/scalable/apps"
install -m 644 build/icon.png "$ICON_DIR/512x512/apps/$APP_ID.png"
install -m 644 build/icon.svg "$ICON_DIR/scalable/apps/$APP_ID.svg"

log "Writing $DESKTOP"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Metrik Studio
GenericName=Video script studio
Comment=Script, rehearse, record, and cut Metrik Rule videos with Glitch
Exec=$TARGET %U
TryExec=$TARGET
Icon=$ICON_DIR/512x512/apps/$APP_ID.png
Terminal=false
Categories=AudioVideo;Video;AudioVideoEditing;Education;
Keywords=Glitch;Metrik;OBS;Kdenlive;teleprompter;script;
StartupWMClass=metrik-studio
StartupNotify=true
Actions=diagnose;obs-setup;

[Desktop Action diagnose]
Name=Run diagnostics
Exec=sh -c '$TARGET --diagnose | \${PAGER:-less}'
Terminal=true

[Desktop Action obs-setup]
Name=Set up the OBS scene
Exec=$TARGET --obs-setup
Terminal=true
EOF
chmod 644 "$DESKTOP"

if command -v update-desktop-database >/dev/null; then update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true; fi
if command -v gtk-update-icon-cache >/dev/null; then gtk-update-icon-cache -f -t "$ICON_DIR" >/dev/null 2>&1 || true; fi
rm -f "$HOME/.cache/icon-cache.kcache" 2>/dev/null || true
if command -v kbuildsycoca6 >/dev/null; then kbuildsycoca6 >/dev/null 2>&1 || true; fi
# the mscript CLI (Claude Code / shell editing of Script.yml files)
if [[ -f dist/cli/mscript.js ]]; then printf '#!/usr/bin/env bash\nexec node "%s/dist/cli/mscript.js" "$@"\n' "$PWD" > "$BIN_DIR/mscript"; chmod 755 "$BIN_DIR/mscript"; log "Installed $BIN_DIR/mscript (script CLI)"; fi

# ── optional: matting image ───────────────────────────────────────────────────
if [[ "${1:-}" == "--matte" ]]; then
  log "Building the metrik-matte Docker image (this downloads PyTorch + RVM weights)"
  docker build -t metrik-matte docker/matte
fi

log "Done. 'Metrik Studio' is in the application menu; CLI: $TARGET [--post <dir> [step] | --obs-setup | --diagnose]"
