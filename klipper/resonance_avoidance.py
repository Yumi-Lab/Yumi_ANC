"""
Klipper extras module: resonance_avoidance (Yumi-ANC)

Avoids cruise speeds that cause chassis resonance by intercepting
moves via the kinematics check_move() method — before trapezoid
planning, which is cleaner and more precise than wrapping ToolHead.move().

Config:
  [resonance_avoidance]
  enabled: True
  avoidance_margin: 5          # +/- mm/s around each peak
  avoidance_zones_x: 100, 275, 375, 585
  avoidance_zones_y: 120, 330
  avoidance_zones_z:
"""

import logging
import math


class ResonanceAvoidance:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.enabled = config.getboolean('enabled', True)
        self.margin = config.getfloat('avoidance_margin', 5.0,
                                       minval=1.0, maxval=50.0)
        self.margin_z = config.getfloat('avoidance_margin_z', 1.0,
                                         minval=0.5, maxval=10.0)

        # Try to load zones from resonance_zones.cfg (managed by Python script)
        self.zones_x = []
        self.zones_y = []
        self.zones_z = []
        # Measurement grid per axis (min_speed, step) — used to snap a clamped
        # move back onto a speed that was actually swept and validated quiet,
        # instead of landing at lo-0.1 on the very edge of the forbidden band.
        self.grid_x = (
            config.getfloat('grid_min_x', 20.0, minval=1.0),
            config.getfloat('grid_step_x', 10.0, minval=0.5))
        self.grid_y = (
            config.getfloat('grid_min_y', 20.0, minval=1.0),
            config.getfloat('grid_step_y', 10.0, minval=0.5))
        self.grid_z = (
            config.getfloat('grid_min_z', 5.0, minval=1.0),
            config.getfloat('grid_step_z', 1.0, minval=0.5))
        self._load_zones_file()

        # Build zone intervals (X/Y use margin, Z uses margin_z)
        self._rebuild_intervals()

        # Stats
        self.moves_clamped = 0
        self.moves_total = 0

        # Hook into kinematics after connect
        self.printer.register_event_handler(
            "klippy:connect", self._handle_connect)

        # GCode commands
        gcode = self.printer.lookup_object('gcode')
        gcode.register_command(
            'RESONANCE_AVOIDANCE_STATUS', self.cmd_STATUS,
            desc="Show ANC status and zones")
        gcode.register_command(
            'RESONANCE_AVOIDANCE_ENABLE', self.cmd_ENABLE,
            desc="Enable ANC")
        gcode.register_command(
            'RESONANCE_AVOIDANCE_DISABLE', self.cmd_DISABLE,
            desc="Disable ANC")
        gcode.register_command(
            'SET_RESONANCE_MARGIN', self.cmd_SET_MARGIN,
            desc="Set avoidance margin")
        gcode.register_command(
            'SET_RESONANCE_ZONES', self.cmd_SET_ZONES,
            desc="Update avoidance zones live (no restart)")
        gcode.register_command(
            'RESONANCE_AVOIDANCE_RELOAD', self.cmd_RELOAD,
            desc="Re-read resonance_zones.cfg from disk (after a sweep)")

        self._log_config()

    def _load_zones_file(self):
        """Load zones from resonance_zones.cfg if it exists.

        This file is managed by acoustic_sweep.py, not by Klipper config.
        No [include] needed — the module reads it directly.
        """
        import os
        zones_path = os.path.expanduser(
            "~/printer_data/config/resonance_zones.cfg")
        if not os.path.exists(zones_path):
            logging.info("resonance_avoidance: no zones file yet (not calibrated)")
            return

        try:
            with open(zones_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or not line:
                        continue
                    if '=' in line or ':' in line:
                        sep = '=' if '=' in line else ':'
                        key, val = line.split(sep, 1)
                        key = key.strip()
                        val = val.strip()
                        if key == 'avoidance_zones_x':
                            self.zones_x = self._parse_peaks(val)
                        elif key == 'avoidance_zones_y':
                            self.zones_y = self._parse_peaks(val)
                        elif key == 'avoidance_zones_z':
                            self.zones_z = self._parse_peaks(val)
                        elif key == 'avoidance_margin':
                            try: self.margin = float(val)
                            except ValueError: pass
                        elif key == 'avoidance_margin_z':
                            try: self.margin_z = float(val)
                            except ValueError: pass
                        elif key in ('grid_min_x', 'grid_step_x',
                                     'grid_min_y', 'grid_step_y',
                                     'grid_min_z', 'grid_step_z'):
                            try:
                                fv = float(val)
                                axis = key[-1]
                                lo, step = getattr(self, 'grid_' + axis)
                                if key.startswith('grid_min'):
                                    setattr(self, 'grid_' + axis, (fv, step))
                                else:
                                    setattr(self, 'grid_' + axis, (lo, fv))
                            except ValueError:
                                pass
                        elif key == 'enabled':
                            self.enabled = val.lower() in ('true', '1', 'yes')
            logging.info("resonance_avoidance: loaded zones from %s", zones_path)
        except Exception as e:
            logging.info("resonance_avoidance: could not read zones file: %s", e)

    def _rebuild_intervals(self):
        """Rebuild avoidance intervals from current zones + margins."""
        self.intervals_x = self._build_intervals(self.zones_x, self.margin)
        self.intervals_y = self._build_intervals(self.zones_y, self.margin)
        self.intervals_z = self._build_intervals(self.zones_z, self.margin_z)

    def _parse_peaks(self, peaks_str):
        peaks = []
        if not peaks_str.strip():
            return peaks
        for entry in peaks_str.split(','):
            entry = entry.strip()
            if not entry:
                continue
            try:
                speed = float(entry)
                if speed > 0:
                    peaks.append(speed)
            except ValueError:
                raise self.printer.config_error(
                    "resonance_avoidance: invalid speed '%s'" % entry)
        peaks.sort()
        return peaks

    def _build_intervals(self, peaks, margin=None):
        """Build sorted, merged avoidance intervals from peak list."""
        if not peaks:
            return []
        if margin is None:
            margin = self.margin
        intervals = [(max(1.0, p - margin), p + margin) for p in peaks]
        # Merge overlapping
        intervals.sort()
        merged = [intervals[0]]
        for lo, hi in intervals[1:]:
            if lo <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
            else:
                merged.append((lo, hi))
        return merged

    def _snap_down(self, speed, intervals, grid):
        """Clamp speed out of any avoidance interval, DOWNWARD, onto the
        measurement grid.

        We never bump up (slower is always acoustically safer and within
        limits). And we don't stop at lo-0.1 on the edge of the forbidden
        band — that speed was never swept. Instead we snap to the nearest
        grid point at or below the band: a speed that was actually measured
        and validated quiet during calibration.
        """
        in_zone = False
        for lo, hi in intervals:
            if lo <= speed <= hi:
                in_zone = True
                break
        if not in_zone:
            return speed

        gmin, gstep = grid
        if gstep and gstep > 0:
            # Largest grid point strictly below the move's requested speed.
            n = math.floor((speed - gmin) / gstep + 1e-9)
            cand = gmin + n * gstep
            while cand >= gmin:
                if not any(lo <= cand <= hi for lo, hi in intervals):
                    return cand
                cand -= gstep
        # Fallback: just below the band, clamped to the grid minimum.
        return max(gmin, 1.0)

    def _log_config(self):
        total = len(self.zones_x) + len(self.zones_y) + len(self.zones_z)
        if total:
            logging.info("resonance_avoidance: margin=+/-%.0f mm/s", self.margin)
            for axis, zones in [('X', self.zones_x), ('Y', self.zones_y),
                                ('Z', self.zones_z)]:
                if zones:
                    logging.info("  %s: %s mm/s", axis,
                                 ", ".join(str(int(z)) for z in zones))
        else:
            logging.info("resonance_avoidance: no zones configured")

    def _handle_connect(self):
        """Wrap kinematics check_move() for pre-planning speed clamping."""
        has_zones = self.zones_x or self.zones_y or self.zones_z
        if not self.enabled or not has_zones:
            return

        toolhead = self.printer.lookup_object('toolhead')
        kin = toolhead.get_kinematics()

        # Wrap check_move — called before trapezoid planning
        self._orig_check_move = kin.check_move
        kin.check_move = self._wrapped_check_move
        logging.info("resonance_avoidance: hooked into kinematics.check_move()")

    def _wrapped_check_move(self, move):
        """Clamp move speed before kinematics validates it.

        Called by ToolHead for every move before trapezoid generation.
        The move object has .axes_d (displacement per axis) and
        .max_cruise_v2 which we can reduce.
        """
        self.moves_total += 1

        if not self.enabled:
            return self._orig_check_move(move)

        # Get axis displacements
        axes_d = move.axes_d
        dx, dy, dz = abs(axes_d[0]), abs(axes_d[1]), abs(axes_d[2])
        move_d = move.move_d
        if move_d < 0.001:
            return self._orig_check_move(move)

        # Current planned cruise speed
        cruise_v = math.sqrt(move.max_cruise_v2)

        # Compute per-axis speed components
        # For cartesian: axis_speed = cruise_speed * (axis_displacement / total_displacement)
        # For corexy: both X and Y move together, but the resonance
        # still maps to the physical axis speed
        x_ratio = dx / move_d if move_d > 0 else 0
        y_ratio = dy / move_d if move_d > 0 else 0
        z_ratio = dz / move_d if move_d > 0 else 0

        new_cruise_v = cruise_v
        clamped = False

        # Check X component
        if x_ratio > 0.3 and self.intervals_x:
            x_speed = cruise_v * x_ratio
            x_safe = self._snap_down(x_speed, self.intervals_x, self.grid_x)
            if x_safe != x_speed:
                # Scale total speed to keep X component safe
                new_cruise_v = min(new_cruise_v, x_safe / x_ratio)
                clamped = True

        # Check Y component
        if y_ratio > 0.3 and self.intervals_y:
            y_speed = cruise_v * y_ratio
            y_safe = self._snap_down(y_speed, self.intervals_y, self.grid_y)
            if y_safe != y_speed:
                new_cruise_v = min(new_cruise_v, y_safe / y_ratio)
                clamped = True

        # Check Z component
        if z_ratio > 0.3 and self.intervals_z:
            z_speed = cruise_v * z_ratio
            z_safe = self._snap_down(z_speed, self.intervals_z, self.grid_z)
            if z_safe != z_speed:
                new_cruise_v = min(new_cruise_v, z_safe / z_ratio)
                clamped = True

        if clamped:
            self.moves_clamped += 1
            new_cruise_v = max(1.0, new_cruise_v)
            new_v2 = new_cruise_v * new_cruise_v
            move.max_cruise_v2 = new_v2
            # Also limit start velocity (short moves may never reach cruise)
            move.max_start_v2 = min(move.max_start_v2, new_v2)

        return self._orig_check_move(move)

    def cmd_STATUS(self, gcmd):
        gcmd.respond_info(
            "Yumi-ANC: %s, margin=+/-%.0f mm/s" %
            ("ENABLED" if self.enabled else "DISABLED", self.margin))
        for axis, zones in [('X', self.zones_x), ('Y', self.zones_y),
                            ('Z', self.zones_z)]:
            if zones:
                gcmd.respond_info("  %s: %s mm/s" %
                                  (axis, ", ".join(str(int(z)) for z in zones)))
        if self.moves_total > 0:
            pct = 100.0 * self.moves_clamped / self.moves_total
            gcmd.respond_info("  Stats: %d/%d moves clamped (%.1f%%)" %
                              (self.moves_clamped, self.moves_total, pct))

    def cmd_ENABLE(self, gcmd):
        has_zones = self.zones_x or self.zones_y or self.zones_z
        if not has_zones:
            gcmd.respond_info("No zones. Run ACOUSTIC_SPEED_SWEEP first.")
            return
        self.enabled = True
        if not hasattr(self, '_orig_check_move'):
            self._handle_connect()
        gcmd.respond_info("Yumi-ANC ENABLED")

    def cmd_DISABLE(self, gcmd):
        self.enabled = False
        gcmd.respond_info("Yumi-ANC DISABLED")

    def cmd_SET_MARGIN(self, gcmd):
        margin = gcmd.get_float('MARGIN', None, minval=1.0, maxval=50.0)
        margin_z = gcmd.get_float('MARGIN_Z', None, minval=0.5, maxval=10.0)
        if margin is not None:
            self.margin = margin
        if margin_z is not None:
            self.margin_z = margin_z
        self._rebuild_intervals()
        gcmd.respond_info("Margin XY=+/-%.0f Z=+/-%.0f mm/s" %
                          (self.margin, self.margin_z))

    def cmd_RELOAD(self, gcmd):
        """Re-read resonance_zones.cfg from disk and apply live.

        Used right after a sweep: cmd_stop writes fresh zones to the file, but
        the module still holds the old in-memory zones. This reloads them
        without a FIRMWARE_RESTART so ENABLE then activates the new zones.
        """
        self.zones_x = []
        self.zones_y = []
        self.zones_z = []
        self._load_zones_file()
        self._rebuild_intervals()
        self.moves_clamped = 0
        self.moves_total = 0
        if not hasattr(self, '_orig_check_move') and \
           (self.zones_x or self.zones_y or self.zones_z):
            self._handle_connect()
        gcmd.respond_info("Zones reloaded from disk:")
        for axis, zones in [('X', self.zones_x), ('Y', self.zones_y),
                            ('Z', self.zones_z)]:
            gcmd.respond_info("  %s: %s" % (axis,
                ", ".join(str(int(z)) for z in zones) if zones else "none"))

    def cmd_SET_ZONES(self, gcmd):
        """Update avoidance zones live — no restart needed.

        Usage: SET_RESONANCE_ZONES ZONES_X="100,275,375" ZONES_Y="120" ZONES_Z="11"
        Omit an axis to keep its current zones. Use "" to clear.
        """
        changed = False
        for axis, attr in [('X', 'zones_x'), ('Y', 'zones_y'), ('Z', 'zones_z')]:
            param = gcmd.get('ZONES_' + axis, None)
            if param is not None:
                new_zones = self._parse_peaks(param)
                setattr(self, attr, new_zones)
                changed = True

        if changed:
            self._rebuild_intervals()
            # Reset stats
            self.moves_clamped = 0
            self.moves_total = 0
            # Hook if not already
            if not hasattr(self, '_orig_check_move') and \
               (self.zones_x or self.zones_y or self.zones_z):
                self._handle_connect()

        gcmd.respond_info("Zones updated live:")
        for axis, zones in [('X', self.zones_x), ('Y', self.zones_y),
                            ('Z', self.zones_z)]:
            gcmd.respond_info("  %s: %s" % (axis,
                ", ".join(str(int(z)) for z in zones) if zones else "none"))

    def get_status(self, eventtime):
        return {
            'enabled': self.enabled,
            'margin': self.margin,
            'margin_z': self.margin_z,
            'zones_x': list(self.zones_x),
            'zones_y': list(self.zones_y),
            'zones_z': list(self.zones_z),
            'moves_clamped': self.moves_clamped,
            'moves_total': self.moves_total,
        }


def load_config(config):
    return ResonanceAvoidance(config)
