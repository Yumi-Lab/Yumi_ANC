let data = { x: [], y: [] };
let threshold = 10;
let margin = 5;
let marginZ = 1;
let chartType = 'line'; // 'line' or 'bars'

function toggleChartType() {
    chartType = chartType === 'bars' ? 'line' : 'bars';
    document.getElementById('btnChartType').textContent = chartType === 'bars' ? 'Bars' : 'Line';
    render();
}

function updateControls() {
    threshold = parseFloat(document.getElementById('sliderThreshold').value);
    margin = parseInt(document.getElementById('sliderMargin').value);
    useAutoZones = false; // manual adjustment overrides auto
    document.getElementById('valThreshold').textContent = '+' + threshold.toFixed(1) + ' dBA (manual)';
    document.getElementById('valMargin').textContent = '±' + margin;
    marginZ = parseFloat(document.getElementById('sliderMarginZ').value);
    document.getElementById('valMarginZ').textContent = '±' + marginZ.toFixed(1);
    render();
}

async function loadData() {
    try {
        const resp = await fetch('/acoustic_data.json?' + Date.now());
        if (!resp.ok) throw new Error('No data file');
        data = await resp.json();
        // Apply auto-threshold if available
        if (data.auto_threshold) {
            const avg = Object.values(data.auto_threshold);
            if (avg.length) {
                const autoT = avg.reduce((a,b) => a+b, 0) / avg.length;
                threshold = Math.round(autoT * 2) / 2; // round to 0.5
                document.getElementById('sliderThreshold').value = threshold;
                document.getElementById('valThreshold').textContent = '+' + threshold.toFixed(1) + ' dBA (auto)';
            }
        }
        const nx = (data.x||[]).length, ny = (data.y||[]).length, nz = (data.z||[]).length;
        setStatus('green', `Loaded: ${nx}X + ${ny}Y + ${nz}Z points` +
            (data.auto_threshold ? ` — auto threshold: ${JSON.stringify(data.auto_threshold)}` : ''));
        render();
    } catch(e) {
        setStatus('red', 'No calibration data — run a sweep first');
    }
}

function setStatus(color, text) {
    document.getElementById('statusDot').className = 'status-dot ' + color;
    document.getElementById('statusText').textContent = text;
}

async function sendGcode(cmd) {
    await fetch('/printer/gcode/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: cmd })
    });
}

let useAutoZones = true; // true = use algo-detected zones, false = use slider threshold

function findZones(arr, axisKey) {
    if (!arr.length) return { zones: [], median: 0, maxE: 0 };
    const vals = arr.map(d => d.db != null ? d.db : d.energy || 0).filter(v => v != null);
    const isDb = arr[0] && arr[0].db != null;
    const sorted = [...vals].sort((a,b) => a-b);
    const med = sorted[Math.floor(sorted.length/2)];
    const thresh = isDb ? threshold : med * threshold;

    let zones;
    if (!isDb && useAutoZones && data.detected_zones && data.detected_zones[axisKey]) {
        // Legacy energy mode only: exact zones from the top-N algorithm.
        const detectedSpeeds = data.detected_zones[axisKey];
        zones = arr.filter(d => detectedSpeeds.includes(d.speed)).map(d => {
            const v = d.db != null ? d.db : d.energy || 0;
            return { speed: d.speed, value: v, ratio: (v / med).toFixed(1) + 'x' };
        });
    } else {
        // dBA mode (and manual): everything above the threshold is forbidden.
        // Same predicate as the red dots, so every red point gets a band + label.
        zones = arr.filter(d => {
            const v = d.db != null ? d.db : d.energy || 0;
            return v != null && v > thresh;
        }).map(d => {
            const v = d.db != null ? d.db : d.energy || 0;
            return { speed: d.speed, value: v, ratio: isDb ? v.toFixed(1) + ' dBA' : (v / med).toFixed(1) + 'x' };
        });
    }
    return { zones, median: med, threshold: thresh, maxE: Math.max(...vals), isDb };
}

