# VitalScan — Camera-Based Heart Rate & Blood Pressure Monitor
## Complete Project Summary for Development Team

---

## 1. What This Is

A web app that estimates **heart rate and blood pressure** from a **15-second facial video** using remote photoplethysmography (rPPG). Everything runs client-side in the browser — no server, no API calls, no data leaves the device.

**Current status:** Working prototype. Camera captures face → extracts pulse signal → predicts BP. The signal extraction quality needs improvement for real-world accuracy.

**Live deployment:** GitHub Pages (static files only)
**Tech stack:** Vanilla JavaScript, MediaPipe FaceMesh, HTML5 Canvas
**Total size:** ~1.7 MB (including 2 ML models)

---

## 2. How It Works — The Pipeline

```
iPhone/Webcam (30 fps)
    ↓
MediaPipe FaceMesh (468 3D landmarks)
    ↓
43 Landmark Patches (Elgendi et al. 2024, npj Biosensing)
  • 10 forehead: [10, 67, 69, 104, 108, 109, 151, 299, 337, 338]
  • 18 left cheek: [36, 47, 50, 100, 101, 116, 117, 118, 119, 123, 126, 147, 187, 203, 205, 206, 207, 216]
  • 15 right cheek: [266, 280, 329, 330, 346, 347, 348, 355, 371, 411, 423, 425, 426, 427, 436]
  • 20×20 pixel patch around each landmark
  • RGB 5-230 threshold (pyVHR) to reject non-skin pixels
    ↓
POS Algorithm (Wang et al. 2017)
  • 1.6-second sliding windows, 50% overlap
  • Temporal normalization: divide each RGB by window mean
  • Projection: S1 = Gn - Bn, S2 = -2Rn + Gn + Bn
  • Alpha-tuning: α = σ(S1) / σ(S2)
  • Combine: BVP = S1 + α·S2
  • Hanning-windowed overlap-add
    ↓
3rd-Order Butterworth Bandpass (0.7 – 3.0 Hz)
  • Zero-phase (forward + reverse) for no phase distortion
  • Cascaded biquad sections
    ↓
28 Morphological Features
  • Timing: HR, mean IBI, crest time
  • HRV: SDNN, RMSSD, pNN50
  • Waveform: max slope, pulse widths (10/25/50/75/90%)
  • Reflection: area ratio, reflection index, augmentation index
  • APG: b/a, c/a, d/a ratios (2nd derivative peaks)
  • Stats: beat skew, kurtosis, stiffness index
  • Demographics: age, BMI, gender (from user profile)
    ↓
GBR + Neural Network Ensemble
  • GBR: 300+300 decision trees, depth 5 (445 KB JSON)
  • NN: 5-layer MLP, 28→256→128→64→32→2 (366 KB JSON)
  • Ensemble: final = 0.7 × GBR + 0.3 × NN
    ↓
SBP / DBP Prediction (mmHg)
```

---

## 3. Project Structure

```
vitalscan/
├── index.html              ← UI shell (6 KB)
├── css/
│   └── style.css           ← All styling (3 KB)
├── js/
│   └── app.js              ← Everything: camera, signal processing,
│                              feature extraction, ML inference,
│                              face alignment, drawing (28 KB)
├── models/
│   ├── gbr.js              ← GBR model (445 KB) - <script> loader
│   ├── gbr.json             ← Same model for fetch() fallback
│   ├── nn.js               ← NN model (366 KB) - <script> loader
│   └── nn.json              ← Same model for fetch() fallback
└── README.md
```

**Why both .js and .json for models:**
- `.js` files load via `<script>` tags → works on `file://` protocol (local Chrome)
- `.json` files load via `fetch()` → works on `https://` (GitHub Pages, future API)

---

## 4. Training Data & Model Accuracy

### Datasets Used (real clinical data)
| Dataset | Subjects | Samples | Age Range | SBP Range | Source |
|---------|----------|---------|-----------|-----------|--------|
| PPG-BP Figshare (Liang et al.) | 219 | 657 recordings | 20-89 | 80-182 | Finger PPG, 1kHz |
| PPG-BP-assessment (Vasquez et al. 2024) | 56 | 56 recordings | 44-65 | 97-164 | Finger PPG, 200Hz |
| **Combined + windowed** | **275** | **1,638** | **20-89** | **80-176** | |

