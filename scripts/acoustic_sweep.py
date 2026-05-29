#!/usr/bin/env python3
"""
Yumi-ANC — Active Noise Canceling for Klipper.

Microphone-based chassis resonance detection. Uses the SmartPad built-in
microphone to identify cruise speeds that cause frame resonance on each axis,
then generates avoidance zones for the Klipper motion planner.

Architecture:
  - "start" launches a CONTINUOUS background recording (arecord process)
  - The Klipper macro chains all moves without any pause
  - "mark <speed> <axis>" writes a timestamp marker (instant, non-blocking)
  - "stop" kills recording, slices audio by markers, analyzes each segment

This eliminates all pauses — the macro just does moves back-to-back.

Commands:
    acoustic_sweep.py start <min> <max> <step>
    acoustic_sweep.py mark <speed> <axis>
    acoustic_sweep.py stop
    acoustic_sweep.py clear
    acoustic_sweep.py analyze

Output:
  - /home/pi/printer_data/config/resonance_zones.cfg  (Klipper config)
  - /home/pi/mainsail/acoustic_data.json              (web viewer data)
"""

import sys
import os
import time
import json
import csv
import signal
import subprocess
import numpy as np

DATA_DIR = os.path.expanduser("~/printer_data/config")
WEB_DIR = os.path.expanduser("~/mainsail")
STATE_FILE = os.path.join(DATA_DIR, ".acoustic_state.json")
MARKERS_FILE = os.path.join(DATA_DIR, ".acoustic_markers.jsonl")
RAW_WAV = os.path.join(DATA_DIR, ".acoustic_raw.wav")
RAW_CSV = os.path.join(DATA_DIR, "acoustic_profile.csv")
ZONES_CFG = os.path.join(DATA_DIR, "resonance_zones.cfg")
WEB_JSON = os.path.join(WEB_DIR, "acoustic_data.json")
PID_FILE = os.path.join(DATA_DIR, ".acoustic_pid")

SAMPLE_RATE = 16000  # 16kHz — enough for 100-800Hz band, 2.7x less RAM than 44100
BANDPASS_LOW = 100
BANDPASS_HIGH = 800


def setup_alsa_mixer():
    """Configure ALSA mixer for SmartPad H3 analog codec MIC1."""
    for cmd in [
        ['amixer', 'cset', 'numid=18', 'on,on'],    # Mic1 Capture on
        ['amixer', 'cset', 'numid=19', 'off,off'],   # Mic2 Capture off
        ['amixer', 'cset', 'numid=8', '2'],           # Mic1 Boost = 2 (+30dB)
        ['amixer', 'cset', 'numid=9', '1'],           # ADC Gain = 1 (-3dB)
    ]:
        subprocess.run(cmd, capture_output=True, check=False)
    print("ALSA: Mic1 on, boost=0, gain=0")


