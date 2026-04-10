// signal.js — BVP signal processing and feature extraction
window.Signal = (function() {
  'use strict';

  // Butterworth bandpass filter coefficients
  function butterCoeffs(order, lo, hi) {
    // 2nd order sections for bandpass
    var wl = Math.tan(Math.PI * lo), wh = Math.tan(Math.PI * hi);
    var bw = wh - wl, w0 = Math.sqrt(wl * wh);
    // Simplified 4th-order Butterworth via cascaded biquads
    var Q = [0.7654, 1.8478]; // 4th order Butterworth Q factors
    var sections = [];
    for (var i = 0; i < Math.min(order/2, Q.length); i++) {
      var alpha = bw / (2 * Q[i]);
      var a0 = 1 + alpha;
      sections.push({
        b: [alpha/a0, 0, -alpha/a0],
        a: [1, -2*Math.cos(2*Math.atan(w0))/a0, (1-alpha)/a0]
      });
    }
    return sections;
  }

  // Apply biquad filter (forward or reverse)
  function applyBiquad(sig, b, a) {
    var n = sig.length, out = new Float64Array(n);
    var x1=0,x2=0,y1=0,y2=0;
    for (var i = 0; i < n; i++) {
      out[i] = b[0]*sig[i] + b[1]*x1 + b[2]*x2 - a[1]*y1 - a[2]*y2;
      x2=x1; x1=sig[i]; y2=y1; y1=out[i];
    }
    return out;
  }

  // Zero-phase Butterworth bandpass
  function bandpass(sig, fs, lo, hi) {
    var nyq = fs / 2;
    var wl = lo / nyq, wh = Math.min(hi / nyq, 0.99);
    if (wl >= wh || wl <= 0) return sig;

    // Simple 4th-order Butterworth via bilinear transform
    var n = sig.length;
    var filt = new Float64Array(sig);

    // Pre-warp
    var fl = Math.tan(Math.PI * wl), fh = Math.tan(Math.PI * wh);
    var bw = fh - fl, cf = fl * fh;
    var Q = 0.7071;
    var alpha = bw / Q;
    var a0 = 1 + alpha + cf;

    var b0 = alpha / a0, b1 = 0, b2 = -alpha / a0;
    var a1 = 2 * (cf - 1) / a0, a2 = (1 - alpha + cf) / a0;

    // Forward pass
    var x1=0,x2=0,y1=0,y2=0;
    var fwd = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      fwd[i] = b0*filt[i] + b1*x1 + b2*x2 - a1*y1 - a2*y2;
      x2=x1; x1=filt[i]; y2=y1; y1=fwd[i];
    }
    // Reverse pass (zero-phase)
    x1=0;x2=0;y1=0;y2=0;
    var out = new Float64Array(n);
    for (var i = n-1; i >= 0; i--) {
      out[i] = b0*fwd[i] + b1*x1 + b2*x2 - a1*y1 - a2*y2;
      x2=x1; x1=fwd[i]; y2=y1; y1=out[i];
    }
    return out;
  }

  // Detrend (polynomial)
  function detrend(sig, order) {
    var n = sig.length;
    if (n < order + 1) return sig;
    var x = new Float64Array(n);
    for (var i = 0; i < n; i++) x[i] = i / n;

    // Fit polynomial (least squares, Vandermonde)
    // Simplified: just remove linear trend for speed
    var sx=0,sy=0,sxx=0,sxy=0;
    for (var i=0;i<n;i++) { sx+=i; sy+=sig[i]; sxx+=i*i; sxy+=i*sig[i]; }
    var det = n*sxx - sx*sx;
    if (Math.abs(det) < 1e-12) return sig;
    var slope = (n*sxy - sx*sy) / det;
    var intercept = (sy - slope*sx) / n;
    var out = new Float64Array(n);
    for (var i=0;i<n;i++) out[i] = sig[i] - (slope*i + intercept);
    return out;
  }

  // POS algorithm (Plane-Orthogonal-to-Skin)
  function pos(rgbFrames, winSize) {
    winSize = winSize || 48;
    var n = rgbFrames.length;
    var bvp = new Float64Array(n);
    var weights = new Float64Array(n);
    var half = Math.floor(winSize / 2);

    for (var start = 0; start < n - winSize; start += half) {
      var end = Math.min(start + winSize, n);
      var len = end - start;

      // Temporal normalization
      var mr=0,mg=0,mb=0;
      for (var i=start;i<end;i++) { mr+=rgbFrames[i][0]; mg+=rgbFrames[i][1]; mb+=rgbFrames[i][2]; }
      mr/=len; mg/=len; mb/=len;
      if (mr<1||mg<1||mb<1) continue;

      var s1 = new Float64Array(len), s2 = new Float64Array(len);
      for (var i=0;i<len;i++) {
        var rn=rgbFrames[start+i][0]/mr, gn=rgbFrames[start+i][1]/mg, bn=rgbFrames[start+i][2]/mb;
        s1[i] = gn - bn;
        s2[i] = -2*rn + gn + bn;
      }

      // Alpha tuning
      var std1=0,std2=0,m1=0,m2=0;
      for (var i=0;i<len;i++) { m1+=s1[i]; m2+=s2[i]; }
      m1/=len; m2/=len;
      for (var i=0;i<len;i++) { std1+=(s1[i]-m1)*(s1[i]-m1); std2+=(s2[i]-m2)*(s2[i]-m2); }
      std1=Math.sqrt(std1/len); std2=Math.sqrt(std2/len);
      var alpha = (std2 > 1e-10) ? std1/std2 : 1;

      // Hanning window + overlap-add
      for (var i=0;i<len;i++) {
        var w = 0.5 * (1 - Math.cos(2*Math.PI*i/(len-1)));
        var val = (s1[i] + alpha * s2[i]) * w;
        bvp[start+i] += val;
        weights[start+i] += w;
      }
    }

    // Normalize
    for (var i=0;i<n;i++) {
      if (weights[i] > 0) bvp[i] /= weights[i];
    }
    return bvp;
  }

  // Simple FFT (radix-2, for power spectrum)
  function fft(re, im) {
    var n = re.length;
    // Bit-reversal
    for (var i=1,j=0; i<n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var t=re[i]; re[i]=re[j]; re[j]=t;
        t=im[i]; im[i]=im[j]; im[j]=t;
      }
    }
    for (var len=2; len<=n; len*=2) {
      var ang = -2*Math.PI/len;
      var wRe=Math.cos(ang), wIm=Math.sin(ang);
      for (var i=0; i<n; i+=len) {
        var curRe=1, curIm=0;
        for (var j=0; j<len/2; j++) {
          var uRe=re[i+j], uIm=im[i+j];
          var vRe=re[i+j+len/2]*curRe - im[i+j+len/2]*curIm;
          var vIm=re[i+j+len/2]*curIm + im[i+j+len/2]*curRe;
          re[i+j]=uRe+vRe; im[i+j]=uIm+vIm;
          re[i+j+len/2]=uRe-vRe; im[i+j+len/2]=uIm-vIm;
          var newRe=curRe*wRe-curIm*wIm;
          curIm=curRe*wIm+curIm*wRe; curRe=newRe;
        }
      }
    }
  }

  // Power spectrum
  function powerSpectrum(sig, fs) {
    var n = 1;
    while (n < sig.length) n *= 2;
    var re = new Float64Array(n), im = new Float64Array(n);
    for (var i=0;i<sig.length;i++) re[i] = sig[i] * (0.5 - 0.5*Math.cos(2*Math.PI*i/(sig.length-1))); // Hanning
    fft(re, im);
    var freqs = [], power = [];
    for (var i=0;i<n/2;i++) {
      freqs.push(i * fs / n);
      power.push(re[i]*re[i] + im[i]*im[i]);
    }
    return { freqs: freqs, power: power };
  }

  // Find peaks
  function findPeaks(sig, minDist, minProm) {
    var peaks = [];
    for (var i=1;i<sig.length-1;i++) {
      if (sig[i] > sig[i-1] && sig[i] > sig[i+1]) {
        // Check prominence
        var leftMin = sig[i], rightMin = sig[i];
        for (var j=i-1;j>=Math.max(0,i-minDist);j--) leftMin = Math.min(leftMin, sig[j]);
        for (var j=i+1;j<=Math.min(sig.length-1,i+minDist);j++) rightMin = Math.min(rightMin, sig[j]);
        var prom = sig[i] - Math.max(leftMin, rightMin);
        if (prom >= minProm) {
          // Check distance from last peak
          if (peaks.length === 0 || i - peaks[peaks.length-1] >= minDist) {
            peaks.push(i);
          } else if (sig[i] > sig[peaks[peaks.length-1]]) {
            peaks[peaks.length-1] = i;
          }
        }
      }
    }
    return peaks;
  }

  // Extract 28 features from BVP
  function extractFeatures(bvp, fs, profile) {
    var filtered = bandpass(bvp, fs, 0.7, 4.0);
    filtered = detrend(filtered, 1);

    var minDist = Math.max(Math.floor(fs * 0.35), 3);
    var std = 0, mean = 0;
    for (var i=0;i<filtered.length;i++) mean += filtered[i];
    mean /= filtered.length;
    for (var i=0;i<filtered.length;i++) std += (filtered[i]-mean)*(filtered[i]-mean);
    std = Math.sqrt(std / filtered.length);
    var prom = Math.max(std * 0.1, 0.001);

    var peaks = findPeaks(filtered, minDist, prom);
    if (peaks.length < 3) return null;

    // IBIs
    var ibis = [];
    for (var i=1;i<peaks.length;i++) {
      var ibi = (peaks[i] - peaks[i-1]) / fs;
      if (ibi > 0.3 && ibi < 2.0) ibis.push(ibi);
    }
    if (ibis.length < 2) return null;

    var meanIBI = 0;
    for (var i=0;i<ibis.length;i++) meanIBI += ibis[i];
    meanIBI /= ibis.length;
    var hr = 60 / meanIBI;
    if (hr < 40 || hr > 200) return null;

    var sdnn = 0;
    for (var i=0;i<ibis.length;i++) sdnn += (ibis[i]-meanIBI)*(ibis[i]-meanIBI);
    sdnn = Math.sqrt(sdnn / ibis.length);

    var rmssd = 0;
    for (var i=1;i<ibis.length;i++) rmssd += (ibis[i]-ibis[i-1])*(ibis[i]-ibis[i-1]);
    rmssd = Math.sqrt(rmssd / Math.max(1, ibis.length-1));

    var pnn50 = 0;
    if (ibis.length > 1) {
      var nn50 = 0;
      for (var i=1;i<ibis.length;i++) if (Math.abs(ibis[i]-ibis[i-1]) > 0.05) nn50++;
      pnn50 = nn50 / ibis.length;
    }

    // Beat segmentation (trough-to-trough)
    var troughs = [];
    for (var i=0;i<peaks.length-1;i++) {
      var minV = Infinity, minIdx = peaks[i];
      for (var j=peaks[i];j<peaks[i+1];j++) {
        if (filtered[j] < minV) { minV = filtered[j]; minIdx = j; }
      }
      troughs.push(minIdx);
    }

    var beats = [];
    for (var i=0;i<troughs.length-1;i++) {
      var blen = troughs[i+1] - troughs[i];
      if (blen > Math.max(fs*0.3, 5) && blen < fs*2) {
        var beat = [];
        for (var j=troughs[i];j<troughs[i+1];j++) beat.push(filtered[j]);
        beats.push(beat);
      }
    }
    if (beats.length < 2) return null;

    // Average beat
    var avgLen = 0;
    for (var i=0;i<beats.length;i++) avgLen += beats[i].length;
    avgLen = Math.round(avgLen / beats.length);
    if (avgLen < 6) return null;

    var avg = new Float64Array(avgLen);
    for (var b=0;b<beats.length;b++) {
      for (var i=0;i<avgLen;i++) {
        var srcIdx = i * (beats[b].length-1) / (avgLen-1);
        var lo2 = Math.floor(srcIdx), hi2 = Math.min(lo2+1, beats[b].length-1);
        var frac = srcIdx - lo2;
        avg[i] += (beats[b][lo2]*(1-frac) + beats[b][hi2]*frac) / beats.length;
      }
    }

    var pk = 0, pa = avg[0];
    for (var i=1;i<avgLen;i++) if (avg[i] > pa) { pa = avg[i]; pk = i; }
    if (pa === 0 || pk === 0) return null;

    var ct = pk / fs;
    var ms = 0;
    for (var i=1;i<=pk;i++) { var s2 = (avg[i]-avg[i-1])*fs; if (s2>ms) ms=s2; }

    // Pulse widths
    function pw(lv) {
      var am = pa * lv, s2=0, e2=avgLen-1;
      for (var i=0;i<pk;i++) if (avg[i]>=am) { s2=i; break; }
      for (var i=avgLen-1;i>pk;i--) if (avg[i]>=am) { e2=i; break; }
      return (e2-s2)/fs;
    }
    var pw10=pw(.1),pw25=pw(.25),pw50=pw(.5),pw75=pw(.75),pw90=pw(.9);

    // Area ratio
    var sa=0, da2=0;
    for (var i=0;i<=pk;i++) sa+=Math.abs(avg[i]);
    for (var i=pk+1;i<avgLen;i++) da2+=Math.abs(avg[i]);
    var areaRatio = sa/(sa+da2) || 0.5;

    // Dicrotic notch
    var se = Math.min(pk + Math.floor(avgLen*0.45), avgLen);
    var di = pk, ri = 0.5;
    if (se > pk+1) {
      var minDic = Infinity;
      for (var i=pk+1;i<se;i++) if (avg[i]<minDic) { minDic=avg[i]; di=i; }
      ri = avg[di] / pa;
    }

    var ai = 0;
    if (di < avgLen-2 && pa > 0) {
      var maxPost = -Infinity;
      for (var i=di+1;i<avgLen;i++) if (avg[i]>maxPost) maxPost=avg[i];
      ai = maxPost / pa;
    }

    // APG features (2nd derivative)
    var apgBA=0, apgCA=0, apgDA=0;
    if (avgLen > 8) {
      var d1 = new Float64Array(avgLen), d2 = new Float64Array(avgLen);
      for (var i=1;i<avgLen-1;i++) d1[i] = (avg[i+1]-avg[i-1])/2;
      for (var i=1;i<avgLen-1;i++) d2[i] = (d1[i+1]-d1[i-1])/2;

      var aIdx=0, aVal=d2[0];
      for (var i=1;i<=pk;i++) if (d2[i]>aVal) { aVal=d2[i]; aIdx=i; }
      if (Math.abs(aVal) > 1e-12) {
        var bVal=Infinity, bIdx=aIdx+1;
        for (var i=aIdx+1;i<=pk;i++) if (d2[i]<bVal) { bVal=d2[i]; bIdx=i; }
        apgBA = bVal / aVal;

        var cVal=-Infinity, cIdx=bIdx+1;
        for (var i=bIdx+1;i<se;i++) if (d2[i]>cVal) { cVal=d2[i]; cIdx=i; }
        apgCA = cVal / aVal;

        var dVal=Infinity;
        for (var i=cIdx+1;i<avgLen;i++) if (d2[i]<dVal) dVal=d2[i];
        if (dVal !== Infinity) apgDA = dVal / aVal;
      }
    }

    var decay = 0;
    if (di < avgLen-2) {
      var dLen = avgLen - di;
      decay = (avg[di] - avg[avgLen-1]) / (dLen/fs);
    }

    var pp = pa - avg[0];
    for (var i=1;i<avgLen;i++) if (avg[i]<avg[0]) pp = pa - avg[i];

    // Statistical
    var beatMean=0;
    for (var i=0;i<avgLen;i++) beatMean+=avg[i];
    beatMean/=avgLen;
    var m2=0,m3=0,m4=0;
    for (var i=0;i<avgLen;i++) {
      var d=(avg[i]-beatMean); m2+=d*d; m3+=d*d*d; m4+=d*d*d*d;
    }
    m2/=avgLen; m3/=avgLen; m4/=avgLen;
    var beatSkew = m2>0 ? m3/Math.pow(m2,1.5) : 0;
    var beatKurt = m2>0 ? m4/(m2*m2)-3 : 0;

    // Stiffness index
    var si = 0;
    var h = (profile && profile.height) ? profile.height : 0;
    if (h > 0 && di > pk) {
      var dt = (di-pk)/fs;
      if (dt > 0) si = (h/100) / dt;
    }

    // Profile values
    var age = (profile && profile.age) ? profile.age : 50;
    var bmi = (profile && profile.bmi) ? profile.bmi : 25;
    var gender = (profile && profile.gender !== null && profile.gender !== undefined) ? profile.gender : 0;

    return {
      hr: Math.round(hr*10)/10, meanIBI: Math.round(meanIBI*10000)/10000,
      sdnn: Math.round(sdnn*100000)/100000, rmssd: Math.round(rmssd*100000)/100000,
      pnn50: Math.round(pnn50*10000)/10000,
      crestTime: Math.round(ct*10000)/10000, maxSlope: Math.round(ms*1000)/1000,
      pw10: Math.round(pw10*10000)/10000, pw25: Math.round(pw25*10000)/10000,
      pw50: Math.round(pw50*10000)/10000, pw75: Math.round(pw75*10000)/10000,
      pw90: Math.round(pw90*10000)/10000,
      areaRatio: Math.round(areaRatio*10000)/10000,
      reflectionIndex: Math.round(ri*10000)/10000,
      augmentationIndex: Math.round(ai*10000)/10000,
      apgBARatio: Math.round(apgBA*10000)/10000,
      apgCARatio: Math.round(apgCA*10000)/10000,
      apgDARatio: Math.round(apgDA*10000)/10000,
      numBeats: beats.length,
      decayRate: Math.round(decay*10000)/10000,
      ppProxy: Math.round(pp*10000)/10000,
      age: age, bmi: bmi, gender: gender,
      lfHfRatio: 1, beatSkew: Math.round(beatSkew*10000)/10000,
      beatKurt: Math.round(beatKurt*10000)/10000,
      stiffnessIndex: Math.round(si*100)/100,
      _avgBeat: avg, _peaks: peaks, _filtered: filtered
    };
  }

  return {
    pos: pos,
    bandpass: bandpass,
    detrend: detrend,
    powerSpectrum: powerSpectrum,
    findPeaks: findPeaks,
    extractFeatures: extractFeatures
  };
})();