### Model Performance (5-fold cross-validation)
| Model | SBP MAE | DBP MAE | Size |
|-------|---------|---------|------|
| GBR (300 trees) | 3.29 mmHg | 2.39 mmHg | 445 KB |
| Neural Network | 2.62 (train) | 2.39 (train) | 366 KB |
| **Ensemble** | **~3.0** | **~2.4** | **811 KB** |
| Clinical threshold (AAMI) | <5.0 | <5.0 | — |

**Critical caveat:** These numbers are on **contact PPG data** (finger sensor). Real-world camera rPPG will be significantly worse (~6-10 SBP, ~4-7 DBP MAE) due to the domain gap between clean contact PPG and noisy camera video.

---

## 5. Face Alignment System

Before scanning starts, the user must pass 6 checks for 30 consecutive frames:

| Check | Threshold | Method |
|-------|-----------|--------|
| Face detected | FaceMesh confidence > 0.5 | MediaPipe built-in |
| Face size | 25-70% of frame height | Bounding box from landmarks |
| Centered X | Within ±12% of frame center | Face centroid vs frame center |
| Centered Y | Within ±15% | Same |
| Yaw angle | <15° | Nose position relative to eye midpoint |
| Pitch angle | Nose at 35-55% of face height | Nose Y relative to forehead-chin line |

Visual: dashed ellipse overlay turns green when all checks pass. Status indicators on the left show each check's state.

---

## 6. Key Technical Decisions & Why

### Why POS algorithm (not deep learning)?
- No GPU dependency, runs on any browser
- No training data needed for signal extraction
- Comparable accuracy to DL under controlled conditions (1-3 BPM MAE)
- POS handles skin-tone variation well via temporal normalization

### Why 0.7-3.0 Hz bandpass (not 0.5-4.0)?
- 0.7 Hz = 42 BPM (covers bradycardia, rejects respiratory artifact at 0.15-0.4 Hz)
- 3.0 Hz = 180 BPM (sufficient for resting adults)
- Tighter band = less noise in the signal

### Why RGB 5-230 threshold (not YCbCr skin segmentation)?
- YCbCr thresholds fail on Fitzpatrick skin types V-VI (dark skin)
- MAE degrades from 5.2 to 14.1 BPM with skin-color segmentation on dark skin
- Landmark-defined ROIs already isolate skin regions; simple brightness thresholds suffice

### Why GBR + NN ensemble (not just one)?
- GBR excels on small tabular datasets (well-known ML finding)
- NN provides complementary diversity — catches patterns GBR misses
- 0.7/0.3 weighting because GBR has better validated accuracy

### Why no dicrotic notch in the waveform?
- At 30 fps, you get ~24 samples per heartbeat at 75 BPM
- Dicrotic notch requires 10-15 Hz temporal resolution
- Would need ≥60 fps camera with excellent SNR
- Ensemble pulse averaging (20+ beats) can sometimes reveal it

---

## 7. Current Known Issues

### Critical
1. **Signal quality varies wildly** — Δ% ranges from 0.3% (good) to 18%+ (unusable) depending on lighting, motion, glasses
2. **No ground truth validation** — we don't know if the extracted waveform matches a real PPG; need finger pulse oximeter comparison
3. **Domain gap** — model trained on contact PPG, deployed on camera rPPG; expected 2-3× accuracy degradation

### Important
4. **Glasses cause specular reflections** — forehead patches near glasses frames capture glare instead of skin
5. **ROI preview shows patches are on skin but signal is still noisy** — likely motion artifacts between frames, not ROI placement
6. **HR from green channel vs HR from filtered BVP sometimes disagree** — indicates the POS algorithm may be introducing its own artifacts

### Minor
7. Profile save doesn't show confirmation on all browsers
8. No calibration tab in current v9 (was in earlier versions)
9. No measurement history persistence

---

## 8. What Needs To Be Done Next (Priority Order)

### Tier 1 — Validate the signal is real
1. **Buy a finger pulse oximeter** (~$20 CMS50E on Amazon). Run the app while wearing it. Compare the beat timing. If beats align within ±100ms, the camera PPG is real.
2. **Record video of screen + finger oximeter simultaneously** for 60 seconds. This gives ground truth to measure actual camera rPPG accuracy.
3. **Add a signal quality gate** — only show results when SNR > 5 dB (currently shows results at SNR > 0 dB which is too lenient)

