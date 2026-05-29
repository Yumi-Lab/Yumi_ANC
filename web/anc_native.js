/**
 * Yumi-ANC — NATIVE Mainsail Panel Injection
 *
 * Adds a "YUMi ANC (native)" entry to the Mainsail sidebar (matching Mainsail's
 * own nav-item CSS so it looks native). When clicked it hides Mainsail's content
 * and shows a NATIVE panel built directly in the main DOM (no iframe). The panel
 * markup is the full body of anc.html; its logic is loaded once from
 * /anc_core.js. The ANC CSS is re-themed to Mainsail's dark palette and fully
 * scoped under #anc-native-root so nothing leaks into Mainsail.
 *
 * Same injection pattern as anc_inject.js (which it can coexist with: the iframe
 * panel runs anc.html in an isolated document, this native panel runs anc_core.js
 * in the main document — no shared globals). Everything here stays inside the
 * IIFE so no global names clash with anc_inject.js.
 */

(function () {
  'use strict';

  const MAX_WAIT = 30000;
  let ancActive = false;
  let savedActive = [];
  let ancDiv = null;
  let ancNavItem = null;
  let markupInjected = false;
  let coreLoaded = false;

  // Equalizer / resonance icon (same as anc_inject.js)
  const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:24px;height:24px;fill:currentColor">
    <path d="M3,9H5V15H3V9M7,5H9V19H7V5M11,11H13V13H11V11M15,7H17V17H15V7M19,10H21V14H19V10Z"/>
  </svg>`;

  // Full body markup of anc.html (everything inside <body>...</body> EXCEPT the
  // trailing <script>). All element IDs and inline onclick handlers are kept
  // identical so anc_core.js works unchanged.
  const PANEL_HTML = `

<div class="header">
    <h1>YUMi ANC <span>Active Noise Canceling</span></h1>
    <div style="display:flex; gap:8px; align-items:center;">
        <button class="btn btn-primary" id="btnCalibrate" onclick="startCalibration()">Start Calibration</button>
        <button class="btn btn-danger" id="btnStop" onclick="stopCalibration()" style="display:none">Stop</button>
        <button class="btn" onclick="loadData()">Reload Data</button>
        <button class="btn" id="btnWav" onclick="toggleWavPanel()">Audio</button>
    </div>
</div>

<div class="status-bar" id="statusBar">
    <div class="status-dot green" id="statusDot"></div>
    <span id="statusText">Ready — Load data or start calibration</span>
</div>

<div class="card" id="wavPanel" style="display:none;margin:0 20px 0 20px">
    <div class="card-title">Last Sweep Audio</div>
    <audio id="wavPlayer" controls style="width:100%;margin-bottom:8px"></audio>
    <div style="display:flex;gap:8px;align-items:center">
        <a class="btn" id="wavDownload" href="/anc_last_sweep.wav" download="anc_sweep.wav">Download WAV</a>
        <span id="wavInfo" style="color:var(--dim);font-size:0.8em">—</span>
    </div>
</div>

<div class="container">
    <div class="controls card" style="margin-bottom:15px">
        <div class="control-group">
            <label>Threshold:</label>
            <input type="range" id="sliderThreshold" min="3" max="30" step="0.5" value="10" oninput="updateControls()">
            <span class="val" id="valThreshold">+10.0 dBA</span>
        </div>
        <div class="control-group">
            <label>Margin XY:</label>
            <input type="range" id="sliderMargin" min="1" max="20" step="1" value="5" oninput="updateControls()">
            <span class="val" id="valMargin">±5</span>
        </div>
        <div class="control-group">
            <label>Margin Z:</label>
            <input type="range" id="sliderMarginZ" min="0.5" max="5" step="0.5" value="1" oninput="updateControls()">
            <span class="val" id="valMarginZ">±1</span>
        </div>
        <div class="control-group">
            <label>Speed range:</label>
            <span class="val" id="valRange">20-700 mm/s</span>
        </div>
        <div class="control-group">
            <label>Chart:</label>
            <button class="btn" id="btnChartType" onclick="toggleChartType()" style="padding:4px 10px;font-size:0.8em">Line</button>
        </div>
        <div class="control-group" style="margin-left:auto">
            <button class="btn" onclick="resetToAuto()" style="padding:6px 12px;font-size:0.85em">Auto</button>
            <button class="btn btn-primary" onclick="applyToKlipper()" style="padding:6px 14px;font-size:0.85em">Apply to Klipper</button>
        </div>
    </div>

    <div class="card" id="livePanel" style="margin-bottom:15px;display:none">
        <div class="card-title">
            Live Audio Spectrum
            <span id="liveSpeed" style="color:var(--orange);font-size:0.85em">—</span>
        </div>
        <canvas id="chartLive" style="height:150px"></canvas>
    </div>

    <div class="tabs">
        <div class="tab active" onclick="switchView('spl')">SPL</div>
        <div class="tab" onclick="switchView('waterfall')">Waterfall</div>
        <div class="tab" onclick="switchView('scope')">Scope</div>
    </div>

    <div class="view-panel active" id="view-spl">
        <div class="card" style="margin-bottom:15px">
            <div class="card-title">
                X Axis — Resonance Map
                <span class="badge" id="badgeX">—</span>
            </div>
            <canvas id="chartX"></canvas>
            <div class="legend">
                <div class="legend-item"><div class="legend-dot" style="background:#c9d1d9"></div> Total</div>
                <div class="legend-item"><div class="legend-dot" style="background:#f0883e"></div> Low 50-200Hz</div>
                <div class="legend-item"><div class="legend-dot" style="background:#58a6ff"></div> Mid 200-500Hz</div>
                <div class="legend-item"><div class="legend-dot" style="background:#a371f7"></div> High 500-2kHz</div>
                <div class="legend-item"><div class="legend-dot" style="background:var(--red)"></div> Resonance</div>
            </div>
        </div>
        <div class="card" style="margin-top:15px;margin-bottom:15px">
            <div class="card-title">
                Y Axis — Resonance Map
                <span class="badge" id="badgeY">—</span>
            </div>
            <canvas id="chartY"></canvas>
            <div class="legend">
                <div class="legend-item"><div class="legend-dot" style="background:#c9d1d9"></div> Total</div>
                <div class="legend-item"><div class="legend-dot" style="background:#f0883e"></div> Low 50-200Hz</div>
                <div class="legend-item"><div class="legend-dot" style="background:#58a6ff"></div> Mid 200-500Hz</div>
                <div class="legend-item"><div class="legend-dot" style="background:#a371f7"></div> High 500-2kHz</div>
                <div class="legend-item"><div class="legend-dot" style="background:var(--red)"></div> Resonance</div>
            </div>
        </div>
        <div class="card" style="margin-bottom:15px">
        <div class="card-title">
            Z Axis — Resonance Map
            <span class="badge" id="badgeZ">—</span>
        </div>
        <canvas id="chartZ"></canvas>
        <div class="legend">
            <div class="legend-item"><div class="legend-dot" style="background:var(--blue)"></div> Safe</div>
            <div class="legend-item"><div class="legend-dot" style="background:var(--red)"></div> Resonance</div>
            <div class="legend-item"><div class="legend-dot" style="background:var(--orange);opacity:0.3"></div> Avoidance zone</div>
        </div>
    </div>

    <div class="card" id="cardD" style="margin-bottom:15px">
        <div class="card-title">
            XY Diagonal — Resonance Map (experimental)
            <span class="badge" id="badgeD">—</span>
        </div>
        <canvas id="chartD"></canvas>
        <div class="legend">
                <div class="legend-item"><div class="legend-dot" style="background:#c9d1d9"></div> Total</div>
                <div class="legend-item"><div class="legend-dot" style="background:#f0883e"></div> Low 50-200Hz</div>
                <div class="legend-item"><div class="legend-dot" style="background:#58a6ff"></div> Mid 200-500Hz</div>
                <div class="legend-item"><div class="legend-dot" style="background:#a371f7"></div> High 500-2kHz</div>
                <div class="legend-item"><div class="legend-dot" style="background:var(--red)"></div> Resonance</div>
        </div>
    </div>

    </div><!-- end view-spl -->

    <div class="view-panel" id="view-waterfall">
        <div class="card" style="margin-bottom:15px">
            <div class="card-title">Waterfall — Frequency vs Speed vs Amplitude</div>
            <div style="display:flex;gap:8px;margin-bottom:8px">
                <button class="btn" onclick="drawWaterfall('x')" style="padding:4px 12px;font-size:0.8em">X</button>
                <button class="btn" onclick="drawWaterfall('y')" style="padding:4px 12px;font-size:0.8em">Y</button>
                <button class="btn" onclick="drawWaterfall('z')" style="padding:4px 12px;font-size:0.8em">Z</button>
                <button class="btn" onclick="drawWaterfall('d')" style="padding:4px 12px;font-size:0.8em">XY</button>
            </div>
            <canvas id="chartWaterfall" style="height:350px"></canvas>
            <div style="display:flex;justify-content:space-between;font-size:0.7em;color:var(--dim);margin-top:3px">
                <span>Speed (mm/s) →</span>
                <span>Color = amplitude (dBA)</span>
                <span>↑ Frequency (Hz)</span>
            </div>
        </div>
    </div>

    <div class="view-panel" id="view-scope">
        <div class="card" style="margin-bottom:15px">
            <div class="card-title">
                Scope — FFT Spectrum per Speed
                <span id="scopeInfo" style="color:var(--blue);font-size:0.85em">—</span>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
                <button class="btn" onclick="scopeAxis='x';scopeIdx=0;drawScopeStored()" style="padding:4px 12px;font-size:0.8em">X</button>
                <button class="btn" onclick="scopeAxis='y';scopeIdx=0;drawScopeStored()" style="padding:4px 12px;font-size:0.8em">Y</button>
                <button class="btn" onclick="scopeAxis='z';scopeIdx=0;drawScopeStored()" style="padding:4px 12px;font-size:0.8em">Z</button>
                <span style="color:var(--dim);font-size:0.8em">|</span>
                <button class="btn" onclick="scopeIdx=Math.max(0,scopeIdx-1);drawScopeStored()" style="padding:4px 10px;font-size:0.8em">◀</button>
                <span id="scopeSpeedLabel" style="color:var(--text);font-size:0.9em;min-width:80px;text-align:center">—</span>
                <button class="btn" onclick="scopeIdx=Math.min(scopeMaxIdx(),scopeIdx+1);drawScopeStored()" style="padding:4px 10px;font-size:0.8em">▶</button>
                <input type="range" id="scopeSlider" min="0" max="0" value="0" oninput="scopeIdx=parseInt(this.value);drawScopeStored()" style="flex:1;accent-color:var(--blue)">
            </div>
            <canvas id="chartScopeFFT" style="height:280px"></canvas>
            <div style="display:flex;justify-content:space-between;font-size:0.7em;margin-top:3px">
                <span style="color:var(--dim)">0 Hz</span>
                <span style="color:#f0883e">Low 50-200</span>
                <span style="color:#58a6ff">Mid 200-500</span>
                <span style="color:#a371f7">High 500-2k</span>
            </div>
        </div>
    </div>

    <div class="stats-row">
        <div class="stat-box"><div class="label">X Zones</div><div class="value red" id="statXZones">—</div></div>
        <div class="stat-box"><div class="label">Y Zones</div><div class="value red" id="statYZones">—</div></div>
        <div class="stat-box"><div class="label">X Median</div><div class="value blue" id="statXMedian">—</div></div>
        <div class="stat-box"><div class="label">Y Median</div><div class="value blue" id="statYMedian">—</div></div>
        <div class="stat-box"><div class="label">Worst Peak</div><div class="value red" id="statWorst">—</div></div>
        <div class="stat-box"><div class="label">Total Points</div><div class="value green" id="statPoints">—</div></div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">X Axis — Zones to Avoid</div>
            <table class="zone-table" id="tableX"></table>
        </div>
        <div class="card">
            <div class="card-title">Y Axis — Zones to Avoid</div>
            <table class="zone-table" id="tableY"></table>
        </div>
    </div>

    <div class="card">
        <div class="card-title">
            Klipper Config Output
            <button class="btn" onclick="copyConfig()" style="font-size:0.8em;padding:4px 10px;">Copy</button>
        </div>
        <div class="config-output" id="configOutput">## No data loaded yet</div>
    </div>

    <div class="sweep-progress" id="sweepProgress" style="display:none">
        <div class="sweep-progress-fill" id="sweepProgressFill" style="width:0%"></div>
    </div>
</div>

<div class="tooltip" id="tooltip" style="display:none"></div>
`;

  // Scoped + re-themed CSS. Every selector from anc.html's <style> is prefixed
  // with `#anc-native-root ` so it cannot leak into Mainsail. Colors are remapped
  // to Mainsail's dark theme palette. The box-sizing reset is scoped to
  // `#anc-native-root *` only — we never touch global body/* rules.
  const PANEL_CSS = `
    #anc-native-root {
      --bg: #121212; --card: rgb(30,30,30); --border: rgba(255,255,255,.12);
      --text: rgba(255,255,255,.87); --dim: rgba(255,255,255,.6);
      --blue: var(--v-primary-base, #2196f3); --red: #ff5252; --green: #4caf50; --orange: #fb8c00;
      font-family: Roboto, sans-serif; background: var(--bg); color: var(--text);
      overflow-y: auto; padding: 0 0 20px 0;
    }
    #anc-native-root * { margin: 0; padding: 0; box-sizing: border-box; }
    #anc-native-root .header { background: var(--card); border-bottom: 1px solid var(--border); padding: 15px 20px; display: flex; align-items: center; justify-content: space-between; }
    #anc-native-root .header h1 { font-size: 1.2em; color: var(--blue); }
    #anc-native-root .header h1 span { color: var(--dim); font-weight: normal; font-size: 0.8em; }
    #anc-native-root .btn { padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font-size: 0.85em; transition: all 0.2s; }
    #anc-native-root .btn:hover { border-color: var(--blue); color: var(--blue); }
    #anc-native-root .btn-primary { background: #4caf50; border-color: #4caf50; color: #fff; }
    #anc-native-root .btn-primary:hover { background: #43a047; }
    #anc-native-root .btn-danger { background: #ff5252; border-color: #ff5252; color: #fff; }
    #anc-native-root .btn-danger:hover { background: #ff1744; }
    #anc-native-root .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #anc-native-root .container { max-width: 100%; padding: 15px; }
    #anc-native-root .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; }
    @media (max-width: 768px) { #anc-native-root .grid { grid-template-columns: 1fr; } }
    #anc-native-root .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 15px; }
    #anc-native-root .card-title { font-size: 0.9em; color: var(--blue); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
    #anc-native-root .card-title .badge { font-size: 0.75em; padding: 2px 8px; border-radius: 10px; }
    #anc-native-root .badge-red { background: rgba(255,82,82,0.2); color: var(--red); }
    #anc-native-root .badge-green { background: rgba(76,175,80,0.2); color: var(--green); }
    #anc-native-root canvas { width: 100%; height: 220px; display: block; cursor: crosshair; }
    #anc-native-root .controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    #anc-native-root .control-group { display: flex; align-items: center; gap: 6px; }
    #anc-native-root .control-group label { color: var(--dim); font-size: 0.8em; white-space: nowrap; }
    #anc-native-root .control-group input[type="range"] { width: 100px; accent-color: var(--blue); }
    #anc-native-root .control-group .val { color: var(--blue); font-weight: bold; font-size: 0.85em; min-width: 45px; }
    #anc-native-root .stats-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0; }
    #anc-native-root .stat-box { background: var(--bg); border-radius: 6px; padding: 8px 12px; flex: 1; min-width: 100px; }
    #anc-native-root .stat-box .label { font-size: 0.7em; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; }
    #anc-native-root .stat-box .value { font-size: 1.3em; font-weight: bold; }
    #anc-native-root .stat-box .value.red { color: var(--red); }
    #anc-native-root .stat-box .value.green { color: var(--green); }
    #anc-native-root .stat-box .value.blue { color: var(--blue); }
    #anc-native-root .zone-table { width: 100%; font-size: 0.8em; border-collapse: collapse; }
    #anc-native-root .zone-table th { text-align: left; color: var(--dim); padding: 4px 8px; border-bottom: 1px solid var(--border); }
    #anc-native-root .zone-table td { padding: 4px 8px; }
    #anc-native-root .zone-table tr.resonance td { color: var(--red); }
    #anc-native-root .zone-table tr.safe td { color: var(--green); }
    #anc-native-root .zone-bar { height: 6px; border-radius: 3px; background: var(--border); }
    #anc-native-root .zone-bar-fill { height: 100%; border-radius: 3px; }
    #anc-native-root .config-output { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-family: monospace; font-size: 0.8em; color: var(--green); white-space: pre; overflow-x: auto; margin-top: 10px; }
    #anc-native-root .status-bar { padding: 8px 15px; font-size: 0.8em; display: flex; align-items: center; gap: 8px; }
    #anc-native-root .status-dot { width: 8px; height: 8px; border-radius: 50%; }
    #anc-native-root .status-dot.green { background: var(--green); }
    #anc-native-root .status-dot.red { background: var(--red); }
    #anc-native-root .status-dot.orange { background: var(--orange); animation: anc-native-pulse 1s infinite; }
    @keyframes anc-native-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    #anc-native-root .tooltip { position: absolute; background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; font-size: 0.8em; pointer-events: none; z-index: 100; }
    #anc-native-root .legend { display: flex; gap: 15px; font-size: 0.75em; color: var(--dim); margin-top: 5px; }
    #anc-native-root .legend-item { display: flex; align-items: center; gap: 4px; }
    #anc-native-root .legend-dot { width: 8px; height: 8px; border-radius: 2px; }
    #anc-native-root .sweep-progress { height: 4px; background: var(--border); border-radius: 2px; margin-top: 8px; }
    #anc-native-root .sweep-progress-fill { height: 100%; background: var(--blue); border-radius: 2px; transition: width 0.3s; }
    #anc-native-root .tabs { display: flex; gap: 2px; margin-bottom: 15px; }
    #anc-native-root .tab { padding: 8px 16px; border-radius: 6px 6px 0 0; background: var(--bg); color: var(--dim); cursor: pointer; font-size: 0.85em; border: 1px solid var(--border); border-bottom: none; }
    #anc-native-root .tab.active { background: var(--card); color: var(--blue); font-weight: bold; }
    #anc-native-root .view-panel { display: none; }
    #anc-native-root .view-panel.active { display: block; }
  `;

  function waitFor(sel, timeout) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function check() {
        const el = document.querySelector(sel);
        if (el) return resolve(el);
        if (Date.now() - t0 > timeout) return reject('timeout');
        requestAnimationFrame(check);
      })();
    });
  }

  function injectStyles() {
    if (document.getElementById('anc-native-styles')) return;
    const style = document.createElement('style');
    style.id = 'anc-native-styles';
    style.textContent = `
      #anc-native-root { display:none; position:fixed; top:48px; left:256px; right:0; bottom:0; z-index:100; }
      #anc-native-root.anc-show { display:block; }
      ${PANEL_CSS}
      /* Mainsail's blue selection bar, replicated reliably on our nav item
         (its scoped .active-nav-item[data-v-...] rule won't match our element). */
      a[href="#anc-native"].v-list-item--active { border-right: 4px solid var(--v-primary-base, #2196f3) !important; }
    `;
    document.head.appendChild(style);
  }

  function createRoot() {
    injectStyles();
    const root = document.createElement('div');
    root.id = 'anc-native-root';
    document.body.appendChild(root);
    return root;
  }

  function loadCore() {
    if (coreLoaded) return;
    coreLoaded = true;
    // Load the logic ONCE, AFTER the markup exists so its init (loadData /
    // autoDetectLive, attached to the end of anc_core.js) finds its DOM.
    const s = document.createElement('script');
    s.src = '/anc_core.js';
    s.async = false;
    document.body.appendChild(s);
  }

  // Close sibling Yumi panels (YMS, ANC web) when we open.
  window.addEventListener('yumi-panel-open', e => {
    if (e.detail !== 'anc-native' && ancActive) hideAnc(false);
  });

  function showAnc() {
    window.dispatchEvent(new CustomEvent('yumi-panel-open', { detail: 'anc-native' }));
    if (!ancDiv) ancDiv = createRoot();
    // Lazy init: inject markup first, then load the logic once.
    if (!markupInjected) {
      ancDiv.innerHTML = PANEL_HTML;
      markupInjected = true;
      loadCore();
    }
    document.querySelectorAll('main, .v-main, .v-main__wrap').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.v-navigation-drawer--right').forEach(el => el.style.display = 'none');
    ancDiv.classList.add('anc-show');
    ancActive = true;
    // 'active-nav-item' draws Mainsail's blue selection bar; 'v-list-item--active'
    // gives the active background. Also clear the active state Mainsail still holds
    // on its current item so two items don't show the bar at once.
    if (ancNavItem) ancNavItem.classList.add('v-list-item--active', 'active-nav-item');
    deactivateOthers();
    adjustPos();
  }

  function deactivateOthers() {
    savedActive = [];
    document.querySelectorAll('.v-navigation-drawer .v-list-item--active, .v-navigation-drawer .active-nav-item')
      .forEach(el => {
        if (el === ancNavItem) return;
        const had = [];
        ['v-list-item--active', 'active-nav-item'].forEach(c => {
          if (el.classList.contains(c)) { el.classList.remove(c); had.push(c); }
        });
        if (had.length) savedActive.push([el, had]);
      });
  }
  function restoreOthers() {
    savedActive.forEach(([el, had]) => had.forEach(c => el.classList.add(c)));
    savedActive = [];
  }

  function hideAnc(restore) {
    if (ancDiv) ancDiv.classList.remove('anc-show');
    document.querySelectorAll('main, .v-main, .v-main__wrap').forEach(el => el.style.display = '');
    document.querySelectorAll('.v-navigation-drawer--right').forEach(el => el.style.display = '');
    ancActive = false;
    if (ancNavItem) ancNavItem.classList.remove('v-list-item--active', 'active-nav-item');
    if (restore) restoreOthers(); else savedActive = [];
  }

  function adjustPos() {
    if (!ancDiv) return;
    const nav = document.querySelector('.v-navigation-drawer');
    if (!nav) return;
    const w = nav.offsetWidth || 256;
    const closed = nav.classList.contains('v-navigation-drawer--close');
    ancDiv.style.left = closed ? '56px' : w + 'px';
  }
  window.addEventListener('resize', adjustPos);

  function injectSidebar(nav) {
    const list = nav.querySelector('.v-list') || nav;
    const items = list.querySelectorAll('a.v-list-item, .v-list-item');
    if (!items.length) return false;
    if (list.querySelector('a[href="#anc-native"]')) return true;

    let insertBefore = null;
    items.forEach(item => { if (item.textContent.trim().toUpperCase() === 'MACHINE') insertBefore = item; });

    ancNavItem = document.createElement('a');
    ancNavItem.href = '#anc-native';
    // Copy Mainsail's exact nav-item classes (minus active state) for a native look.
    ancNavItem.className = items[0].className.replace(/v-list-item--active/g, '').replace(/active-nav-item/g, '').trim();
    // Copy Vue scoped-style attributes (e.g. data-v-640efc00) so Mainsail's
    // scoped rule `.active-nav-item[data-v-...]{border-right:4px solid primary}`
    // applies to our item — without it the blue selection bar never shows.
    items[0].getAttributeNames().forEach(a => {
      if (a.indexOf('data-v-') === 0) ancNavItem.setAttribute(a, items[0].getAttribute(a));
    });
    ancNavItem.style.textDecoration = 'none';
    ancNavItem.innerHTML = `
      <div class="v-list-item__icon my-3 mr-3 menu-item-icon">${ICON}</div>
      <div class="v-list-item__content">
        <div class="v-list-item__title menu-item-title">YUMi ANC</div>
      </div>`;

    ancNavItem.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      showAnc();
    });

    if (insertBefore) insertBefore.parentNode.insertBefore(ancNavItem, insertBefore);
    else list.appendChild(ancNavItem);

    items.forEach(item => item.addEventListener('click', () => { if (ancActive) hideAnc(false); }));
    return true;
  }

  async function init() {
    try {
      const nav = await waitFor('.v-navigation-drawer', MAX_WAIT);
      await new Promise(r => setTimeout(r, 3000));
      if (injectSidebar(nav)) console.log('[ANC-native] Injected');
      else { console.warn('[ANC-native] Retry...'); setTimeout(init, 3000); }
    } catch (e) { console.warn('[ANC-native]', e); setTimeout(init, 5000); }
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
