// app.js — VitalScan v9: Research-based rPPG extraction
// Based on: Elgendi et al. 2024 (npj Biosensing), Wang et al. 2017 (POS),
// Kim et al. 2021 (ROI assessment), pyVHR framework
// _MPC saved in index.html

(function(){
'use strict';

// ===== CONFIG =====
var FPS = 30;
var WIN = Math.round(FPS * 1.6); // POS window: 1.6s = 48 frames
var STEP = Math.round(WIN / 2);  // 50% overlap
var PATCH_R = 10; // patch half-size (20x20 pixels)
var BUF_SEC = 15; // keep 15s of RGB buffer
var PRED_SEC = 5; // predict every 5s
var RGB_LO = 5, RGB_HI = 230; // pyVHR thresholds (not skin color - just valid pixel range)

// Elgendi et al. 2024 (npj Biosensing) landmark indices
var LM_FH = [10, 67, 69, 104, 108, 109, 151, 299, 337, 338]; // forehead
var LM_LC = [36, 47, 50, 100, 101, 116, 117, 118, 119, 123, 126, 147, 187, 203, 205, 206, 207, 216]; // left cheek
var LM_RC = [266, 280, 329, 330, 346, 347, 348, 355, 371, 411, 423, 425, 426, 427, 436]; // right cheek
var ALL_LM = LM_FH.concat(LM_LC).concat(LM_RC); // 43 total

// ===== STATE =====
var vid, ov, ovCtx, fm = null, mpc = null;
var on = false, fc = 0, ready = false;
var rgbBuf = []; // [{r,g,b}] per frame, averaged across all patches
var bestReport = null; // best-SNR report
var snrHistory = []; // track SNR over time
var reportSent = false;
var patchBuf = []; // per-patch RGB for quality weighting
var readyFrames = 0;

// ===== FACE ALIGNMENT =====
function checkAlignment(lm, w, h) {
  // Face bounding box
  var xs = [], ys = [];
  for (var i = 0; i < lm.length; i++) { xs.push(lm[i].x * w); ys.push(lm[i].y * h); }
  var mnX = Math.min.apply(null, xs), mxX = Math.max.apply(null, xs);
  var mnY = Math.min.apply(null, ys), mxY = Math.max.apply(null, ys);
  var fW = mxX - mnX, fH = mxY - mnY;
  var cX = (mnX + mxX) / 2, cY = (mnY + mxY) / 2;

  var checks = {};
  // Face height fraction: 25-70% of frame
  checks.size = fH / h > 0.25 && fH / h < 0.70;
  // Centered: within ±12% of center
  checks.centerX = Math.abs(cX - w/2) < w * 0.12;
  checks.centerY = Math.abs(cY - h/2) < h * 0.15;

  // Head pose via nose-forehead vector (simple yaw/pitch)
  var nose = lm[1], forehead = lm[10];
  var leye = lm[33], reye = lm[263];
  var eyeDist = Math.sqrt(Math.pow((reye.x - leye.x)*w, 2) + Math.pow((reye.y - leye.y)*h, 2));
  // Yaw: nose.x relative to eye midpoint
  var eyeMidX = (leye.x + reye.x) / 2;
  var yawRatio = (nose.x - eyeMidX) / (reye.x - leye.x + 1e-6);
  checks.yaw = Math.abs(yawRatio) < 0.15; // ~15°
  // Pitch: nose.y relative to forehead-chin line
  var chin = lm[152];
  var faceH = (chin.y - forehead.y) * h;
  var noseRelY = (nose.y - forehead.y) / (chin.y - forehead.y + 1e-6);
  checks.pitch = noseRelY > 0.35 && noseRelY < 0.55; // neutral range

  // Green channel brightness
  checks.brightness = true; // checked per-patch below

  checks.allGood = checks.size && checks.centerX && checks.centerY && checks.yaw && checks.pitch;

  return {
    checks: checks, fW: fW, fH: fH, cX: cX, cY: cY,
    yawRatio: yawRatio, noseRelY: noseRelY,
    sizeRatio: fH / h
  };
}

// ===== DRAW FACE GUIDE =====
function drawGuide(ctx, w, h, align) {
  // Oval guide
  var eW = w * 0.28, eH = h * 0.42;
  ctx.strokeStyle = align.checks.allGood ? 'rgba(62,230,138,0.7)' : 'rgba(230,106,106,0.5)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.ellipse(w/2, h*0.45, eW, eH, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Crosshair at center
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(w/2 - 15, h*0.45); ctx.lineTo(w/2 + 15, h*0.45); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w/2, h*0.45 - 15); ctx.lineTo(w/2, h*0.45 + 15); ctx.stroke();

  // Status text
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  var y = 14;
  function indicator(label, ok) {
    ctx.fillStyle = ok ? 'rgba(62,230,138,0.8)' : 'rgba(230,106,106,0.6)';
    ctx.fillText((ok ? '✓ ' : '✗ ') + label, 6, y);
    y += 14;
  }
  indicator('Size ' + (align.sizeRatio * 100).toFixed(0) + '%', align.checks.size);
  indicator('Center', align.checks.centerX && align.checks.centerY);
  indicator('Yaw ' + (align.yawRatio * 100).toFixed(0), align.checks.yaw);
  indicator('Pitch', align.checks.pitch);
}

// ===== EXTRACT RGB FROM LANDMARK PATCHES =====
function extractPatches(lm, imgData, w, h) {
  var px = imgData.data;
  var totalR = 0, totalG = 0, totalB = 0, totalN = 0;
  var patches = []; // per-landmark data

  for (var li = 0; li < ALL_LM.length; li++) {
    var idx = ALL_LM[li];
    var cx = (lm[idx].x * w) | 0;
    var cy = (lm[idx].y * h) | 0;
    var pR = 0, pG = 0, pB = 0, pN = 0;

    for (var dy = -PATCH_R; dy <= PATCH_R; dy += 2) {
      for (var dx = -PATCH_R; dx <= PATCH_R; dx += 2) {
        var px2 = cx + dx, py2 = cy + dy;
        if (px2 < 0 || px2 >= w || py2 < 0 || py2 >= h) continue;
        var off = (py2 * w + px2) * 4;
        var r = px[off], g = px[off+1], b = px[off+2];
        // pyVHR threshold: reject near-black and near-white pixels
        if (r < RGB_LO || g < RGB_LO || b < RGB_LO) continue;
        if (r > RGB_HI || g > RGB_HI || b > RGB_HI) continue;
        pR += r; pG += g; pB += b; pN++;
      }
    }

    if (pN > 0) {
      patches.push({ r: pR/pN, g: pG/pN, b: pB/pN, n: pN, cx: cx, cy: cy, li: li });
      totalR += pR; totalG += pG; totalB += pB; totalN += pN;
    }
  }

  return {
    mean: totalN > 0 ? { r: totalR/totalN, g: totalG/totalN, b: totalB/totalN } : null,
    patches: patches,
    totalPixels: totalN
  };
}

// ===== DRAW PATCHES ON OVERLAY =====
function drawPatches(ctx, patches) {
  for (var i = 0; i < patches.length; i++) {
    var p = patches[i];
    var li = p.li;
    // Color by region
    var color;
    if (li < LM_FH.length) color = 'rgba(167,139,250,0.25)';
    else if (li < LM_FH.length + LM_LC.length) color = 'rgba(62,230,138,0.25)';
    else color = 'rgba(230,166,62,0.25)';

    ctx.fillStyle = color;
    ctx.fillRect(p.cx - PATCH_R, p.cy - PATCH_R, PATCH_R*2, PATCH_R*2);

    // Dot at center
    ctx.fillStyle = li < LM_FH.length ? '#a78bfa' :
                    li < LM_FH.length + LM_LC.length ? '#3ee68a' : '#e6a63e';
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ===== POS ALGORITHM (Wang et al. 2017) =====
function posPPG(buf, fs) {
  var n = buf.length;
  if (n < WIN) return new Float64Array(n);
  var bvp = new Float64Array(n), wt = new Float64Array(n);

  for (var s = 0; s < n - WIN; s += STEP) {
    var mr = 0, mg = 0, mb = 0;
    for (var i = s; i < s + WIN; i++) { mr += buf[i].r; mg += buf[i].g; mb += buf[i].b; }
    mr /= WIN; mg /= WIN; mb /= WIN;
    if (mg < 5) continue;

    var s1 = new Float64Array(WIN), s2 = new Float64Array(WIN);
    for (var i = 0; i < WIN; i++) {
      var rn = buf[s+i].r / mr, gn = buf[s+i].g / mg, bn = buf[s+i].b / mb;
      s1[i] = gn - bn;
      s2[i] = -2*rn + gn + bn;
    }

    var m1 = 0, m2 = 0;
    for (var i = 0; i < WIN; i++) { m1 += s1[i]; m2 += s2[i]; }
    m1 /= WIN; m2 /= WIN;
    var v1 = 0, v2 = 0;
    for (var i = 0; i < WIN; i++) { v1 += (s1[i]-m1)*(s1[i]-m1); v2 += (s2[i]-m2)*(s2[i]-m2); }
    var std2 = Math.sqrt(v2/WIN);
    var alpha = std2 > 1e-10 ? Math.sqrt(v1/WIN) / std2 : 1;

    for (var i = 0; i < WIN; i++) {
      var w = 0.5 * (1 - Math.cos(2*Math.PI*i/(WIN-1))); // Hanning
      bvp[s+i] += (s1[i] + alpha * s2[i]) * w;
      wt[s+i] += w;
    }
  }
  for (var i = 0; i < n; i++) if (wt[i] > 0) bvp[i] /= wt[i];
  return bvp;
}

// ===== BUTTERWORTH BANDPASS (3rd order, 0.7-3.0 Hz) =====
function bqC(f, fs, t) {
  var w = 2*Math.PI*f/fs, a = Math.sin(w)/(2*0.7071), c = Math.cos(w);
  var b0, b1, b2;
  if (t === 'l') { b0=(1-c)/2; b1=1-c; b2=b0; }
  else { b0=(1+c)/2; b1=-(1+c); b2=b0; }
  var a0 = 1+a;
  return { b: [b0/a0, b1/a0, b2/a0], a: [1, -2*c/a0, (1-a)/a0] };
}
function bqFwd(s, c) {
  var n=s.length, o=new Float64Array(n), x1=0,x2=0,y1=0,y2=0;
  for (var i=0;i<n;i++) { o[i]=c.b[0]*s[i]+c.b[1]*x1+c.b[2]*x2-c.a[1]*y1-c.a[2]*y2; x2=x1;x1=s[i];y2=y1;y1=o[i]; }
  return o;
}
function bqRev(s, c) {
  var n=s.length, o=new Float64Array(n), x1=0,x2=0,y1=0,y2=0;
  for (var i=n-1;i>=0;i--) { o[i]=c.b[0]*s[i]+c.b[1]*x1+c.b[2]*x2-c.a[1]*y1-c.a[2]*y2; x2=x1;x1=s[i];y2=y1;y1=o[i]; }
  return o;
}
function bandpass(sig, fs, lo, hi) {
  // 3rd order = 3 cascaded biquad passes (HP then LP), each zero-phase
  var hp = bqC(lo, fs, 'h');
  var s = bqRev(bqFwd(sig, hp), hp); // 1st order zero-phase
  s = bqRev(bqFwd(s, hp), hp);       // 2nd
  s = bqRev(bqFwd(s, hp), hp);       // 3rd
  var lp = bqC(hi, fs, 'l');
  s = bqRev(bqFwd(s, lp), lp);
  s = bqRev(bqFwd(s, lp), lp);
  return bqRev(bqFwd(s, lp), lp);
}

// ===== FFT + SPECTRUM =====
function fft(re, im) {
  var n = re.length;
  for (var i=1,j=0; i<n; i++) {
    var b = n >> 1; for (; j&b; b>>=1) j^=b; j^=b;
    if (i<j) { var t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; }
  }
  for (var l=2; l<=n; l*=2) {
    var a=-2*Math.PI/l, wR=Math.cos(a), wI=Math.sin(a);
    for (var i=0; i<n; i+=l) {
      var cR=1, cI=0;
      for (var j=0; j<l/2; j++) {
        var uR=re[i+j],uI=im[i+j];
        var vR=re[i+j+l/2]*cR-im[i+j+l/2]*cI, vI=re[i+j+l/2]*cI+im[i+j+l/2]*cR;
        re[i+j]=uR+vR; im[i+j]=uI+vI;
        re[i+j+l/2]=uR-vR; im[i+j+l/2]=uI-vI;
        var nR=cR*wR-cI*wI; cI=cR*wI+cI*wR; cR=nR;
      }
    }
  }
}
function getSpectrum(sig, fs) {
  var n = 1; while (n < sig.length) n *= 2;
  var re = new Float64Array(n), im = new Float64Array(n);
  for (var i = 0; i < sig.length; i++) re[i] = sig[i] * (0.5 - 0.5*Math.cos(2*Math.PI*i/(sig.length-1)));
  fft(re, im);
  var f = [], p = [];
  for (var i = 0; i < n/2; i++) { f.push(i*fs/n); p.push(Math.sqrt(re[i]*re[i]+im[i]*im[i])); }
  return { f: f, p: p };
}

// ===== SNR COMPUTATION (de Haan method) =====
function computeSNR(spec, hrFreq) {
  var sigPow = 0, noisePow = 0;
  for (var i = 0; i < spec.f.length; i++) {
    var f = spec.f[i];
    if (f < 0.65 || f > 4.0) continue;
    // Signal: f0 ± 0.1 Hz + 2nd harmonic ± 0.1 Hz
    if (Math.abs(f - hrFreq) < 0.12 || Math.abs(f - hrFreq*2) < 0.12) {
      sigPow += spec.p[i] * spec.p[i];
    } else {
      noisePow += spec.p[i] * spec.p[i];
    }
  }
  return noisePow > 0 ? 10 * Math.log10(sigPow / noisePow) : 0;
}

// ===== PEAK DETECTION =====
function findPeaks(sig, minDist, minProm) {
  var pk = [];
  for (var i = 1; i < sig.length-1; i++) {
    if (sig[i] > sig[i-1] && sig[i] >= sig[i+1]) {
      var lm2 = sig[i], rm = sig[i];
      for (var j = Math.max(0, i-minDist); j < i; j++) lm2 = Math.min(lm2, sig[j]);
      for (var j = i+1; j <= Math.min(sig.length-1, i+minDist); j++) rm = Math.min(rm, sig[j]);
      if (sig[i] - Math.max(lm2, rm) >= minProm) {
        if (pk.length === 0 || i - pk[pk.length-1] >= minDist) pk.push(i);
        else if (sig[i] > sig[pk[pk.length-1]]) pk[pk.length-1] = i;
      }
    }
  }
  return pk;
}

// ===== DRAWING =====
function drawLine(cid, data, series, h) {
  var c = document.getElementById(cid); if (!c) return;
  var x = c.getContext('2d');
  var W = c.parentElement.clientWidth - 20;
  c.width = W*2; c.height = h*2; c.style.width = W+'px'; c.style.height = h+'px';
  x.scale(2,2); x.fillStyle = '#12151e'; x.fillRect(0,0,W,h);
  var P = 4, cw = W-P*2, ch = h-P*2;
  var mn = 1e9, mx = -1e9;
  var ss = series || [{d:data,c:'#a78bfa'}];
  for (var s=0;s<ss.length;s++) for (var i=0;i<ss[s].d.length;i++) {
    if (ss[s].d[i]<mn) mn=ss[s].d[i]; if (ss[s].d[i]>mx) mx=ss[s].d[i];
  }
  var rng = mx-mn || 1;
  for (var s=0;s<ss.length;s++) {
    x.strokeStyle = ss[s].c; x.lineWidth = 1.2; x.beginPath();
    for (var i=0;i<ss[s].d.length;i++) {
      var px = P + i/(ss[s].d.length-1)*cw;
      var py = P + ch - (ss[s].d[i]-mn)/rng*ch;
      i===0 ? x.moveTo(px,py) : x.lineTo(px,py);
    }
    x.stroke();
  }
}

function drawWithPeaks(cid, data, peaks, h, color) {
  var c = document.getElementById(cid); if (!c) return;
  var x = c.getContext('2d');
  var W = c.parentElement.clientWidth - 20;
  c.width = W*2; c.height = h*2; c.style.width = W+'px'; c.style.height = h+'px';
  x.scale(2,2); x.fillStyle = '#12151e'; x.fillRect(0,0,W,h);
  var P = 4, cw = W-P*2, ch = h-14;
  var mn = 1e9, mx = -1e9;
  for (var i=0;i<data.length;i++) { if (data[i]<mn)mn=data[i]; if(data[i]>mx)mx=data[i]; }
  var rng = mx-mn||1;
  // Zero line
  if (mn<0 && mx>0) { var zy=P+ch-(-mn)/rng*ch; x.strokeStyle='rgba(255,255,255,.08)'; x.lineWidth=1; x.beginPath(); x.moveTo(P,zy); x.lineTo(P+cw,zy); x.stroke(); }
  // Signal
  x.strokeStyle = color||'#3ee68a'; x.lineWidth = 1.5; x.beginPath();
  for (var i=0;i<data.length;i++) { var px=P+i/(data.length-1)*cw, py=P+ch-(data[i]-mn)/rng*ch; i===0?x.moveTo(px,py):x.lineTo(px,py); }
  x.stroke();
  // Peaks
  if (peaks) {
    x.fillStyle = '#e66a6a';
    for (var i=0;i<peaks.length;i++) {
      var pi = peaks[i]; if (pi<0||pi>=data.length) continue;
      var px = P+pi/(data.length-1)*cw, py = P+ch-(data[pi]-mn)/rng*ch;
      x.beginPath(); x.arc(px,py,3.5,0,Math.PI*2); x.fill();
    }
    x.fillStyle = 'rgba(230,106,106,.7)'; x.font = '8px monospace'; x.textAlign = 'center';
    for (var i=1;i<peaks.length;i++) {
      var ms = ((peaks[i]-peaks[i-1])/FPS*1000)|0;
      var px = P+((peaks[i]+peaks[i-1])/2/(data.length-1))*cw;
      x.fillText(ms+'ms', px, h-1);
    }
  }
}

function drawSpec(cid, freqs, pwr, hrF, h) {
  var c = document.getElementById(cid); if (!c) return;
  var x = c.getContext('2d');
  var W = c.parentElement.clientWidth - 20;
  c.width = W*2; c.height = h*2; c.style.width = W+'px'; c.style.height = h+'px';
  x.scale(2,2); x.fillStyle = '#12151e'; x.fillRect(0,0,W,h);
  var P = 4, cw = W-P*2, ch = h-16;
  var si=0,ei=freqs.length,mx=0;
  for (var i=0;i<freqs.length;i++) { if(freqs[i]>=0.5&&si===0)si=i; if(freqs[i]>4){ei=i;break;} if(freqs[i]>=0.5&&pwr[i]>mx)mx=pwr[i]; }
  if (mx===0) return; var n=ei-si, bw=Math.max(1,cw/n-1);
  for (var i=si;i<ei;i++) { var px=P+(i-si)/n*cw, bh=pwr[i]/mx*ch; x.fillStyle=hrF&&Math.abs(freqs[i]-hrF)<0.12?'#3ee68a':'rgba(167,139,250,.35)'; x.fillRect(px,P+ch-bh,bw,bh); }
  if (hrF) { var hx=P+(hrF-freqs[si])/(freqs[ei-1]-freqs[si])*cw; x.fillStyle='#3ee68a'; x.font='10px monospace'; x.textAlign='center'; x.fillText(Math.round(hrF*60)+' BPM',hx,h-2); }
}

// ===== FEATURE EXTRACTION (28 features) =====
function extractFeats(bvp, fs) {
  var md = Math.max(Math.floor(fs*0.35), 3);
  var mn = 1e9, mx = -1e9;
  for (var i=0;i<bvp.length;i++) { if(bvp[i]>mx)mx=bvp[i]; if(bvp[i]<mn)mn=bvp[i]; }
  var rng = mx-mn, pm = Math.max(rng*0.08, 0.0001);
  var pks = findPeaks(bvp, md, pm); if (pks.length<3) return null;
  var ib=[]; for(var i=1;i<pks.length;i++){var v=(pks[i]-pks[i-1])/fs;if(v>0.3&&v<2)ib.push(v);}if(ib.length<2)return null;
  var mi=0;for(var i=0;i<ib.length;i++)mi+=ib[i];mi/=ib.length;var hr=60/mi;if(hr<40||hr>200)return null;
  var sd=0;for(var i=0;i<ib.length;i++)sd+=(ib[i]-mi)*(ib[i]-mi);sd=Math.sqrt(sd/ib.length);
  var rm=0;for(var i=1;i<ib.length;i++)rm+=(ib[i]-ib[i-1])*(ib[i]-ib[i-1]);rm=Math.sqrt(rm/Math.max(1,ib.length-1));
  var pn=0;if(ib.length>1){var nn=0;for(var i=1;i<ib.length;i++)if(Math.abs(ib[i]-ib[i-1])>0.05)nn++;pn=nn/ib.length;}
  var tr=[];for(var i=0;i<pks.length-1;i++){var mv=1e9,mi2=pks[i];for(var j=pks[i];j<pks[i+1];j++)if(bvp[j]<mv){mv=bvp[j];mi2=j;}tr.push(mi2);}
  var bts=[];for(var i=0;i<tr.length-1;i++){var bl=tr[i+1]-tr[i];if(bl>Math.max(fs*0.3,5)&&bl<fs*2){var bt=[];for(var j=tr[i];j<tr[i+1];j++)bt.push(bvp[j]);bts.push(bt);}}
  if(bts.length<2)return null;
  var al=0;for(var i=0;i<bts.length;i++)al+=bts[i].length;al=Math.round(al/bts.length);if(al<6)return null;
  var av=new Float64Array(al);for(var b=0;b<bts.length;b++)for(var i=0;i<al;i++){var si2=i*(bts[b].length-1)/(al-1),lo=Math.floor(si2),hi=Math.min(lo+1,bts[b].length-1),fr=si2-lo;av[i]+=(bts[b][lo]*(1-fr)+bts[b][hi]*fr)/bts.length;}
  var bmn=1e9,bmx=-1e9;for(var i=0;i<al;i++){if(av[i]<bmn)bmn=av[i];if(av[i]>bmx)bmx=av[i];}var br=bmx-bmn;if(br<1e-10)return null;for(var i=0;i<al;i++)av[i]=(av[i]-bmn)/br;
  var pk=0,pa=av[0];for(var i=1;i<al;i++)if(av[i]>pa){pa=av[i];pk=i;}if(pa===0||pk===0)return null;
  var ct=pk/fs,ms=0;for(var i=1;i<=pk;i++){var s=(av[i]-av[i-1])*fs;if(s>ms)ms=s;}
  function pw(lv){var am=pa*lv,s2=0,e2=al-1;for(var i=0;i<pk;i++)if(av[i]>=am){s2=i;break;}for(var i=al-1;i>pk;i--)if(av[i]>=am){e2=i;break;}return(e2-s2)/fs;}
  var p10=pw(.1),p25=pw(.25),p50=pw(.5),p75=pw(.75),p90=pw(.9);
  var sa=0,da=0;for(var i=0;i<=pk;i++)sa+=Math.abs(av[i]);for(var i=pk+1;i<al;i++)da+=Math.abs(av[i]);var ar=sa/(sa+da)||.5;
  var se=Math.min(pk+Math.floor(al*.45),al),di=pk,ri=.5;if(se>pk+1){var mdic=1e9;for(var i=pk+1;i<se;i++)if(av[i]<mdic){mdic=av[i];di=i;}ri=av[di]/pa;}
  var ai=0;if(di<al-2&&pa>0){var mxp=-1e9;for(var i=di+1;i<al;i++)if(av[i]>mxp)mxp=av[i];ai=mxp/pa;}
  var ab=0,ac=0,ad=0;if(al>8){var d1=new Float64Array(al),d2=new Float64Array(al);for(var i=1;i<al-1;i++)d1[i]=(av[i+1]-av[i-1])/2;for(var i=1;i<al-1;i++)d2[i]=(d1[i+1]-d1[i-1])/2;var ax=0,avl=d2[0];for(var i=1;i<=pk;i++)if(d2[i]>avl){avl=d2[i];ax=i;}if(Math.abs(avl)>1e-12){var bv=1e9,bi=ax+1;for(var i=ax+1;i<=pk;i++)if(d2[i]<bv){bv=d2[i];bi=i;}ab=bv/avl;var cv=-1e9,ci=bi+1;for(var i=bi+1;i<se;i++)if(d2[i]>cv){cv=d2[i];ci=i;}ac=isFinite(cv)?cv/avl:0;var dv=1e9;for(var i=ci+1;i<al;i++)if(d2[i]<dv)dv=d2[i];ad=isFinite(dv)?dv/avl:0;}}
  var dc=0;if(di<al-2)dc=(av[di]-av[al-1])/((al-di)/fs);var pp=pa-av[0];
  var bm=0;for(var i=0;i<al;i++)bm+=av[i];bm/=al;var m2=0,m3=0,m4=0;for(var i=0;i<al;i++){var d=av[i]-bm;m2+=d*d;m3+=d*d*d;m4+=d*d*d*d;}m2/=al;m3/=al;m4/=al;
  var bsk=m2>0?m3/Math.pow(m2,1.5):0,bkt=m2>0?m4/(m2*m2)-3:0;
  var prof=getProf(),age=prof.age||50,bmi=prof.bmi||25,gen=prof.gender!==undefined&&prof.gender!==null?prof.gender:0;
  var siv=0,ht=prof.height||0;if(ht>0&&di>pk){var dt=(di-pk)/fs;if(dt>0)siv=(ht/100)/dt;}
  return{hr:Math.round(hr*10)/10,meanIBI:mi,sdnn:sd,rmssd:rm,pnn50:pn,crestTime:ct,maxSlope:ms,pw10:p10,pw25:p25,pw50:p50,pw75:p75,pw90:p90,areaRatio:ar,reflectionIndex:ri,augmentationIndex:ai,apgBARatio:ab,apgCARatio:ac,apgDARatio:ad,numBeats:bts.length,decayRate:dc,ppProxy:pp,age:age,bmi:bmi,gender:gen,lfHfRatio:1,beatSkew:bsk,beatKurt:bkt,stiffnessIndex:siv,_ab:av};
}

// ===== PREDICTION (GBR + NN ensemble) =====
function loadCal(){
  try{
    var data=JSON.parse(localStorage.getItem('vs_cal')||'[]');
    if(data.length===0)return null;
    var tw=0,sOff=0,dOff=0;
    for(var i=0;i<data.length;i++){
      var w=0.5+0.5*(i+1)/data.length; // recency weight
      sOff+=w*(data[i].c.s-data[i].p.s);
      dOff+=w*(data[i].c.d-data[i].p.d);
      tw+=w;
    }
    sOff/=tw; dOff/=tw;
    var conf=Math.min(1, 0.2+0.2*data.length); // 20% at 1 point, 100% at 5+
    return{sOff:sOff*conf, dOff:dOff*conf, n:data.length};
  }catch(e){return null;}
}
var FN = __GBR__.features;
function walkT(n,f){if(n.v!==undefined)return n.v;return f[n.f]<=n.t?walkT(n.l,f):walkT(n.r,f);}
function dense(W,x,b,r){var o=[];for(var i=0;i<W.length;i++){var s=b[i];for(var j=0;j<x.length;j++)s+=W[i][j]*x[j];o.push(r?Math.max(0,s):s);}return o;}
function predict(feats){
  var fa=[];for(var i=0;i<FN.length;i++){var v=feats[FN[i]];fa.push(v!==undefined&&isFinite(v)?v:0);}
  var sbp=__GBR__.sbp.init,dbp=__GBR__.dbp.init;
  for(var i=0;i<__GBR__.sbp.trees.length;i++)sbp+=__GBR__.sbp.lr*walkT(__GBR__.sbp.trees[i],fa);
  for(var i=0;i<__GBR__.dbp.trees.length;i++)dbp+=__GBR__.dbp.lr*walkT(__GBR__.dbp.trees[i],fa);
  try{var x=[];for(var i=0;i<fa.length;i++)x.push((fa[i]-__NN__.mean[i])/(__NN__.std[i]||1));
  x=dense(__NN__.fc1_w,x,__NN__.fc1_b,1);x=dense(__NN__.fc2_w,x,__NN__.fc2_b,1);x=dense(__NN__.fc3_w,x,__NN__.fc3_b,1);x=dense(__NN__.fc4_w,x,__NN__.fc4_b,1);x=dense(__NN__.fc5_w,x,__NN__.fc5_b,0);
  sbp=0.7*sbp+0.3*x[0];dbp=0.7*dbp+0.3*x[1];}catch(e){}
  var rawSbp=Math.round(sbp),rawDbp=Math.round(dbp);
  // Apply calibration offset
  var cal=loadCal();
  if(cal){sbp+=cal.sOff;dbp+=cal.dOff;}
  sbp=Math.max(70,Math.min(220,Math.round(sbp)));dbp=Math.max(40,Math.min(140,Math.round(dbp)));if(dbp>=sbp)dbp=sbp-20;
  return{sbp:sbp,dbp:dbp,rawSbp:rawSbp,rawDbp:rawDbp,calApplied:!!cal,calPoints:cal?cal.n:0};
}

// ===== PROFILE =====
function getProf(){try{return JSON.parse(localStorage.getItem('vs_prof')||'{}')}catch(e){return{};}}
function saveProf(){
  var h=parseFloat($('pHt').value)||null, w=parseFloat($('pWt').value)||null;
  var bmi=null;
  if(h&&w){bmi=Math.round(w/(h/100*h/100)*10)/10;$('pBMI').value=bmi;}
  var p={name:$('pName').value,age:parseInt($('pAge').value)||null,gender:$('pGen').value!==''?parseInt($('pGen').value):null,height:h,weight:w,bmi:bmi};
  try{localStorage.setItem('vs_prof',JSON.stringify(p));
  var msg=$('profMsg');if(msg){msg.textContent='Saved! Age:'+p.age+' BMI:'+p.bmi+' Gender:'+(p.gender===1?'M':'F');msg.style.color='#3ee68a';setTimeout(function(){msg.textContent='';},3000);}
  }catch(e){}}
function loadProf(){var p=getProf();if(p.name)$('pName').value=p.name;if(p.age)$('pAge').value=p.age;if(p.gender!==undefined&&p.gender!==null)$('pGen').value=p.gender;if(p.height)$('pHt').value=p.height;if(p.weight)$('pWt').value=p.weight;if(p.height&&p.weight)$('pBMI').value=(p.weight/(p.height/100*p.height/100)).toFixed(1);}
function calcBMI(){var h=parseFloat($('pHt').value),w=parseFloat($('pWt').value);$('pBMI').value=h>0&&w>0?(w/(h/100*h/100)).toFixed(1):'';}
function $(id){return document.getElementById(id);}

// ===== CAMERA + MAIN LOOP =====
function toggle() {
  if (on) { on=false; if(mpc)try{mpc.stop();}catch(e){} mpc=null; $('btnGo').textContent='▶ Start'; $('st').textContent='Stopped'; return; }
  on=true; fc=0; rgbBuf=[]; readyFrames=0; ready=false; bestReport=null; snrHistory=[]; reportSent=false;
  $('btnGo').textContent='⬛ Stop'; $('st').textContent='Starting…';
  ['c1','c2','c3','c4','c5','resBar','ibar','roiBar'].forEach(function(id){$(id).style.display='none';});

  if (!fm) {
    fm = new FaceMesh({locateFile:function(f){return 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/'+f;}});
    fm.setOptions({maxNumFaces:1,refineLandmarks:false,minDetectionConfidence:0.5,minTrackingConfidence:0.5});
    fm.onResults(onFace);
  }
  mpc = new _MPC(vid,{onFrame:async function(){if(!on)return;try{await fm.send({image:vid});}catch(e){}},width:640,height:480});
  mpc.start();
}

function onFace(res) {
  if (!on) return; fc++;
  var w = vid.videoWidth||640, h = vid.videoHeight||480;
  ov.width = w; ov.height = h; ovCtx.clearRect(0,0,w,h);

  if (!res.multiFaceLandmarks || !res.multiFaceLandmarks.length) {
    $('st').textContent = 'No face detected'; readyFrames = 0; ready = false;
    drawGuide(ovCtx, w, h, {checks:{allGood:false,size:false,centerX:false,centerY:false,yaw:false,pitch:false},sizeRatio:0,yawRatio:0});
    return;
  }

  var lm = res.multiFaceLandmarks[0];
  var align = checkAlignment(lm, w, h);
  drawGuide(ovCtx, w, h, align);

  if (!align.checks.allGood) {
    readyFrames = 0; ready = false;
    $('st').textContent = 'Align face to guide';
    return;
  }

  readyFrames++;
  if (readyFrames < 30 && !ready) {
    $('st').textContent = 'Hold still… ' + (30 - readyFrames);
    return;
  }
  ready = true;

  // Extract RGB from landmark patches
  var tc = document.createElement('canvas'); tc.width = w; tc.height = h;
  var tx = tc.getContext('2d'); tx.drawImage(vid, 0, 0, w, h);
  var imgData; try { imgData = tx.getImageData(0, 0, w, h); } catch(e) { return; }

  var result = extractPatches(lm, imgData, w, h);
  if (!result.mean) return;

  rgbBuf.push(result.mean);
  if (rgbBuf.length > FPS * BUF_SEC) rgbBuf = rgbBuf.slice(-FPS * BUF_SEC);

  $('st').textContent = 'Scanning · ' + rgbBuf.length + ' frames · ' + result.patches.length + ' patches · ' + result.totalPixels + ' skin px';
  $('fCount').textContent = 'F' + fc;

  // Draw patches on overlay
  drawPatches(ovCtx, result.patches);

  // ROI preview
  if (fc % 20 === 0) {
    $('roiBar').style.display = '';
    // Draw forehead, left cheek, right cheek previews from bounding box of their patches
    var groups = [{pts: result.patches.filter(function(p){return p.li < LM_FH.length;}), id:'rF'},
                  {pts: result.patches.filter(function(p){return p.li >= LM_FH.length && p.li < LM_FH.length+LM_LC.length;}), id:'rL'},
                  {pts: result.patches.filter(function(p){return p.li >= LM_FH.length+LM_LC.length;}), id:'rR'}];
    groups.forEach(function(g) {
      if (g.pts.length < 2) return;
      var mnx=1e9,mny=1e9,mxx=0,mxy=0;
      g.pts.forEach(function(p){mnx=Math.min(mnx,p.cx);mny=Math.min(mny,p.cy);mxx=Math.max(mxx,p.cx);mxy=Math.max(mxy,p.cy);});
      mnx=Math.max(0,mnx-PATCH_R);mny=Math.max(0,mny-PATCH_R);mxx=Math.min(w,mxx+PATCH_R);mxy=Math.min(h,mxy+PATCH_R);
      var c2 = $(g.id); if(c2&&mxx>mnx&&mxy>mny)try{c2.getContext('2d').drawImage(vid,mnx,mny,mxx-mnx,mxy-mny,0,0,c2.width,c2.height);}catch(e){}
    });
  }

  // ===== LIVE MONITORING (every 4 frames) =====
  if (fc % 4 !== 0 || rgbBuf.length < FPS * 2) return;

  var N = Math.min(rgbBuf.length, FPS * 10);
  var gg = []; for (var i = rgbBuf.length-N; i < rgbBuf.length; i++) gg.push(rgbBuf[i].g);

  // 1. Raw green
  $('c1').style.display = '';
  drawLine('ch1', gg, null, 70);
  var gMn=1e9,gMx=-1e9,gMean=0;
  for(var i=0;i<gg.length;i++){gMean+=gg[i];if(gg[i]<gMn)gMn=gg[i];if(gg[i]>gMx)gMx=gg[i];}
  gMean/=gg.length;
  var delta=gMean>0?((gMx-gMn)/gMean*100):0;
  $('i1').textContent='mean='+gMean.toFixed(1)+' Δ='+delta.toFixed(2)+'%';

  // 2. Green delta with peaks
  $('c2').style.display='';
  var gD=[];for(var i=0;i<gg.length;i++)gD.push(gg[i]-gMean);
  var gStd=0;for(var i=0;i<gD.length;i++)gStd+=gD[i]*gD[i];gStd=Math.sqrt(gStd/gD.length);
  var gPks=findPeaks(gD,Math.round(FPS*0.4),gStd*0.2);
  drawWithPeaks('ch2',gD,gPks,100,'#3ee68a');
  var gHR='--';
  if(gPks.length>=2){var gIBI=0;for(var i=1;i<gPks.length;i++)gIBI+=(gPks[i]-gPks[i-1])/FPS;gIBI/=(gPks.length-1);gHR=Math.round(60/gIBI);}
  $('i2').textContent=gPks.length+' beats · raw HR ~'+gHR;

  // Pulse dot
  $('ibar').style.display='';
  $('ihr').textContent=gHR==='--'?'--':gHR+' BPM';
  if(gPks.length>0){var since=gD.length-gPks[gPks.length-1];$('pd').className='pdot'+(since<4?' on':'');}

  // 3. Filtered BVP (POS)
  if(rgbBuf.length>FPS*4){
    $('c3').style.display='';
    var bvpRaw=posPPG(rgbBuf,FPS);
    var bvp=bandpass(bvpRaw,FPS,0.7,3.0);
    var bN=Math.min(bvp.length,FPS*10);var bS=[];for(var i=bvp.length-bN;i<bvp.length;i++)bS.push(bvp[i]);
    var bStd=0,bM=0;for(var i=0;i<bS.length;i++)bM+=bS[i];bM/=bS.length;
    for(var i=0;i<bS.length;i++)bStd+=(bS[i]-bM)*(bS[i]-bM);bStd=Math.sqrt(bStd/bS.length);
    var bPks=findPeaks(bS,Math.round(FPS*0.4),bStd*0.15);
    drawWithPeaks('ch3',bS,bPks,110,'#a78bfa');

    // Spectrum + SNR
    var sp=getSpectrum(bvp,FPS);var mxP=0,hrF=0;
    for(var i=0;i<sp.f.length;i++)if(sp.f[i]>=0.7&&sp.f[i]<=3.5&&sp.p[i]>mxP){mxP=sp.p[i];hrF=sp.f[i];}
    var snr=computeSNR(sp,hrF);
    $('i3').textContent='POS · SNR '+snr.toFixed(1)+' dB · HR ~'+Math.round(hrF*60);
    $('imeta').textContent='POS · SNR '+snr.toFixed(1)+' dB';

    $('c4').style.display='';
    drawSpec('ch4',sp.f,sp.p,hrF,70);
    $('i4').textContent='peak '+hrF.toFixed(2)+' Hz = '+Math.round(hrF*60)+' BPM';

    // 5. Prediction (every PRED_SEC seconds)
    if(rgbBuf.length>=FPS*PRED_SEC && fc%(FPS*PRED_SEC)<5 && snr>0){
      var feats=extractFeats(bvp,FPS);
      if(feats){
        // Average beat template
        if(feats._ab){
          $('c5').style.display='';
          var abD=[];for(var i=0;i<feats._ab.length;i++)abD.push(feats._ab[i]);
          drawLine('ch5',abD,null,90);
          $('i5').textContent=feats.numBeats+' beats · '+feats._ab.length+' samples/beat';
        }
        var res=predict(feats);
        $('resBar').style.display='';
        // Raw row (always shown)
        $('rawHR').textContent=feats.hr;
        $('rawSBP').textContent=res.rawSbp;
        $('rawDBP').textContent=res.rawDbp;
        // Calibrated row
        if(res.calApplied){
          $('calRow').style.display='';
          $('calHR').textContent=feats.hr;
          $('calSBP').textContent=res.sbp;
          $('calDBP').textContent=res.dbp;
          $('calInfo').textContent=res.calPoints+' calibration points applied';
        } else {
          $('calRow').style.display='none';
          $('calInfo').textContent='No calibration — add cuff readings in Calibrate tab';
        }
        var finalSbp=res.sbp,finalDbp=res.dbp;
        var cat=finalSbp<120&&finalDbp<80?{l:'Normal',c:'#3ee68a'}:finalSbp<140?{l:'Elevated',c:'#e6a63e'}:{l:'Hypertension',c:'#e66a6a'};
        var ce=$('bpC');ce.textContent=cat.l;ce.style.color=cat.c;ce.style.background=cat.c+'1a';
        saveHist(res.sbp,res.dbp,feats.hr);
        checkBestReport(snr, feats, res, bS);
      }
    }
  }
}



// ===== AUTO-REPORT (peak reliability) =====
function checkBestReport(snr, feats, res, bvpData) {
  snrHistory.push(snr);
  if (snrHistory.length < 3) return;

  // Update best if this is the highest SNR so far
  if (!bestReport || snr > bestReport.snr) {
    bestReport = {
      snr: snr,
      hr: feats.hr,
      rawSbp: res.rawSbp, rawDbp: res.rawDbp,
      sbp: res.sbp, dbp: res.dbp,
      calApplied: res.calApplied, calPoints: res.calPoints,
      numBeats: feats.numBeats,
      sdnn: feats.sdnn, rmssd: feats.rmssd,
      time: new Date().toLocaleTimeString(),
      timestamp: Date.now()
    };
  }

  // Detect peak: if SNR has been declining for 3+ readings after a peak, lock in report
  if (snrHistory.length >= 6 && !reportSent) {
    var recent = snrHistory.slice(-4);
    var peak = bestReport.snr;
    // Check if all recent readings are below 80% of peak AND peak was good (>2dB)
    var allBelow = true;
    for (var i = 0; i < recent.length; i++) { if (recent[i] >= peak * 0.85) allBelow = false; }
    if (peak > 2 && allBelow) {
      reportSent = true;
      showReport(bestReport);
    }
  }
}

function showReport(rpt) {
  var el = $('reportCard');
  if (!el) return;
  el.style.display = '';
  var cat = rpt.sbp<120&&rpt.dbp<80?{l:'Normal',c:'#3ee68a'}:rpt.sbp<140?{l:'Elevated',c:'#e6a63e'}:{l:'Hypertension',c:'#e66a6a'};
  el.innerHTML = '<div class="card-h"><span>📋 BEST READING (peak SNR '+rpt.snr.toFixed(1)+' dB)</span><span class="dim">'+rpt.time+'</span></div>' +
    '<div class="res-table">' +
      '<div class="res-header"><div class="res-lbl"></div><div class="res-col">HR</div><div class="res-col">SBP</div><div class="res-col">DBP</div></div>' +
      '<div class="res-row"><div class="res-lbl">Raw</div>' +
        '<div class="res-col"><span class="rv-sm">'+rpt.hr+'</span></div>' +
        '<div class="res-col"><span class="rv-sm raw-sbp">'+rpt.rawSbp+'</span></div>' +
        '<div class="res-col"><span class="rv-sm raw-dbp">'+rpt.rawDbp+'</span></div></div>' +
      (rpt.calApplied ? '<div class="res-row cal-row"><div class="res-lbl cal-lbl">Calibrated</div>' +
        '<div class="res-col"><span class="rv-lg">'+rpt.hr+'</span></div>' +
        '<div class="res-col"><span class="rv-lg cal-sbp">'+rpt.sbp+'</span></div>' +
        '<div class="res-col"><span class="rv-lg cal-dbp">'+rpt.dbp+'</span></div></div>' : '') +
    '</div>' +
    '<div class="bp-cat" style="color:'+cat.c+';background:'+cat.c+'1a">'+cat.l+'</div>' +
    '<div style="font:10px monospace;color:var(--dim);padding:6px 0;display:grid;grid-template-columns:1fr 1fr;gap:4px">' +
      '<span>Beats: '+rpt.numBeats+'</span>' +
      '<span>SDNN: '+rpt.sdnn.toFixed(3)+'s</span>' +
      '<span>RMSSD: '+rpt.rmssd.toFixed(3)+'s</span>' +
      (rpt.calApplied ? '<span>Cal points: '+rpt.calPoints+'</span>' : '<span>No calibration</span>') +
    '</div>' +
    '<div style="text-align:center;padding:6px 0"><button class="btn btn-g" onclick="resetReport()" style="font-size:10px;padding:5px 12px">New measurement</button></div>';
}

function resetReport() {
  bestReport = null; snrHistory = []; reportSent = false;
  var el = $('reportCard'); if (el) el.style.display = 'none';
}

// ===== CALIBRATION =====
function saveCal(){
  var cs=parseInt($('calS').value),cd=parseInt($('calD').value);
  if(!cs||!cd||cs<70||cs>220||cd<40||cd>140){$('calMsg').textContent='Enter valid cuff BP';$('calMsg').style.color='#e66a6a';return;}
  var resBar=$('resBar');var sbp=$('rawSBP').textContent,dbp=$('rawDBP').textContent;
  if(sbp==='--'){$('calMsg').textContent='Do a scan first';$('calMsg').style.color='#e66a6a';return;}
  try{
    var data=JSON.parse(localStorage.getItem('vs_cal')||'[]');
    data.push({d:new Date().toISOString(),p:{s:parseInt(sbp),d:parseInt(dbp)},c:{s:cs,d:cd}});
    if(data.length>20)data=data.slice(-20);
    localStorage.setItem('vs_cal',JSON.stringify(data));
    $('calS').value='';$('calD').value='';
    $('calMsg').textContent='Saved! Pred '+sbp+'/'+dbp+' → Cuff '+cs+'/'+cd;$('calMsg').style.color='#3ee68a';
    renderCal();
  }catch(e){$('calMsg').textContent='Error: '+e.message;$('calMsg').style.color='#e66a6a';}
}
function clearCal(){try{localStorage.removeItem('vs_cal');}catch(e){}renderCal();}
function renderCal(){
  try{
    var data=JSON.parse(localStorage.getItem('vs_cal')||'[]');
    var list=$('calList');if(!list)return;
    if(data.length===0){list.innerHTML='<div style="color:var(--dim);text-align:center;padding:20px;font:12px monospace">No calibration data</div>';return;}
    var html='';for(var i=data.length-1;i>=0;i--){var c=data[i];html+='<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--bdr);font:11px monospace;color:var(--txt)"><span>'+new Date(c.d).toLocaleDateString()+'</span><span>Pred '+c.p.s+'/'+c.p.d+' → Cuff '+c.c.s+'/'+c.c.d+'</span></div>';}
    list.innerHTML=html;
  }catch(e){}
}
// ===== HISTORY =====
function clearHist(){try{localStorage.removeItem('vs_hist');}catch(e){}renderHist();}
function renderHist(){
  try{
    var data=JSON.parse(localStorage.getItem('vs_hist')||'[]');
    var list=$('histList');if(!list)return;
    if(data.length===0){list.innerHTML='<div style="color:var(--dim);text-align:center;padding:20px;font:12px monospace">No measurements</div>';return;}
    var html='';for(var i=data.length-1;i>=Math.max(0,data.length-20);i--){var h=data[i];html+='<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--bdr);font:11px monospace;color:var(--txt)"><span>'+new Date(h.t).toLocaleString()+'</span><span>'+h.s+'/'+h.d+' · '+h.h+' BPM</span></div>';}
    list.innerHTML=html;
  }catch(e){}
}
function saveHist(sbp,dbp,hr){
  try{var data=JSON.parse(localStorage.getItem('vs_hist')||'[]');
  data.push({t:new Date().toISOString(),s:sbp,d:dbp,h:hr});
  if(data.length>100)data=data.slice(-100);
  localStorage.setItem('vs_hist',JSON.stringify(data));}catch(e){}
}

// ===== TABS =====
function showTab(t){
  var tabs=['scan','profile','history','calibrate','about'];
  document.querySelectorAll('.tab').forEach(function(e,i){e.classList.toggle('active',tabs[i]===t);});
  document.querySelectorAll('.panel').forEach(function(e,i){e.classList.toggle('active',tabs[i]===t);});
  if(t==='history')renderHist();
  if(t==='calibrate')renderCal();
}

// ===== INIT =====
window.onload = function() {
  vid = $('vid'); ov = $('ov'); ovCtx = ov.getContext('2d');
  loadProf();
};

// Expose globals
window.toggle = toggle;
window.saveCal = saveCal;
window.clearCal = clearCal;
window.clearHist = clearHist;
window.resetReport = resetReport;
window.showTab = showTab;
window.saveProf = saveProf;
window.calcBMI = calcBMI;

})();
