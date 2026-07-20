/* global cv, Tesseract */

const boardEl = document.getElementById("board");
const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const imageInput = document.getElementById("imageInput");
const answerBtn = document.getElementById("answerBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const resetBtn = document.getElementById("resetBtn");

const emptyBoard = () => Array.from({ length: 9 }, () => Array(9).fill(0));
const cloneBoard = (src) => src.map((row) => row.slice());
const emptyFlags = () => Array.from({ length: 9 }, () => Array(9).fill(false));

let initialBoard = emptyBoard();
let currentBoard = emptyBoard();
let forcedCells = emptyFlags();
let steps = [];
let stepIndex = -1;
let solvedBoard = null;
let navHighlightCell = null;

let cvReady = false;
let ocrWorker = null;
let ocrReady = false;
let workerBootstrapUrl = null;
let digitTemplateVectors = null;
const debugLines = [];
const opencvReadyPromise = window.__opencvReadyPromise || Promise.resolve();

function resourceUrl(path) {
  return new URL(path, document.baseURI).href;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function clearDebugLog(text = "") {
  debugLines.length = 0;
  logEl.textContent = text;
}

function appendDebugLog(message) {
  const timestamp = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  const line = `${timestamp} ${message}`;
  debugLines.push(line);
  if (debugLines.length > 120) {
    debugLines.shift();
  }
  logEl.textContent = debugLines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
  console.debug(line);
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function createFileProtocolWorkerBootstrap() {
  const workerScriptUrl = resourceUrl("./worker.min.js");
  const bootstrapCode = `importScripts(${JSON.stringify(workerScriptUrl)});`;
  return URL.createObjectURL(
    new Blob([bootstrapCode], { type: "application/javascript" }),
  );
}

function buildWorkerOptions(workerPathToUse, langPathToUse) {
  return {
    workerPath: workerPathToUse,
    corePath: resourceUrl("./"),
    langPath: langPathToUse,
    // workerPath 自体を blob にするため、追加の blob 化は無効化する
    workerBlobURL: false,
    gzip: true,
    logger: (message) => {
      if (!message || !message.status) return;
      if (message.status.includes("recognizing text")) return;
      const progress = typeof message.progress === "number"
        ? ` ${Math.round(message.progress * 100)}%`
        : "";
      appendDebugLog(`tesseract: ${message.status}${progress}`);

      if (message.status.includes("loading language traineddata")) {
        setStatus("OCR辞書を読み込み中です...");
      } else if (message.status.includes("loading tesseract core")) {
        setStatus("OCRコアを読み込み中です...");
      } else if (message.status.includes("initializing tesseract")) {
        setStatus("OCRエンジンを初期化しています...");
      }
    },
  };
}

function renderBoard() {
  boardEl.innerHTML = "";
  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      const cell = document.createElement("div");
      let className = "cell";
      if (c === 2 || c === 5) className += " thick-right";
      if (r === 2 || r === 5) className += " thick-bottom";
      if (initialBoard[r][c] !== 0) className += " prefilled";
      if (navHighlightCell && navHighlightCell.row === r && navHighlightCell.col === c) className += " step-highlight";
      // Temporarily disable forced-cell color highlighting.
      // if (forcedCells[r][c]) className += " forced";
      cell.className = className;
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);
      cell.title = "クリックで値を編集 (0-9)";
      cell.textContent = currentBoard[r][c] === 0 ? "" : String(currentBoard[r][c]);
      boardEl.appendChild(cell);
    }
  }
}

function updateCellValue(row, col, value) {
  initialBoard[row][col] = value;
  currentBoard[row][col] = value;
  forcedCells[row][col] = false;
  steps = [];
  stepIndex = -1;
  solvedBoard = null;
  navHighlightCell = null;
  renderBoard();
  clearDebugLog(`R${row + 1}C${col + 1} を ${value === 0 ? "空欄" : value} に更新しました。`);
  setStatus("セルを手修正しました。必要なら解くを押してください。");
}

function renderLog() {
  if (steps.length === 0) {
    logEl.textContent = "まだ解いていません。";
    return;
  }
  if (stepIndex < 0) {
    logEl.textContent = `解法を準備しました。\n進むボタンで1手目から表示します。\n手数: ${steps.length}`;
    return;
  }
  const s = steps[stepIndex];
  if (!s) {
    logEl.textContent = "解説がありません。";
    return;
  }
  logEl.textContent = `${stepIndex + 1}/${steps.length}\n技法: ${s.technique}\n${s.reason}`;
}

function resetToInitial() {
  currentBoard = cloneBoard(initialBoard);
  stepIndex = -1;
  navHighlightCell = null;
  renderBoard();
  renderLog();
}

function applySteps(upto) {
  currentBoard = cloneBoard(initialBoard);
  for (let i = 0; i <= upto; i += 1) {
    const s = steps[i];
    if (s) currentBoard[s.row][s.col] = s.value;
  }
}

function isValid(board, row, col, value) {
  for (let i = 0; i < 9; i += 1) {
    if (board[row][i] === value) return false;
    if (board[i][col] === value) return false;
  }
  const br = Math.floor(row / 3) * 3;
  const bc = Math.floor(col / 3) * 3;
  for (let r = br; r < br + 3; r += 1) {
    for (let c = bc; c < bc + 3; c += 1) {
      if (board[r][c] === value) return false;
    }
  }
  return true;
}

function candidates(board, row, col) {
  const result = [];
  for (let v = 1; v <= 9; v += 1) {
    if (isValid(board, row, col, v)) result.push(v);
  }
  return result;
}

function buildCandidateGrid(board) {
  const grid = Array.from({ length: 9 }, () => Array(9).fill(null));
  let unresolved = 0;

  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      if (board[r][c] !== 0) continue;
      const cand = candidates(board, r, c);
      grid[r][c] = cand;
      unresolved += 1;
      if (cand.length === 0) {
        return { grid, unresolved, contradiction: { row: r, col: c } };
      }
    }
  }

  return { grid, unresolved, contradiction: null };
}

function findBestEmptyByGrid(board, candidateGrid) {
  let best = null;
  let bestLen = 10;
  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      if (board[r][c] === 0) {
        const cand = candidateGrid[r][c] || [];
        if (cand.length < bestLen) {
          best = { row: r, col: c, cand };
          bestLen = cand.length;
          if (bestLen === 1) return best;
        }
      }
    }
  }
  return best;
}

function findNakedSingleMove(board, candidateGrid) {
  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      if (board[r][c] !== 0) continue;
      const cand = candidateGrid[r][c] || [];
      if (cand.length !== 1) continue;
      return {
        row: r,
        col: c,
        value: cand[0],
        technique: "単一候補",
        reason: `(${r + 1},${c + 1}) の候補が ${JSON.stringify(cand)} だけだったため、${cand[0]} を入れます。`,
      };
    }
  }
  return null;
}

function findHiddenSingleMove(board, candidateGrid) {
  for (let r = 0; r < 9; r += 1) {
    for (let value = 1; value <= 9; value += 1) {
      const positions = [];
      for (let c = 0; c < 9; c += 1) {
        if (board[r][c] !== 0) continue;
        if ((candidateGrid[r][c] || []).includes(value)) positions.push(c);
      }
      if (positions.length === 1) {
        const col = positions[0];
        return {
          row: r,
          col,
          value,
          technique: "隠れシングル(行)",
          reason: `${r + 1}行では ${value} を置ける位置が C${col + 1} だけのため、R${r + 1}C${col + 1} に ${value} を入れます。`,
        };
      }
    }
  }

  for (let c = 0; c < 9; c += 1) {
    for (let value = 1; value <= 9; value += 1) {
      const positions = [];
      for (let r = 0; r < 9; r += 1) {
        if (board[r][c] !== 0) continue;
        if ((candidateGrid[r][c] || []).includes(value)) positions.push(r);
      }
      if (positions.length === 1) {
        const row = positions[0];
        return {
          row,
          col: c,
          value,
          technique: "隠れシングル(列)",
          reason: `${c + 1}列では ${value} を置ける位置が R${row + 1} だけのため、R${row + 1}C${c + 1} に ${value} を入れます。`,
        };
      }
    }
  }

  for (let br = 0; br < 3; br += 1) {
    for (let bc = 0; bc < 3; bc += 1) {
      for (let value = 1; value <= 9; value += 1) {
        const positions = [];
        for (let dr = 0; dr < 3; dr += 1) {
          for (let dc = 0; dc < 3; dc += 1) {
            const r = br * 3 + dr;
            const c = bc * 3 + dc;
            if (board[r][c] !== 0) continue;
            if ((candidateGrid[r][c] || []).includes(value)) positions.push({ row: r, col: c });
          }
        }
        if (positions.length === 1) {
          const p = positions[0];
          return {
            row: p.row,
            col: p.col,
            value,
            technique: "隠れシングル(ブロック)",
            reason: `(${br + 1},${bc + 1}) ブロックでは ${value} を置ける位置が R${p.row + 1}C${p.col + 1} だけのため、${value} を入れます。`,
          };
        }
      }
    }
  }

  return null;
}

