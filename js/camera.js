// camera.js — Camera + MediaPipe FaceMesh + ROI extraction
// NOTE: MediaPipe's camera_utils.js exposes a global "Camera" class.
// We save a reference before defining our own module.
var _MPCamera = window.Camera; // Save MediaPipe's Camera class

window.Cam = (function() {
  'use strict';

  var video, overlay, ctx;
  var faceMesh = null;
  var mpCam = null;
  var landmarks = null;
  var frameCount = 0;
  var rgbBuffers = { f: [], l: [], r: [], all: [] }; // per-ROI RGB
  var onFrame = null;
  var running = false;

  function init(videoEl, overlayEl) {
    video = videoEl;
    overlay = overlayEl;
    ctx = overlay.getContext('2d');
  }

  async function start(callback) {
    onFrame = callback;
    frameCount = 0;
    rgbBuffers = { f: [], l: [], r: [], all: [] };
    running = true;

    if (!faceMesh) {
      faceMesh = new FaceMesh({
        locateFile: function(file) {
          return 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/' + file;
        }
      });
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      faceMesh.onResults(onResults);
    }

    // Use MediaPipe's Camera class (saved as _MPCamera)
    mpCam = new _MPCamera(video, {
      onFrame: async function() {
        if (!running) return;
        try { await faceMesh.send({ image: video }); } catch(e) {}
      },
      width: 640,
      height: 480
    });
    await mpCam.start();
  }

  function stop() {
    running = false;
    if (mpCam) { try { mpCam.stop(); } catch(e) {} mpCam = null; }
  }

  function onResults(results) {
    if (!running) return;
    frameCount++;

    var w = video.videoWidth || 640;
    var h = video.videoHeight || 480;
    overlay.width = w;
    overlay.height = h;
    ctx.clearRect(0, 0, w, h);

    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      landmarks = null;
      if (onFrame) onFrame({ frame: frameCount, face: false });
      return;
    }

    landmarks = results.multiFaceLandmarks[0];
    var boxes = getROIBoxes(w, h);
    if (!boxes) return;

    // Draw ROI boxes on overlay
    ctx.lineWidth = 2;
    var colors = { f: 'rgba(167,139,250,0.6)', l: 'rgba(62,230,138,0.6)', r: 'rgba(230,166,62,0.6)' };
    ['f','l','r'].forEach(function(key) {
      ctx.strokeStyle = colors[key];
      var b = boxes[key];
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    });

    // Extract RGB from each ROI separately
    var tempCanvas = document.createElement('canvas');
    tempCanvas.width = w; tempCanvas.height = h;
    var tc = tempCanvas.getContext('2d');
    tc.drawImage(video, 0, 0, w, h);

    var allR = 0, allG = 0, allB = 0, allPx = 0;
    var roiRGB = {};

    ['f','l','r'].forEach(function(key) {
      var b = boxes[key];
      if (b.w < 4 || b.h < 4) return;
      var r = 0, g = 0, bl = 0, px = 0;
      try {
        var img = tc.getImageData(b.x, b.y, b.w, b.h);
        var d = img.data;
        for (var i = 0; i < d.length; i += 16) { // stride 4 for speed
          r += d[i]; g += d[i+1]; bl += d[i+2]; px++;
        }
      } catch(e) { return; }
      if (px > 0) {
        roiRGB[key] = [r/px, g/px, bl/px];
        rgbBuffers[key].push([r/px, g/px, bl/px]);
        allR += r; allG += g; allB += bl; allPx += px;
      }
    });

    if (allPx > 0) {
      rgbBuffers.all.push([allR/allPx, allG/allPx, allB/allPx]);
    }

    if (onFrame) {
      onFrame({
        frame: frameCount,
        face: true,
        boxes: boxes,
        rgbBuffers: rgbBuffers,
        roiRGB: roiRGB,
        landmarks: landmarks,
        videoWidth: w,
        videoHeight: h
      });
    }
  }

  function getROIBoxes(w, h) {
    if (!landmarks) return null;
    var xs = [], ys = [];
    for (var i = 0; i < landmarks.length; i++) {
      xs.push(landmarks[i].x * w);
      ys.push(landmarks[i].y * h);
    }
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var fw = maxX - minX, fh = maxY - minY;
    var noseX = landmarks[1].x * w;
    var eyeY = (landmarks[159].y * h + landmarks[386].y * h) / 2;
    var mouthY = landmarks[13].y * h;

    return {
      f: { x: Math.round(minX+fw*0.25), y: Math.round(minY+fh*0.02), w: Math.round(fw*0.5), h: Math.round((eyeY-minY)*0.65) },
      l: { x: Math.round(minX+fw*0.05), y: Math.round(eyeY+fh*0.05), w: Math.round(noseX-minX-fw*0.12), h: Math.round((mouthY-eyeY)*0.7) },
      r: { x: Math.round(noseX+fw*0.07), y: Math.round(eyeY+fh*0.05), w: Math.round(maxX-noseX-fw*0.12), h: Math.round((mouthY-eyeY)*0.7) }
    };
  }

  function drawROI(canvasId, box) {
    var c = document.getElementById(canvasId);
    if (!c || !box || box.w < 2 || box.h < 2) return;
    try { c.getContext('2d').drawImage(video, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height); } catch(e) {}
  }

  return {
    init: init, start: start, stop: stop, drawROI: drawROI,
    getBuffer: function() { return rgbBuffers; },
    getFrameCount: function() { return frameCount; },
    isRunning: function() { return running; }
  };
})();
