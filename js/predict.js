// predict.js — GBR + Neural Network ensemble inference
window.Predict = (function() {
  'use strict';

  var gbrModel = null;
  var nnModel = null;
  var featureNames = null;

  // Load models from JSON files
  async function loadModels() {
    try {
      var [gbrResp, nnResp] = await Promise.all([
        fetch('models/gbr.json'),
        fetch('models/nn.json')
      ]);
      gbrModel = await gbrResp.json();
      nnModel = await nnResp.json();
      featureNames = gbrModel.features;
      console.log('Models loaded: GBR (' + gbrModel.sbp.trees.length + ' trees) + NN (' + nnModel.arch.join('→') + ')');
      return true;
    } catch(e) {
      console.error('Model load failed:', e);
      return false;
    }
  }

  // === GBR INFERENCE ===
  function walkTree(node, features) {
    if (node.v !== undefined) return node.v;
    return features[node.f] <= node.t
      ? walkTree(node.l, features)
      : walkTree(node.r, features);
  }

  function gbrPredict(featureArray) {
    var sbp = gbrModel.sbp.init;
    var lr = gbrModel.sbp.lr;
    for (var i = 0; i < gbrModel.sbp.trees.length; i++) {
      sbp += lr * walkTree(gbrModel.sbp.trees[i], featureArray);
    }

    var dbp = gbrModel.dbp.init;
    var lr2 = gbrModel.dbp.lr;
    for (var i = 0; i < gbrModel.dbp.trees.length; i++) {
      dbp += lr2 * walkTree(gbrModel.dbp.trees[i], featureArray);
    }

    return { sbp: sbp, dbp: dbp };
  }

  // === NEURAL NETWORK INFERENCE ===
  // Matrix-vector multiply: y = W·x + b, then apply activation
  function dense(W, x, b, relu) {
    var out = new Array(W.length);
    for (var i = 0; i < W.length; i++) {
      var s = b[i];
      for (var j = 0; j < x.length; j++) s += W[i][j] * x[j];
      out[i] = relu ? Math.max(0, s) : s;
    }
    return out;
  }

  function nnPredict(featureArray) {
    if (!nnModel) return null;
    try {
      // Standardize inputs
      var x = new Array(featureArray.length);
      for (var i = 0; i < featureArray.length; i++) {
        x[i] = (featureArray[i] - nnModel.mean[i]) / (nnModel.std[i] || 1);
      }

      // Forward pass: 28 → 256 → 128 → 64 → 32 → 2
      x = dense(nnModel.fc1_w, x, nnModel.fc1_b, true);   // ReLU
      x = dense(nnModel.fc2_w, x, nnModel.fc2_b, true);   // ReLU
      x = dense(nnModel.fc3_w, x, nnModel.fc3_b, true);   // ReLU
      x = dense(nnModel.fc4_w, x, nnModel.fc4_b, true);   // ReLU
      x = dense(nnModel.fc5_w, x, nnModel.fc5_b, false);  // Linear output

      return { sbp: x[0], dbp: x[1] };
    } catch(e) {
      console.warn('NN predict error:', e);
      return null;
    }
  }

  // === ENSEMBLE ===
  function predict(features) {
    if (!gbrModel) return null;

    // Build feature array in correct order
    var fa = [];
    for (var i = 0; i < featureNames.length; i++) {
      var val = features[featureNames[i]];
      fa.push(val !== undefined && val !== null && isFinite(val) ? val : 0);
    }

    // GBR prediction
    var gbr = gbrPredict(fa);

    // NN prediction
    var nn = nnPredict(fa);

    // Ensemble: 0.7 * GBR + 0.3 * NN
    var sbp, dbp;
    if (nn && isFinite(nn.sbp) && isFinite(nn.dbp)) {
      sbp = 0.7 * gbr.sbp + 0.3 * nn.sbp;
      dbp = 0.7 * gbr.dbp + 0.3 * nn.dbp;
    } else {
      sbp = gbr.sbp;
      dbp = gbr.dbp;
    }

    // Apply calibration offset
    var cal = loadCalibration();
    if (cal) {
      sbp += cal.sbpOffset;
      dbp += cal.dbpOffset;
    }

    // Clamp
    sbp = Math.max(70, Math.min(220, Math.round(sbp)));
    dbp = Math.max(40, Math.min(140, Math.round(dbp)));
    if (dbp >= sbp) dbp = sbp - 20;

    return {
      sbp: sbp, dbp: dbp,
      gbrSbp: Math.round(gbr.sbp), gbrDbp: Math.round(gbr.dbp),
      nnSbp: nn ? Math.round(nn.sbp) : null, nnDbp: nn ? Math.round(nn.dbp) : null,
      features: features
    };
  }

  function loadCalibration() {
    try {
      var data = JSON.parse(localStorage.getItem('vs_cal') || '[]');
      if (data.length === 0) return null;

      var totalW = 0, sbpOff = 0, dbpOff = 0;
      for (var i = 0; i < data.length; i++) {
        var w = 0.5 + 0.5 * (i + 1) / data.length; // recency weight
        sbpOff += w * (data[i].c.s - data[i].p.s);
        dbpOff += w * (data[i].c.d - data[i].p.d);
        totalW += w;
      }
      sbpOff /= totalW;
      dbpOff /= totalW;

      // Confidence ramp: 20% at 1 point, 100% at 5+ points
      var conf = Math.min(1, 0.2 + 0.2 * data.length);
      return { sbpOffset: sbpOff * conf, dbpOffset: dbpOff * conf };
    } catch(e) { return null; }
  }

  function getImportance() {
    return gbrModel ? { sbp: gbrModel.sbp_imp || {}, dbp: gbrModel.dbp_imp || {} } : null;
  }

  function isLoaded() { return !!gbrModel; }

  return {
    loadModels: loadModels,
    predict: predict,
    getImportance: getImportance,
    isLoaded: isLoaded
  };
})();
