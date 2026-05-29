#!/bin/bash
## Yumi_ANC — Active Noise Canceling
## Install/update script — compatible with:
##   - Moonraker update_manager (live system)
##   - GitHub Actions chroot build (armbian image builder)
##   - Manual install (sudo ./install.sh)

# Detect user and home directory
REAL_USER="$USER"
OWNER=""

if [ -n "$SUDO_USER" ]; then
    if [ "$SUDO_USER" = "runner" ]; then
        # GitHub Actions / chroot build
        USER_HOME="/home/pi"
        OWNER="pi"
    else
        USER_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
        OWNER="$SUDO_USER"
    fi
else
    USER_HOME=$(getent passwd "$USER" | cut -d: -f6)
    OWNER="$USER"
fi

echo "Yumi_ANC install — user: ${OWNER}, home: ${USER_HOME}"

# Directories
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${USER_HOME}/printer_data/config"
SCRIPTS_DIR="${USER_HOME}/printer_data/scripts"
KLIPPER_EXTRAS="${USER_HOME}/klipper/klippy/extras"
MAINSAIL_DIR="${USER_HOME}/mainsail"

# Klipper extras module (symlink — repo stays clean for Moonraker)
if [ -d "${KLIPPER_EXTRAS}" ]; then
    ln -sf "${SCRIPT_DIR}/klipper/resonance_avoidance.py" "${KLIPPER_EXTRAS}/resonance_avoidance.py"
    echo "  Klipper module linked"
fi

# Sweep script (symlink)
mkdir -p "${SCRIPTS_DIR}"
ln -sf "${SCRIPT_DIR}/scripts/acoustic_sweep.py" "${SCRIPTS_DIR}/acoustic_sweep.py"
echo "  Sweep script linked"

# Macro config — symlink (like the .py/.html) so repo updates always
# propagate. The macro is project-managed (reads printer settings live), not
# user-edited, so there is nothing local to preserve. A previous cp + "only if
# missing" left the active file stale: repo edits (e.g. the XY-diagonal
# section) never reached the file Klipper actually reads.
ln -sf "${SCRIPT_DIR}/config/smartpad-anc.cfg" "${CONFIG_DIR}/smartpad-anc.cfg"
echo "  Config linked"

# Web viewer + Mainsail sidebar integration (symlinks)
if [ -d "${MAINSAIL_DIR}" ]; then
    # anc.html (standalone, loads anc_core.js) + native Mainsail panel.
    ln -sf "${SCRIPT_DIR}/web/anc.html" "${MAINSAIL_DIR}/anc.html"
    ln -sf "${SCRIPT_DIR}/web/anc_core.js" "${MAINSAIL_DIR}/anc_core.js"
    ln -sf "${SCRIPT_DIR}/web/anc_native.js" "${MAINSAIL_DIR}/anc_native.js"
    echo "  Web viewer + native panel linked"

    # Drop the old iframe inject if upgrading from it.
    rm -f "${MAINSAIL_DIR}/anc_inject.js"

    INDEX="${MAINSAIL_DIR}/index.html"
    if [ -f "${INDEX}" ]; then
        sed -i '/anc_inject.js/d' "${INDEX}"   # remove stale iframe tag
        if ! grep -q 'anc_native.js' "${INDEX}"; then
            sed -i 's|</body>|    <script src="/anc_native.js"></script>\n</body>|' "${INDEX}"
            echo "  Patched index.html with ANC native <script> tag"
        fi
    fi
fi

# Moonraker update manager config
cp "${SCRIPT_DIR}/config/update_smartpad_anc.cfg" "${CONFIG_DIR}/update_smartpad_anc.cfg" 2>/dev/null
[ -n "$OWNER" ] && chown "${OWNER}:${OWNER}" "${CONFIG_DIR}/update_smartpad_anc.cfg" 2>/dev/null

# Add [include smartpad-anc.cfg] to printer.cfg if needed
if [ -f "${CONFIG_DIR}/printer.cfg" ]; then
    if ! grep -q "smartpad-anc.cfg" "${CONFIG_DIR}/printer.cfg"; then
        sed -i "1i [include smartpad-anc.cfg]" "${CONFIG_DIR}/printer.cfg"
        echo "  Added [include smartpad-anc.cfg] to printer.cfg"
    fi
fi

# Add [include update_smartpad_anc.cfg] to moonraker.conf if needed
if [ -f "${CONFIG_DIR}/moonraker.conf" ]; then
    if ! grep -q "update_smartpad_anc" "${CONFIG_DIR}/moonraker.conf"; then
        echo "" >> "${CONFIG_DIR}/moonraker.conf"
        echo "[include update_smartpad_anc.cfg]" >> "${CONFIG_DIR}/moonraker.conf"
        echo "  Added [include update_smartpad_anc.cfg] to moonraker.conf"
    fi
fi

echo "Yumi_ANC: Done."