function findNakedPairDerivedSingle(board, candidateGrid) {
  const work = candidateGrid.map((row) => row.map((cand) => (cand ? cand.slice() : null)));
  const reasons = Array.from({ length: 9 }, () => Array(9).fill(""));

  function applyUnit(cells, unitLabel) {
    const pairMap = new Map();
    for (const cell of cells) {
      const cand = work[cell.row][cell.col];
      if (!cand || cand.length !== 2) continue;
      const key = cand.slice().sort((a, b) => a - b).join(",");
      if (!pairMap.has(key)) pairMap.set(key, []);
      pairMap.get(key).push(cell);
    }

    for (const [key, pairCells] of pairMap.entries()) {
      if (pairCells.length !== 2) continue;
      const digits = key.split(",").map((x) => Number(x));
      for (const cell of cells) {
        if (pairCells.some((p) => p.row === cell.row && p.col === cell.col)) continue;
        const cand = work[cell.row][cell.col];
        if (!cand || cand.length === 0) continue;
        const reduced = cand.filter((v) => !digits.includes(v));
        if (reduced.length !== cand.length) {
          work[cell.row][cell.col] = reduced;
          if (!reasons[cell.row][cell.col]) {
            const p1 = pairCells[0];
            const p2 = pairCells[1];
            reasons[cell.row][cell.col] = `${unitLabel} のネイキッドペア R${p1.row + 1}C${p1.col + 1}/R${p2.row + 1}C${p2.col + 1} = [${digits.join(",")}]`; 
          }
        }
      }
    }
  }

  for (let r = 0; r < 9; r += 1) {
    const cells = [];
    for (let c = 0; c < 9; c += 1) if (board[r][c] === 0) cells.push({ row: r, col: c });
    applyUnit(cells, `${r + 1}行`);
  }

  for (let c = 0; c < 9; c += 1) {
    const cells = [];
    for (let r = 0; r < 9; r += 1) if (board[r][c] === 0) cells.push({ row: r, col: c });
    applyUnit(cells, `${c + 1}列`);
  }

  for (let br = 0; br < 3; br += 1) {
    for (let bc = 0; bc < 3; bc += 1) {
      const cells = [];
      for (let dr = 0; dr < 3; dr += 1) {
        for (let dc = 0; dc < 3; dc += 1) {
          const r = br * 3 + dr;
          const c = bc * 3 + dc;
          if (board[r][c] === 0) cells.push({ row: r, col: c });
        }
      }
      applyUnit(cells, `(${br + 1},${bc + 1})ブロック`);
    }
  }

  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      if (board[r][c] !== 0) continue;
      const before = candidateGrid[r][c] || [];
      const after = work[r][c] || [];
      if (before.length > 1 && after.length === 1) {
        return {
          row: r,
          col: c,
          value: after[0],
          technique: "ネイキッドペア",
          reason: `${reasons[r][c]} により R${r + 1}C${c + 1} の候補が ${JSON.stringify(before)} -> ${JSON.stringify(after)} となったため、${after[0]} を入れます。`,
        };
      }
    }
  }

  return null;
}

function findLockedCandidatesDerivedSingle(board, candidateGrid) {
  const work = candidateGrid.map((row) => row.map((cand) => (cand ? cand.slice() : null)));
  const reasons = Array.from({ length: 9 }, () => Array(9).fill(""));

  function eliminateCandidate(row, col, value, reason) {
    const cand = work[row][col];
    if (!cand || cand.length === 0) return;
    if (!cand.includes(value)) return;
    work[row][col] = cand.filter((v) => v !== value);
    if (!reasons[row][col]) reasons[row][col] = reason;
  }

  for (let br = 0; br < 3; br += 1) {
    for (let bc = 0; bc < 3; bc += 1) {
      const boxRowStart = br * 3;
      const boxColStart = bc * 3;

      for (let value = 1; value <= 9; value += 1) {
        const positions = [];
        for (let dr = 0; dr < 3; dr += 1) {
          for (let dc = 0; dc < 3; dc += 1) {
            const row = boxRowStart + dr;
            const col = boxColStart + dc;
            if (board[row][col] !== 0) continue;
            if ((work[row][col] || []).includes(value)) positions.push({ row, col });
          }
        }

        if (positions.length < 2) continue;

        const sameRow = positions.every((p) => p.row === positions[0].row);
        if (sameRow) {
          const row = positions[0].row;
          const reason = `ロックド候補: (${br + 1},${bc + 1})ブロック内の ${value} 候補が R${row + 1} に限定`;
          for (let col = 0; col < 9; col += 1) {
            if (col >= boxColStart && col < boxColStart + 3) continue;
            if (board[row][col] !== 0) continue;
            eliminateCandidate(row, col, value, reason);
          }
        }

        const sameCol = positions.every((p) => p.col === positions[0].col);
        if (sameCol) {
          const col = positions[0].col;
          const reason = `ロックド候補: (${br + 1},${bc + 1})ブロック内の ${value} 候補が C${col + 1} に限定`;
          for (let row = 0; row < 9; row += 1) {
            if (row >= boxRowStart && row < boxRowStart + 3) continue;
            if (board[row][col] !== 0) continue;
            eliminateCandidate(row, col, value, reason);
          }
        }
      }
    }
  }

  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      if (board[r][c] !== 0) continue;
      const before = candidateGrid[r][c] || [];
      const after = work[r][c] || [];
      if (before.length > 1 && after.length === 1) {
        const reasonHead = reasons[r][c] ? `${reasons[r][c]} により` : "ロックド候補により";
        return {
          row: r,
          col: c,
          value: after[0],
          technique: "ロックド候補",
          reason: `${reasonHead} R${r + 1}C${c + 1} の候補が ${JSON.stringify(before)} -> ${JSON.stringify(after)} となったため、${after[0]} を入れます。`,
        };
      }
    }
  }

  return null;
}

function isPeerCell(aRow, aCol, bRow, bCol) {
  if (aRow === bRow && aCol === bCol) return false;
  if (aRow === bRow) return true;
  if (aCol === bCol) return true;
  return Math.floor(aRow / 3) === Math.floor(bRow / 3)
    && Math.floor(aCol / 3) === Math.floor(bCol / 3);
}

function findXWingDerivedSingle(board, candidateGrid) {
  const work = candidateGrid.map((row) => row.map((cand) => (cand ? cand.slice() : null)));
  const reasons = Array.from({ length: 9 }, () => Array(9).fill(""));

  function eliminate(row, col, value, reason) {
    const cand = work[row][col];
    if (!cand || !cand.includes(value)) return;
    work[row][col] = cand.filter((v) => v !== value);
    if (!reasons[row][col]) reasons[row][col] = reason;
  }

  for (let value = 1; value <= 9; value += 1) {
    const rowPairs = [];
    for (let row = 0; row < 9; row += 1) {
      const cols = [];
      for (let col = 0; col < 9; col += 1) {
        if (board[row][col] !== 0) continue;
        if ((work[row][col] || []).includes(value)) cols.push(col);
      }
      if (cols.length === 2) rowPairs.push({ row, c1: cols[0], c2: cols[1] });
    }

    for (let i = 0; i < rowPairs.length; i += 1) {
      for (let j = i + 1; j < rowPairs.length; j += 1) {
        const a = rowPairs[i];
        const b = rowPairs[j];
        if (a.c1 !== b.c1 || a.c2 !== b.c2) continue;
        const reason = `X-Wing: 数字 ${value} が R${a.row + 1}/R${b.row + 1} と C${a.c1 + 1}/C${a.c2 + 1} で長方形を形成`;
        for (let row = 0; row < 9; row += 1) {
          if (row === a.row || row === b.row) continue;
          if (board[row][a.c1] === 0) eliminate(row, a.c1, value, reason);
          if (board[row][a.c2] === 0) eliminate(row, a.c2, value, reason);
        }
      }
    }

    const colPairs = [];
    for (let col = 0; col < 9; col += 1) {
      const rows = [];
      for (let row = 0; row < 9; row += 1) {
        if (board[row][col] !== 0) continue;
        if ((work[row][col] || []).includes(value)) rows.push(row);
      }
      if (rows.length === 2) colPairs.push({ col, r1: rows[0], r2: rows[1] });
    }

    for (let i = 0; i < colPairs.length; i += 1) {
      for (let j = i + 1; j < colPairs.length; j += 1) {
        const a = colPairs[i];
        const b = colPairs[j];
        if (a.r1 !== b.r1 || a.r2 !== b.r2) continue;
        const reason = `X-Wing: 数字 ${value} が C${a.col + 1}/C${b.col + 1} と R${a.r1 + 1}/R${a.r2 + 1} で長方形を形成`;
        for (let col = 0; col < 9; col += 1) {
          if (col === a.col || col === b.col) continue;
          if (board[a.r1][col] === 0) eliminate(a.r1, col, value, reason);
          if (board[a.r2][col] === 0) eliminate(a.r2, col, value, reason);
        }
      }
    }
  }

  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      if (board[r][c] !== 0) continue;
      const before = candidateGrid[r][c] || [];
      const after = work[r][c] || [];
      if (before.length > 1 && after.length === 1) {
        const reasonHead = reasons[r][c] ? `${reasons[r][c]} により` : "X-Wing により";
        return {
          row: r,
          col: c,
          value: after[0],
          technique: "X-Wing",
          reason: `${reasonHead} R${r + 1}C${c + 1} の候補が ${JSON.stringify(before)} -> ${JSON.stringify(after)} となったため、${after[0]} を入れます。`,
        };
      }
    }
  }

  return null;
}

function findXYWingDerivedSingle(board, candidateGrid) {
  const work = candidateGrid.map((row) => row.map((cand) => (cand ? cand.slice() : null)));
  const reasons = Array.from({ length: 9 }, () => Array(9).fill(""));

  function eliminate(row, col, value, reason) {
    const cand = work[row][col];
    if (!cand || !cand.includes(value)) return;
    work[row][col] = cand.filter((v) => v !== value);
    if (!reasons[row][col]) reasons[row][col] = reason;
  }

  function peersWithPivot(row, col) {
    const result = [];
    for (let r = 0; r < 9; r += 1) {
      for (let c = 0; c < 9; c += 1) {
        if (board[r][c] !== 0) continue;
        if (!isPeerCell(row, col, r, c)) continue;
        result.push({ row: r, col: c, cand: work[r][c] || [] });
      }
    }
    return result;
  }

  for (let pr = 0; pr < 9; pr += 1) {
    for (let pc = 0; pc < 9; pc += 1) {
      if (board[pr][pc] !== 0) continue;
      const pivot = work[pr][pc] || [];
      if (pivot.length !== 2) continue;
      const x = pivot[0];
      const y = pivot[1];
      const peers = peersWithPivot(pr, pc);

      const wingX = peers.filter((p) => p.cand.length === 2 && p.cand.includes(x) && !p.cand.includes(y));
      const wingY = peers.filter((p) => p.cand.length === 2 && p.cand.includes(y) && !p.cand.includes(x));

      for (const a of wingX) {
        const z = a.cand.find((v) => v !== x);
        if (!z || z === y) continue;
        for (const b of wingY) {
          if (a.row === b.row && a.col === b.col) continue;
          if (!b.cand.includes(z)) continue;

          const reason = `XY-Wing: Pivot R${pr + 1}C${pc + 1}=[${pivot.join(",")}], Wing R${a.row + 1}C${a.col + 1}=[${a.cand.join(",")}], R${b.row + 1}C${b.col + 1}=[${b.cand.join(",")}]`;
          for (let r = 0; r < 9; r += 1) {
            for (let c = 0; c < 9; c += 1) {
              if (board[r][c] !== 0) continue;
              if ((r === pr && c === pc) || (r === a.row && c === a.col) || (r === b.row && c === b.col)) continue;
              if (!isPeerCell(a.row, a.col, r, c)) continue;
              if (!isPeerCell(b.row, b.col, r, c)) continue;
              eliminate(r, c, z, reason);
            }
          }
        }
      }
    }
  }

  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      if (board[r][c] !== 0) continue;
      const before = candidateGrid[r][c] || [];
      const after = work[r][c] || [];
      if (before.length > 1 && after.length === 1) {
        const reasonHead = reasons[r][c] ? `${reasons[r][c]} により` : "XY-Wing により";
        return {
          row: r,
          col: c,
          value: after[0],
          technique: "XY-Wing",
          reason: `${reasonHead} R${r + 1}C${c + 1} の候補が ${JSON.stringify(before)} -> ${JSON.stringify(after)} となったため、${after[0]} を入れます。`,
        };
      }
    }
  }

  return null;
}

