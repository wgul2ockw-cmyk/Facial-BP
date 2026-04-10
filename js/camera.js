// camera.js — Camera management + MediaPipe FaceMesh + ROI extraction
window.Camera = (function() {
  'use strict';

  var video, overlay, ctx;
  var faceMesh = null;
  var mpCamera = null;
  var landmarks = null;
  var frameCount = 0;
  var rgbBuffer = [];
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
    rgbBuffer = [];
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

    mpCamera = new window.Camera(video, {
      onFrame: async function() {
        if (!running) return;
        await faceMesh.send({ image: video });
      },
      width: 640, height: 480
    });
    await mpCamera.start();
  }

  function stop() {
    running = false;
    if (mpCamera) { mpCamera.stop(); mpCamera = null; }
  }

  function onResults(results) {
    if (!running) return;
    frameCount++;

    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    var w = overlay.width, h = overlay.height;
    ctx.clearRect(0, 0, w, h);

    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      landmarks = null;
      if (onFrame) onFrame({ frame: frameCount, face: false });
      return;
    }

    landmarks = results.multiFaceLandmarks[0];
    var boxes = getROIBoxes(w, h);
    if (!boxes) return;

    // Draw ROI rectangles on overlay
    ctx.strokeStyle = 'rgba(167,139,250,0.5)';
    ctx.lineWidth = 2;
    ['f','l','r'].forEach(function(key) {
      var b = boxes[key];
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    });

    // Extract RGB from video frame
    var tempCanvas = document.createElement('canvas');
    tempCanvas.width = w; tempCanvas.height = h;
    var tc = tempCanvas.getContext('2d');
    tc.drawImage(video, 0, 0, w, h);

    var rgb = [0,0,0], totalPx = 0;
    ['f','l','r'].forEach(function(key) {
      var b = boxes[key];
      if (b.w < 2 || b.h < 2) return;
      try {
        var imgData = tc.getImageData(b.x, b.y, b.w, b.h);
        var d = imgData.data;
        for (var i = 0; i < d.length; i += 8) { // stride 2
          rgb[0] += d[i]; rgb[1] += d[i+1]; rgb[2] += d[i+2];
          totalPx++;
        }
      } catch(e) {}
    });

    if (totalPx > 0) {
      rgbBuffer.push([rgb[0]/totalPx, rgb[1]/totalPx, rgb[2]/totalPx]);
    }

    if (onFrame) {
      onFrame({
        frame: frameCount,
        face: true,
        boxes: boxes,
        rgbBuffer: rgbBuffer,
        landmarks: landmarks,
        videoWidth: w,
        videoHeight: h
      });
    }
  }

  // Compute ROI boxes using face geometry
  function getROIBoxes(w, h) {
    if (!landmarks) return null;

    // Find face bounding box
    var xs = [], ys = [];
    for (var i = 0; i < landmarks.length; i++) {
      xs.push(landmarks[i].x * w);
      ys.push(landmarks[i].y * h);
    }
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var fw = maxX - minX, fh = maxY - minY;

    // Key anchors
    var noseX = landmarks[1].x * w;
    var eyeLY = landmarks[159].y * h, eyeRY = landmarks[386].y * h;
    var eyeY = (eyeLY + eyeRY) / 2;
    var mouthY = landmarks[13].y * h;

    return {
      f: { x: Math.round(minX + fw*0.25), y: Math.round(minY + fh*0.02),
           w: Math.round(fw*0.5), h: Math.round((eyeY - minY) * 0.65) },
      l: { x: Math.round(minX + fw*0.05), y: Math.round(eyeY + fh*0.05),
           w: Math.round(noseX - minX - fw*0.12), h: Math.round((mouthY - eyeY) * 0.7) },
      r: { x: Math.round(noseX + fw*0.07), y: Math.round(eyeY + fh*0.05),
           w: Math.round(maxX - noseX - fw*0.12), h: Math.round((mouthY - eyeY) * 0.7) }
    };
  }

  // Draw ROI preview
  function drawROI(canvasId, box) {
    var c = document.getElementById(canvasId);
    if (!c || !box || box.w < 2 || box.h < 2) return;
    var ctx2 = c.getContext('2d');
    try {
      ctx2.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
    } catch(e) {}
  }

  return {
    init: init,
    start: start,
    stop: stop,
    drawROI: drawROI,
    getBuffer: function() { return rgbBuffer; },
    getFrameCount: function() { return frameCount; },
    isRunning: function() { return running; }
  };
})();
