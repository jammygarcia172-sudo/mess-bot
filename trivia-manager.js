const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'trivia-state.json');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

/**
 * Load trivia questions from trivia-questions.js
 * Supports multiple export formats
 */
function loadQuestions() {
  const mod = require('./trivia-questions');
  if (Array.isArray(mod)) return mod.slice();
  if (Array.isArray(mod.questions)) return mod.questions.slice();
  if (Array.isArray(mod.default)) return mod.default.slice();
  if (mod && Array.isArray(mod.TRIVIA_QUESTIONS)) return mod.TRIVIA_QUESTIONS.slice();
  return [];
}

/**
 * Generate a stable ID for each question
 * Uses existing id field if available, otherwise derives from question text
 */
function makeQuestionId(q, idx) {
  if (q.id) return String(q.id);
  const text = String(q.q || q.question || q.text || q.prompt || '').slice(0, 120);
  return `q_${idx}_${Buffer.from(text).toString('base64').slice(0, 8)}`;
}

/**
 * Normalize a raw question object to match games.js format
 */
function normalizeQuestion(raw) {
  if (!raw) return null;
  const question = raw.q || raw.question || raw.text || raw.prompt;
  const options = raw.options || raw.choices || raw.answers;
  const answer = raw.answer ?? raw.correct ?? raw.correctAnswer ?? raw.correctIndex;
  const correctIndex = Number(answer);

  if (
    !question ||
    !Array.isArray(options) ||
    options.length < 4 ||
    !Number.isInteger(correctIndex) ||
    correctIndex < 0 ||
    correctIndex > 3
  ) {
    return null;
  }

  return {
    question: String(question),
    options: options.slice(0, 4).map((opt) => String(opt)),
    answer: correctIndex,
  };
}

/**
 * Load state from disk
 * Format: { cycles: { 'thread:ID': { pool: [id, id, ...], used: Set of ids, currentIdx } } }
 */
function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Convert used arrays back to Sets
    if (data.cycles) {
      for (const key in data.cycles) {
        if (data.cycles[key].used && Array.isArray(data.cycles[key].used)) {
          data.cycles[key].used = new Set(data.cycles[key].used);
        }
      }
    }
    return data;
  } catch {
    return { cycles: {} };
  }
}

/**
 * Save state to disk
 * Convert Sets to arrays for JSON serialization
 */
function saveState(state) {
  const toSave = { cycles: {} };
  for (const key in state.cycles) {
    const cycle = state.cycles[key];
    toSave.cycles[key] = {
      pool: cycle.pool || [],
      used: Array.from(cycle.used || []),
      currentIdx: cycle.currentIdx || 0,
    };
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2), 'utf8');
}

/**
 * Shuffle an array using Fisher-Yates algorithm
 */
function shuffle(arr) {
  const result = arr.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

class TriviaManager {
  constructor() {
    // Load all questions once at startup
    const raw = loadQuestions();
    this.allQuestions = raw
      .map((q, idx) => {
        const normalized = normalizeQuestion(q);
        if (normalized) {
          return { ...normalized, _id: makeQuestionId(q, idx) };
        }
        return null;
      })
      .filter(Boolean);

    this.state = loadState();
    console.log(`[trivia-manager] Loaded ${this.allQuestions.length} questions`);
  }

  _scopeKey(threadID) {
    return `thread:${String(threadID || 'global')}`;
  }

  /**
   * Get the next trivia question for a thread
   * TRUE NO-REPEAT: Each question used once per full cycle, then restart
   */
  async getNextQuestion({ threadID = null } = {}) {
    if (!this.allQuestions || this.allQuestions.length === 0) {
      console.error('[trivia-manager] No questions loaded');
      return null;
    }

    const key = this._scopeKey(threadID);

    // Initialize cycle for this thread if not exists
    if (!this.state.cycles[key]) {
      const shuffled = shuffle(this.allQuestions.map((q) => q._id));
      this.state.cycles[key] = {
        pool: shuffled,
        used: new Set(),
        currentIdx: 0,
      };
      saveState(this.state);
    }

    const cycle = this.state.cycles[key];

    // Check if cycle exhausted
    if (cycle.used.size >= this.allQuestions.length) {
      console.log(`[trivia-manager] Cycle exhausted for ${key}, resetting`);
      const shuffled = shuffle(this.allQuestions.map((q) => q._id));
      cycle.pool = shuffled;
      cycle.used = new Set();
      cycle.currentIdx = 0;
      saveState(this.state);
    }

    // Find next unused question in pool
    let attempts = 0;
    while (cycle.currentIdx < cycle.pool.length && attempts < cycle.pool.length) {
      const qid = cycle.pool[cycle.currentIdx];
      cycle.currentIdx++;

      if (!cycle.used.has(qid)) {
        cycle.used.add(qid);
        saveState(this.state);

        // Find and return the question object
        const q = this.allQuestions.find((x) => x._id === qid);
        if (q) return q;
      }
      attempts++;
    }

    // Should not reach here if pool is correctly shuffled
    console.error(`[trivia-manager] Failed to find unused question for ${key}`);
    return null;
  }

  /**
   * Admin: Reset usage for a thread (e.g., if database changes)
   */
  async resetThread(threadID) {
    const key = this._scopeKey(threadID);
    if (this.state.cycles[key]) {
      delete this.state.cycles[key];
      saveState(this.state);
      console.log(`[trivia-manager] Reset cycle for ${key}`);
    }
  }

  /**
   * Admin: Reset all threads
   */
  async resetAll() {
    this.state.cycles = {};
    saveState(this.state);
    console.log('[trivia-manager] Reset all cycles');
  }
}

module.exports = new TriviaManager();
