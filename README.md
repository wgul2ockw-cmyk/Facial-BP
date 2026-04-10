# VitalScan — Camera-Based Blood Pressure Monitor

Estimates heart rate and blood pressure from a 15-second facial video scan using remote photoplethysmography (rPPG). Runs entirely in the browser — no server required.

## Live Demo
Deploy to GitHub Pages and open on your phone.

## Quick Deploy to GitHub Pages

1. Create a new repository on GitHub
2. Upload **all files and folders** in this project (keep the folder structure)
3. Go to **Settings → Pages → Source → main branch → / (root) → Save**
4. Wait ~1 minute, then visit `https://YOUR-USERNAME.github.io/YOUR-REPO/`

## Project Structure

```
├── index.html          # Main page
├── css/
│   └── style.css       # Styling
├── js/
│   ├── signal.js       # POS algorithm, Butterworth filter, FFT, feature extraction
│   ├── predict.js      # GBR tree walker + Neural Network forward pass
│   ├── camera.js       # MediaPipe FaceMesh + ROI extraction
│   ├── ui.js           # Charts, toasts, history rendering
│   └── app.js          # Main controller
├── models/
│   ├── gbr.json        # Gradient Boosting model (300+300 trees, 444 KB)
│   └── nn.json         # Neural Network weights (28→64→32→16→2, 36 KB)
└── README.md
```

## How It Works

**Pipeline:** Camera (30fps) → MediaPipe FaceMesh (468 landmarks) → 3 ROIs (forehead + cheeks) → POS algorithm → Butterworth bandpass (0.7–4 Hz) → BVP waveform → 28 features → GBR + NN ensemble → BP prediction

**Ensemble:** `final_BP = 0.7 × GBR + 0.3 × NN`

**Training Data:** 1,638 samples from 275 real hospital patients (PPG-BP Figshare + PPG-based-BP-assessment datasets). SBP range 80–176, DBP range 48–109 mmHg.

**Accuracy:** GBR 5-fold CV: SBP MAE 3.29 mmHg, DBP MAE 2.39 mmHg

## Features

- 28 morphological features extracted from BVP waveform
- Gradient Boosting (300 trees, depth 5) + MLP Neural Network (4 layers)
- Personal calibration with recency-weighted offset correction
- Measurement history with trend charts
- Real-time signal quality visualization

## Disclaimer

Research tool only. Not a medical device. Do not use for clinical decisions.