function solveWithSteps(inputBoard) {
  const board = cloneBoard(inputBoard);
  const stepLog = [];

  while (true) {
    const state = buildCandidateGrid(board);
    if (state.contradiction) {
      return { ok: false, steps: stepLog, solution: null, stalled: false, contradiction: state.contradiction };
    }
    if (state.unresolved === 0) {
      return { ok: true, steps: stepLog, solution: board, stalled: false };
    }

    const move = findNakedSingleMove(board, state.grid)
      || findHiddenSingleMove(board, state.grid)
      || findLockedCandidatesDerivedSingle(board, state.grid)
      || findNakedPairDerivedSingle(board, state.grid)
      || findXWingDerivedSingle(board, state.grid)
      || findXYWingDerivedSingle(board, state.grid);

    if (!move) {
      const best = findBestEmptyByGrid(board, state.grid);
      return { ok: false, steps: stepLog, solution: null, stalled: true, stalledCell: best };
    }

    board[move.row][move.col] = move.value;
    stepLog.push(move);
  }
}

function executeSolveFromInitial() {
  const result = solveWithSteps(initialBoard);
  if (!result.ok) {
    if (result.stalled && result.stalledCell) {
      clearDebugLog(`論理テクニックでは進めません。最小候補セル: R${result.stalledCell.row + 1}C${result.stalledCell.col + 1} ${JSON.stringify(result.stalledCell.cand)}`);
      setStatus("論理テクニックで進行停止しました。推測手は実行しません。");
    } else {
      clearDebugLog("この盤面は解けません。");
      setStatus("矛盾があるため解けません。");
    }
    solvedBoard = null;
    steps = [];
    stepIndex = -1;
    navHighlightCell = null;
    return false;
  }

  steps = result.steps;
  solvedBoard = result.solution;
  stepIndex = steps.length - 1;
  navHighlightCell = null;
  currentBoard = cloneBoard(solvedBoard);
  renderBoard();
  renderLog();
  setStatus("画像読込と解法計算が完了しました。回答を表示しています。");
  clearDebugLog("回答を表示しました。戻る/進むで手順を確認できます。");
  return true;
}

function waitCvReady(timeoutMs = 15000) {
  if (cvReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (cvReady) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("OpenCV.js の初期化がタイムアウトしました"));
      }
    }, 100);
  });
}

function orderCorners(pts) {
  const sums = pts.map((p) => p.x + p.y);
  const diffs = pts.map((p) => p.y - p.x);
  const tl = pts[sums.indexOf(Math.min(...sums))];
  const br = pts[sums.indexOf(Math.max(...sums))];
  const tr = pts[diffs.indexOf(Math.min(...diffs))];
  const bl = pts[diffs.indexOf(Math.max(...diffs))];
  return [tl, tr, br, bl];
}

function matToCanvas(mat, canvas) {
  cv.imshow(canvas, mat);
}

function ensureDigitTemplates() {
  if (digitTemplateVectors) return digitTemplateVectors;

  const size = 64;
  digitTemplateVectors = new Map();
  for (let d = 1; d <= 9; d += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "black";
    ctx.font = "bold 54px Segoe UI";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(d), size / 2, size / 2 + 2);

    const data = ctx.getImageData(0, 0, size, size).data;
    const vec = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i += 1) {
      vec[i] = data[i * 4] < 180 ? 1 : 0;
    }
    digitTemplateVectors.set(d, vec);
  }
  return digitTemplateVectors;
}

function makeDigitBinary(cellScaled) {
  const margin = Math.floor(cellScaled.cols * 0.14);
  const w = cellScaled.cols - margin * 2;
  const h = cellScaled.rows - margin * 2;
  const src = (w > 0 && h > 0)
    ? cellScaled.roi(new cv.Rect(margin, margin, w, h))
    : cellScaled;

  const blur = new cv.Mat();
  const bin = new cv.Mat();
  cv.GaussianBlur(src, blur, new cv.Size(3, 3), 0);
  cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
  blur.delete();
  if (src !== cellScaled) src.delete();
  return bin;
}

function countDigitHoles(bin) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);
    if (contours.size() === 0 || hierarchy.rows === 0) return 0;

    let holes = 0;
    for (let i = 0; i < contours.size(); i += 1) {
      const area = cv.contourArea(contours.get(i));
      const child = hierarchy.intPtr(0, i)[2];
      if (child >= 0) {
        for (let k = child; k >= 0; k = hierarchy.intPtr(0, k)[0]) {
          const holeArea = cv.contourArea(contours.get(k));
          if (holeArea > area * 0.03) holes += 1;
        }
      }
    }
    return holes;
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

function extractHoleMetrics(bin) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);
    if (contours.size() === 0 || hierarchy.rows === 0) {
      return { holeCount: 0, holeCentroidY: 0.5 };
    }

    let holeCount = 0;
    let largestHoleArea = 0;
    let largestHoleCy = 0.5;
    const rows = bin.rows || 1;

    for (let i = 0; i < contours.size(); i += 1) {
      const parent = hierarchy.intPtr(0, i)[3];
      if (parent < 0) continue;
      const holeArea = cv.contourArea(contours.get(i));
      if (holeArea <= 4) continue;
      holeCount += 1;
      if (holeArea > largestHoleArea) {
        const m = cv.moments(contours.get(i), false);
        const cy = m.m00 !== 0 ? (m.m01 / m.m00) / rows : 0.5;
        largestHoleArea = holeArea;
        largestHoleCy = cy;
      }
    }

    return {
      holeCount,
      holeCentroidY: largestHoleCy,
    };
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

