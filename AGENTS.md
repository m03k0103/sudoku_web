# OCR Test Agent Policy

This repository uses a fixed OCR regression workflow for Sudoku screenshots.

## Scope
- Target app: `deploy/index.html` + `deploy/app.js`
- Test images:
  - `testing/Screenshot_20260719-151941.png`
  - `testing/Screenshot_20260719-174639.png`

## Required Workflow (Every Code Change)
1. Open `file:///.../sudoku_web/deploy/index.html`.
2. Run OCR on both test images.
3. Extract full 9x9 recognized board for each image.
4. Compare against expected answers in `testing/expected_answers.json`.
5. Report results:
   - per-image pass/fail
   - list of mismatched cells in `R{row}C{col}` format
   - count of misses (`0`) and wrong digits

## Ground Truth Source
- Canonical truth file: `testing/expected_answers.json`
- If missing or incomplete, do not invent truth values.
- Ask the user for missing ground-truth values, then update the truth file.

## Output Format for Test Reports
- `image`: file name
- `recognized_board`: 9x9 integer matrix
- `expected_board`: 9x9 integer matrix
- `mismatches`: array of `{ cell, expected, actual }`
- `summary`: `{ total_mismatches, misses, wrong_digits }`

## Safety Rules
- Do not add per-cell hardcoded fixes (e.g., specific R/C overrides).
- Prefer generalized rules (shape, holes, confidence, contour metrics).
- Keep post-correction stages explicit and logged.

## Local Tooling Notes (Windows)
- Git executable path: `C:\Program Files\Git\cmd\git.exe`
- If `git` is not on PATH, run commands as:
  - `$git='C:\Program Files\Git\cmd\git.exe'`
  - `& $git status`
