const fs = require('fs');
const path = require('path');

const QUESTIONS_MODULE = path.join(__dirname, 'trivia-questions.js');
const STATE_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'trivia-state.json');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

function loadQuestions() {
  // support multiple export shapes (array or { questions: [] } )
  const mod = require('./trivia-questions');
  if (Array.isArray(mod)) return mod.slice();
  if (Array.isArray(mod.questions)) return mod.questions.slice();
  if (Array.isArray(mod.default)) return mod.default.slice();
  // fallback: try common const name
  if (mod && Array.isArray(mod.TRIVIA_QUESTIONS)) return mod.TRIVIA_QUESTIONS.slice();
  return [];
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { usage: {}, recent: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function makeId(q, idx) {
  if (q.id) return String(q.id);
  const text = String(q.q || q.question || q.text || '').slice(0, 120);
  return `q_${idx}_${Buffer.from(text).toString('base64').slice(0, 8)}`;
}

class TriviaManager {
  constructor(opts = {}) {
    this.recentWindowSize = opts.recentWindowSize || 40; // last N to avoid per-thread
    this.questions = loadQuestions().map((q, i) => ({ ...q, _id: makeId(q, i) }));
    this.state = loadState();
    if (!this.state.usage) this.state.usage = {};
    if (!this.state.recent) this.state.recent = {};
  }

  _scopeKey({ threadID = null, userID = null } = {}) {
    // keep repetition avoidance per thread (chat). Use user if you prefer per-user.
    return `thread:${String(threadID || 'global')}`;
  }

  async getNextQuestion({ threadID = null, userID = null, tags = [] } = {}) {
    if (!this.questions || this.questions.length === 0) return null;
    const key = this._scopeKey({ threadID, userID });
    const recent = new Set(this.state.recent[key] || []);

    // filter by tags if provided
    let pool = this.questions.filter((q) => {
      if (tags && tags.length) {
        if (!q.tags) return false;
        const has = tags.some((t) => (q.tags || []).includes(t));
        if (!has) return false;
      }
      return true;
    });

    // prefer those not in recent
    let candidates = pool.filter((q) => !recent.has(q._id));
    if (candidates.length === 0) candidates = pool.slice();

    // compute usage counts
    candidates.forEach((c) => { c._uses = Number(this.state.usage[c._id] || 0); });

    // weighted random: weight = 1 / (1 + uses)
    const total = candidates.reduce((s, c) => s + 1 / (1 + c._uses), 0);
    let pick = Math.random() * total;
    let chosen = candidates[candidates.length - 1];
    for (const c of candidates) {
      pick -= 1 / (1 + c._uses);
      if (pick <= 0) { chosen = c; break; }
    }

    // record usage & recent
    this.state.usage[chosen._id] = (this.state.usage[chosen._id] || 0) + 1;
    this.state.recent[key] = [chosen._id].concat(this.state.recent[key] || []).slice(0, this.recentWindowSize);
    saveState(this.state);

    // normalize shape to games.js expectations
    const questionText = chosen.q || chosen.question || chosen.prompt || chosen.text || '';
    const options = chosen.options || chosen.choices || chosen.answers || null;
    const answer = (chosen.answer ?? chosen.correct ?? chosen.correctIndex ?? chosen.correctAnswer);

    // If options is an object or not array, try to coerce
    const normalizedOptions = Array.isArray(options) ? options.slice(0, 4).map(String) : null;

    return {
      question: String(questionText),
      options: normalizedOptions,
      answer: Number.isFinite(Number(answer)) ? Number(answer) : null,
      _raw: chosen,
    };
  }

  // admin helpers
  async resetUsage() { this.state.usage = {}; saveState(this.state); }
  async resetRecent() { this.state.recent = {}; saveState(this.state); }
}

module.exports = new TriviaManager();