def cmd_start(args):
    """Start continuous background recording + record baseline."""
    speed_min = int(args[0])
    speed_max = int(args[1])
    speed_step = int(args[2])

    setup_alsa_mixer()

    # Clean previous run
    for f in [MARKERS_FILE, RAW_WAV, PID_FILE]:
        if os.path.exists(f):
            os.remove(f)

    # Record 3s baseline first (blocking)
    print("Recording 3s baseline...")
    baseline_wav = os.path.join(DATA_DIR, ".baseline.wav")
    subprocess.run([
        'arecord', '-D', 'hw:0,0', '-f', 'S16_LE', '-r', str(SAMPLE_RATE),
        '-c', '1', '-d', '3', baseline_wav
    ], capture_output=True, check=True)
    # Compute baseline dB for live delta calculation
    bl_samples = _load_wav(baseline_wav)
    bl_fft, bl_freqs = _compute_fft(bl_samples)
    bl_mask = (bl_freqs >= BANDPASS_LOW) & (bl_freqs <= BANDPASS_HIGH)
    bl_energy = float(np.sqrt(np.mean(bl_fft[bl_mask] ** 2)))
    baseline_db = 20.0 * np.log10(bl_energy) if bl_energy > 0 else -100
    # Save normalized baseline FFT for spectral subtraction (live + stop analysis)
    bl_fft_norm = bl_fft / len(bl_samples)
    np.save(os.path.join(DATA_DIR, ".baseline_fft_norm.npy"), bl_fft_norm)
    print(f"Baseline: {baseline_db:.1f} dB (fans filtered)")

    # Publish baseline spectrum to live viewer (machine idle reference)
    max_freq = min(2000, SAMPLE_RATE / 2)
    freq_mask = bl_freqs <= max_freq
    spec_bl = bl_fft[freq_mask]
    n_bins = 64
    bin_size = max(1, len(spec_bl) // n_bins)
    spectrum = []
    for bi in range(0, min(len(spec_bl), n_bins * bin_size), bin_size):
        chunk = spec_bl[bi:bi+bin_size]
        val = float(np.max(chunk))
        db = 20.0 * np.log10(val) if val > 1e-10 else -100
        spectrum.append(round(db, 1))

    live_file = os.path.join(WEB_DIR, "anc_live.json")
    with open(live_file, 'w') as f:
        json.dump({
            "speed": 0, "axis": "baseline",
            "t": time.time(),
            "spectrum": spectrum,
            "freq_max": max_freq, "bins": len(spectrum)
        }, f)
    print("Baseline spectrum published to live viewer")

    # Start continuous recording in background (will run until killed)
    # Record for max 20 minutes (enough for full XYZ sweep)
    proc = subprocess.Popen([
        'arecord', '-D', 'hw:0,0', '-f', 'S16_LE', '-r', str(SAMPLE_RATE),
        '-c', '1', '-d', '1200', RAW_WAV
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Save PID for stop command
    with open(PID_FILE, 'w') as f:
        f.write(str(proc.pid))

    # Clear previous web JSON (avoid overlapping curves)
    if os.path.exists(WEB_JSON):
        os.remove(WEB_JSON)

    # Save state
    state = {
        "speed_min": speed_min,
        "speed_max": speed_max,
        "speed_step": speed_step,
        "record_pid": proc.pid,
        "record_start": time.time(),
        "baseline_db": baseline_db,
        "status": "recording"
    }
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f)

    # Initialize empty markers file
    with open(MARKERS_FILE, 'w') as f:
        pass

    print(f"Recording started (PID {proc.pid}). Sweep: {speed_min}-{speed_max}, step {speed_step}")


def cmd_mark(args):
    """Write a timestamp marker + compute live dB from growing WAV.

    Reads the last ~1s of the WAV being recorded by the background arecord
    process, computes dB delta vs baseline, and updates the web JSON in
    real-time so the graph builds live during calibration.
    """
    speed = int(args[0])
    axis = args[1].lower() if len(args) > 1 else 'x'

    # Read audio BEFORE writing marker — the audio is from the PREVIOUS speed
    # (the current move hasn't started yet when mark is called)
    prev_speed = None
    prev_axis = axis
    if os.path.exists(MARKERS_FILE):
        with open(MARKERS_FILE, 'r') as f:
            lines = f.readlines()
            if lines:
                prev = json.loads(lines[-1].strip())
                prev_speed = prev["speed"]
                prev_axis = prev["axis"]

    # Read live audio (corresponds to previous speed's movement)
    live_db, spectrum = _read_live_db()
    if prev_speed is not None:
        _live_update(prev_speed, prev_axis, live_db)
        _save_live_spectrum(prev_speed, prev_axis, spectrum)

    # Now write the new marker
    marker = {
        "t": time.time(),
        "speed": speed,
        "axis": axis
    }
    with open(MARKERS_FILE, 'a') as f:
        f.write(json.dumps(marker) + '\n')


def _read_live_db():
    """Read last ~1s of the growing WAV and compute spectral-subtracted dB.

    Uses baseline FFT saved in state to subtract fan/ambient frequencies,
    leaving only motion-induced resonance energy.
    """
    try:
        with open(STATE_FILE, 'r') as f:
            state = json.load(f)
        baseline_db = state.get("baseline_db")
        if baseline_db is None:
            return None, None

        # Load baseline FFT for subtraction
        baseline_npy = os.path.join(DATA_DIR, ".baseline_fft_norm.npy")
        if not os.path.exists(baseline_npy):
            return None, None
        bl_fft_norm = np.load(baseline_npy)

        # Read last 1 second of raw PCM from the growing WAV
        chunk_samples = SAMPLE_RATE
        chunk_bytes = chunk_samples * 2
        wav_header = 44

        file_size = os.path.getsize(RAW_WAV)
        if file_size < wav_header + chunk_bytes:
            return None, None

        with open(RAW_WAV, 'rb') as f:
            f.seek(file_size - chunk_bytes)
            raw = f.read(chunk_bytes)

        import struct
        n = len(raw) // 2
        samples = np.array(struct.unpack('<%dh' % n, raw), dtype=np.float64)
        samples -= np.mean(samples)

        fft_vals = np.abs(np.fft.rfft(samples))
        freqs = np.fft.rfftfreq(len(samples), 1.0 / SAMPLE_RATE)

        # Spectral subtraction — remove fan frequencies
        fft_norm = fft_vals / len(samples)
        min_len = min(len(fft_norm), len(bl_fft_norm))
        cleaned = np.maximum(fft_norm[:min_len] - bl_fft_norm[:min_len], 0)
        f = freqs[:min_len]
        mask = (f >= BANDPASS_LOW) & (f <= BANDPASS_HIGH)
        energy = float(np.sqrt(np.mean(cleaned[mask] ** 2)))

        delta_db = round(20.0 * np.log10(energy) if energy > 1e-10 else -100, 1)

        # Build spectrum for live visualization (0-2000 Hz, 100 bins)
        max_freq = min(2000, SAMPLE_RATE / 2)
        freq_mask = f <= max_freq
        spec_cleaned = cleaned[freq_mask]
        n_bins = min(100, len(spec_cleaned))
        bin_size = max(1, len(spec_cleaned) // n_bins)
        spectrum = []
        for i in range(0, len(spec_cleaned), bin_size):
            chunk = spec_cleaned[i:i+bin_size]
            val = float(np.max(chunk))
            db = 20.0 * np.log10(val) if val > 1e-10 else -100
            spectrum.append(round(db, 1))

        return delta_db, spectrum
    except Exception:
        return None, None


def _save_live_spectrum(speed, axis, spectrum):
    """Save current FFT spectrum for real-time visualization on web page."""
    if spectrum is None:
        return
    try:
        live_file = os.path.join(WEB_DIR, "anc_live.json")
        data = {
            "speed": speed,
            "axis": axis,
            "t": time.time(),
            "spectrum": spectrum,       # 100 bins, 0-2000 Hz, dB delta
            "freq_max": 2000,
            "bins": len(spectrum)
        }
        with open(live_file, 'w') as f:
            json.dump(data, f)
    except Exception:
        pass


def _live_update(speed, axis, live_db=None):
    """Update web JSON with live dB value for real-time graph."""
    try:
        if os.path.exists(WEB_JSON):
            with open(WEB_JSON, 'r') as f:
                web_data = json.load(f)
        else:
            web_data = {}

        if axis not in web_data:
            web_data[axis] = []

        web_data[axis].append({"speed": speed, "db": live_db})

        with open(WEB_JSON, 'w') as f:
            json.dump(web_data, f)
    except Exception:
        pass


def cmd_stop(_args):
    """Stop recording, slice audio by markers, analyze, generate config."""
    # Kill the recording process
    if os.path.exists(PID_FILE):
        with open(PID_FILE, 'r') as f:
            pid = int(f.read().strip())
        try:
            os.kill(pid, signal.SIGINT)  # SIGINT lets arecord finalize WAV header
            time.sleep(1.5)
        except ProcessLookupError:
            pass
        os.remove(PID_FILE)
        print("Recording stopped.")

    # Load state and markers
    with open(STATE_FILE, 'r') as f:
        state = json.load(f)

    markers = []
    with open(MARKERS_FILE, 'r') as f:
        for line in f:
            line = line.strip()
            if line:
                markers.append(json.loads(line))

    if not markers:
        print("ERROR: No markers recorded!")
        sys.exit(1)

    print(f"Processing {len(markers)} speed points...")

    # Load baseline FFT spectrum (for spectral subtraction — removes fans, ambient)
    baseline_wav = os.path.join(DATA_DIR, ".baseline.wav")
    baseline_samples = _load_wav(baseline_wav)
    baseline_fft, baseline_freqs = _compute_fft(baseline_samples)
    # Normalize baseline FFT to per-sample basis for matching different segment lengths
    baseline_fft_norm = baseline_fft / len(baseline_samples)
    mask_bl = (baseline_freqs >= BANDPASS_LOW) & (baseline_freqs <= BANDPASS_HIGH)
    baseline_energy = float(np.sqrt(np.mean(baseline_fft[mask_bl] ** 2)))
    print(f"Baseline energy: {baseline_energy:.0f} (fans + ambient)")
    del baseline_samples  # Free RAM

    record_start = state["record_start"]

    # Process WAV segment by segment (never load full file in RAM)
    measurements = []
    wav_file = open(RAW_WAV, 'rb')
    wav_file.read(44)  # Skip WAV header (44 bytes for standard PCM)

    for i, marker in enumerate(markers):
        t_offset = marker["t"] - record_start
        sample_start = int(t_offset * SAMPLE_RATE)

        if i + 1 < len(markers):
            t_next = markers[i + 1]["t"] - record_start
            duration_s = min(t_next - t_offset, 2.0)
        else:
            duration_s = 2.0

        sample_end = int((t_offset + duration_s) * SAMPLE_RATE)
        n_samples = sample_end - sample_start
        if n_samples < int(SAMPLE_RATE * 0.3):
            continue

        # Seek and read only this segment (2 bytes per S16_LE sample)
        try:
            wav_file.seek(44 + sample_start * 2)
            raw = wav_file.read(n_samples * 2)
            if len(raw) < n_samples * 2:
                continue
        except Exception:
            continue

        import struct
        n = len(raw) // 2
        segment = np.array(struct.unpack('<%dh' % n, raw), dtype=np.float64)

        fft_vals, freqs = _compute_fft(segment)

        # Spectral subtraction: remove fan/ambient frequencies bin by bin
        fft_norm = fft_vals / len(segment)
        min_len = min(len(fft_norm), len(baseline_fft_norm))
        cleaned = np.maximum(fft_norm[:min_len] - baseline_fft_norm[:min_len], 0)
        f = freqs[:min(len(freqs), min_len)]

        # 3-band analysis + total
        bands = {
            "low":   (50, 200),    # chassis, frame, bed
            "mid":   (200, 500),   # gantry, belts, harmonics
            "high":  (500, 2000),  # rails, bearings, stepper
            "total": (50, 2000),   # combined energy for detection
        }
        band_db = {}
        for band_name, (flo, fhi) in bands.items():
            mask = (f >= flo) & (f <= fhi)
            if np.any(mask):
                e = float(np.sqrt(np.mean(cleaned[mask] ** 2)))
                band_db[band_name] = round(20.0 * np.log10(e) if e > 1e-10 else -100, 1)
            else:
                band_db[band_name] = -100.0

        # Downsample spectrum to 64 bins (0-2kHz) for waterfall/spectrogram
        max_freq = min(2000, SAMPLE_RATE / 2)
        freq_mask = f <= max_freq
        spec = cleaned[freq_mask]
        n_bins = 64
        bin_size = max(1, len(spec) // n_bins)
        spectrum = []
        for bi in range(0, min(len(spec), n_bins * bin_size), bin_size):
            chunk = spec[bi:bi+bin_size]
            val = float(np.max(chunk))
            db = 20.0 * np.log10(val) if val > 1e-10 else -100
            spectrum.append(round(db, 1))

        measurements.append({
            "speed_mm_s": marker["speed"],
            "delta_db": band_db["total"],
            "db_low": band_db["low"],
            "db_mid": band_db["mid"],
            "db_high": band_db["high"],
            "axis": marker["axis"],
            "spectrum": spectrum
        })

        print(f"  {marker['axis'].upper()} {marker['speed']:3d} mm/s: "
              f"total={band_db['total']:+.1f} "
              f"L={band_db['low']:+.1f} M={band_db['mid']:+.1f} H={band_db['high']:+.1f}")
        del segment  # Free RAM immediately

    wav_file.close()

    # Split by axis
    by_axis = {'x': [], 'y': [], 'z': [], 'd': []}
    for m in measurements:
        by_axis[m.get('axis', 'x')].append(m)

    # Save raw CSV
    with open(RAW_CSV, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(["speed_mm_s", "total_db", "low_db", "mid_db", "high_db", "axis"])
        for m in measurements:
            writer.writerow([m["speed_mm_s"], m["delta_db"],
                             m["db_low"], m["db_mid"], m["db_high"],
                             m.get("axis", "x")])
    print(f"CSV saved to {RAW_CSV}")

    # Analyze and generate zones per axis
    first_axis = True
    auto_thresholds = {}
    detected_zones = {}
    for axis in ['x', 'y', 'z', 'd']:
        if by_axis[axis]:
            print(f"\n=== {axis.upper()} axis ===")
            zones, auto_th = _analyze_zones(by_axis[axis])
            auto_thresholds[axis] = round(auto_th, 1)
            detected_zones[axis] = [z["peak_speed"] for z in zones]
            _write_zones_cfg(zones, axis=axis, first=first_axis)
            first_axis = False

    # Save web JSON with 4 curves + spectrum + detected zones
    web_data = {
        "freq_max": min(2000, SAMPLE_RATE / 2),
        "bins": 64,
        "auto_threshold": auto_thresholds,
        "detected_zones": detected_zones
    }
    for axis in ['x', 'y', 'z', 'd']:
        if by_axis[axis]:
            web_data[axis] = [{
                "speed": m["speed_mm_s"],
                "db": m["delta_db"],
                "low": m["db_low"],
                "mid": m["db_mid"],
                "high": m["db_high"],
                "s": m.get("spectrum", [])
            } for m in by_axis[axis]]
    with open(WEB_JSON, 'w') as f:
        json.dump(web_data, f)
    print(f"Web JSON saved to {WEB_JSON}")
    print(f"Auto thresholds: {auto_thresholds}")

    # Keep last WAV for download (just move, no RAM-heavy normalization)
    KEEP_WAV = os.path.join(WEB_DIR, "anc_last_sweep.wav")
    if os.path.exists(RAW_WAV) and os.path.getsize(RAW_WAV) > 100:
        import shutil
        shutil.move(RAW_WAV, KEEP_WAV)
        print(f"WAV saved to {KEEP_WAV} ({os.path.getsize(KEEP_WAV) // 1048576} MB)")
    else:
        print("WARNING: RAW WAV missing or empty")

    # Cleanup temp files
    baseline_npy = os.path.join(DATA_DIR, ".baseline_fft_norm.npy")
    for f in [MARKERS_FILE, baseline_wav, baseline_npy]:
        if os.path.exists(f):
            os.remove(f)

    state["status"] = "complete"
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f)

    print(f"\nConfig: {ZONES_CFG}")
    print("FIRMWARE_RESTART to apply.")


def _normalize_wav(src, dst):
    """Normalize WAV volume to -3 dBFS for comfortable listening."""
    import wave
    import struct
    w = wave.open(src, 'r')
    params = w.getparams()
    n = w.getnframes()
    frames = w.readframes(n)
    w.close()

    samples = np.array(struct.unpack('<%dh' % n, frames), dtype=np.float64)
    peak = np.max(np.abs(samples))
    if peak < 1:
        # Silent — just copy
        import shutil
        shutil.copy2(src, dst)
        return

    # Normalize to -3 dBFS (70% of max)
    target = 32767 * 0.7
    gain = target / peak
    normalized = np.clip(samples * gain, -32768, 32767).astype(np.int16)

    out = wave.open(dst, 'w')
    out.setparams(params)
    out.writeframes(struct.pack('<%dh' % len(normalized), *normalized))
    out.close()
    print(f"  Normalized: gain={gain:.1f}x ({20*np.log10(gain):.1f} dB)")


def _load_wav(path):
    """Load WAV file as numpy float array."""
    import wave
    import struct
    w = wave.open(path, 'r')
    n = w.getnframes()
    frames = w.readframes(n)
    samples = np.array(struct.unpack('<%dh' % n, frames), dtype=np.float64)
    return samples


def _a_weight(freqs):
    """A-weighting curve — models human ear sensitivity.

    Standard IEC 61672:2003. Attenuates low frequencies (we don't hear well),
    boosts 1-4 kHz (most sensitive zone). Returns dB offset per frequency.
    """
    f2 = freqs ** 2
    # Avoid division by zero
    f2 = np.maximum(f2, 1e-10)
    num = 12194.0 ** 2 * f2 ** 2
    den = ((f2 + 20.6 ** 2) *
           np.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) *
           (f2 + 12194.0 ** 2))
    den = np.maximum(den, 1e-30)
    ra = num / den
    # Convert to dB and normalize (0 dB at 1 kHz)
    a_db = 20.0 * np.log10(np.maximum(ra, 1e-30)) + 2.0
    return a_db


def _compute_fft(samples, a_weight=True):
    """Compute FFT magnitude spectrum with optional A-weighting."""
    samples = samples - np.mean(samples)
    fft_vals = np.abs(np.fft.rfft(samples))
    freqs = np.fft.rfftfreq(len(samples), 1.0 / SAMPLE_RATE)
    if a_weight:
        # Apply A-weighting in linear domain
        a_db = _a_weight(freqs)
        a_linear = 10.0 ** (a_db / 20.0)
        fft_vals = fft_vals * a_linear
    return fft_vals, freqs


def _analyze_zones(measurements, max_zones=None):
    """Find resonance peaks with double threshold (DeepSeek v2 recommendation).

    1. Find all peaks with prominence >= 3 dB
    2. Filter: keep only peaks with prominence >= 3 dB AND SNR >= 6 dB
       (SNR = peak dB vs median of 10 neighboring speeds)
    3. Sort by loudness, keep top N
    4. If fewer than 3 survive the filter, take top 3 anyway

    Args:
        measurements: list of dicts with delta_db
        max_zones: max peaks to keep. None = auto (8 for XY, 3 for Z)
    """
    from scipy.signal import find_peaks

    speeds = np.array([m["speed_mm_s"] for m in measurements])
    deltas = np.array([m["delta_db"] for m in measurements])

    if len(deltas) < 3:
        print("  Not enough data points")
        return [], 0

    # Smooth to reduce noise
    if len(deltas) > 5:
        kernel = np.ones(3) / 3
        deltas_smooth = np.convolve(deltas, kernel, mode='same')
    else:
        deltas_smooth = deltas

    # Auto max_zones based on speed range (Z is narrow)
    speed_range = speeds[-1] - speeds[0]
    if max_zones is None:
        max_zones = 3 if speed_range < 50 else 8

    print(f"  Range: {np.min(deltas_smooth):.1f} to {np.max(deltas_smooth):.1f} dBA")
    print(f"  Max zones: {max_zones}")

    # Find ALL peaks with minimum prominence
    peaks, properties = find_peaks(
        deltas_smooth,
        prominence=3.0,
        distance=2
    )

    if len(peaks) == 0:
        print("  No peaks detected. Clean!")
        return [], 0

    # Build peak data with SNR (peak vs local neighbors)
    peak_data = []
    for i, idx in enumerate(peaks):
        # SNR: compare peak to median of 10 neighboring points
        lo = max(0, idx - 5)
        hi = min(len(deltas_smooth), idx + 6)
        neighbors = np.concatenate([deltas_smooth[lo:idx], deltas_smooth[idx+1:hi]])
        local_median = float(np.median(neighbors)) if len(neighbors) > 0 else 0
        snr = float(deltas_smooth[idx]) - local_median

        peak_data.append({
            "idx": idx,
            "speed": int(speeds[idx]),
            "db": float(deltas_smooth[idx]),
            "prominence": float(properties['prominences'][i]),
            "snr": round(snr, 1)
        })

    # Double threshold: prominence >= 3 dB AND SNR >= 6 dB
    filtered = [p for p in peak_data if p["prominence"] >= 3.0 and p["snr"] >= 6.0]
    print(f"  Peaks found: {len(peak_data)}, after filter (prom>=3 + SNR>=6): {len(filtered)}")

    # If too few survive, take top 3 by loudness anyway
    if len(filtered) < 3:
        filtered = sorted(peak_data, key=lambda p: -p["db"])[:3]
        print(f"  Filter too strict, fallback to top 3")

    # Sort by loudness, keep top N
    filtered.sort(key=lambda p: -p["db"])
    top_peaks = filtered[:max_zones]

    # Auto threshold = dB of the weakest kept peak
    auto_threshold = top_peaks[-1]["db"] if top_peaks else 0
    print(f"  Auto threshold: {auto_threshold:.1f} dB (weakest of top {len(top_peaks)})")

    zones = []
    for p in sorted(top_peaks, key=lambda p: p["speed"]):
        zones.append({"peak_speed": p["speed"], "peak_db": round(p["db"], 1)})
        print(f"  >>> {p['speed']} mm/s: {p['db']:+.1f} dB (prominence {p['prominence']:.1f})")

    print(f"  {len(zones)} zone(s)")
    return zones, auto_threshold


def _write_zones_cfg(zones, axis='x', first=True):
    """Write Klipper config for resonance avoidance."""
    mode = 'w' if first else 'a'
    with open(ZONES_CFG, mode) as f:
        if first:
            f.write("## Yumi-ANC — Active Noise Canceling\n")
            f.write(f"## {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
            f.write("[resonance_avoidance]\n")
            f.write("enabled: True\n")
            f.write("avoidance_margin: 5\n")
            f.write("avoidance_margin_z: 1\n")
            f.write("#   threshold auto-calculated per axis (IQR outlier detection)\n")

        key = f"avoidance_zones_{axis}"
        if zones:
            f.write(f"{key}: {', '.join(str(z['peak_speed']) for z in zones)}\n")
        else:
            f.write(f"{key}:\n")


def cmd_clear(_args):
    """Remove all ANC files."""
    for f in [ZONES_CFG, STATE_FILE, MARKERS_FILE, RAW_WAV, PID_FILE, RAW_CSV]:
        if os.path.exists(f):
            os.remove(f)
    print("Yumi-ANC data cleared.")


def cmd_analyze(_args):
    """Re-analyze existing CSV data."""
    if not os.path.exists(RAW_CSV):
        print(f"No data at {RAW_CSV}")
        sys.exit(1)

    by_axis = {'x': [], 'y': [], 'z': [], 'd': []}
    with open(RAW_CSV, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            m = {
                "speed_mm_s": int(row["speed_mm_s"]),
                "delta_db": float(row["delta_db"]),
                "energy_db": float(row["energy_db"]),
                "axis": row.get("axis", "x")
            }
            by_axis[m["axis"]].append(m)

    first = True
    for axis in ['x', 'y', 'z', 'd']:
        if by_axis[axis]:
            print(f"=== {axis.upper()} ===")
            zones, _ = _analyze_zones(by_axis[axis])
            _write_zones_cfg(zones, axis=axis, first=first)
            first = False


def cmd_save(args):
    """Save zones config from web UI parameters.

    Args: <margin_xy> <margin_z> <zones_x> | <zones_y> | <zones_z>
    Example: save 5 1 100,275,375 | 120,330 | 11
    """
    raw = ' '.join(args)
    parts = raw.split('|')

    margin_xy = 5
    margin_z = 1
    zones = {'x': '', 'y': '', 'z': '', 'd': ''}

    # First part: margin_xy margin_z zones_x
    first = parts[0].strip().split()
    if len(first) >= 1:
        try:
            margin_xy = float(first[0])
        except ValueError:
            pass
    if len(first) >= 2:
        try:
            margin_z = float(first[1])
        except ValueError:
            pass
    if len(first) >= 3:
        zones['x'] = ','.join(first[2:]).replace(',', ', ')

    if len(parts) >= 2:
        zones['y'] = parts[1].strip().replace(',', ', ')
    if len(parts) >= 3:
        zones['z'] = parts[2].strip().replace(',', ', ')

    with open(ZONES_CFG, 'w') as f:
        f.write("## Yumi-ANC — Active Noise Canceling\n")
        f.write(f"## {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write("[resonance_avoidance]\n")
        f.write("enabled: True\n")
        f.write(f"avoidance_margin: {margin_xy}\n")
        f.write(f"avoidance_margin_z: {margin_z}\n")
        for axis in ['x', 'y', 'z', 'd']:
            f.write(f"avoidance_zones_{axis}: {zones[axis]}\n")

    print(f"Config saved to {ZONES_CFG}")
    print(f"  Margin XY=±{margin_xy} Z=±{margin_z}")
    for axis in ['x', 'y', 'z', 'd']:
        if zones[axis]:
            print(f"  {axis.upper()}: {zones[axis]}")


def main():
    if len(sys.argv) < 2:
        print("Usage: acoustic_sweep.py <start|mark|stop|clear|analyze|save> [args]")
        sys.exit(1)

    commands = {
        "start": cmd_start,
        "mark": cmd_mark,
        "speed": cmd_mark,
        "stop": cmd_stop,
        "clear": cmd_clear,
        "analyze": cmd_analyze,
        "save": cmd_save,
    }

    cmd = sys.argv[1]
    if cmd not in commands:
        print(f"Unknown: {cmd}")
        sys.exit(1)

    commands[cmd](sys.argv[2:])


if __name__ == "__main__":
    main()
