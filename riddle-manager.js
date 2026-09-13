const fs = require('fs');
const path = require('path');

const RIDDLES_MODULE = path.join(__dirname, 'riddle-questions.js');
const STATE_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'riddle-state.json');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

function loadRiddles() {
  const mod = require('./riddle-questions');
  if (Array.isArray(mod)) return mod.slice();
  if (Array.isArray(mod.default)) return mod.default.slice();
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
  const text = String(q.question || q.q || '').slice(0, 120);
  return `r_${idx}_${Buffer.from(text).toString('base64').slice(0,8)}`;
}

class RiddleManager {
  constructor(opts = {}) {
    this.recentWindowSize = opts.recentWindowSize || 40;
    this.riddles = loadRiddles().map((r, i) => ({ ...r, _id: makeId(r, i) }));
    this.state = loadState();
    if (!this.state.usage) this.state.usage = {};
    if (!this.state.recent) this.state.recent = {};
  }

  _scopeKey({ threadID = null } = {}) {
    return `thread:${String(threadID || 'global')}`;
  }

  async getNextRiddle({ threadID = null, userID = null } = {}) {
    if (!this.riddles || this.riddles.length === 0) return null;
    const key = this._scopeKey({ threadID, userID });
    const recent = new Set(this.state.recent[key] || []);

    let pool = this.riddles.slice();
    let candidates = pool.filter((r) => !recent.has(r._id));
    if (candidates.length === 0) candidates = pool.slice();

    candidates.forEach((c) => { c._uses = Number(this.state.usage[c._id] || 0); });

    const total = candidates.reduce((s, c) => s + 1 / (1 + c._uses), 0);
    let pick = Math.random() * total;
    let chosen = candidates[candidates.length - 1];
    for (const c of candidates) {
      pick -= 1 / (1 + c._uses);
      if (pick <= 0) { chosen = c; break; }
    }

    this.state.usage[chosen._id] = (this.state.usage[chosen._id] || 0) + 1;
    this.state.recent[key] = [chosen._id].concat(this.state.recent[key] || []).slice(0, this.recentWindowSize);
    saveState(this.state);

    const question = chosen.question || chosen.q || '';
    const answers = Array.isArray(chosen.answers) ? chosen.answers.map(String) : [String(chosen.answer || '')];

    return { question: String(question), answers };
  }

  async resetUsage() { this.state.usage = {}; saveState(this.state); }
  async resetRecent() { this.state.recent = {}; saveState(this.state); }
}

module.exports = new RiddleManager();
