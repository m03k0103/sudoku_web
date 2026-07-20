# Third-Party Notices

This repository includes third-party files in `deploy/`.

## OpenCV.js
- File: `deploy/opencv.js`
- Project: OpenCV
- Upstream: https://opencv.org/
- License: Apache License 2.0
- Notes: Distributed as JavaScript build output.

## Tesseract.js
- Files: `deploy/tesseract.min.js`, `deploy/worker.min.js`
- Project: tesseract.js
- Upstream: https://github.com/naptha/tesseract.js
- License: Apache License 2.0
- Notes: Minified bundle license references are included as:
  - `deploy/tesseract.min.js.LICENSE.txt`
  - `deploy/worker.min.js.LICENSE.txt`

## tesseract.js-core (WASM/JS core files)
- Files:
  - `deploy/tesseract-core.wasm`
  - `deploy/tesseract-core.wasm.js`
  - `deploy/tesseract-core-simd.wasm`
  - `deploy/tesseract-core-simd.wasm.js`
  - `deploy/tesseract-core-lstm.wasm`
  - `deploy/tesseract-core-lstm.wasm.js`
  - `deploy/tesseract-core-simd-lstm.wasm`
  - `deploy/tesseract-core-simd-lstm.wasm.js`
  - `deploy/tesseract-core-lstm.js`
  - `deploy/tesseract-core-simd-lstm.js`
- Project: tesseract.js-core
- Upstream: https://github.com/naptha/tesseract.js-core
- License: Apache License 2.0

## Tesseract language data
- File: `deploy/eng.traineddata.gz`
- Project: Tesseract OCR language data
- Upstream: https://github.com/tesseract-ocr/tessdata
- License: Apache License 2.0

## Additional bundled notices
Some bundles contain third-party modules (for example `buffer`, `ieee754`, and `regenerator-runtime`).
Those notices are provided in:
- `deploy/tesseract.min.js.LICENSE.txt`
- `deploy/worker.min.js.LICENSE.txt`

Please review upstream projects for full license terms and attribution details.
