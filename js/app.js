// app.js — Main application controller
(function() {
  'use strict';

  var $ = UI.$;
  var scanning = false;
  var scanTimer = null;
  var lastResult = null;
  var SCAN_DURATION = 15; // seconds
  var FPS = 30;

  // === INITIALIZATION ===
  async function init() {
    // Tab navigation
    document.querySelectorAll('.tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
        tab.classList.add('active');
        var target = 'tab-' + tab.dataset.tab;
        document.getElementById(target).classList.add('active');
        if (tab.dataset.tab === 'history') UI.renderHistory();
        if (tab.dataset.tab === 'calibrate') UI.renderCalibration();
      });
    });

    // Camera
    Camera.init($('video'), $('overlay'));

    // Buttons
    $('btnStart').addEventListener('click', startScan);
    $('btnStop').addEventListener('click', stopScan);

    // Load models
    $('versionBadge').textContent = 'loading models…';
    var ok = await Predict.loadModels();
    if (ok) {
      $('versionBadge').textContent = 'v6 · GBR+NN · 275 subjects';
      UI.toast('Models loaded', 'ok');
    } else {
      $('versionBadge').textContent = 'model load failed';
      UI.toast('Failed to load models', 'err');
    }

    // Load profile
    loadProfile();
    UI.renderHistory();
  }

  // === SCANNING ===
  function startScan() {
    if (scanning) return;
    if (!Predict.isLoaded()) { UI.toast('Models not loaded yet', 'err'); return; }
    scanning = true;
    $('btnStart').disabled = true;
    $('btnStop').disabled = false;
    $('scanStatus').textContent = 'Initializing camera…';
    $('resultCard').style.display = 'none';
    $('featCard').style.display = 'none';

    var startTime = Date.now();
    var bvpData = [];

    Camera.start(function(data) {
      if (!scanning) return;

      var elapsed = (Date.now() - startTime) / 1000;
      var remaining = Math.max(0, SCAN_DURATION - elapsed);

      if (!data.face) {
        $('scanStatus').textContent = 'No face detected — look at camera';
        return;
      }

      $('frameCount').textContent = 'Frame ' + data.frame + ' ✓';
      $('scanStatus').textContent = 'Scanning… ' + Math.ceil(remaining) + 's remaining';

      // Show ROIs
      if (data.boxes && data.frame % 10 === 0) {
        $('roiCard').style.display = '';
        $('roiFrame').textContent = 'Frame ' + data.frame;
        Camera.drawROI('roiF', data.boxes.f);
        Camera.drawROI('roiL', data.boxes.l);
        Camera.drawROI('roiR', data.boxes.r);
      }

      // Process BVP signal
      if (data.rgbBuffer.length > 30) {
        var bvp = Signal.pos(data.rgbBuffer);
        var filtered = Signal.bandpass(bvp, FPS, 0.7, 4.0);

        // Show live signal (last 150 samples)
        $('signalCard').style.display = '';
        var showLen = Math.min(filtered.length, 150);
        var showData = [];
        for (var i = filtered.length - showLen; i < filtered.length; i++) showData.push(filtered[i]);
        UI.drawChart('bvpChart', showData, { height: 120 });

        // Show spectrum
        if (filtered.length > 64) {
          $('specCard').style.display = '';
          var spec = Signal.powerSpectrum(filtered, FPS);
          // Find HR peak
          var maxP = 0, hrFreq = 1;
          for (var i = 0; i < spec.freqs.length; i++) {
            if (spec.freqs[i] >= 0.75 && spec.freqs[i] <= 3.5 && spec.power[i] > maxP) {
              maxP = spec.power[i]; hrFreq = spec.freqs[i];
            }
          }
          UI.drawSpectrum('specChart', spec.freqs, spec.power, hrFreq);
          $('sigQuality').textContent = 'HR ~' + Math.round(hrFreq * 60) + ' BPM';
        }
      }

      // Complete scan
      if (elapsed >= SCAN_DURATION) {
        completeScan(data.rgbBuffer);
      }
    });
  }

  function completeScan(rgbBuffer) {
    scanning = false;
    Camera.stop();
    $('btnStart').disabled = false;
    $('btnStop').disabled = true;
    $('scanStatus').textContent = 'Processing…';

    if (rgbBuffer.length < FPS * 5) {
      $('scanStatus').textContent = 'Not enough data — try again in better lighting';
      UI.toast('Scan failed — insufficient data', 'err');
      return;
    }

    // Final BVP
    var bvp = Signal.pos(rgbBuffer);
    var profile = getProfile();
    var features = Signal.extractFeatures(bvp, FPS, profile);

    if (!features) {
      $('scanStatus').textContent = 'Could not extract pulse — try again';
      UI.toast('Feature extraction failed', 'err');
      return;
    }

    // Predict
    var result = Predict.predict(features);
    if (!result) {
      $('scanStatus').textContent = 'Prediction failed';
      UI.toast('Model prediction failed', 'err');
      return;
    }

    lastResult = result;
    window._lastRes = result; // for calibration

    // Display
    $('scanStatus').textContent = 'Complete ✓';
    UI.showResults(result);
    UI.showFeatures(features, Predict.getImportance());

    // Save to history
    saveHistory(result);
    UI.toast('BP: ' + result.sbp + '/' + result.dbp + ' mmHg', 'ok');
  }

  function stopScan() {
    scanning = false;
    Camera.stop();
    $('btnStart').disabled = false;
    $('btnStop').disabled = true;
    $('scanStatus').textContent = 'Stopped';
  }

  // === PROFILE ===
  function getProfile() {
    try {
      return JSON.parse(localStorage.getItem('vs_profile') || '{}');
    } catch(e) { return {}; }
  }

  function loadProfile() {
    var p = getProfile();
    if (p.name) $('profName').value = p.name;
    if (p.age) $('profAge').value = p.age;
    if (p.gender !== undefined && p.gender !== null) $('profGender').value = p.gender;
    if (p.height) $('profHeight').value = p.height;
    if (p.weight) $('profWeight').value = p.weight;
    if (p.height && p.weight) {
      $('profBMI').value = (p.weight / Math.pow(p.height/100, 2)).toFixed(1);
    }
    if (p.name) $('profBadge').textContent = p.name;
  }

  function saveProfile() {
    var p = {
      name: $('profName').value,
      age: parseInt($('profAge').value) || null,
      gender: $('profGender').value !== '' ? parseInt($('profGender').value) : null,
      height: parseFloat($('profHeight').value) || null,
      weight: parseFloat($('profWeight').value) || null,
      bmi: parseFloat($('profBMI').value) || null
    };
    if (!p.bmi && p.height && p.weight) {
      p.bmi = Math.round(p.weight / Math.pow(p.height/100, 2) * 10) / 10;
    }
    try {
      localStorage.setItem('vs_profile', JSON.stringify(p));
      $('profBadge').textContent = p.name || 'Saved';
      UI.toast('Profile saved · BMI: ' + (p.bmi||'?'), 'ok');
    } catch(e) {
      UI.toast('Error: ' + e.message, 'err');
    }
  }

  function resetProfile() {
    try { localStorage.removeItem('vs_profile'); } catch(e) {}
    ['profName','profAge','profGender','profBMI','profHeight','profWeight'].forEach(function(id) { $(id).value = ''; });
    $('profBadge').textContent = 'No profile';
    UI.toast('Profile reset', 'ok');
  }

  function calcBMI() {
    var h = parseFloat($('profHeight').value);
    var w = parseFloat($('profWeight').value);
    $('profBMI').value = (h > 0 && w > 0) ? (w / Math.pow(h/100, 2)).toFixed(1) : '';
  }

  // === HISTORY ===
  function saveHistory(result) {
    try {
      var hist = JSON.parse(localStorage.getItem('vs_hist') || '[]');
      hist.push({ t: new Date().toISOString(), s: result.sbp, d: result.dbp, h: result.features.hr });
      if (hist.length > 100) hist = hist.slice(-100);
      localStorage.setItem('vs_hist', JSON.stringify(hist));
    } catch(e) {}
  }

  function clearHistory() {
    try { localStorage.removeItem('vs_hist'); } catch(e) {}
    $('histList').innerHTML = '<p class="empty">No measurements yet.</p>';
    UI.toast('History cleared', 'ok');
  }

  // === CALIBRATION ===
  function saveCalibration() {
    if (!lastResult) { UI.toast('Complete a scan first', 'err'); return; }
    var cs = parseInt($('calSBP').value);
    var cd = parseInt($('calDBP').value);
    if (!cs || !cd || cs < 70 || cs > 220 || cd < 40 || cd > 140) {
      UI.toast('Enter valid cuff BP values', 'err'); return;
    }
    try {
      var data = JSON.parse(localStorage.getItem('vs_cal') || '[]');
      data.push({ d: new Date().toISOString(), p: { s: lastResult.sbp, d: lastResult.dbp }, c: { s: cs, d: cd } });
      if (data.length > 20) data = data.slice(-20);
      localStorage.setItem('vs_cal', JSON.stringify(data));
      $('calSBP').value = ''; $('calDBP').value = '';
      UI.renderCalibration();
      UI.toast('Calibration saved', 'ok');
    } catch(e) { UI.toast('Error: ' + e.message, 'err'); }
  }

  function clearCalibration() {
    try { localStorage.removeItem('vs_cal'); } catch(e) {}
    UI.renderCalibration();
    UI.toast('Calibration cleared', 'ok');
  }

  // === GLOBAL API ===
  window.VS = {
    saveProfile: saveProfile,
    resetProfile: resetProfile,
    calcBMI: calcBMI,
    clearHistory: clearHistory,
    saveCalibration: saveCalibration,
    clearCalibration: clearCalibration
  };

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