function averageBandWidth(maskRoi, startRow, endRow) {
  const h = maskRoi.rows;
  const w = maskRoi.cols;
  const s = Math.max(0, Math.min(h - 1, startRow));
  const e = Math.max(0, Math.min(h - 1, endRow));
  if (e < s) return 0;

  let widthSum = 0;
  let widthCount = 0;
  for (let y = s; y <= e; y += 1) {
    let minX = w;
    let maxX = -1;
    for (let x = 0; x < w; x += 1) {
      if (maskRoi.ucharPtr(y, x)[0] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    if (maxX >= minX) {
      widthSum += (maxX - minX + 1);
      widthCount += 1;
    }
  }
  return widthCount ? widthSum / widthCount : 0;
}

function extractMainContourMetrics(bin) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const mask = new cv.Mat.zeros(bin.rows, bin.cols, cv.CV_8UC1);
  let maskRoi = null;
  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    if (contours.size() === 0) {
      return {
        loopTipDirection: "neutral",
        bottomTopWidthRatio: 1,
        contourAspect: 0.6,
      };
    }

    let bestIdx = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i += 1) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area > bestArea) {
        bestArea = area;
        bestIdx = i;
      }
      cnt.delete();
    }
    if (bestIdx < 0) {
      return {
        loopTipDirection: "neutral",
        bottomTopWidthRatio: 1,
        contourAspect: 0.6,
      };
    }

    cv.drawContours(mask, contours, bestIdx, new cv.Scalar(255), cv.FILLED);
    const rect = cv.boundingRect(contours.get(bestIdx));
    if (rect.width <= 0 || rect.height <= 0) {
      return {
        loopTipDirection: "neutral",
        bottomTopWidthRatio: 1,
        contourAspect: 0.6,
      };
    }

    maskRoi = mask.roi(rect);
    const bandRows = Math.max(2, Math.floor(rect.height * 0.2));
    const topWidth = averageBandWidth(maskRoi, 0, bandRows - 1);
    const bottomWidth = averageBandWidth(maskRoi, rect.height - bandRows, rect.height - 1);
    const bottomTopWidthRatio = topWidth > 0 ? (bottomWidth / topWidth) : 1;

    const touchBand = Math.max(2, Math.floor(rect.height * 0.08));
    const topBandMat = maskRoi.rowRange(0, touchBand);
    const bottomBandMat = maskRoi.rowRange(rect.height - touchBand, rect.height);
    const topTouch = cv.countNonZero(topBandMat);
    const bottomTouch = cv.countNonZero(bottomBandMat);
    topBandMat.delete();
    bottomBandMat.delete();
    let loopTipDirection = "neutral";
    if (topTouch > bottomTouch * 1.15) loopTipDirection = "top";
    else if (bottomTouch > topTouch * 1.15) loopTipDirection = "bottom";

    return {
      loopTipDirection,
      bottomTopWidthRatio,
      contourAspect: rect.height > 0 ? (rect.width / rect.height) : 0.6,
    };
  } finally {
    if (maskRoi) maskRoi.delete();
    mask.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function extractDigitFeatures(cellScaled) {
  const bin = makeDigitBinary(cellScaled);
  const upper = new cv.Mat();
  const lower = new cv.Mat();
  const left = new cv.Mat();
  const right = new cv.Mat();

  try {
    const totalInk = cv.countNonZero(bin);
    if (!totalInk) {
      return {
        holeCount: 0,
        holeCentroidY: 0.5,
        centroidY: 0.5,
        lowerRatio: 0.5,
        leftRatio: 0.5,
      };
    }

    const rows = bin.rows;
    const cols = bin.cols;
    const halfRow = Math.floor(rows / 2);
    const halfCol = Math.floor(cols / 2);

    const upperRoi = bin.roi(new cv.Rect(0, 0, cols, halfRow));
    const lowerRoi = bin.roi(new cv.Rect(0, halfRow, cols, rows - halfRow));
    const leftRoi = bin.roi(new cv.Rect(0, 0, halfCol, rows));
    const rightRoi = bin.roi(new cv.Rect(halfCol, 0, cols - halfCol, rows));
    upperRoi.copyTo(upper);
    lowerRoi.copyTo(lower);
    leftRoi.copyTo(left);
    rightRoi.copyTo(right);
    upperRoi.delete();
    lowerRoi.delete();
    leftRoi.delete();
    rightRoi.delete();

    const lowerInk = cv.countNonZero(lower);
    const leftInk = cv.countNonZero(left);
    const moments = cv.moments(bin, true);
    const centroidY = moments.m00 !== 0 ? (moments.m01 / moments.m00) / rows : 0.5;
    const centroidX = moments.m00 !== 0 ? (moments.m10 / moments.m00) / cols : 0.5;
    const holeMetrics = extractHoleMetrics(bin);
    const contourMetrics = extractMainContourMetrics(bin);

    return {
      holeCount: holeMetrics.holeCount,
      holeCentroidY: holeMetrics.holeCentroidY,
      centroidY,
      centroidX,
      lowerRatio: lowerInk / totalInk,
      leftRatio: leftInk / totalInk,
      loopTipDirection: contourMetrics.loopTipDirection,
      bottomTopWidthRatio: contourMetrics.bottomTopWidthRatio,
      contourAspect: contourMetrics.contourAspect,
    };
  } finally {
    bin.delete();
    upper.delete();
    lower.delete();
    left.delete();
    right.delete();
  }
}

function refineAmbiguousDigit(rawDigit, features) {
  if (!rawDigit || !features) return rawDigit;

  // 6 vs 9: one-hole digits refined by tip direction and top/bottom width ratio.
  if (rawDigit === 6 || rawDigit === 9) {
    if (features.holeCount >= 2) return 8;
    if (features.holeCount === 0) return 2;

    if (features.holeCentroidY <= 0.47) return 9;
    if (features.holeCentroidY >= 0.53) return 6;

    if (rawDigit === 6 && features.loopTipDirection === "bottom" && features.bottomTopWidthRatio < 0.98 && features.centroidY < 0.52) {
      return 9;
    }
    if (rawDigit === 9 && (features.lowerRatio > 0.54 || features.bottomTopWidthRatio > 1.03) && features.loopTipDirection !== "bottom") {
      return 6;
    }

    let score6 = 0;
    let score9 = 0;
    if (features.loopTipDirection === "top") score6 += 2;
    if (features.loopTipDirection === "bottom") score9 += 2;
    if (features.bottomTopWidthRatio > 1.12) score6 += 1;
    if (features.bottomTopWidthRatio < 0.9) score9 += 1;
    if (features.lowerRatio > 0.56) score6 += 1;
    else score9 += 1;
    if (features.centroidY > 0.53) score6 += 1;
    else score9 += 1;
    return score6 >= score9 ? 6 : 9;
  }

  // 2 vs 9 fallback for OCR ambiguity.
  if (rawDigit === 2) {
    if (features.holeCount >= 2) return 8;
    if (features.holeCount === 1) {
      return features.lowerRatio > 0.56 || features.centroidY > 0.53 ? 6 : 9;
    }
    return 2;
  }

  // 3 vs 5: both no-hole often; 3 is right-heavy, 5 has more left/upper mass.
  if (rawDigit === 3 || rawDigit === 5) {
    if (features.holeCount >= 1) return 9;
    if (rawDigit === 5 && features.leftRatio < 0.40) return 3;
    if (rawDigit === 5 && features.leftRatio < 0.41 && features.centroidX > 0.52) return 3;
    if (rawDigit === 5 && features.contourAspect < 0.62 && features.centroidX > 0.50 && features.lowerRatio < 0.63) return 3;
    if (features.leftRatio < 0.38 && features.centroidX > 0.50) return 3;
    if (features.leftRatio < 0.35 && features.lowerRatio < 0.60) return 3;
    return 5;
  }

  // 1 vs 3: 1 is usually slender and centered; 3 is right-heavy.
  if (rawDigit === 1 || rawDigit === 3) {
    if (features.holeCount >= 1) return 9;
    if (rawDigit === 1 && features.contourAspect < 0.56 && features.leftRatio > 0.26) {
      return 1;
    }
    if (features.contourAspect < 0.34) {
      return 1;
    }
    if (rawDigit === 3 && features.contourAspect < 0.50 && features.leftRatio > 0.38 && features.centroidX < 0.54) {
      return 1;
    }
    if (features.contourAspect < 0.42 && features.leftRatio > 0.34 && features.leftRatio < 0.62) {
      return 1;
    }
    if (features.leftRatio < 0.33 || features.centroidX > 0.56) {
      return 3;
    }
    return rawDigit;
  }

  // 4 vs 7: 7 is top-heavy and right-leaning, 4 keeps more lower/left structure.
  if (rawDigit === 4 || rawDigit === 7) {
    const topRatio = 1 - features.lowerRatio;
    if (rawDigit === 4 && features.centroidY < 0.47 && features.lowerRatio < 0.46) return 7;
    if (topRatio > 0.56 && features.leftRatio < 0.34) return 7;
    if (features.lowerRatio > 0.48 && features.leftRatio >= 0.34) return 4;
    return rawDigit;
  }

  return rawDigit;
}

function pickDigitFromAttemptsByCandidates(attempts, candidates) {
  if (!Array.isArray(attempts) || attempts.length === 0) return 0;
  let bestDigit = 0;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = scoreDigitFromAttempts(attempts, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestDigit = candidate;
    }
  }
  return bestScore > 0 ? bestDigit : 0;
}

function routeByHoleBuckets(rawDigit, features, attempts = []) {
  if (!rawDigit || !features) return rawDigit;

  // Bucket-1: two holes -> 8 family.
  if (features.holeCount >= 2) {
    return 8;
  }

  // Bucket-2: one hole -> 4/6/9 family.
  if (features.holeCount === 1) {
    const oneHoleGroup = [4, 6, 9];
    let digit = rawDigit;
    if (!oneHoleGroup.includes(digit)) {
      const fromAttempts = pickDigitFromAttemptsByCandidates(attempts, oneHoleGroup);
      if (fromAttempts) {
        digit = fromAttempts;
      } else if (features.holeCentroidY >= 0.54 || features.lowerRatio > 0.56) {
        digit = 6;
      } else if (features.contourAspect < 0.62 && features.leftRatio > 0.42) {
        digit = 4;
      } else {
        digit = 9;
      }
    }

    // 6 vs 9 refinement inside one-hole bucket.
    if (digit === 6 || digit === 9) {
      const score6 = scoreDigitFromAttempts(attempts, 6);
      const score9 = scoreDigitFromAttempts(attempts, 9);
      const sixByShape = features.holeCentroidY >= 0.50
        || features.lowerRatio >= 0.54
        || features.bottomTopWidthRatio >= 0.98;
      const nineByShape = features.holeCentroidY <= 0.46
        || features.lowerRatio <= 0.50
        || features.bottomTopWidthRatio <= 0.92;

      if (digit === 9 && sixByShape && score6 >= score9 * 0.88) return 6;
      if (digit === 6 && nineByShape && score9 >= score6 * 0.92) return 9;
      if (digit === 9 && sixByShape && score9 === 0) return 6;
      if (digit === 6 && nineByShape && score6 === 0) return 9;
    }
    return digit;
  }

  // Bucket-3: no hole -> 1/2/3/5/7 family.
  const noHoleGroup = [1, 2, 3, 5, 7];
  let digit = rawDigit;
  if (!noHoleGroup.includes(digit)) {
    const fromAttempts = pickDigitFromAttemptsByCandidates(attempts, noHoleGroup);
    if (fromAttempts) {
      digit = fromAttempts;
    } else if (features.contourAspect < 0.40) {
      digit = 1;
    } else if (features.lowerRatio < 0.46 && features.leftRatio < 0.34) {
      digit = 7;
    } else if (features.leftRatio < 0.45 && features.centroidX > 0.50) {
      digit = 3;
    } else if (features.centroidX < 0.48 && features.leftRatio > 0.52) {
      digit = 5;
    } else {
      digit = 2;
    }
  }

  // 2 vs 7 refinement inside no-hole bucket.
  if (digit === 2 || digit === 7) {
    const score2 = scoreDigitFromAttempts(attempts, 2);
    const score7 = scoreDigitFromAttempts(attempts, 7);
    const twoByShape = features.lowerRatio >= 0.48
      && features.leftRatio >= 0.36
      && features.contourAspect >= 0.44;
    const sevenByShape = features.lowerRatio <= 0.45
      && features.leftRatio <= 0.40
      && features.contourAspect <= 0.62;
    const strongTwoByShape = features.lowerRatio >= 0.55
      && features.leftRatio >= 0.43
      && features.contourAspect >= 0.50;
    const strongSevenByShape = features.lowerRatio <= 0.42
      && features.leftRatio <= 0.34
      && features.contourAspect <= 0.58;

    if (digit === 7 && (score2 > score7 * 1.15) && (twoByShape || strongTwoByShape)) return 2;
    if (digit === 2 && (score7 > score2 * 1.20) && (sevenByShape || strongSevenByShape)) return 7;

    if (digit === 7 && score2 === 0 && score7 === 0 && strongTwoByShape) return 2;
    if (digit === 2 && score2 === 0 && score7 === 0 && strongSevenByShape) return 7;
  }

  return digit;
}

