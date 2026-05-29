#!/bin/bash
## SmartPad-ANC — install/update script
## Called by Moonraker update_manager after git pull

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_HOME=$(eval echo ~"$(whoami)")
CONFIG_DIR="${USER_HOME}/printer_data/config"
SCRIPTS_DIR="${USER_HOME}/printer_data/scripts"
KLIPPER_EXTRAS="${USER_HOME}/klipper/klippy/extras"
MAINSAIL_DIR="${USER_HOME}/mainsail"

echo "SmartPad-ANC: Installing/updating..."

# Copy Klipper extras module
cp "${SCRIPT_DIR}/klipper/resonance_avoidance.py" "${KLIPPER_EXTRAS}/resonance_avoidance.py"
echo "  Klipper module updated"

# Copy sweep script
mkdir -p "${SCRIPTS_DIR}"
cp "${SCRIPT_DIR}/scripts/acoustic_sweep.py" "${SCRIPTS_DIR}/acoustic_sweep.py"
chmod +x "${SCRIPTS_DIR}/acoustic_sweep.py"
echo "  Sweep script updated"

# Copy macro config (only if not exists — don't overwrite user customizations)
if [ ! -f "${CONFIG_DIR}/smartpad-anc.cfg" ]; then
    cp "${SCRIPT_DIR}/config/smartpad-anc.cfg" "${CONFIG_DIR}/smartpad-anc.cfg"
    echo "  Config installed (new)"
else
    echo "  Config exists (not overwritten)"
fi

# Copy web viewer
cp "${SCRIPT_DIR}/web/anc.html" "${MAINSAIL_DIR}/anc.html" 2>/dev/null
echo "  Web viewer updated"

# Add include to printer.cfg if needed
if ! grep -q "smartpad-anc.cfg" "${CONFIG_DIR}/printer.cfg" 2>/dev/null; then
    sed -i "1i [include smartpad-anc.cfg]" "${CONFIG_DIR}/printer.cfg"
    echo "  Added [include smartpad-anc.cfg] to printer.cfg"
fi

# Add include to moonraker.conf if needed
if ! grep -q "update_smartpad_anc" "${CONFIG_DIR}/moonraker.conf" 2>/dev/null; then
    echo "" >> "${CONFIG_DIR}/moonraker.conf"
    echo "[include update_smartpad_anc.cfg]" >> "${CONFIG_DIR}/moonraker.conf"
    echo "  Added [include update_smartpad_anc.cfg] to moonraker.conf"
fi

# Copy update manager config
cp "${SCRIPT_DIR}/config/update_smartpad_anc.cfg" "${CONFIG_DIR}/update_smartpad_anc.cfg"

echo "SmartPad-ANC: Done."