function drawChart(id, arr, axis, axisMargin) {
    if (axisMargin === undefined) axisMargin = margin;
    const canvas = document.getElementById(id);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const pad = { t: 10, r: 15, b: 25, l: 50 };

    ctx.clearRect(0, 0, W, H);

    if (!arr.length) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No ' + axis + ' data', W/2, H/2);
        return;
    }

    const getVal = (d) => d.db != null ? d.db : d.energy || 0;
    const { zones, median, threshold: thresh, maxE, isDb } = findZones(arr, axis.toLowerCase());
    const values = arr.map(d => getVal(d));
    const speeds = arr.map(d => d.speed);
    const minS = Math.min(...speeds), maxS = Math.max(...speeds);
    // Detect speed step for bar width
    const sortedSpeeds = [...new Set(speeds)].sort((a,b) => a-b);
    const speedStep = sortedSpeeds.length > 1 ? sortedSpeeds[1] - sortedSpeeds[0] : 10;
    // Pad X range by half a step so first/last bars don't get clipped
    const xMin = minS - speedStep / 2;
    const xMax = maxS + speedStep / 2;

    // Y axis range — include all band values
    const allVals = [...values];
    if (arr[0] && arr[0].low != null) {
        arr.forEach(d => { allVals.push(d.low, d.mid, d.high); });
    }
    const minV = Math.min(...allVals.filter(v => v != null && v > -100), 0);
    const maxV = Math.max(...allVals.filter(v => v != null), thresh + 5);
    const yPad = (maxV - minV) * 0.1;
    const yMin = minV - yPad;
    const yMax = maxV + yPad;

    const x = s => pad.l + (s - xMin) / (xMax - xMin || 1) * (W - pad.l - pad.r);
    const y = v => pad.t + (yMax - v) / (yMax - yMin || 1) * (H - pad.t - pad.b);

    // 0 dB baseline reference line
    if (isDb && yMin < 0 && yMax > 0) {
        ctx.strokeStyle = 'rgba(139,148,158,0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(pad.l, y(0)); ctx.lineTo(W - pad.r, y(0)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(139,148,158,0.5)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('0 dBA (baseline)', pad.l + 4, y(0) - 3);
    }

    // Avoidance zone bands
    ctx.fillStyle = 'rgba(210,153,34,0.08)';
    zones.forEach(z => {
        ctx.fillRect(x(z.speed - axisMargin), pad.t, x(z.speed + axisMargin) - x(z.speed - axisMargin), H - pad.t - pad.b);
    });

    // Threshold line
    const threshY = y(thresh);
    if (threshY > pad.t && threshY < H - pad.b) {
        ctx.strokeStyle = 'rgba(248,81,73,0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(pad.l, threshY); ctx.lineTo(W - pad.r, threshY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(248,81,73,0.6)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('+' + threshold.toFixed(1) + ' dBA', W - pad.r - 2, threshY - 3);
    }

    // 4-curve rendering: low (orange), mid (blue), high (purple), total (white)
    const hasLow = arr[0] && arr[0].low != null;
    const bandCurves = hasLow ? [
        { key: 'low',  color: 'rgba(240,136,62,0.7)',  fill: 'rgba(240,136,62,0.05)' },
        { key: 'mid',  color: 'rgba(88,166,255,0.7)',  fill: 'rgba(88,166,255,0.05)' },
        { key: 'high', color: 'rgba(163,113,247,0.7)', fill: 'rgba(163,113,247,0.05)' },
    ] : [];
    const bottomY = y(yMin);

    // Smooth curve helper — cardinal spline through points
    function smoothCurve(ctx, points) {
        if (points.length < 2) return;
        ctx.moveTo(points[0][0], points[0][1]);
        if (points.length === 2) { ctx.lineTo(points[1][0], points[1][1]); return; }
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[Math.max(0, i - 1)];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = points[Math.min(points.length - 1, i + 2)];
            const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
            const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
            const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
            const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
        }
    }

    if (chartType === 'line') {
        // Sub-band curves (behind total) — smooth
        bandCurves.forEach(band => {
            const pts = arr.map(d => [x(d.speed), y(d[band.key] != null ? d[band.key] : yMin)]);
            ctx.beginPath();
            smoothCurve(ctx, pts);
            ctx.strokeStyle = band.color;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.lineTo(x(arr[arr.length-1].speed), bottomY);
            ctx.lineTo(x(arr[0].speed), bottomY);
            ctx.closePath();
            ctx.fillStyle = band.fill;
            ctx.fill();
        });

        // Total curve on top (bold white) — smooth
        const totalPts = arr.map(d => [x(d.speed), y(getVal(d))]);
        ctx.beginPath();
        smoothCurve(ctx, totalPts);
        ctx.strokeStyle = hasLow ? 'rgba(201,209,217,0.9)' : 'rgba(88,166,255,0.8)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Red dots on resonance
        arr.forEach(d => {
            const v = getVal(d);
            if (v > thresh) {
                ctx.beginPath();
                ctx.arc(x(d.speed), y(v), 3.5, 0, Math.PI * 2);
                ctx.fillStyle = '#f85149';
                ctx.fill();
            }
        });
    } else {
        // Bar chart with band colors
        const bw = Math.max(2, Math.min(30, (x(minS + speedStep) - x(minS)) * 0.8));
        arr.forEach(d => {
            const v = getVal(d);
            const bx = x(d.speed) - bw/2;
            const vy = y(v);
            const isRed = v > thresh;
            // Color by dominant band
            let col = 'rgba(88,166,255,0.6)';
            if (hasLow && !isRed) {
                const lo = d.low || -100, mi = d.mid || -100, hi = d.high || -100;
                if (lo >= mi && lo >= hi) col = 'rgba(240,136,62,0.6)';
                else if (hi >= mi && hi >= lo) col = 'rgba(163,113,247,0.6)';
            }
            ctx.fillStyle = isRed ? '#f85149' : col;
            ctx.fillRect(bx, vy, bw, bottomY - vy);
        });
    }

    // Peak labels
    ctx.fillStyle = '#f85149';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    zones.forEach(z => {
        ctx.fillText(z.speed + '', x(z.speed), y(z.value) - 6);
    });

    // Axes
    ctx.strokeStyle = var_border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b);
    ctx.stroke();

    // X axis labels (speed)
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const step = maxS > 400 ? 100 : maxS > 100 ? 50 : 5;
    for (let s = Math.ceil(minS/step)*step; s <= maxS; s += step) {
        ctx.fillText(s, x(s), H - 6);
    }

    // Y axis labels (dB or energy)
    ctx.textAlign = 'right';
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
        const v = yMin + (yMax - yMin) * i / ySteps;
        const label = isDb ? (v >= 0 ? '+' : '') + v.toFixed(0) + ' dBA' :
                      v > 1000 ? (v/1000).toFixed(0) + 'k' : v.toFixed(0);
        ctx.fillText(label, pad.l - 4, y(v) + 3);
    }

    // Hover handler
    canvas.onmousemove = (ev) => {
        const br = canvas.getBoundingClientRect();
        const mx = ev.clientX - br.left;
        const speed_at = minS + (mx - pad.l) / (W - pad.l - pad.r) * (maxS - minS);
        const closest = arr.reduce((best, d) => Math.abs(d.speed - speed_at) < Math.abs(best.speed - speed_at) ? d : best);
        const v = getVal(closest);
        const isZone = v > thresh;
        const tip = document.getElementById('tooltip');
        tip.style.display = 'block';
        tip.style.left = (ev.clientX + 10) + 'px';
        tip.style.top = (ev.clientY - 30) + 'px';
        let bandInfo = '';
        if (closest.low != null) {
            bandInfo = `<br><span style="color:#f0883e">Low: ${closest.low >= 0 ? '+' : ''}${closest.low.toFixed(1)}</span>` +
                ` <span style="color:#58a6ff">Mid: ${closest.mid >= 0 ? '+' : ''}${closest.mid.toFixed(1)}</span>` +
                ` <span style="color:#a371f7">High: ${closest.high >= 0 ? '+' : ''}${closest.high.toFixed(1)}</span>`;
        }
        tip.innerHTML = `<b>${closest.speed} mm/s</b><br>` +
            `Total: ${v >= 0 ? '+' : ''}${v.toFixed(1)} dBA` + bandInfo +
            `<br>Threshold: +${threshold.toFixed(1)} dBA` +
            (isZone ? '<br><span style="color:var(--red)">RESONANCE</span>' : '');
    };
    canvas.onmouseleave = () => { document.getElementById('tooltip').style.display = 'none'; };

    // Badge
    const badge = document.getElementById('badge' + axis);
    badge.textContent = zones.length + ' zone' + (zones.length !== 1 ? 's' : '');
    badge.className = 'badge ' + (zones.length > 0 ? 'badge-red' : 'badge-green');
}