function resolveDigitWithRules(cellScaled, digit, wasForced, attempts = []) {
  if (!digit) return digit;
  const features = extractDigitFeatures(cellScaled);
  return routeByHoleBuckets(digit, features, attempts);
}

function pickBestAttempt(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return { digit: 0, confidence: -1 };
  }
  return attempts.reduce((acc, attempt) => {
    if (!attempt || !attempt.digit) return acc;
    if (attempt.confidence > acc.confidence) return attempt;
    return acc;
  }, { digit: 0, confidence: -1 });
}

function pickVotedDigit(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return { digit: 0, topScore: 0, secondScore: 0 };
  }

  const scores = Array(10).fill(0);
  for (const attempt of attempts) {
    if (!attempt || !attempt.digit) continue;
    const d = attempt.digit;
    if (!Number.isInteger(d) || d < 1 || d > 9) continue;
    const conf = Number.isFinite(attempt.confidence) ? attempt.confidence : 0;
    scores[d] += Math.max(0, conf) + 1;
  }

  let bestDigit = 0;
  let topScore = 0;
  let secondScore = 0;
  for (let d = 1; d <= 9; d += 1) {
    const s = scores[d];
    if (s > topScore) {
      secondScore = topScore;
      topScore = s;
      bestDigit = d;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }

  return { digit: bestDigit, topScore, secondScore };
}

function scoreDigitFromAttempts(attempts, targetDigit) {
  if (!Array.isArray(attempts) || !Number.isInteger(targetDigit)) return 0;
  let score = 0;
  for (const attempt of attempts) {
    if (!attempt || attempt.digit !== targetDigit) continue;
    const conf = Number.isFinite(attempt.confidence) ? attempt.confidence : 0;
    score += Math.max(0, conf) + 1;
  }
  return score;
}

async function resolveNoHoleCurveAmbiguity(cellScaled, currentDigit, baseAttempts = [], wasForced = false) {
  if (currentDigit !== 5 && currentDigit !== 3) return currentDigit;

  const features = extractDigitFeatures(cellScaled);
  if (features.holeCount !== 0) return currentDigit;

  // Generic 3/5 re-check for no-hole curved digits (final stage).
  const focused = await recognizeDigitFromVariants(cellScaled, 0, true, "35", [10, 13]);
  const mergedAttempts = [...baseAttempts, ...(focused.attempts || [])];
  const focusedAltPsm = await recognizeDigitFromVariants(cellScaled, 0, true, "35", [6, 7, 8]);
  mergedAttempts.push(...(focusedAltPsm.attempts || []));
  const tight = findDigitRoi(cellScaled);
  if (tight) {
    const focusedTight = await recognizeDigitFromVariants(tight, 0, true, "35", [10, 13]);
    const focusedTightAlt = await recognizeDigitFromVariants(tight, 0, true, "35", [6, 7, 8]);
    mergedAttempts.push(...(focusedTight.attempts || []));
    mergedAttempts.push(...(focusedTightAlt.attempts || []));
    tight.delete();
  }
  const score3 = scoreDigitFromAttempts(mergedAttempts, 3);
  const score5 = scoreDigitFromAttempts(mergedAttempts, 5);
  const templateDigit = estimateDigitByTemplate(cellScaled);

  const shapeLooksLike3 = features.leftRatio < 0.50
    || features.centroidX > 0.49
    || features.contourAspect < 0.72;
  const shapeLooksLike5 = features.leftRatio > 0.52
    && features.centroidX < 0.51
    && features.lowerRatio > 0.55;

  if (currentDigit === 5 && wasForced && templateDigit === 3 && score3 >= score5 * 0.82) {
    return 3;
  }

  if (shapeLooksLike3 && score3 >= score5 * (wasForced ? 0.95 : 1.18)) {
    return 3;
  }
  if (shapeLooksLike5 && score5 > score3 * 1.12) {
    return 5;
  }

  // Conservative fallback for forced decisions likely to be 3.
  if (currentDigit === 5 && shapeLooksLike3 && wasForced && score3 >= score5 * 0.90) {
    return 3;
  }

  // Weak-evidence fallback: when OCR gives little 3/5 signal, use shape bias.
  if (currentDigit === 5 && wasForced) {
    const weakEvidence = (score3 + score5) < 12;
    const likely3ByShape = features.leftRatio < 0.52
      && features.centroidX > 0.46
      && features.contourAspect < 0.78;
    const likely3BySymmetry = features.bottomTopWidthRatio > 0.92
      && features.bottomTopWidthRatio < 1.20
      && features.leftRatio < 0.58;
    if (weakEvidence && likely3ByShape) {
      return 3;
    }
    if ((weakEvidence || score3 >= score5 * 0.88) && likely3BySymmetry) {
      return 3;
    }
  }
  return currentDigit;
}

async function resolveEightNineAmbiguity(cellScaled, currentDigit, baseAttempts = [], wasForced = false) {
  if (currentDigit !== 8 && currentDigit !== 9) return currentDigit;

  const features = extractDigitFeatures(cellScaled);
  if (features.holeCount >= 2) return 8;

  const focused = await recognizeDigitFromVariants(cellScaled, 0, true, "89", [10, 13]);
  const mergedAttempts = [...baseAttempts, ...(focused.attempts || [])];
  const tight = findDigitRoi(cellScaled);
  if (tight) {
    const focusedTight = await recognizeDigitFromVariants(tight, 0, true, "89", [10, 13]);
    mergedAttempts.push(...(focusedTight.attempts || []));
    tight.delete();
  }

  const score8 = scoreDigitFromAttempts(mergedAttempts, 8);
  const score9 = scoreDigitFromAttempts(mergedAttempts, 9);
  const templateDigit = estimateDigitByTemplate(cellScaled);

  const shapeLooksLike8 = Math.abs(features.lowerRatio - 0.5) <= 0.11
    && Math.abs(features.bottomTopWidthRatio - 1) <= 0.20
    && features.loopTipDirection === "neutral";
  const shapeLooksLike9 = features.holeCount === 1
    && features.holeCentroidY <= 0.48
    && features.lowerRatio < 0.53;

  if (currentDigit === 9 && templateDigit === 8 && score8 >= score9 * 0.78) {
    return 8;
  }
  if (shapeLooksLike8 && score8 >= score9 * 0.90) {
    return 8;
  }
  if (shapeLooksLike9 && score9 >= score8 * 0.88) {
    return 9;
  }

  if (wasForced && templateDigit === 8 && score8 >= score9 * 0.72) {
    return 8;
  }
  if (score8 > score9 * 1.20) return 8;
  if (score9 > score8 * 1.20) return 9;
  return currentDigit;
}

function extractTwoSevenRoiStrokeMetrics(cellScaled) {
  const bin = makeDigitBinary(cellScaled);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    if (contours.size() === 0) {
      return {
        topHorizontalScore: 0.5,
        topSpanRatio: 0.5,
        bottomHorizontalScore: 0.5,
        bottomSpanRatio: 0.5,
      };
    }

    let bestIdx = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i += 1) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area > bestArea) {
        bestArea = area;
        bestIdx = i;
      }
      cnt.delete();
    }
    if (bestIdx < 0) {
      return {
        topHorizontalScore: 0.5,
        topSpanRatio: 0.5,
        bottomHorizontalScore: 0.5,
        bottomSpanRatio: 0.5,
      };
    }

    const rect = cv.boundingRect(contours.get(bestIdx));
    if (rect.width <= 2 || rect.height <= 2) {
      return {
        topHorizontalScore: 0.5,
        topSpanRatio: 0.5,
        bottomHorizontalScore: 0.5,
        bottomSpanRatio: 0.5,
      };
    }

    const roi = bin.roi(rect);
    const bandRows = Math.max(2, Math.floor(roi.rows * 0.22));

    let bandMinX = roi.cols;
    let bandMaxX = -1;
    let longestRun = 0;

    let bottomBandMinX = roi.cols;
    let bottomBandMaxX = -1;
    let bottomLongestRun = 0;

    for (let y = 0; y < bandRows; y += 1) {
      let rowRun = 0;
      let rowLongest = 0;
      for (let x = 0; x < roi.cols; x += 1) {
        if (roi.ucharPtr(y, x)[0] > 0) {
          rowRun += 1;
          if (rowRun > rowLongest) rowLongest = rowRun;
          if (x < bandMinX) bandMinX = x;
          if (x > bandMaxX) bandMaxX = x;
        } else {
          rowRun = 0;
        }
      }
      if (rowLongest > longestRun) longestRun = rowLongest;
    }

    for (let y = roi.rows - bandRows; y < roi.rows; y += 1) {
      let rowRun = 0;
      let rowLongest = 0;
      for (let x = 0; x < roi.cols; x += 1) {
        if (roi.ucharPtr(y, x)[0] > 0) {
          rowRun += 1;
          if (rowRun > rowLongest) rowLongest = rowRun;
          if (x < bottomBandMinX) bottomBandMinX = x;
          if (x > bottomBandMaxX) bottomBandMaxX = x;
        } else {
          rowRun = 0;
        }
      }
      if (rowLongest > bottomLongestRun) bottomLongestRun = rowLongest;
    }

    roi.delete();

    const topSpanRatio = bandMaxX >= bandMinX
      ? (bandMaxX - bandMinX + 1) / rect.width
      : 0;
    const topLongestRunRatio = longestRun / rect.width;
    const topHorizontalScore = topLongestRunRatio * 0.65 + topSpanRatio * 0.35;

    const bottomSpanRatio = bottomBandMaxX >= bottomBandMinX
      ? (bottomBandMaxX - bottomBandMinX + 1) / rect.width
      : 0;
    const bottomLongestRunRatio = bottomLongestRun / rect.width;
    const bottomHorizontalScore = bottomLongestRunRatio * 0.65 + bottomSpanRatio * 0.35;

    return {
      topHorizontalScore,
      topSpanRatio,
      bottomHorizontalScore,
      bottomSpanRatio,
    };
  } finally {
    bin.delete();
    contours.delete();
    hierarchy.delete();
  }
}

