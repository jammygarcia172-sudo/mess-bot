const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'riddle-state.json');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

/**
 * Load riddles from riddle-questions.js
 * Supports multiple export formats
 */
function loadRiddles() {
  const mod = require('./riddle-questions');
  if (Array.isArray(mod)) return mod.slice();
  if (Array.isArray(mod.default)) return mod.default.slice();
  if (Array.isArray(mod.questions)) return mod.questions.slice();
  return [];
}

/**
 * Generate a stable ID for each riddle
 */
function makeRiddleId(r, idx) {
  if (r.id) return String(r.id);
  const text = String(r.question || r.q || '').slice(0, 120);
  return `r_${idx}_${Buffer.from(text).toString('base64').slice(0, 8)}`;
}

/**
 * Load state from disk
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

/**
 * Normalize riddle answers: trim, lowercase, handle multiple acceptable answers
 */
function normalizeRiddle(r) {
  if (!r) return null;
  const question = r.question || r.q || '';
  let answers = r.answers || r.answer || [];
  
  // Coerce to array
  if (!Array.isArray(answers)) {
    answers = [String(answers)];
  }
  
  // Trim and normalize each answer
  answers = answers.map((a) => String(a).trim()).filter(Boolean);
  
  if (!question || !answers.length) return null;
  
  return {
    question: String(question),
    answers: answers,
  };
}

class RiddleManager {
  constructor() {
    // Load all riddles once at startup
    const raw = loadRiddles();
    this.allRiddles = raw
      .map((r, idx) => {
        const normalized = normalizeRiddle(r);
        if (normalized) {
          return { ...normalized, _id: makeRiddleId(r, idx) };
        }
        return null;
      })
      .filter(Boolean);

    this.state = loadState();
    console.log(`[riddle-manager] Loaded ${this.allRiddles.length} riddles`);
  }

  _scopeKey(threadID) {
    return `thread:${String(threadID || 'global')}`;
  }

  /**
   * Get the next riddle for a thread
   * TRUE NO-REPEAT: Each riddle used once per full cycle, then restart
   */
  async getNextRiddle({ threadID = null } = {}) {
    if (!this.allRiddles || this.allRiddles.length === 0) {
      console.error('[riddle-manager] No riddles loaded');
      return null;
    }

    const key = this._scopeKey(threadID);

    // Initialize cycle for this thread if not exists
    if (!this.state.cycles[key]) {
      const shuffled = shuffle(this.allRiddles.map((r) => r._id));
      this.state.cycles[key] = {
        pool: shuffled,
        used: new Set(),
        currentIdx: 0,
      };
      saveState(this.state);
    }

    const cycle = this.state.cycles[key];

    // Check if cycle exhausted
    if (cycle.used.size >= this.allRiddles.length) {
      console.log(`[riddle-manager] Cycle exhausted for ${key}, resetting`);
      const shuffled = shuffle(this.allRiddles.map((r) => r._id));
      cycle.pool = shuffled;
      cycle.used = new Set();
      cycle.currentIdx = 0;
      saveState(this.state);
    }

    // Find next unused riddle in pool
    let attempts = 0;
    while (cycle.currentIdx < cycle.pool.length && attempts < cycle.pool.length) {
      const rid = cycle.pool[cycle.currentIdx];
      cycle.currentIdx++;

      if (!cycle.used.has(rid)) {
        cycle.used.add(rid);
        saveState(this.state);

        // Find and return the riddle object
        const r = this.allRiddles.find((x) => x._id === rid);
        if (r) return r;
      }
      attempts++;
    }

    // Should not reach here if pool is correctly shuffled
    console.error(`[riddle-manager] Failed to find unused riddle for ${key}`);
    return null;
  }

  /**
   * Admin: Reset usage for a thread
   */
  async resetThread(threadID) {
    const key = this._scopeKey(threadID);
    if (this.state.cycles[key]) {
      delete this.state.cycles[key];
      saveState(this.state);
      console.log(`[riddle-manager] Reset cycle for ${key}`);
    }
  }

  /**
   * Admin: Reset all threads
   */
  async resetAll() {
    this.state.cycles = {};
    saveState(this.state);
    console.log('[riddle-manager] Reset all cycles');
  }
}

module.exports = new RiddleManager();