### Tier 2 — Improve signal extraction
4. **Fix motion compensation** — track landmark displacement between frames, flag frames with >2% face-height motion, interpolate RGB values for rejected frames
5. **Add per-patch SNR weighting** — compute each patch's spectral SNR independently, weight high-SNR patches more in the average (Elgendi showed 29% improvement)
6. **Test CHROM as alternative** — run both POS and CHROM, auto-select the one with higher SNR per-segment (partially implemented in earlier versions)
7. **Increase to 60 fps** if device supports it — doubles temporal resolution for waveform morphology

### Tier 3 — Improve the model
8. **Collect paired data** — 30+ recordings with simultaneous cuff BP + camera scan. This is the most valuable thing for accuracy.
9. **Apply for MMSE-HR / V4V dataset access** — only public datasets with facial video + BP ground truth (~179 subjects, Binghamton University)
10. **Add calibration back** — per-user offset correction from cuff readings (was implemented in v5-v6, removed in v9 rebuild)

### Tier 4 — Production readiness
11. **Add Web Worker** for signal processing — currently everything runs on main thread, can cause frame drops
12. **Add error boundaries** — graceful fallback when camera access denied, MediaPipe fails to load, etc.
13. **Mobile optimization** — test on iPhone Safari, Android Chrome, handle orientation changes
14. **Privacy disclaimer + consent flow** before camera access

---

## 9. References

### Core Methods
- **POS algorithm:** Wang, W., den Brinker, A.C., Stuijk, S., de Haan, G. (2017). "Algorithmic Principles of Remote PPG." IEEE Trans. Biomed. Eng. 64(7).
- **CHROM algorithm:** De Haan, G., Jeanne, V. (2013). "Robust Pulse Rate from Chrominance-Based rPPG." IEEE Trans. Biomed. Eng. 60(10).
- **ROI landmarks:** Elgendi, M. et al. (2024). "Optimal signal quality index for remote photoplethysmogram sensing." npj Biosensing.
- **ROI assessment:** Kim, C.B. et al. (2021). "Assessment of ROI Selection for Facial Video-Based rPPG." Sensors 21(23).

### Datasets
- **PPG-BP:** Liang, Y. et al. (2018). "A new, short-recorded photoplethysmogram dataset." Scientific Data 5.
- **PPG-BP-assessment:** Vasquez, S. et al. (2024). GitHub: sanvsquezsz/PPG-based-BP-assessment.
- **UBFC-rPPG:** Bobbia, S. et al. (2019). 42 subjects, 640×480/30fps. Standard benchmark.

### Frameworks
- **pyVHR:** Boccignone, G. et al. (2022). PeerJ Computer Science 8:e929.
- **rPPG-Toolbox:** Liu, X. et al. (2023). NeurIPS 2023.
- **VitalLens:** Rouast, P. (2023). JavaScript rPPG implementation.

---

## 10. Quick Start for Developers

```bash
# Clone/download the project
# Open index.html in Chrome (no server needed)
# Or deploy to GitHub Pages:
git init
git add .
git commit -m "VitalScan v9"
git remote add origin https://github.com/YOUR-USER/vitalscan.git
git push -u origin main
# Settings → Pages → main → root → Save
# Live at https://YOUR-USER.github.io/vitalscan/
```

### Key files to modify:
- `js/app.js` lines 1-20: Config constants (FPS, window size, patch radius)
- `js/app.js` lines 22-30: Landmark indices (change ROI regions)
- `js/app.js` ~line 250: `bandpass()` filter parameters
- `js/app.js` ~line 450: `predict()` function (model inference)
- `models/gbr.json`: Replace with retrained model
- `models/nn.json`: Replace with retrained NN

### To retrain the model:
1. Collect paired data: camera scan + cuff BP reading
2. Extract 28 features from BVP waveform (same pipeline as app)
3. Train GBR: `GradientBoostingRegressor(n_estimators=300, max_depth=5)`
4. Train NN: PyTorch MLP `28→256→128→64→32→2`
5. Export to JSON, replace model files

---

*Document generated April 10, 2026. VitalScan v9.*
*This is a research tool, not a medical device.*