async function resolveTwoSevenAmbiguityFinal(cellScaled, currentDigit, baseAttempts = [], wasForced = false) {
  if (currentDigit !== 2 && currentDigit !== 7) return currentDigit;

  const features = extractDigitFeatures(cellScaled);
  if (features.holeCount !== 0) return currentDigit;

  const focused = await recognizeDigitFromVariants(cellScaled, 0, true, "27", [10, 13, 6]);
  const mergedAttempts = [...baseAttempts, ...(focused.attempts || [])];
  const tight = findDigitRoi(cellScaled);
  if (tight) {
    const focusedTight = await recognizeDigitFromVariants(tight, 0, true, "27", [10, 13]);
    mergedAttempts.push(...(focusedTight.attempts || []));
    tight.delete();
  }

  const score2 = scoreDigitFromAttempts(mergedAttempts, 2);
  const score7 = scoreDigitFromAttempts(mergedAttempts, 7);
  const strokeMetrics = extractTwoSevenRoiStrokeMetrics(cellScaled);

  // 7 tends to have wider top and narrower bottom; 2 tends to keep wider lower body.
  const ratio = features.bottomTopWidthRatio;
  const sevenByWidth = ratio <= 0.86;
  const sevenByWidthStrong = ratio <= 0.78;
  const twoByWidth = ratio >= 0.93;
  const sevenByWidthAndLower = ratio <= 0.84 && features.lowerRatio <= 0.46;
  const twoByWidthAndLeft = ratio >= 0.94 && features.leftRatio >= 0.40;
  const sevenByTopStroke = strokeMetrics.topHorizontalScore >= 0.79
    && strokeMetrics.topSpanRatio >= 0.78
    && features.lowerRatio <= 0.44;
  const twoByTopStroke = strokeMetrics.topHorizontalScore <= 0.62 && strokeMetrics.topSpanRatio <= 0.64;
  const twoByBottomStroke = strokeMetrics.bottomHorizontalScore >= 0.76
    && strokeMetrics.bottomSpanRatio >= 0.72
    && ratio >= 0.90;

  // Width-only strong bias: if bottom is much narrower than top, prioritize 7.
  if (currentDigit === 2 && sevenByWidthStrong) return 7;
  if (currentDigit === 7 && twoByBottomStroke) return 2;
  if (currentDigit === 7 && twoByTopStroke && ratio >= 0.95) return 2;

  if (currentDigit === 2 && (sevenByWidthAndLower || sevenByWidth || sevenByTopStroke) && score7 >= score2 * 0.90) return 7;
  if (currentDigit === 7 && (twoByBottomStroke || twoByWidthAndLeft || twoByWidth || twoByTopStroke) && score2 >= score7 * 0.88) return 2;

  // Weak-evidence fallback uses width-first bias.
  if (score2 === 0 && score7 === 0) {
    if (sevenByTopStroke || sevenByWidthAndLower || sevenByWidth) return 7;
    if (twoByBottomStroke || twoByTopStroke || twoByWidthAndLeft || twoByWidth) return 2;
  }

  // For forced digits, allow slightly looser switch thresholds.
  if (wasForced) {
    if (currentDigit === 2 && (sevenByTopStroke || sevenByWidthAndLower || sevenByWidth) && score7 >= score2 * 0.82) return 7;
    if (currentDigit === 7 && (twoByBottomStroke || twoByTopStroke || twoByWidthAndLeft || twoByWidth) && score2 >= score7 * 0.80) return 2;
  }

  return currentDigit;
}

function pickByTemplateSet(sampleVec, candidates) {
  let bestDigit = candidates[0] || 8;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const d of candidates) {
    const tpl = digitTemplateVectors.get(d);
    let diff = 0;
    for (let i = 0; i < sampleVec.length; i += 1) {
      if (sampleVec[i] !== tpl[i]) diff += 1;
    }
    if (diff < bestScore) {
      bestScore = diff;
      bestDigit = d;
    }
  }
  return bestDigit;
}

function estimateDigitByTemplate(cellScaled) {
  ensureDigitTemplates();

  const bin = makeDigitBinary(cellScaled);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const sample = new cv.Mat();
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 64;
  sampleCanvas.height = 64;

  try {
    const holeCount = countDigitHoles(bin);
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    if (contours.size() === 0) return 8;

    let bestIdx = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i += 1) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area > bestArea) {
        bestArea = area;
        bestIdx = i;
      }
      cnt.delete();
    }
    if (bestIdx < 0) return 8;

    const rect = cv.boundingRect(contours.get(bestIdx));
    const roi = bin.roi(rect);
    cv.resize(roi, sample, new cv.Size(44, 44), 0, 0, cv.INTER_AREA);
    roi.delete();

    const ctx = sampleCanvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 64, 64);

    const centered = new cv.Mat.zeros(64, 64, cv.CV_8UC1);
    const x = Math.floor((64 - 44) / 2);
    const y = Math.floor((64 - 44) / 2);
    const dstRoi = centered.roi(new cv.Rect(x, y, 44, 44));
    sample.copyTo(dstRoi);
    dstRoi.delete();

    cv.imshow(sampleCanvas, centered);
    const imgData = ctx.getImageData(0, 0, 64, 64).data;
    const sampleVec = new Uint8Array(64 * 64);
    for (let i = 0; i < 64 * 64; i += 1) {
      sampleVec[i] = imgData[i * 4] > 120 ? 1 : 0;
    }

    centered.delete();

    // Hole-aware candidate narrowing for ambiguous digits.
    // 8 tends to have two holes, 6/9 one hole, 2/5 zero holes.
    if (holeCount >= 2) {
      return 8;
    }
    if (holeCount === 1) {
      return pickByTemplateSet(sampleVec, [6, 9]);
    }

    // Very slender no-hole shape tends to be 1.
    if (rect.height > 0 && (rect.width / rect.height) < 0.42) {
      return 1;
    }

    const noHoleCandidate = pickByTemplateSet(sampleVec, [1, 2, 3, 5, 7]);
    const broadCandidate = pickByTemplateSet(sampleVec, [1, 2, 3, 4, 5, 7]);
    return noHoleCandidate === 1 || noHoleCandidate === 2 || noHoleCandidate === 3 || noHoleCandidate === 5 || noHoleCandidate === 7
      ? noHoleCandidate
      : broadCandidate;
  } catch (error) {
    return 8;
  } finally {
    bin.delete();
    contours.delete();
    hierarchy.delete();
    sample.delete();
  }
}

async function initOcrWorker() {
  if (ocrReady) return;
  appendDebugLog("OCR worker の初期化を開始します。");
  appendDebugLog(`workerPath=${resourceUrl("./worker.min.js")}`);
  appendDebugLog(`corePath=${resourceUrl("./")}`);
  appendDebugLog(`langPath=${resourceUrl("./")}`);
  appendDebugLog(`protocol=${window.location.protocol}`);
  setStatus("OCRエンジンを初期化しています...");

  const runningOnFileProtocol = window.location.protocol === "file:";
  const workerInitTimeoutMs = runningOnFileProtocol ? 180000 : 45000;
  const remoteLangPath = "https://tessdata.projectnaptha.com/4.0.0/";
  let workerPathToUse = resourceUrl("./worker.min.js");
  let langPathToUse = resourceUrl("./");
  if (runningOnFileProtocol) {
    workerBootstrapUrl = createFileProtocolWorkerBootstrap(); 
    workerPathToUse = workerBootstrapUrl;
    appendDebugLog("file:// 用に blob worker ブートストラップを作成しました。");
  }

  let workerOptions = buildWorkerOptions(workerPathToUse, langPathToUse);
  appendDebugLog(`workerPath(used)=${workerPathToUse}`);
  appendDebugLog(`langPath(used)=${langPathToUse}`);
  appendDebugLog(`workerBlobURL=${String(workerOptions.workerBlobURL)}`);
  appendDebugLog(`workerInitTimeoutMs=${workerInitTimeoutMs}`);

  try {
    ocrWorker = await withTimeout(
      Tesseract.createWorker("eng", 1, workerOptions),
      workerInitTimeoutMs,
      `OCR worker 作成がタイムアウトしました (${Math.round(workerInitTimeoutMs / 1000)}秒)。初回は辞書展開に時間がかかる場合があります。`,
    );
  } catch (error) {
    appendDebugLog(`OCR worker 作成失敗(ローカル辞書): ${error.message}`);

    // file:// 環境では local langPath が worker 側で参照不能な場合があるため、
    // 公開 tessdata へ1回だけフォールバックして継続する。
    if (runningOnFileProtocol) {
      appendDebugLog("オンライン辞書にフォールバックして再試行します。");
      setStatus("OCR辞書をオンラインから取得中です...");
      try {
        langPathToUse = remoteLangPath;
        workerOptions = buildWorkerOptions(workerPathToUse, langPathToUse);
        appendDebugLog(`langPath(used)=${langPathToUse}`);
        ocrWorker = await withTimeout(
          Tesseract.createWorker("eng", 1, workerOptions),
          workerInitTimeoutMs,
          `OCR worker 作成がタイムアウトしました (${Math.round(workerInitTimeoutMs / 1000)}秒)。オンライン辞書でも初期化できませんでした。`,
        );
      } catch (retryError) {
        appendDebugLog(`OCR worker 再試行失敗: ${retryError.message}`);
        if (workerBootstrapUrl) {
          URL.revokeObjectURL(workerBootstrapUrl);
          workerBootstrapUrl = null;
        }
        setStatus("OCRエンジンの初期化に失敗しました");
        throw retryError;
      }
    } else {
      if (workerBootstrapUrl) {
        URL.revokeObjectURL(workerBootstrapUrl);
        workerBootstrapUrl = null;
      }
      setStatus("OCRエンジンの初期化に失敗しました");
      throw error;
    }
  }

  appendDebugLog("Tesseract worker を作成しました。パラメータを設定します。");
  await withTimeout(ocrWorker.setParameters({
    tessedit_char_whitelist: "123456789",
    tessedit_pageseg_mode: "10",
    preserve_interword_spaces: "0",
    user_defined_dpi: "300",
    classify_bln_numeric_mode: "1",
    load_system_dawg: "0",
    load_freq_dawg: "0",
  }), 15000, "OCR パラメータ設定がタイムアウトしました (15秒)。");
  ocrReady = true;
  if (workerBootstrapUrl) {
    URL.revokeObjectURL(workerBootstrapUrl);
    workerBootstrapUrl = null;
  }
  appendDebugLog("OCR worker の初期化が完了しました。");
}