const var_border = '#30363d';

function buildTable(tableId, arr) {
    const { zones, median } = findZones(arr, tableId.replace('table','').toLowerCase());
    const table = document.getElementById(tableId);
    if (!zones.length) { table.innerHTML = '<tr><td style="color:var(--green)">No resonance zones detected</td></tr>'; return; }
    let html = '<tr><th>Speed</th><th>Avoid Range</th><th>Ratio</th><th>Severity</th></tr>';
    zones.sort((a,b) => b.ratio - a.ratio);
    zones.forEach(z => {
        const severity = z.ratio >= 3 ? 'Critical' : z.ratio >= 2 ? 'High' : 'Medium';
        const color = z.ratio >= 3 ? 'var(--red)' : z.ratio >= 2 ? 'var(--orange)' : 'var(--dim)';
        const pct = Math.min(100, z.ratio / 4 * 100);
        html += `<tr class="resonance"><td>${z.speed} mm/s</td>` +
            `<td>${z.speed-margin}–${z.speed+margin}</td>` +
            `<td>${z.ratio}x</td>` +
            `<td><div class="zone-bar"><div class="zone-bar-fill" style="width:${pct}%;background:${color}"></div></div></td></tr>`;
    });
    table.innerHTML = html;
}

function buildConfig() {
    const xZones = findZones(data.x || [], 'x').zones;
    const yZones = findZones(data.y || [], 'y').zones;
    let cfg = '## Auto-generated by ANC — Active Noise Canceling\n';
    cfg += '## ' + new Date().toISOString().slice(0,19) + '\n\n';
    cfg += '[resonance_avoidance]\n';
    cfg += 'enabled: True\n';
    cfg += 'avoidance_margin: ' + margin + '\n';
    cfg += 'avoidance_margin_z: ' + marginZ + '\n';
    cfg += 'detection_threshold: ' + threshold.toFixed(1) + '\n';
    if (xZones.length) cfg += 'avoidance_zones_x: ' + xZones.map(z => z.speed).join(', ') + '\n';
    if (yZones.length) cfg += 'avoidance_zones_y: ' + yZones.map(z => z.speed).join(', ') + '\n';
    cfg += '\n## X: ' + xZones.length + ' zones — ' + xZones.map(z => z.speed + 'mm/s(' + z.ratio + 'x)').join(', ');
    cfg += '\n## Y: ' + yZones.length + ' zones — ' + yZones.map(z => z.speed + 'mm/s(' + z.ratio + 'x)').join(', ');
    document.getElementById('configOutput').textContent = cfg;
}

function copyConfig() {
    navigator.clipboard.writeText(document.getElementById('configOutput').textContent);
    setStatus('green', 'Config copied to clipboard!');
}

function updateStats() {
    const xr = findZones(data.x || [], 'x');
    const yr = findZones(data.y || [], 'y');
    document.getElementById('statXZones').textContent = xr.zones.length;
    document.getElementById('statYZones').textContent = yr.zones.length;
    document.getElementById('statXMedian').textContent = xr.median ? (xr.median/1000).toFixed(1) + 'k' : '—';
    document.getElementById('statYMedian').textContent = yr.median ? (yr.median/1000).toFixed(1) + 'k' : '—';
    const allZones = [...xr.zones, ...yr.zones];
    if (allZones.length) {
        const worst = allZones.sort((a,b) => b.ratio - a.ratio)[0];
        document.getElementById('statWorst').textContent = worst.speed + 'mm/s (' + worst.ratio + 'x)';
    }
    document.getElementById('statPoints').textContent = data.x.length + data.y.length;
    const range = [...data.x, ...data.y];
    if (range.length) {
        const speeds = range.map(d => d.speed);
        document.getElementById('valRange').textContent = Math.min(...speeds) + '-' + Math.max(...speeds) + ' mm/s';
    }
}

function render() {
    drawChart('chartX', data.x || [], 'X', margin);
    drawChart('chartY', data.y || [], 'Y', margin);
    drawChart('chartZ', data.z || [], 'Z', marginZ);
    drawChart('chartD', data.d || [], 'D', margin);
    buildTable('tableX', data.x || []);
    buildTable('tableY', data.y || []);
    buildConfig();
    updateStats();
}

// Live refresh — polls JSON every 2s during calibration
let liveInterval = null;
let lastPointCount = 0;

