#!/usr/bin/env bash
# Install the LearnHarness desktop client for the current user (no sudo):
#   ~/.local/bin/learnharness, a launcher entry, and the icon.
# Needs: rust/cargo, webkit2gtk-4.1 and gtk3 (CachyOS/Arch:
#   sudo pacman -S --needed rust webkit2gtk-4.1 gtk3).
# Uninstall: desktop/scripts/install-linux.sh --uninstall
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
bin="$HOME/.local/bin/learnharness"
app="$HOME/.local/share/applications/learnharness.desktop"
icon="$HOME/.local/share/icons/hicolor/512x512/apps/learnharness.png"

if [[ "${1:-}" == "--uninstall" ]]; then
	rm -f "$bin" "$app" "$icon"
	echo "Removed. Settings stay in ~/.config/dev.learnharness.desktop."
	exit 0
fi

(cd "$here" && cargo build --release --locked)
install -Dm755 "$here/target/release/learnharness" "$bin"
install -Dm644 "$here/icons/icon.png" "$icon"
mkdir -p "$(dirname "$app")"
cat > "$app" <<DESKTOP
[Desktop Entry]
Type=Application
Name=LearnHarness
Comment=Desktop client for a LearnHarness server
Exec=$bin
Icon=learnharness
Categories=Education;
StartupWMClass=learnharness
Terminal=false
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$app")" || true
echo "Installed $bin"
