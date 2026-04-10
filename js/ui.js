// ui.js — UI helpers, chart drawing, history/calibration display
window.UI = (function() {
  'use strict';

  function $(id) { return document.getElementById(id); }

  // Toast notification
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type === 'err' ? 'toast-err' : 'toast-ok');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 3000);
  }

  // Draw line chart on canvas
  function drawChart(canvasId, data, options) {
    var c = $(canvasId);
    if (!c) return;
    var ctx = c.getContext('2d');
    var W = c.parentElement.clientWidth - 32;
    c.width = W * 2; c.height = (options.height || 120) * 2;
    c.style.width = W + 'px'; c.style.height = (options.height || 120) + 'px';
    ctx.scale(2, 2);

    var pad = { l: 35, r: 10, t: 10, b: 20 };
    var cw = W - pad.l - pad.r, ch = (options.height || 120) - pad.t - pad.b;

    ctx.fillStyle = '#141822';
    ctx.fillRect(0, 0, W, options.height || 120);

    if (!data || data.length === 0) return;

    // Auto-range
    var minV = Infinity, maxV = -Infinity;
    for (var s = 0; s < (options.series || [data]).length; s++) {
      var d = options.series ? options.series[s].data : data;
      for (var i = 0; i < d.length; i++) {
        if (d[i] < minV) minV = d[i];
        if (d[i] > maxV) maxV = d[i];
      }
    }
    if (options.yMin !== undefined) minV = options.yMin;
    if (options.yMax !== undefined) maxV = options.yMax;
    var range = maxV - minV || 1;

    // Grid
    ctx.strokeStyle = '#1e2636';
    ctx.lineWidth = 0.5;
    for (var i = 0; i < 5; i++) {
      var y = pad.t + ch * i / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
      ctx.fillStyle = '#5a6580';
      ctx.font = '9px JetBrains Mono';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxV - range * i / 4), pad.l - 4, y + 3);
    }

    // Draw each series
    var seriesList = options.series || [{ data: data, color: '#a78bfa' }];
    for (var s = 0; s < seriesList.length; s++) {
      var d = seriesList[s].data;
      var color = seriesList[s].color || '#a78bfa';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (var i = 0; i < d.length; i++) {
        var x = pad.l + (i / Math.max(1, d.length - 1)) * cw;
        var y = pad.t + ch - ((d[i] - minV) / range) * ch;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // Draw bar chart (for spectrum)
  function drawSpectrum(canvasId, freqs, power, hrFreq) {
    var c = $(canvasId);
    if (!c) return;
    var ctx = c.getContext('2d');
    var W = c.parentElement.clientWidth - 32;
    c.width = W * 2; c.height = 200;
    c.style.width = W + 'px'; c.style.height = '100px';
    ctx.scale(2, 2);

    ctx.fillStyle = '#141822';
    ctx.fillRect(0, 0, W, 100);

    if (!freqs || freqs.length === 0) return;

    var pad = { l: 30, r: 10, t: 8, b: 18 };
    var cw = W - pad.l - pad.r, ch = 100 - pad.t - pad.b;

    // Only show 0.5-4 Hz
    var maxP = 0;
    var startIdx = 0, endIdx = freqs.length;
    for (var i = 0; i < freqs.length; i++) {
      if (freqs[i] >= 0.5 && startIdx === 0) startIdx = i;
      if (freqs[i] > 4) { endIdx = i; break; }
      if (freqs[i] >= 0.5 && power[i] > maxP) maxP = power[i];
    }
    if (maxP === 0) return;

    var n = endIdx - startIdx;
    var barW = Math.max(1, cw / n - 1);

    for (var i = startIdx; i < endIdx; i++) {
      var x = pad.l + ((i - startIdx) / n) * cw;
      var h = (power[i] / maxP) * ch;
      var isHR = hrFreq && Math.abs(freqs[i] - hrFreq) < 0.1;
      ctx.fillStyle = isHR ? '#3ee68a' : 'rgba(167,139,250,0.4)';
      ctx.fillRect(x, pad.t + ch - h, barW, h);
    }

    // HR marker
    if (hrFreq) {
      var hx = pad.l + ((hrFreq - freqs[startIdx]) / (freqs[endIdx-1] - freqs[startIdx])) * cw;
      ctx.fillStyle = '#3ee68a';
      ctx.font = '9px JetBrains Mono';
      ctx.textAlign = 'center';
      ctx.fillText(Math.round(hrFreq * 60) + ' BPM', hx, pad.t + ch + 14);
    }
  }

  // BP category
  function bpCategory(sbp, dbp) {
    if (sbp < 120 && dbp < 80) return { label: 'Normal', color: '#3ee68a', bg: 'rgba(62,230,138,0.1)' };
    if (sbp < 130 && dbp < 80) return { label: 'Elevated', color: '#e6a63e', bg: 'rgba(230,166,62,0.1)' };
    if (sbp < 140 || dbp < 90) return { label: 'Stage 1 Hypertension', color: '#e6a63e', bg: 'rgba(230,166,62,0.1)' };
    return { label: 'Stage 2 Hypertension', color: '#e66a6a', bg: 'rgba(230,106,106,0.1)' };
  }

  // Show results
  function showResults(result) {
    $('resHR').textContent = result.features.hr;
    $('resSBP').textContent = result.sbp;
    $('resDBP').textContent = result.dbp;
    $('resultTime').textContent = new Date().toLocaleTimeString();

    var cat = bpCategory(result.sbp, result.dbp);
    var catEl = $('bpCategory');
    catEl.textContent = cat.label;
    catEl.style.color = cat.color;
    catEl.style.background = cat.bg;

    $('resultCard').style.display = '';
  }

  // Render history
  function renderHistory() {
    try {
      var hist = JSON.parse(localStorage.getItem('vs_hist') || '[]');
      var list = $('histList');
      if (hist.length === 0) { list.innerHTML = '<p class="empty">No measurements yet.</p>'; return; }

      var html = '';
      for (var i = hist.length - 1; i >= Math.max(0, hist.length - 20); i--) {
        var h = hist[i];
        html += '<div class="hist-item"><span>' + new Date(h.t).toLocaleString() + '</span><span>' + h.s + '/' + h.d + ' mmHg · ' + h.h + ' BPM</span></div>';
      }
      list.innerHTML = html;

      // Chart
      if (hist.length > 1) {
        drawChart('histChart', null, {
          height: 140,
          series: [
            { data: hist.map(function(h) { return h.s; }), color: '#a78bfa' },
            { data: hist.map(function(h) { return h.d; }), color: '#3ee68a' }
          ],
          yMin: 40, yMax: 200
        });
      }
    } catch(e) {}
  }

  // Render calibration
  function renderCalibration() {
    try {
      var data = JSON.parse(localStorage.getItem('vs_cal') || '[]');
      var list = $('calList');
      if (data.length === 0) { list.innerHTML = '<p class="empty">No calibration data.</p>'; $('calStats').innerHTML = ''; return; }

      var html = '';
      for (var i = data.length - 1; i >= 0; i--) {
        var c = data[i];
        html += '<div class="hist-item"><span>' + new Date(c.d).toLocaleDateString() + '</span><span>Pred: ' + c.p.s + '/' + c.p.d + ' → Cuff: ' + c.c.s + '/' + c.c.d + '</span></div>';
      }
      list.innerHTML = html;

      var avgSE = 0, avgDE = 0;
      for (var i = 0; i < data.length; i++) {
        avgSE += data[i].c.s - data[i].p.s;
        avgDE += data[i].c.d - data[i].p.d;
      }
      $('calStats').innerHTML = data.length + ' calibration points · Avg offset: SBP ' + (avgSE/data.length > 0 ? '+' : '') + Math.round(avgSE/data.length) + ', DBP ' + (avgDE/data.length > 0 ? '+' : '') + Math.round(avgDE/data.length);
    } catch(e) {}
  }

  // Feature display
  function showFeatures(features, importance) {
    var list = $('featList');
    if (!list) return;
    $('featCard').style.display = '';

    var names = ['hr','meanIBI','sdnn','rmssd','pnn50','crestTime','maxSlope','pw10','pw25','pw50','pw75','pw90','areaRatio','reflectionIndex','augmentationIndex','apgBARatio','apgCARatio','apgDARatio','numBeats','decayRate','ppProxy','stiffnessIndex'];
    var labels = {hr:'Heart Rate',meanIBI:'Mean IBI',sdnn:'SDNN',rmssd:'RMSSD',pnn50:'pNN50',crestTime:'Crest Time',maxSlope:'Max Slope',pw10:'PW 10%',pw25:'PW 25%',pw50:'PW 50%',pw75:'PW 75%',pw90:'PW 90%',areaRatio:'Area Ratio',reflectionIndex:'Reflection Idx',augmentationIndex:'Augment. Idx',apgBARatio:'APG b/a',apgCARatio:'APG c/a',apgDARatio:'APG d/a',numBeats:'Num Beats',decayRate:'Decay Rate',ppProxy:'Pulse Press.',stiffnessIndex:'Stiffness Idx'};

    var imp = (importance && importance.sbp) || {};
    var maxImp = 0;
    for (var k in imp) if (imp[k] > maxImp) maxImp = imp[k];

    var html = '';
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      var v = features[n];
      var impV = imp[n] || 0;
      var pct = maxImp > 0 ? Math.round(impV / maxImp * 100) : 0;
      html += '<div class="feat-row"><span class="feat-name">' + (labels[n]||n) + '</span><div class="feat-bar"><div class="feat-bar-fill" style="width:' + pct + '%"></div></div><span class="feat-val">' + (typeof v === 'number' ? (v < 1 ? v.toFixed(4) : v.toFixed(1)) : v) + '</span></div>';
    }
    list.innerHTML = html;
  }

  return {
    toast: toast,
    drawChart: drawChart,
    drawSpectrum: drawSpectrum,
    showResults: showResults,
    showFeatures: showFeatures,
    renderHistory: renderHistory,
    renderCalibration: renderCalibration,
    bpCategory: bpCategory,
    $: $
  };
})();
