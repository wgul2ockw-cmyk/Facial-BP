# VitalScan v8 — Camera-Based BP Monitor

Continuous heart rate and blood pressure estimation from facial video using remote photoplethysmography (rPPG).

## Deploy

### Local (Chrome)
Unzip → open `index.html` in Chrome. Done.

### GitHub Pages
1. Create repo → upload all files (keep folder structure)
2. Settings → Pages → main → root → Save
3. Live at `https://USERNAME.github.io/REPO/`

## Project Structure
```
├── index.html              ← UI shell (3.6 KB)
├── css/style.css            ← Styling (3 KB)
├── js/app.js                ← Camera, signal processing, prediction (22 KB)
├── models/
│   ├── gbr.js               ← Gradient Boosting (300 trees) - script loader
│   ├── gbr.json              ← Same model as fetch() fallback
│   ├── nn.js                 ← Neural Network (28→256→128→64→32→2) - script loader
│   └── nn.json               ← Same model as fetch() fallback
└── README.md
```

## How It Works
Camera 30fps → MediaPipe FaceMesh 468 landmarks → 30 landmark patches (skin-filtered) → POS algorithm → Butterworth bandpass → 28 features → GBR+NN ensemble → BP

## ROI Method (Ontiveros & Elgendi, Nature 2024)
- 30 specific landmark indices (10 forehead + 10 left cheek + 10 right cheek)
- 24×24 pixel patch around each landmark
- YCbCr skin color filter rejects non-skin pixels
- Quality-weighted averaging across ROIs

## Models
- **GBR**: 300+300 trees, depth 5, trained on 1,638 samples from 275 subjects
- **NN**: 5-layer MLP (28→256→128→64→32→2), 47K parameters
- **Ensemble**: 0.7×GBR + 0.3×NN
- **Accuracy**: SBP MAE 3.29, DBP MAE 2.39 mmHg (5-fold CV)

## Disclaimer
Research tool only. Not a medical device.