function createCanvasFromMat(mat) {
  const canvas = document.createElement("canvas");
  canvas.width = mat.cols;
  canvas.height = mat.rows;
  matToCanvas(mat, canvas);
  return canvas;
}

function makeCellVariantCanvases(cellScaled) {
  const variants = [];

  const margin = Math.floor(cellScaled.cols * 0.14);
  const w = cellScaled.cols - margin * 2;
  const h = cellScaled.rows - margin * 2;
  if (w <= 0 || h <= 0) {
    variants.push(createCanvasFromMat(cellScaled));
    return variants;
  }

  const inner = cellScaled.roi(new cv.Rect(margin, margin, w, h));
  const blur = new cv.Mat();
  const adaptiveInv = new cv.Mat();
  const adaptiveInvOpen = new cv.Mat();
  const otsuInv = new cv.Mat();
  const otsu = new cv.Mat();
  const otsuInvDilated = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
  const kernelThin = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 2));

  cv.GaussianBlur(inner, blur, new cv.Size(3, 3), 0);
  cv.adaptiveThreshold(blur, adaptiveInv, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);
  cv.morphologyEx(adaptiveInv, adaptiveInv, cv.MORPH_CLOSE, kernel);
  variants.push(createCanvasFromMat(adaptiveInv));

  cv.morphologyEx(adaptiveInv, adaptiveInvOpen, cv.MORPH_OPEN, kernelThin);
  variants.push(createCanvasFromMat(adaptiveInvOpen));

  cv.threshold(blur, otsuInv, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
  variants.push(createCanvasFromMat(otsuInv));

  cv.dilate(otsuInv, otsuInvDilated, kernelThin);
  variants.push(createCanvasFromMat(otsuInvDilated));

  cv.threshold(blur, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  variants.push(createCanvasFromMat(otsu));

  inner.delete();
  blur.delete();
  adaptiveInv.delete();
  adaptiveInvOpen.delete();
  otsuInv.delete();
  otsu.delete();
  otsuInvDilated.delete();
  kernel.delete();
  kernelThin.delete();

  return variants;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isLikelyBlankCell(grayMat) {
  const bin = new cv.Mat();
  try {
    cv.threshold(grayMat, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    const pixels = grayMat.rows * grayMat.cols;
    if (!pixels) return true;
    const inkRatio = cv.countNonZero(bin) / pixels;
    return inkRatio < 0.004 || inkRatio > 0.92;
  } finally {
    bin.delete();
  }
}

function hasDigitInk(grayMat) {
  const margin = Math.floor(grayMat.cols * 0.22);
  const w = grayMat.cols - margin * 2;
  const h = grayMat.rows - margin * 2;
  if (w <= 0 || h <= 0) return false;

  const inner = grayMat.roi(new cv.Rect(margin, margin, w, h));
  const bin = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.threshold(inner, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    const pixels = inner.rows * inner.cols;
    if (!pixels) return false;
    const inkRatio = cv.countNonZero(bin) / pixels;
    if (inkRatio < 0.0008 || inkRatio > 0.55) return false;
    if (inkRatio >= 0.0030) return true;

    // Weak-ink fallback: keep thin handwriting candidates.
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let bestArea = 0;
    let bestRect = null;
    for (let i = 0; i < contours.size(); i += 1) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area > bestArea) {
        bestArea = area;
        bestRect = cv.boundingRect(cnt);
      }
      cnt.delete();
    }
    if (!bestRect) return false;
    const areaRatio = bestArea / pixels;
    if (areaRatio < 0.0007) return false;
    if (bestRect.width < inner.cols * 0.02 || bestRect.height < inner.rows * 0.05) return false;
    return true;
  } finally {
    inner.delete();
    bin.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function findDigitRoi(cellScaled) {
  const innerMargin = Math.max(10, Math.floor(cellScaled.cols * 0.08));
  const innerWidth = cellScaled.cols - innerMargin * 2;
  const innerHeight = cellScaled.rows - innerMargin * 2;
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const innerRect = new cv.Rect(innerMargin, innerMargin, innerWidth, innerHeight);
  const inner = cellScaled.roi(innerRect);
  const blur = new cv.Mat();
  const binary = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.GaussianBlur(inner, blur, new cv.Size(3, 3), 0);
    cv.adaptiveThreshold(blur, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);

    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    if (contours.size() === 0) return null;

    let bestIdx = -1;
    let bestArea = 0;
    const minArea = inner.rows * inner.cols * 0.004;
    const maxArea = inner.rows * inner.cols * 0.65;

    for (let i = 0; i < contours.size(); i += 1) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area >= minArea && area <= maxArea && area > bestArea) {
        bestArea = area;
        bestIdx = i;
      }
      cnt.delete();
    }

    if (bestIdx < 0) return null;

    const rect = cv.boundingRect(contours.get(bestIdx));
    const pad = 8;
    const x = clamp(rect.x - pad, 0, inner.cols - 1);
    const y = clamp(rect.y - pad, 0, inner.rows - 1);
    const width = clamp(rect.width + pad * 2, 1, inner.cols - x);
    const height = clamp(rect.height + pad * 2, 1, inner.rows - y);

    if (width <= 0 || height <= 0) return null;
    if (width < 18 || height < 24) return null;

    const roi = inner.roi(new cv.Rect(x, y, width, height));
    const padded = new cv.Mat();
    cv.copyMakeBorder(roi, padded, 16, 16, 16, 16, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    roi.delete();
    return padded;
  } catch (error) {
    return null;
  } finally {
    blur.delete();
    binary.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
    inner.delete();
  }
}

async function recognizeDigitFromCanvas(canvas, whitelist = "123456789", psm = 10) {
  const { data } = await ocrWorker.recognize(canvas, {
    tessedit_pageseg_mode: psm,
    tessedit_char_whitelist: whitelist,
  });
  const overallConfidence = Number.isFinite(data && data.confidence ? data.confidence : NaN)
    ? data.confidence
    : 0;

  // Prefer symbol-level candidates because top-level text can become "0"
  // for rounded shapes even when 6/8/9 exists in symbol alternatives.
  const symbols = data && Array.isArray(data.symbols) ? data.symbols : [];
  let bestDigit = 0;
  let bestConfidence = -1;
  for (const symbol of symbols) {
    const ch = String(symbol && symbol.text ? symbol.text : "").trim();
    const digit = Number(ch);
    const conf = Number.isFinite(symbol && symbol.confidence ? symbol.confidence : NaN)
      ? symbol.confidence
      : overallConfidence;
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9 && conf > bestConfidence) {
      bestDigit = digit;
      bestConfidence = conf;
    }
  }

  if (bestDigit) {
    return { digit: bestDigit, confidence: bestConfidence };
  }

  const text = (data && data.text ? data.text : "").replace(/\D/g, "");
  if (!text) return { digit: 0, confidence: overallConfidence };
  const d = Number(text[0]);
  return {
    digit: Number.isInteger(d) && d >= 1 && d <= 9 ? d : 0,
    confidence: overallConfidence,
  };
}

async function recognizeDigitFromVariants(cellScaled, confidenceThreshold, allowRoundedSingle = false, whitelist = "123456789", psmList = [10]) {
  const canvases = makeCellVariantCanvases(cellScaled);
  const attempts = [];
  let bestDigit = 0;
  let bestConfidence = -1;

  for (const canvas of canvases) {
    for (const psm of psmList) {
      const { digit, confidence } = await recognizeDigitFromCanvas(canvas, whitelist, psm);
      attempts.push({ digit, confidence, psm, whitelist });
      if (digit && confidence >= confidenceThreshold && confidence > bestConfidence) {
        bestDigit = digit;
        bestConfidence = confidence;
        if (bestConfidence >= 88) {
          return { digit: bestDigit, attempts };
        }
      }
    }
  }

  return { digit: bestDigit, attempts };
}

async function recognizeDigitFromRoi(cellRoi) {
  const allAttempts = [];

  const passGeneral = await recognizeDigitFromVariants(cellRoi, 23, true, "123456789", [10, 13]);
  allAttempts.push(...passGeneral.attempts);
  const baseBest = pickBestAttempt(passGeneral.attempts);
  if (baseBest.digit && baseBest.confidence >= 72) {
    return { digit: baseBest.digit, attempts: allAttempts };
  }

  const features = extractDigitFeatures(cellRoi);
  if (features.holeCount >= 1) {
    const passRounded = await recognizeDigitFromVariants(cellRoi, 10, true, "689", [10, 13]);
    allAttempts.push(...passRounded.attempts);
  } else {
    const passLines = await recognizeDigitFromVariants(cellRoi, 8, true, "147", [10]);
    const passCurves = await recognizeDigitFromVariants(cellRoi, 8, true, "235", [10]);
    const pass27 = await recognizeDigitFromVariants(cellRoi, 7, true, "27", [10, 13]);
    const pass35 = await recognizeDigitFromVariants(cellRoi, 6, true, "35", [10, 13]);
    allAttempts.push(...passLines.attempts, ...passCurves.attempts, ...pass27.attempts, ...pass35.attempts);
  }

  let best = pickBestAttempt(allAttempts);
  if (best.digit && best.confidence >= 66) {
    return { digit: best.digit, attempts: allAttempts };
  }

  const tight = findDigitRoi(cellRoi);
  if (tight) {
    const tightGeneral = await recognizeDigitFromVariants(tight, 18, true, "123456789", [10]);
    allAttempts.push(...tightGeneral.attempts);
    if (features.holeCount >= 1) {
      const tightRounded = await recognizeDigitFromVariants(tight, 9, true, "689", [10]);
      allAttempts.push(...tightRounded.attempts);
    }
    tight.delete();
  }

  best = pickBestAttempt(allAttempts);
  const voted = pickVotedDigit(allAttempts);
  if (voted.digit && (voted.topScore >= best.confidence * 1.35 || best.confidence < 52)) {
    best = { digit: voted.digit, confidence: best.confidence };
  }
  return { digit: best.digit || 0, attempts: allAttempts };
}

