const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'tictactoe-state.json');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

function makeId(threadID, playerA, playerB) {
  // stable id independent of order
  const [a, b] = [String(playerA), String(playerB)].sort();
  return `${threadID}:${a}:${b}`;
}

function emptyBoard() {
  return Array(9).fill(null);
}

function renderCell(c) {
  return c === null ? ' ' : c;
}

function renderBoard(board) {
  // board is array[9]
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const slice = board.slice(r * 3, r * 3 + 3).map(renderCell);
    rows.push(`${slice[0]} | ${slice[1]} | ${slice[2]}`);
    if (r < 2) rows.push('---------');
  }
  return rows.join('\n');
}

function checkWinner(board) {
  const lines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every((c) => c !== null)) return 'draw';
  return null;
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function saveGame(game) {
  const state = loadState();
  state[game.id] = game;
  saveState(state);
}

function deleteGame(gameId) {
  const state = loadState();
  if (state[gameId]) delete state[gameId];
  saveState(state);
}

function loadAllGames() {
  const state = loadState();
  return Object.values(state || {});
}

module.exports = {
  makeId,
  emptyBoard,
  renderBoard,
  checkWinner,
  saveGame,
  deleteGame,
  loadAllGames,
};