function startLiveRefresh() {
    if (liveInterval) return;
    setStatus('orange', 'Live calibration — refreshing every 2s...');
    liveInterval = setInterval(async () => {
        try {
            const resp = await fetch('/acoustic_data.json?' + Date.now());
            if (resp.ok) {
                const newData = await resp.json();
                const newCount = (newData.x||[]).length + (newData.y||[]).length + (newData.z||[]).length;
                if (newCount !== lastPointCount) {
                    data = newData;
                    lastPointCount = newCount;
                    render();
                    setStatus('orange', 'Live: ' + newCount + ' points (' +
                        (newData.x||[]).length + 'X + ' +
                        (newData.y||[]).length + 'Y + ' +
                        (newData.z||[]).length + 'Z)');
                }
            }
        } catch(e) {}
    }, 2000);
}

function stopLiveRefresh() {
    if (liveInterval) {
        clearInterval(liveInterval);
        liveInterval = null;
        // Final reload — get the complete data with bands, spectrum, auto-threshold
        setTimeout(() => loadData(), 2000);
    }
}

// Reflect the calibrating state in the toolbar (used by both manual start
// and auto-detect-on-load, so a refresh mid-sweep shows the right buttons).
function setCalibratingUI(on) {
    const btn = document.getElementById('btnCalibrate');
    if (on) {
        btn.disabled = true;
        btn.textContent = 'Calibrating...';
        btn.className = 'btn btn-danger';
        document.getElementById('btnStop').style.display = '';
    } else {
        btn.disabled = false;
        btn.textContent = 'Start Calibration';
        btn.className = 'btn btn-primary';
        document.getElementById('btnStop').style.display = 'none';
    }
}

// Watch until the sweep finishes (data stops growing OR live feed goes stale),
// then drop back to the idle UI. Safe to call from start or from auto-detect.
let doneWatcher = null;
function finishCalibration() {
    if (doneWatcher) { clearInterval(doneWatcher); doneWatcher = null; }
    stopLiveRefresh();
    stopLiveSpectrum();
    setCalibratingUI(false);
}
// The script writes anc_status.json {running:true/false}. That flag is the
// source of truth — marks during a slow Z move can be 40-50s apart, so any
// freshness/stall heuristic gives false 'done'. Fallback (no status file):
// only finish after a long quiet window so slow moves aren't cut short.
function watchCalibration() {
    if (doneWatcher) clearInterval(doneWatcher);
    let staleTicks = 0;
    doneWatcher = setInterval(async () => {
        let status = null;
        try {
            const r = await fetch('/anc_status.json?' + Date.now());
            if (r.ok) status = await r.json();
        } catch(e) {}
        if (status && typeof status.running === 'boolean') {
            staleTicks = 0;
            if (!status.running) finishCalibration();
            return;
        }
        // Fallback: no status file — generous stall window (~60s).
        const currentCount = (data.x||[]).length + (data.y||[]).length + (data.z||[]).length;
        if (currentCount === lastPointCount && currentCount > 0) {
            if (++staleTicks > 30) finishCalibration();
        } else {
            staleTicks = 0;
        }
    }, 2000);
}

async function startCalibration() {
    lastPointCount = 0;
    setCalibratingUI(true);
    // Clear all previous data — fresh start
    data = {};
    render();
    startLiveRefresh();
    startLiveSpectrum();

    try {
        await sendGcode('ACOUSTIC_SPEED_SWEEP');
        watchCalibration();
    } catch(e) {
        setStatus('red', 'Error: ' + e.message);
        stopLiveRefresh();
        stopLiveSpectrum();
        setCalibratingUI(false);
    }
}

async function stopCalibration() {
    try {
        await sendGcode('ACOUSTIC_STOP');
        setStatus('orange', 'Stopping... analyzing partial data');
        if (doneWatcher) { clearInterval(doneWatcher); doneWatcher = null; }
        setCalibratingUI(false);
        // Wait a bit then reload data
        setTimeout(() => { stopLiveRefresh(); stopLiveSpectrum(); loadData(); }, 5000);
    } catch(e) {
        setStatus('red', 'Stop failed: ' + e.message);
    }
}

// === LIVE SPECTRUM VIEWER ===
let liveInterval2 = null;