async function parseBoardFromImage(file) {
  await opencvReadyPromise;
  cvReady = true;
  await waitCvReady();
  appendDebugLog("OpenCV.js の準備完了を確認しました。");
  await initOcrWorker();

  const imageBitmap = await createImageBitmap(file);
  appendDebugLog(`画像を読み込みました: ${file.name} (${imageBitmap.width}x${imageBitmap.height})`);
  const workCanvas = document.getElementById("workCanvas");
  workCanvas.width = imageBitmap.width;
  workCanvas.height = imageBitmap.height;
  const ctx = workCanvas.getContext("2d");
  ctx.drawImage(imageBitmap, 0, 0);

  const src = cv.imread(workCanvas);
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const thresh = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 3);

    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    appendDebugLog(`輪郭を検出しました: ${contours.size()} 件`);
    if (contours.size() === 0) {
      throw new Error("盤面候補の輪郭が見つかりませんでした");
    }

    let largestIdx = 0;
    let largestArea = 0;
    for (let i = 0; i < contours.size(); i += 1) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area > largestArea) {
        largestArea = area;
        largestIdx = i;
      }
      cnt.delete();
    }

    const cnt = contours.get(largestIdx);
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
    appendDebugLog(`最大輪郭の面積=${Math.round(largestArea)} / approx.rows=${approx.rows}`);

    if (approx.rows < 4) {
      approx.delete();
      cnt.delete();
      throw new Error("盤面の4隅を特定できませんでした");
    }

    const pts = [];
    for (let i = 0; i < approx.rows; i += 1) {
      const x = approx.intPtr(i, 0)[0];
      const y = approx.intPtr(i, 0)[1];
      pts.push({ x, y });
    }
    cnt.delete();
    approx.delete();

    pts.sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const corners = orderCorners(pts.slice(0, 4));
    appendDebugLog(`4隅を推定しました: TL(${corners[0].x},${corners[0].y}) TR(${corners[1].x},${corners[1].y}) BR(${corners[2].x},${corners[2].y}) BL(${corners[3].x},${corners[3].y})`);

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      corners[0].x, corners[0].y,
      corners[1].x, corners[1].y,
      corners[2].x, corners[2].y,
      corners[3].x, corners[3].y,
    ]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      900, 0,
      900, 900,
      0, 900,
    ]);

    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(900, 900), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    const warpedGray = new cv.Mat();
    cv.cvtColor(warped, warpedGray, cv.COLOR_RGBA2GRAY, 0);

    const board = emptyBoard();
    forcedCells = emptyFlags();
    appendDebugLog("セル単位のOCRを開始します。");

    for (let r = 0; r < 9; r += 1) {
      setStatus(`画像を解析中... ${r + 1}/9 行目`);
      appendDebugLog(`行 ${r + 1} を解析中です。`);
      for (let c = 0; c < 9; c += 1) {
        const x = c * 100 + 6;
        const y = r * 100 + 6;
        const rect = new cv.Rect(x, y, 88, 88);
        const cell = warpedGray.roi(rect);

        const cellScaled = new cv.Mat();
        cv.resize(cell, cellScaled, new cv.Size(192, 192), 0, 0, cv.INTER_CUBIC);

        if (!hasDigitInk(cellScaled)) {
          board[r][c] = 0;
          appendDebugLog(`R${r + 1}C${c + 1}: インク量判定で空欄`);
          cell.delete();
          cellScaled.delete();
          continue;
        }

        const result = await recognizeDigitFromRoi(cellScaled);
        let resolvedDigit;
        if (result.digit) {
          resolvedDigit = resolveDigitWithRules(cellScaled, result.digit, false, result.attempts || []);
          board[r][c] = resolvedDigit;
          forcedCells[r][c] = false;
        } else {
          const forced = estimateDigitByTemplate(cellScaled);
          resolvedDigit = resolveDigitWithRules(cellScaled, forced, true, result.attempts || []);
          board[r][c] = resolvedDigit;
          forcedCells[r][c] = true;
          appendDebugLog(`R${r + 1}C${c + 1}: OCR未確定のためテンプレート推定で ${forced} -> ${resolvedDigit} を採用`);
        }

        // Temporarily disable all post-correction passes.
        // const tunedCurveDigit = await resolveNoHoleCurveAmbiguity(
        //   cellScaled,
        //   resolvedDigit,
        //   result.attempts || [],
        //   !result.digit,
        // );
        // if (tunedCurveDigit !== resolvedDigit) {
        //   appendDebugLog(`R${r + 1}C${c + 1}: 曲線数字補正を適用 ${resolvedDigit} -> ${tunedCurveDigit}`);
        //   resolvedDigit = tunedCurveDigit;
        //   board[r][c] = resolvedDigit;
        // }

        // const tunedEightNineDigit = await resolveEightNineAmbiguity(
        //   cellScaled,
        //   resolvedDigit,
        //   result.attempts || [],
        //   !result.digit,
        // );
        // if (tunedEightNineDigit !== resolvedDigit) {
        //   appendDebugLog(`R${r + 1}C${c + 1}: 8/9補正を適用 ${resolvedDigit} -> ${tunedEightNineDigit}`);
        //   resolvedDigit = tunedEightNineDigit;
        //   board[r][c] = resolvedDigit;
        // }

        const tunedTwoSevenDigit = await resolveTwoSevenAmbiguityFinal(
          cellScaled,
          resolvedDigit,
          result.attempts || [],
          !result.digit,
        );
        if (tunedTwoSevenDigit !== resolvedDigit) {
          appendDebugLog(`R${r + 1}C${c + 1}: 2/7最終補正を適用 ${resolvedDigit} -> ${tunedTwoSevenDigit}`);
          resolvedDigit = tunedTwoSevenDigit;
          board[r][c] = resolvedDigit;
        }

        if (result.digit) {
          appendDebugLog(`R${r + 1}C${c + 1}: ${resolvedDigit}`);
        } else {
          const attemptText = result.attempts
            .map((attempt, index) => `v${index + 1}=${attempt.digit || "-"}/${attempt.confidence.toFixed(1)}`)
            .join(", ");
          appendDebugLog(`R${r + 1}C${c + 1}: 空欄 / ${attemptText}`);
        }

        cell.delete();
        cellScaled.delete();
      }
    }

    srcTri.delete();
    dstTri.delete();
    M.delete();
    warped.delete();
    warpedGray.delete();

    return board;
  } finally {
    src.delete();
    gray.delete();
    blur.delete();
    thresh.delete();
    contours.delete();
    hierarchy.delete();
  }
}

imageInput.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    clearDebugLog();
    appendDebugLog("画像読み込みを開始しました。");
    setStatus("画像を読み込み中...");
    const parsed = await parseBoardFromImage(file);
    initialBoard = cloneBoard(parsed);
    currentBoard = cloneBoard(parsed);
    steps = [];
    stepIndex = -1;
    solvedBoard = null;
    navHighlightCell = null;
    renderBoard();
    appendDebugLog("盤面のOCRが完了しました。");
    setStatus("画像読込が完了しました。解法を計算しています...");
    executeSolveFromInitial();
  } catch (err) {
    setStatus("画像読込に失敗しました");
    appendDebugLog(`読込エラー: ${err.message}`);
  }
});

answerBtn.addEventListener("click", () => {
  if (!solvedBoard) {
    const ok = executeSolveFromInitial();
    if (!ok) return;
  }
  currentBoard = cloneBoard(solvedBoard);
  stepIndex = steps.length - 1;
  navHighlightCell = null;
  renderBoard();
  clearDebugLog("回答を表示しました。");
});

prevBtn.addEventListener("click", () => {
  if (steps.length === 0) return;
  if (stepIndex >= 0) {
    const undoneStep = steps[stepIndex];
    stepIndex -= 1;
    if (stepIndex >= 0) applySteps(stepIndex);
    else currentBoard = cloneBoard(initialBoard);
    navHighlightCell = stepIndex >= 0
      ? { row: steps[stepIndex].row, col: steps[stepIndex].col }
      : (undoneStep ? { row: undoneStep.row, col: undoneStep.col } : null);
    renderBoard();
    renderLog();
  }
});

nextBtn.addEventListener("click", () => {
  if (steps.length === 0) return;
  if (stepIndex < steps.length - 1) {
    stepIndex += 1;
    applySteps(stepIndex);
    navHighlightCell = { row: steps[stepIndex].row, col: steps[stepIndex].col };
    renderBoard();
    renderLog();
  }
});

resetBtn.addEventListener("click", () => {
  resetToInitial();
  setStatus("最初の盤面に戻しました。");
});

boardEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("cell")) return;
  const row = Number(target.dataset.row);
  const col = Number(target.dataset.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) return;

  const current = currentBoard[row][col] || 0;
  const answer = window.prompt("セル値を入力してください (0-9)。0 で空欄に戻します。", String(current));
  if (answer === null) return;
  const value = Number(answer.trim());
  if (!Number.isInteger(value) || value < 0 || value > 9) {
    setStatus("0-9 の整数を入力してください。");
    return;
  }
  updateCellValue(row, col, value);
});

(function boot() {
  renderBoard();
  renderLog();

  setStatus("OpenCV.js を読み込み中...");
  clearDebugLog("OpenCV.js を読み込み中です。");
  const cvPoll = setInterval(() => {
    if (typeof cv !== "undefined" && typeof cv.Mat === "function") {
      clearInterval(cvPoll);
      cvReady = true;
      appendDebugLog("OpenCV.js が利用可能になりました。");
      if (typeof window.__opencvReadyResolve === "function" && !window.__opencvReady) {
        window.__opencvReady = true;
        window.__opencvReadyResolve();
      }
    }
  }, 100);

  opencvReadyPromise
    .then(() => {
      cvReady = true;
      setStatus("準備完了。画像を選択してください。");
      appendDebugLog("起動準備が完了しました。画像を選択してください。");
    })
    .catch(() => {
      setStatus("OpenCV.js の初期化に失敗しました");
      appendDebugLog("OpenCV.js の初期化に失敗しました。");
    });
})();