function drawLiveSpectrum(specData) {
    const panel = document.getElementById('livePanel');
    panel.style.display = 'block';

    document.getElementById('liveSpeed').textContent =
        specData.axis.toUpperCase() + ' ' + specData.speed + ' mm/s';

    const canvas = document.getElementById('chartLive');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const pad = { t: 5, r: 10, b: 20, l: 40 };

    ctx.clearRect(0, 0, W, H);

    const bins = specData.spectrum;
    if (!bins || !bins.length) return;

    const maxDb = Math.max(...bins, 10);
    const minDb = Math.min(...bins, -10);
    const range = Math.max(maxDb - minDb, 1);

    const barW = (W - pad.l - pad.r) / bins.length;
    const freqPerBin = specData.freq_max / bins.length;

    // 3-band background zones
    const freqToX = f => pad.l + (f / specData.freq_max) * (W - pad.l - pad.r);
    // Low band background
    ctx.fillStyle = 'rgba(240,136,62,0.06)';
    ctx.fillRect(freqToX(50), pad.t, freqToX(200) - freqToX(50), H - pad.t - pad.b);
    // Mid band background
    ctx.fillStyle = 'rgba(88,166,255,0.06)';
    ctx.fillRect(freqToX(200), pad.t, freqToX(500) - freqToX(200), H - pad.t - pad.b);
    // High band background
    ctx.fillStyle = 'rgba(163,113,247,0.06)';
    ctx.fillRect(freqToX(500), pad.t, freqToX(2000) - freqToX(500), H - pad.t - pad.b);

    // Band separator lines
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    [200, 500].forEach(f => {
        const bx = freqToX(f);
        ctx.beginPath(); ctx.moveTo(bx, pad.t); ctx.lineTo(bx, H - pad.b); ctx.stroke();
    });
    ctx.setLineDash([]);

    // Band labels centered above each zone
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f0883e';
    ctx.fillText('Low 50-200Hz', (freqToX(50) + freqToX(200)) / 2, pad.t + 14);
    ctx.fillStyle = '#58a6ff';
    ctx.fillText('Mid 200-500Hz', (freqToX(200) + freqToX(500)) / 2, pad.t + 14);
    ctx.fillStyle = '#a371f7';
    ctx.fillText('High 500-2kHz', (freqToX(500) + freqToX(specData.freq_max)) / 2, pad.t + 14);

    // Smooth curve helper (same as main charts)
    function smoothLive(ctx, points) {
        if (points.length < 2) return;
        ctx.moveTo(points[0][0], points[0][1]);
        if (points.length === 2) { ctx.lineTo(points[1][0], points[1][1]); return; }
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[Math.max(0, i - 1)];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = points[Math.min(points.length - 1, i + 2)];
            const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
            const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
            const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
            const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
        }
    }

    const bottomY = H - pad.b;
    const yScale = db => H - pad.b - ((db - minDb) / range) * (H - pad.t - pad.b);

    // Build points per band, draw each as a smooth filled curve
    const bandRanges = [
        { lo: 0, hi: 200, color: 'rgba(240,136,62,0.8)', fill: 'rgba(240,136,62,0.1)' },
        { lo: 200, hi: 500, color: 'rgba(88,166,255,0.8)', fill: 'rgba(88,166,255,0.1)' },
        { lo: 500, hi: 8000, color: 'rgba(163,113,247,0.8)', fill: 'rgba(163,113,247,0.1)' },
    ];

    bandRanges.forEach(band => {
        const pts = [];
        bins.forEach((db, i) => {
            const freq = i * freqPerBin;
            if (freq >= band.lo && freq <= band.hi) {
                pts.push([pad.l + i * barW, yScale(db)]);
            }
        });
        if (pts.length < 2) return;

        // Filled area
        ctx.beginPath();
        smoothLive(ctx, pts);
        ctx.lineTo(pts[pts.length-1][0], bottomY);
        ctx.lineTo(pts[0][0], bottomY);
        ctx.closePath();
        ctx.fillStyle = band.fill;
        ctx.fill();

        // Stroke
        ctx.beginPath();
        smoothLive(ctx, pts);
        ctx.strokeStyle = band.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    });

    // Threshold line
    const threshY = yScale(threshold);
    if (threshY > pad.t && threshY < bottomY) {
        ctx.strokeStyle = 'rgba(248,81,73,0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(pad.l, threshY); ctx.lineTo(W - pad.r, threshY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(248,81,73,0.6)';
        ctx.font = '9px sans-serif';
        ctx.fillText('+' + threshold + 'dBA', pad.l - 2, threshY - 2);
    }

    // X axis labels (frequency)
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    for (let f = 0; f <= specData.freq_max; f += 250) {
        ctx.fillText(f + 'Hz', freqToX(f), H - pad.b + 12);
    }

    // Y axis labels
    ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
        const db = minDb + range * i / 3;
        ctx.fillText((db > 0 ? '+' : '') + db.toFixed(0) + 'dBA', pad.l - 3, yScale(db) + 3);
    }

    // Hover tooltip with frequency + dB
    const canvas_ref = canvas;
    canvas_ref.onmousemove = (ev) => {
        const br = canvas_ref.getBoundingClientRect();
        const mx = ev.clientX - br.left;
        const bi = Math.floor((mx - pad.l) / barW);
        if (bi >= 0 && bi < bins.length) {
            const freq = Math.round(bi * freqPerBin);
            const db = bins[bi];
            const band = freq < 200 ? 'Low' : freq < 500 ? 'Mid' : 'High';
            const tip = document.getElementById('tooltip');
            tip.style.display = 'block';
            tip.style.left = (ev.clientX + 10) + 'px';
            tip.style.top = (ev.clientY - 30) + 'px';
            tip.innerHTML = `<b>${freq} Hz</b> (${band})<br>${db > -100 ? db.toFixed(1) + ' dBA' : 'noise floor'}`;
        }
    };
    canvas_ref.onmouseleave = () => { document.getElementById('tooltip').style.display = 'none'; };
}

function startLiveSpectrum() {
    if (liveInterval2) return;
    liveInterval2 = setInterval(async () => {
        // Also update scope view
        if (document.getElementById('view-scope').classList.contains('active')) {
            drawScope();
        }
        try {
            const resp = await fetch('/anc_live.json?' + Date.now());
            if (resp.ok) {
                const specData = await resp.json();
                drawLiveSpectrum(specData);
            }
        } catch(e) {}
    }, 500); // Poll every 500ms for smooth animation
}

function stopLiveSpectrum() {
    if (liveInterval2) {
        clearInterval(liveInterval2);
        liveInterval2 = null;
    }
    // Keep panel visible with last spectrum
}

// === WAV PLAYER ===
function toggleWavPanel() {
    const panel = document.getElementById('wavPanel');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        loadWav();
    } else {
        panel.style.display = 'none';
        document.getElementById('wavPlayer').pause();
    }
}

function loadWav() {
    const player = document.getElementById('wavPlayer');
    const info = document.getElementById('wavInfo');
    const url = '/anc_last_sweep.wav?' + Date.now();

    fetch(url, { method: 'HEAD' }).then(r => {
        if (r.ok) {
            const size = r.headers.get('content-length');
            const sizeMB = size ? (parseInt(size) / 1048576).toFixed(1) + ' MB' : '';
            player.src = url;
            info.textContent = sizeMB + ' — Use timeline to scrub through speeds';
            document.getElementById('wavDownload').style.display = '';
        } else {
            player.src = '';
            info.textContent = 'No WAV yet — run a calibration first';
            document.getElementById('wavDownload').style.display = 'none';
        }
    }).catch(() => {
        info.textContent = 'No WAV available';
    });
}

// === AUTO RESET — restore algo-calculated values ===
function resetToAuto() {
    useAutoZones = true;
    if (data.auto_threshold) {
        const avg = Object.values(data.auto_threshold);
        if (avg.length) {
            threshold = Math.round(avg.reduce((a,b) => a+b, 0) / avg.length * 2) / 2;
            document.getElementById('sliderThreshold').value = threshold;
            document.getElementById('valThreshold').textContent = '+' + threshold.toFixed(1) + ' dBA (auto)';
        }
    }
    margin = 5;
    marginZ = 1;
    document.getElementById('sliderMargin').value = margin;
    document.getElementById('valMargin').textContent = '±' + margin;
    document.getElementById('sliderMarginZ').value = marginZ;
    document.getElementById('valMarginZ').textContent = '±' + marginZ.toFixed(1);
    render();
    setStatus('green', 'Reset to auto values — threshold: +' + threshold.toFixed(1) + ' dBA');
}

// === APPLY TO KLIPPER (live, no restart) ===
async function applyToKlipper() {
    // Recalculate zones with current threshold from slider
    const zones = {};
    ['x', 'y', 'z'].forEach(axis => {
        const arr = data[axis] || [];
        if (!arr.length) return;
        const { zones: z } = findZones(arr, axis);
        zones[axis] = z.map(p => p.speed).join(',');
    });

    try {
        // Set margins
        await sendGcode('SET_RESONANCE_MARGIN MARGIN=' + margin + ' MARGIN_Z=' + marginZ);

        // Set zones per axis
        let cmd = 'SET_RESONANCE_ZONES';
        if (zones.x !== undefined) cmd += ' ZONES_X="' + zones.x + '"';
        if (zones.y !== undefined) cmd += ' ZONES_Y="' + zones.y + '"';
        if (zones.z !== undefined) cmd += ' ZONES_Z="' + zones.z + '"';
        await sendGcode(cmd);

        // Enable
        await sendGcode('RESONANCE_AVOIDANCE_ENABLE');

        // Save config file (persists across restarts)
        const zx = zones.x || '';
        const zy = zones.y || '';
        const zz = zones.z || '';
        await sendGcode(
            'RUN_SHELL_COMMAND CMD=acoustic_sweep PARAMS="save ' +
            margin + ' ' + marginZ + ' ' + zx + ' | ' + zy + ' | ' + zz + '"'
        );

        setStatus('green', 'Applied + saved! Active now, persists after restart.');
    } catch(e) {
        setStatus('red', 'Failed to apply: ' + e.message);
    }
}

// === VIEW SWITCHING ===
function switchView(view) {
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');
    event.target.classList.add('active');
    if (view === 'waterfall') drawWaterfall('x');
    if (view === 'scope') drawScopeStored();
}

// === WATERFALL / SPECTROGRAM ===
function drawWaterfall(axis) {
    const canvas = document.getElementById('chartWaterfall');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const pad = { t: 10, r: 15, b: 30, l: 55 };

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    const arr = data[axis] || [];
    if (!arr.length || !arr[0].s || !arr[0].s.length) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No spectrum data for ' + axis.toUpperCase() + ' — run a new sweep', W/2, H/2);
        return;
    }

    const speeds = arr.map(d => d.speed);
    const nBins = arr[0].s.length;
    const freqMax = data.freq_max || 2000;
    const minS = Math.min(...speeds), maxS = Math.max(...speeds);

    // Find global dB range for color mapping
    let allDb = [];
    arr.forEach(d => d.s.forEach(v => { if (v > -100) allDb.push(v); }));
    const dbMin = allDb.length ? Math.min(...allDb) : -60;
    const dbMax = allDb.length ? Math.max(...allDb) : 0;
    const dbRange = Math.max(dbMax - dbMin, 1);

    // Draw pixels: X = speed, Y = frequency (bottom=0, top=freqMax)
    const cellW = (W - pad.l - pad.r) / arr.length;
    const cellH = (H - pad.t - pad.b) / nBins;

    arr.forEach((d, xi) => {
        const cx = pad.l + xi * cellW;
        d.s.forEach((db, fi) => {
            // fi=0 is lowest freq, draw from bottom
            const cy = H - pad.b - (fi + 1) * cellH;
            const norm = Math.max(0, Math.min(1, (db - dbMin) / dbRange));
            ctx.fillStyle = waterfallColor(norm);
            ctx.fillRect(cx, cy, cellW + 0.5, cellH + 0.5);
        });
    });

    // Band markers
    const freqToY = f => H - pad.b - (f / freqMax) * (H - pad.t - pad.b);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    [200, 500].forEach(f => {
        const fy = freqToY(f);
        ctx.beginPath(); ctx.moveTo(pad.l, fy); ctx.lineTo(W - pad.r, fy); ctx.stroke();
    });
    ctx.setLineDash([]);

    // Band labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Low', pad.l + 3, freqToY(100) - 2);
    ctx.fillText('Mid', pad.l + 3, freqToY(350) - 2);
    ctx.fillText('High', pad.l + 3, freqToY(750) - 2);

    // Axes
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b);
    ctx.stroke();

    // X axis (speed)
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const step = maxS > 400 ? 100 : 50;
    for (let s = Math.ceil(minS/step)*step; s <= maxS; s += step) {
        const sx = pad.l + (s - minS) / (maxS - minS) * (W - pad.l - pad.r);
        ctx.fillText(s, sx, H - 8);
    }

    // Y axis (frequency)
    ctx.textAlign = 'right';
    for (let f = 0; f <= freqMax; f += 500) {
        ctx.fillText(f + ' Hz', pad.l - 4, freqToY(f) + 3);
    }

    // Color scale legend
    const legendW = 15, legendH = H - pad.t - pad.b;
    const legendX = W - pad.r + 3;
    for (let i = 0; i < legendH; i++) {
        const norm = 1 - i / legendH;
        ctx.fillStyle = waterfallColor(norm);
        ctx.fillRect(legendX, pad.t + i, legendW, 1);
    }
    ctx.fillStyle = '#8b949e';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';

    // Hover
    canvas.onmousemove = (ev) => {
        const br = canvas.getBoundingClientRect();
        const mx = ev.clientX - br.left, my = ev.clientY - br.top;
        const si = Math.floor((mx - pad.l) / cellW);
        const fi = Math.floor((H - pad.b - my) / cellH);
        if (si >= 0 && si < arr.length && fi >= 0 && fi < nBins) {
            const d = arr[si];
            const freq = Math.round(fi * freqMax / nBins);
            const db = d.s[fi];
            const tip = document.getElementById('tooltip');
            tip.style.display = 'block';
            tip.style.left = (ev.clientX + 10) + 'px';
            tip.style.top = (ev.clientY - 30) + 'px';
            tip.innerHTML = `<b>${d.speed} mm/s</b> @ ${freq} Hz<br>${db != null ? db.toFixed(1) : '?'} dB`;
        }
    };
    canvas.onmouseleave = () => { document.getElementById('tooltip').style.display = 'none'; };
}

function waterfallColor(norm) {
    // Black → blue → cyan → yellow → red → white
    if (norm < 0.2) {
        const t = norm / 0.2;
        return `rgb(0,0,${Math.round(t * 180)})`;
    } else if (norm < 0.4) {
        const t = (norm - 0.2) / 0.2;
        return `rgb(0,${Math.round(t * 255)},${180 + Math.round(t * 75)})`;
    } else if (norm < 0.6) {
        const t = (norm - 0.4) / 0.2;
        return `rgb(${Math.round(t * 255)},255,${255 - Math.round(t * 255)})`;
    } else if (norm < 0.8) {
        const t = (norm - 0.6) / 0.2;
        return `rgb(255,${255 - Math.round(t * 200)},0)`;
    } else {
        const t = (norm - 0.8) / 0.2;
        return `rgb(255,${55 + Math.round(t * 200)},${Math.round(t * 255)})`;
    }
}

// === SCOPE VIEW — browse stored spectrums or live ===
let scopeAxis = 'x';
let scopeIdx = 0;

function scopeMaxIdx() {
    const arr = data[scopeAxis] || [];
    return Math.max(0, arr.length - 1);
}

function drawScopeStored() {
    const arr = data[scopeAxis] || [];
    const slider = document.getElementById('scopeSlider');
    slider.max = Math.max(0, arr.length - 1);
    slider.value = scopeIdx;

    const canvas = document.getElementById('chartScopeFFT');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const pad = { t: 10, r: 10, b: 25, l: 50 };

    ctx.clearRect(0, 0, W, H);

    if (!arr.length || scopeIdx >= arr.length) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No spectrum data — run a sweep first', W/2, H/2);
        document.getElementById('scopeSpeedLabel').textContent = '—';
        return;
    }

    const d = arr[scopeIdx];
    const bins = d.s || [];
    const freqMax = data.freq_max || 2000;

    document.getElementById('scopeSpeedLabel').textContent =
        scopeAxis.toUpperCase() + ' ' + d.speed + ' mm/s';
    document.getElementById('scopeInfo').textContent =
        'Total: ' + (d.db >= 0 ? '+' : '') + (d.db || 0).toFixed(1) + ' dBA' +
        (d.low != null ? '  L:' + d.low.toFixed(1) + '  M:' + d.mid.toFixed(1) + '  H:' + d.high.toFixed(1) : '');

    if (!bins.length) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No spectrum for this point', W/2, H/2);
        return;
    }

    const validBins = bins.filter(v => v > -100);
    const maxDb = validBins.length ? Math.max(...validBins) : 0;
    const minDb = validBins.length ? Math.min(...validBins) : -40;
    const range = Math.max(maxDb - minDb, 1);

    // Band backgrounds
    const freqToX = f => pad.l + (f / freqMax) * (W - pad.l - pad.r);
    ctx.fillStyle = 'rgba(240,136,62,0.06)';
    ctx.fillRect(freqToX(50), pad.t, freqToX(200) - freqToX(50), H - pad.t - pad.b);
    ctx.fillStyle = 'rgba(88,166,255,0.06)';
    ctx.fillRect(freqToX(200), pad.t, freqToX(500) - freqToX(200), H - pad.t - pad.b);
    ctx.fillStyle = 'rgba(163,113,247,0.06)';
    ctx.fillRect(freqToX(500), pad.t, freqToX(freqMax) - freqToX(500), H - pad.t - pad.b);

    // Band separators
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    [200, 500].forEach(f => {
        const bx = freqToX(f);
        ctx.beginPath(); ctx.moveTo(bx, pad.t); ctx.lineTo(bx, H - pad.b); ctx.stroke();
    });
    ctx.setLineDash([]);

    // Band labels above each zone
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f0883e';
    ctx.fillText('Low 50-200Hz', (freqToX(50) + freqToX(200)) / 2, pad.t + 14);
    ctx.fillStyle = '#58a6ff';
    ctx.fillText('Mid 200-500Hz', (freqToX(200) + freqToX(500)) / 2, pad.t + 14);
    ctx.fillStyle = '#a371f7';
    ctx.fillText('High 500-2kHz', (freqToX(500) + freqToX(freqMax)) / 2, pad.t + 14);

    // Draw FFT bars colored by band
    const barW = (W - pad.l - pad.r) / bins.length;
    bins.forEach((db, i) => {
        if (db <= -100) return;
        const freq = i * freqMax / bins.length;
        const norm = (db - minDb) / range;
        const h = norm * (H - pad.t - pad.b);
        const bx = pad.l + i * barW;
        const by = H - pad.b - h;

        if (freq < 50) ctx.fillStyle = 'rgba(139,148,158,0.3)';
        else if (freq < 200) ctx.fillStyle = '#f0883e';
        else if (freq < 500) ctx.fillStyle = '#58a6ff';
        else ctx.fillStyle = '#a371f7';

        ctx.fillRect(bx, by, barW + 0.5, h);
    });

    // Axes
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b);
    ctx.stroke();

    // X labels (frequency)
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (let f = 0; f <= freqMax; f += 250) {
        ctx.fillText(f + 'Hz', freqToX(f), H - 6);
    }

    // Y labels (dBA)
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const db = minDb + range * i / 4;
        ctx.fillText(db.toFixed(0) + ' dBA', pad.l - 4, H - pad.b - (i/4) * (H - pad.t - pad.b) + 3);
    }

    // Hover
    canvas.onmousemove = (ev) => {
        const br = canvas.getBoundingClientRect();
        const mx = ev.clientX - br.left;
        const bi = Math.floor((mx - pad.l) / barW);
        if (bi >= 0 && bi < bins.length) {
            const freq = Math.round(bi * freqMax / bins.length);
            const db = bins[bi];
            const tip = document.getElementById('tooltip');
            tip.style.display = 'block';
            tip.style.left = (ev.clientX + 10) + 'px';
            tip.style.top = (ev.clientY - 30) + 'px';
            tip.innerHTML = `<b>${freq} Hz</b><br>${db > -100 ? db.toFixed(1) + ' dBA' : 'below noise floor'}`;
        }
    };
    canvas.onmouseleave = () => { document.getElementById('tooltip').style.display = 'none'; };
}

// Also try live scope during sweep
function drawScope() {
    fetch('/anc_live.json?' + Date.now()).then(r => r.ok ? r.json() : null).then(specData => {
        if (!specData || !specData.spectrum) {
            drawScopeStored(); // Fallback to stored data
            return;
        }
        // During live sweep, update stored scope with live data
        scopeAxis = specData.axis;
        document.getElementById('scopeSpeedLabel').textContent =
            specData.axis.toUpperCase() + ' ' + specData.speed + ' mm/s (LIVE)';

        // Draw live spectrum on the same canvas
        const canvas = document.getElementById('chartScopeFFT');
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        const W = rect.width, H = rect.height;
        const pad = { t: 10, r: 10, b: 25, l: 50 };
        ctx.clearRect(0, 0, W, H);

        const bins = specData.spectrum;
        const freqMax = specData.freq_max || 2000;
        const validBins = bins.filter(v => v > -100);
        const maxDb = validBins.length ? Math.max(...validBins) : 0;
        const minDb = validBins.length ? Math.min(...validBins) : -40;
        const range = Math.max(maxDb - minDb, 1);
        const barW = (W - pad.l - pad.r) / bins.length;
        const freqToX = f => pad.l + (f / freqMax) * (W - pad.l - pad.r);

        // Band backgrounds
        ctx.fillStyle = 'rgba(240,136,62,0.06)';
        ctx.fillRect(freqToX(50), pad.t, freqToX(200) - freqToX(50), H - pad.t - pad.b);
        ctx.fillStyle = 'rgba(88,166,255,0.06)';
        ctx.fillRect(freqToX(200), pad.t, freqToX(500) - freqToX(200), H - pad.t - pad.b);
        ctx.fillStyle = 'rgba(163,113,247,0.06)';
        ctx.fillRect(freqToX(500), pad.t, freqToX(freqMax) - freqToX(500), H - pad.t - pad.b);

        bins.forEach((db, i) => {
            if (db <= -100) return;
            const freq = i * freqMax / bins.length;
            const norm = (db - minDb) / range;
            const h = norm * (H - pad.t - pad.b);
            const bx = pad.l + i * barW;
            const by = H - pad.b - h;
            ctx.fillStyle = freq < 200 ? '#f0883e' : freq < 500 ? '#58a6ff' : '#a371f7';
            ctx.fillRect(bx, by, barW + 0.5, h);
        });

        ctx.strokeStyle = '#30363d';
        ctx.beginPath();
        ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b);
        ctx.stroke();
        ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
        for (let f = 0; f <= freqMax; f += 250) ctx.fillText(f+'Hz', freqToX(f), H-6);

        document.getElementById('scopeInfo').textContent = 'LIVE — ' +
            specData.axis.toUpperCase() + ' ' + specData.speed + ' mm/s';
    }).catch(() => { drawScopeStored(); });
}

// Auto-detect sweep in progress on page load — uses the explicit status flag,
// falling back to anc_live freshness if the status file isn't there yet.
async function autoDetectLive() {
    let running = false;
    try {
        const r = await fetch('/anc_status.json?' + Date.now());
        if (r.ok) {
            const s = await r.json();
            if (typeof s.running === 'boolean') running = s.running;
        }
    } catch(e) {}
    if (!running) {
        try {
            const resp = await fetch('/anc_live.json?' + Date.now());
            if (resp.ok) {
                const specData = await resp.json();
                if (specData.t && (Date.now()/1000 - specData.t) < 60) running = true;
            }
        } catch(e) {}
    }
    if (running) {
        setCalibratingUI(true);
        startLiveSpectrum();
        startLiveRefresh();
        watchCalibration();
        setStatus('orange', 'Sweep in progress — live monitoring active');
    }
}

window.addEventListener('resize', render);
loadData();
autoDetectLive();
