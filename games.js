const db = require("./db");
const { reply } = require("./util");
const triviaManager = require("./trivia-manager");
const riddleManager = require("./riddle-manager");

const SESSION_TIMEOUT_MS = 30_000;

// Animation cadence between edits. Lowered from 2200-3000ms so the
// dice/slots/blackjack "spinning" steps feel snappier instead of
// dragging with an obvious ~2s beat between every frame.
const EDIT_MIN_MS = 900;
const EDIT_MAX_MS = 1400;

const EDIT_TIMEOUT_MS = 5000;

// Fix for the "bot sends two messages instead of editing one" bug:
// a single edit attempt was giving up (and falling back to a brand
// new message) on the first timeout or FCA error, even though those
// are often transient (rate limiting from rapid successive edits
// during the animation frames). We now retry a couple of times with
// a short delay before truly giving up and falling back.
const EDIT_MAX_RETRIES = 2;
const EDIT_RETRY_DELAY_MS = 400;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const WORK_COOLDOWN_MS = 60 * 60 * 1000;

const sessions = new Map();
const sessionTimers = new Map();
const activeGames = new Set();

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function editDelay() {
  return randInt(EDIT_MIN_MS, EDIT_MAX_MS);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function sessionKey(threadID, userID) {
  return `${threadID}:${userID}`;
}

function xpForGame(type) {
  const rewards = {
    rps: 40, roll: 30, guess: 50, coinflip: 35, slots: 45,
    blackjack: 60, trivia: 50, math: 50, riddle: 50, "8ball": 10,
  };
  return rewards[type] || 25;
}

function coinReward(type, won = true) {
  const rewards = {
    rps: 100, roll: 75, guess: 150, coinflip: 100, slots: 125,
    blackjack: 175, trivia: 150, math: 175, riddle: 150, "8ball": 25,
  };
  const base = rewards[type] || 50;
  return won ? base : Math.floor(base * 0.25);
}

function getPlayerName(event) {
  if (event && event.senderName) return String(event.senderName);
  if (event && event.userName) return String(event.userName);
  const id = event && event.senderID ? String(event.senderID) : "Player";
  return `Player ${id.slice(-4)}`;
}

function sendMessageAsync(api, threadID, text) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, messageInfo) => {
      if (finished) return;
      finished = true;
      if (error) { reject(error); return; }
      resolve(messageInfo || null);
    };
    try {
      api.sendMessage(text, threadID, (error, messageInfo) => finish(error, messageInfo));
    } catch (error) {
      finish(error);
    }
  });
}

async function editMessageSafe(api, newText, messageID, threadID) {
  if (!messageID || !api || !api.editMessage) return false;
  return new Promise((resolve) => {
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      resolve(!error);
    };
    const timeout = setTimeout(() => finish(new Error("timeout")), EDIT_TIMEOUT_MS);
    try {
      api.editMessage(newText, messageID, (error) => {
        clearTimeout(timeout);
        finish(error);
      });
    } catch (error) {
      clearTimeout(timeout);
      finish(error);
    }
  });
}

// Animation helper: creates an "animator" with setInterval that edits messages
async function createAnimator(api, threadID, initialText, gameType = "") {
  const result = { messageID: null, stopEdit: null, editCount: 0 };
  try {
    const msgInfo = await sendMessageAsync(api, threadID, initialText);
    if (!msgInfo || !msgInfo.messageID) {
      console.error("[games] failed to send initial animator message");
      return result;
    }
    result.messageID = msgInfo.messageID;
    result.stopEdit = () => { /* do nothing; animator was short-lived */ };
  } catch (error) {
    console.error(`[games] animator init (${gameType}):`, error);
  }
  return result;
}

async function editMessageWithRetry(api, newText, messageID, threadID) {
  let lastError = null;
  for (let attempt = 0; attempt <= EDIT_MAX_RETRIES; attempt++) {
    const success = await editMessageSafe(api, newText, messageID, threadID);
    if (success) return true;
    if (attempt < EDIT_MAX_RETRIES) await sleep(EDIT_RETRY_DELAY_MS);
    lastError = `attempt ${attempt + 1} failed`;
  }
  console.warn(`[games] edit failed after retries for message ${messageID}: ${lastError}`);
  return false;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

function setSession(threadID, userID, data) {
  const key = sessionKey(threadID, userID);
  sessions.set(key, data);
  clearTimeout(sessionTimers.get(key));
  sessionTimers.set(key, setTimeout(() => {
    sessions.delete(key);
    sessionTimers.delete(key);
  }, SESSION_TIMEOUT_MS));
}

function getSession(threadID, userID) {
  return sessions.get(sessionKey(threadID, userID)) || null;
}

function clearSession(threadID, userID) {
  const key = sessionKey(threadID, userID);
  clearTimeout(sessionTimers.get(key));
  sessions.delete(key);
  sessionTimers.delete(key);
}

// ============================================================
// LOCK MANAGEMENT
// ============================================================

function lockGame(threadID, userID) {
  const key = `${threadID}:${userID}`;
  if (activeGames.has(key)) return false;
  activeGames.add(key);
  return true;
}

function unlockGame(threadID, userID) {
  activeGames.delete(`${threadID}:${userID}`);
}

// ============================================================
// REWARDS & BALANCE
// ============================================================

async function awardPlayer(threadID, userID, gameType, won = false) {
  const xp = xpForGame(gameType);
  const coins = coinReward(gameType, won);
  await db.addUserData(userID, {
    xp: won ? xp : -Math.floor(xp * 0.5),
    coins: coins,
  });
  return { xp, coins, won };
}

async function getFinalBalanceText(threadID, userID) {
  const user = await db.getUserData(userID);
  const coins = formatNumber(user?.coins ?? 0);
  const xp = formatNumber(user?.xp ?? 0);
  return `💰 Coins: ${coins} | ⭐ XP: ${xp}`;
}

// ============================================================
// TRIVIA
// ============================================================

async function handleTrivia(api, event) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const q = await triviaManager.getNextQuestion({ threadID });

    if (!q) {
      unlockGame(threadID, userID);
      await safeReply(api, event, "❌ No trivia questions available.");
      return;
    }

    const text = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🧠 TRIVIA      ", "╰━━━━━━━━━━━━━━━━━━━━╯", "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈", "",
      `👤 ${getPlayerName(event)}`, "", `❓ ${q.question}`, "",
      `A. ${q.options[0]}`, `B. ${q.options[1]}`, `C. ${q.options[2]}`, `D. ${q.options[3]}`, "",
      "⭐ Reward: +50 XP", "💰 Correct: +150 coins", "", "⏳ Reply A / B / C / D",
    ].join("\n");

    const animator = await createAnimator(api, threadID, text, "trivia");

    setSession(threadID, userID, { type: "trivia", qdata: q, messageID: animator.messageID });
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] trivia:", error);
    await safeReply(api, event, "❌ Trivia failed.");
  }
}

async function resolveTrivia(api, event, answer) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);
  const session = getSession(threadID, userID);

  if (!session || session.type !== "trivia") return false;
  clearSession(threadID, userID);

  const letters = ["A", "B", "C", "D"];
  const normalizedAnswer = String(answer).trim().toUpperCase();
  const chosenIndex = letters.indexOf(normalizedAnswer);
  const correctIndex = session.qdata.answer;
  const correct = chosenIndex === correctIndex;
  const correctLetter = letters[correctIndex] || "?";

  try {
    const reward = await awardPlayer(threadID, userID, "trivia", correct);
    const balanceText = await getFinalBalanceText(threadID, userID);

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🧠 TRIVIA      ", "╰━━━━━━━━━━━━━━━━━━━━╯", "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈", "",
      correct ? "🏆 CORRECT ANSWER!" : "❌ WRONG ANSWER", "",
      `Correct answer: ${correctLetter}`, "",
      `⭐ XP: ${reward.xp}`, `💰 Coins: +${reward.coins}`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, session.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);
  } catch (error) {
    console.error("[games] trivia reward:", error);
  }

  unlockGame(threadID, userID);
  return true;
}

// ============================================================
// RPS
// ============================================================

async function handleRPS(api, event, args) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const playerChoice = (args[0] || "").toLowerCase();
    if (!["rock", "paper", "scissors"].includes(playerChoice)) {
      unlockGame(threadID, userID);
      await safeReply(api, event, "❌ Invalid choice. Use: rock, paper, or scissors.");
      return;
    }

    const choices = ["rock", "paper", "scissors"];
    const botChoice = choices[randInt(0, 2)];
    let result = "draw";
    if (
      (playerChoice === "rock" && botChoice === "scissors") ||
      (playerChoice === "scissors" && botChoice === "paper") ||
      (playerChoice === "paper" && botChoice === "rock")
    ) {
      result = "win";
    } else if (playerChoice !== botChoice) {
      result = "loss";
    }

    const animator = await createAnimator(api, threadID, [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     ✊ ROCK      ", "╰━━━━━━━━━━━━━━━━━━━━╯",
      "", "🤖 Bot is choosing...", "", "⏳ WAIT...",
    ].join("\n"), "rps");

    const reward = await awardPlayer(threadID, userID, "rps", result === "win");
    const balanceText = await getFinalBalanceText(threadID, userID);

    const resultEmoji = result === "win" ? "🏆" : result === "loss" ? "❌" : "🤝";
    const resultText = result === "win" ? "WIN!" : result === "loss" ? "LOSE!" : "DRAW!";

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", `  ${resultEmoji} ${resultText}  `, "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `Your choice: ${playerChoice.toUpperCase()}`, `Bot choice: ${botChoice.toUpperCase()}`, "",
      `💰 Coins: +${reward.coins}`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, animator.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] rps:", error);
    await safeReply(api, event, "❌ RPS failed.");
  }

  unlockGame(threadID, userID);
}

// ============================================================
// ROLL
// ============================================================

async function handleRoll(api, event, args) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const sides = parseInt(args[0], 10) || 20;
    if (sides < 2 || sides > 1000) {
      unlockGame(threadID, userID);
      await safeReply(api, event, "❌ Invalid sides. Use between 2 and 1000.");
      return;
    }

    const animator = await createAnimator(api, threadID, [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🎲 ROLL       ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `Rolling a ${sides}-sided die...`, "", "⏳ ROLLING...",
    ].join("\n"), "roll");

    const result = randInt(1, sides);
    const balanceText = await getFinalBalanceText(threadID, userID);

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🎲 ROLL       ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `You rolled a ${result}!`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, animator.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] roll:", error);
    await safeReply(api, event, "❌ Roll failed.");
  }

  unlockGame(threadID, userID);
}

// ============================================================
// GUESS
// ============================================================

async function handleGuess(api, event, args) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const min = parseInt(args[0], 10) || 1;
    const max = parseInt(args[1], 10) || 100;

    if (min >= max) {
      unlockGame(threadID, userID);
      await safeReply(api, event, "❌ Min must be less than max.");
      return;
    }

    const secretNumber = randInt(min, max);

    const animator = await createAnimator(api, threadID, [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🎯 GUESS      ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `I'm thinking of a number between ${min} and ${max}.`, "",
      "🧠 You have 3 tries. Reply with your guess!", "",
      "⏳ Make your first guess...",
    ].join("\n"), "guess");

    setSession(threadID, userID, {
      type: "guess", secretNumber, min, max, tries: 0, messageID: animator.messageID,
    });
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] guess:", error);
    await safeReply(api, event, "❌ Guess failed.");
  }
}

async function resolveGuess(api, event, guessText) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);
  const session = getSession(threadID, userID);

  if (!session || session.type !== "guess") return false;

  const guess = parseInt(guessText, 10);
  if (Number.isNaN(guess)) {
    await safeReply(api, event, "❌ Invalid guess. Please provide a number.");
    return true;
  }

  const tries = session.tries + 1;
  let resultMessage = "";
  let isCorrect = false;

  if (guess === session.secretNumber) {
    isCorrect = true;
    resultMessage = `🏆 CORRECT! You guessed ${session.secretNumber} in ${tries} try(ies)!`;
  } else if (tries >= 3) {
    resultMessage = `❌ Game Over! The number was ${session.secretNumber}.`;
  } else if (guess < session.secretNumber) {
    resultMessage = `📈 Too low! Try higher. (${3 - tries} tries left)`;
  } else {
    resultMessage = `📉 Too high! Try lower. (${3 - tries} tries left)`;
  }

  if (isCorrect || tries >= 3) {
    clearSession(threadID, userID);
    const reward = await awardPlayer(threadID, userID, "guess", isCorrect);
    const balanceText = await getFinalBalanceText(threadID, userID);

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🎯 GUESS      ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      resultMessage, "",
      `💰 Coins: +${reward.coins}`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, session.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);

    unlockGame(threadID, userID);
  } else {
    setSession(threadID, userID, { ...session, tries });
    const edited = await editMessageSafe(api, resultMessage, session.messageID);
    if (!edited) await sendMessageAsync(api, threadID, resultMessage);
  }

  return true;
}

// ============================================================
// COIN FLIP
// ============================================================

async function handleCoinFlip(api, event, args) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const choice = (args[0] || "").toLowerCase();
    if (!["heads", "tails"].includes(choice)) {
      unlockGame(threadID, userID);
      await safeReply(api, event, "❌ Invalid choice. Use: heads or tails.");
      return;
    }

    const animator = await createAnimator(api, threadID, [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🪙 FLIP       ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      "Flipping a coin...", "", "⏳ SPINNING...",
    ].join("\n"), "coinflip");

    const result = randInt(0, 1) === 0 ? "heads" : "tails";
    const isCorrect = choice === result;

    const reward = await awardPlayer(threadID, userID, "coinflip", isCorrect);
    const balanceText = await getFinalBalanceText(threadID, userID);

    const resultEmoji = isCorrect ? "🏆" : "❌";

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🪙 FLIP       ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `Result: ${result.toUpperCase()}`, `Your choice: ${choice.toUpperCase()}`, "",
      `${resultEmoji} ${isCorrect ? "WIN!" : "LOSE!"}`, "",
      `💰 Coins: +${reward.coins}`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, animator.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] coinflip:", error);
    await safeReply(api, event, "❌ Coin flip failed.");
  }

  unlockGame(threadID, userID);
}

// ============================================================
// BLACKJACK
// ============================================================

const CARD_VALUES = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  "J": 10, "Q": 10, "K": 10, "A": 11,
};

const SUITS = ["♠️", "♥️", "♦️", "♣️"];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of Object.keys(CARD_VALUES)) {
      deck.push(`${value}${suit}`);
    }
  }
  return deck;
}

function drawCard(deck) {
  if (deck.length === 0) deck.push(...createDeck());
  const idx = Math.floor(Math.random() * deck.length);
  const card = deck[idx];
  deck.splice(idx, 1);
  return card;
}

function getCardValue(card) {
  const value = card.slice(0, -1);
  return CARD_VALUES[value] || 0;
}

function calcHandValue(hand) {
  let value = hand.reduce((sum, card) => sum + getCardValue(card), 0);
  let aces = hand.filter((card) => card.startsWith("A")).length;
  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }
  return value;
}

async function handleBlackjack(api, event) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const deck = createDeck();
    const playerHand = [drawCard(deck), drawCard(deck)];
    const botHand = [drawCard(deck), drawCard(deck)];

    const playerValue = calcHandValue(playerHand);
    const botValue = calcHandValue(botHand);

    const text = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "    ♠️  BLACKJACK  ♠️  ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `Your hand: ${playerHand.join(" ")} (${playerValue})`, `Bot hand: ${botHand[0]} ? (?)`, "",
      "Options:", "- Reply 'hit' to draw a card", "- Reply 'stand' to end your turn",
    ].join("\n");

    const animator = await createAnimator(api, threadID, text, "blackjack");

    setSession(threadID, userID, {
      type: "blackjack", playerHand, botHand, deck, messageID: animator.messageID,
    });
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] blackjack:", error);
    await safeReply(api, event, "❌ Blackjack failed.");
  }
}

async function resolveBlackjack(api, event, action) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);
  const session = getSession(threadID, userID);

  if (!session || session.type !== "blackjack") return false;

  const cmd = String(action).trim().toLowerCase();

  if (cmd === "hit") {
    const card = drawCard(session.deck);
    session.playerHand.push(card);
    const playerValue = calcHandValue(session.playerHand);

    if (playerValue > 21) {
      clearSession(threadID, userID);
      const reward = await awardPlayer(threadID, userID, "blackjack", false);
      const balanceText = await getFinalBalanceText(threadID, userID);

      const finalText = [
        "╭━━━━━━━━━━━━━━━━━━━━╮", "    ♠️  BLACKJACK  ♠️  ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
        `Your hand: ${session.playerHand.join(" ")} (${playerValue})`, "",
        "❌ BUST! You went over 21.", "",
        `💰 Coins: -${Math.abs(reward.coins)}`, "", balanceText,
      ].join("\n");

      const edited = await editMessageSafe(api, finalText, session.messageID);
      if (!edited) await sendMessageAsync(api, threadID, finalText);
      unlockGame(threadID, userID);
      return true;
    }

    const text = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "    ♠️  BLACKJACK  ♠️  ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `Your hand: ${session.playerHand.join(" ")} (${playerValue})`, `Bot hand: ${session.botHand[0]} ? (?)`, "",
      "Options:", "- Reply 'hit' to draw a card", "- Reply 'stand' to end your turn",
    ].join("\n");

    setSession(threadID, userID, session);
    const edited = await editMessageSafe(api, text, session.messageID);
    if (!edited) await sendMessageAsync(api, threadID, text);
  } else if (cmd === "stand") {
    clearSession(threadID, userID);

    let botValue = calcHandValue(session.botHand);
    while (botValue < 17) {
      session.botHand.push(drawCard(session.deck));
      botValue = calcHandValue(session.botHand);
    }

    const playerValue = calcHandValue(session.playerHand);

    let result = "loss";
    let resultText = "Bot Wins!";

    if (botValue > 21) {
      result = "win";
      resultText = "Bot Busted! You Win!";
    } else if (playerValue > botValue) {
      result = "win";
      resultText = "You Win!";
    } else if (playerValue === botValue) {
      result = "draw";
      resultText = "Push (Draw)!";
    }

    const reward = await awardPlayer(threadID, userID, "blackjack", result === "win");
    const balanceText = await getFinalBalanceText(threadID, userID);

    const resultEmoji = result === "win" ? "🏆" : result === "draw" ? "🤝" : "❌";

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "    ♠️  BLACKJACK  ♠️  ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `Your hand: ${session.playerHand.join(" ")} (${playerValue})`, `Bot hand: ${session.botHand.join(" ")} (${botValue})`, "",
      `${resultEmoji} ${resultText}`, "",
      `💰 Coins: ${result === "win" ? "+" : "-"}${Math.abs(reward.coins)}`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, session.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);
    unlockGame(threadID, userID);
  } else {
    await safeReply(api, event, "❌ Invalid action. Use 'hit' or 'stand'.");
  }

  return true;
}

// ============================================================
// SLOTS
// ============================================================

async function handleSlots(api, event) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const symbols = ["🍎", "🍊", "🍋", "🍌", "🍉"];

    const animator = await createAnimator(api, threadID, [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🎰 SLOTS      ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      "│      🍎  │  🍊  │  🍋      │", "", "⏳ SPINNING...",
    ].join("\n"), "slots");

    await sleep(1500);

    const randomReels = () => [
      symbols[randInt(0, symbols.length - 1)],
      symbols[randInt(0, symbols.length - 1)],
      symbols[randInt(0, symbols.length - 1)],
    ];

    const reels = randomReels();
    const reelText = (reels) => `│      ${reels.join("  │  ")}      │`;

    const isWinner = reels[0] === reels[1] && reels[1] === reels[2];

    const reward = await awardPlayer(threadID, userID, "slots", isWinner);
    const balanceText = await getFinalBalanceText(threadID, userID);

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🎰 SLOTS      ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      reelText(reels), "",
      isWinner ? "🏆 JACKPOT!" : "❌ No match.", "",
      `💰 Coins: ${isWinner ? "+" : "-"}${Math.abs(reward.coins)}`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, animator.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] slots:", error);
    await safeReply(api, event, "❌ Slots failed.");
  }

  unlockGame(threadID, userID);
}

// ============================================================
// MATH
// ============================================================

async function handleMath(api, event) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const a = randInt(1, 100);
    const b = randInt(1, 100);
    const ops = ["+", "-", "*"];
    const op = ops[randInt(0, 2)];

    let correctAnswer;
    if (op === "+") correctAnswer = a + b;
    else if (op === "-") correctAnswer = a - b;
    else correctAnswer = a * b;

    const animator = await createAnimator(api, threadID, [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🧮 MATH       ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `Solve: ${a} ${op} ${b}`, "", "⏳ What is the answer?",
    ].join("\n"), "math");

    setSession(threadID, userID, { type: "math", correctAnswer, messageID: animator.messageID });
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] math:", error);
    await safeReply(api, event, "❌ Math failed.");
  }
}

async function resolveMath(api, event, answerText) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);
  const session = getSession(threadID, userID);

  if (!session || session.type !== "math") return false;
  clearSession(threadID, userID);

  const userAnswer = parseInt(answerText, 10);
  const correct = !Number.isNaN(userAnswer) && userAnswer === session.correctAnswer;

  try {
    const reward = await awardPlayer(threadID, userID, "math", correct);
    const balanceText = await getFinalBalanceText(threadID, userID);

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🧮 MATH       ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      correct ? "🏆 CORRECT!" : "❌ WRONG", "",
      `Answer: ${session.correctAnswer}`, "",
      `⭐ XP: ${reward.xp}`, `💰 Coins: +${reward.coins}`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, session.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);
  } catch (error) {
    console.error("[games] math reward:", error);
  }

  unlockGame(threadID, userID);
  return true;
}

// ============================================================
// RIDDLES
// ============================================================

async function handleRiddle(api, event) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const riddle = await riddleManager.getNextRiddle({ threadID });

    if (!riddle) {
      unlockGame(threadID, userID);
      await safeReply(api, event, "❌ No riddles available.");
      return;
    }

    const animator = await createAnimator(api, threadID, [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🧩 RIDDLE      ", "╰━━━━━━━━━━━━━━━━━━━━╯", "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈", "",
      `👤 ${getPlayerName(event)}`, "", `❓ ${riddle.question}`, "", "🧠 Think carefully...", "",
      "✦ Reply with your answer.",
    ].join("\n"), "riddle");

    setSession(threadID, userID, {
      type: "riddle", question: riddle.question, answers: riddle.answers, messageID: animator.messageID,
    });
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] riddle:", error);
    await safeReply(api, event, "❌ Riddle failed.");
  }
}

async function resolveRiddle(api, event, answerText) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);
  const session = getSession(threadID, userID);

  if (!session || session.type !== "riddle") return false;
  clearSession(threadID, userID);

  const normalized = String(answerText).trim().toLowerCase();
  const correct = session.answers.some((answer) => normalized === String(answer).toLowerCase());

  try {
    const reward = await awardPlayer(threadID, userID, "riddle", correct);
    const balanceText = await getFinalBalanceText(threadID, userID);

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "     🧩 RIDDLE      ", "╰━━━━━━━━━━━━━━━━━━━━╯", "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈", "",
      correct ? "🏆 CORRECT ANSWER!" : "❌ WRONG ANSWER", "",
      `Correct answer: ${session.answers[0]}`, "",
      `⭐ XP: ${reward.xp}`, `💰 Coins: +${reward.coins}`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, session.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);
  } catch (error) {
    console.error("[games] riddle reward:", error);
  }

  unlockGame(threadID, userID);
  return true;
}

// ============================================================
// 8BALL
// ============================================================

const EIGHTBALL_RESPONSES = [
  "It is certain", "It is decidedly so", "Without a doubt", "Yes definitely", "You may rely on it",
  "As I see it, yes", "Most likely", "Outlook good", "Yes", "Signs point to yes",
  "Reply hazy try again", "Ask again later", "Better not tell you now", "Cannot predict now",
  "Concentrate and ask again", "Don't count on it", "My reply is no", "My sources say no",
  "Outlook not so good", "Very doubtful",
];

async function handleEightBall(api, event, args) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);

  if (!lockGame(threadID, userID)) {
    await safeReply(api, event, "⏳ Finish your current game first.");
    return;
  }

  try {
    const question = (args || []).join(" ");
    if (!question.trim()) {
      unlockGame(threadID, userID);
      await safeReply(api, event, "❌ Ask a yes/no question.");
      return;
    }

    const animator = await createAnimator(api, threadID, [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "    🎱 8BALL       ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `Your question: ${question}`, "", "⏳ Consulting the spirits...",
    ].join("\n"), "8ball");

    await sleep(1500);

    const response = EIGHTBALL_RESPONSES[randInt(0, EIGHTBALL_RESPONSES.length - 1)];
    const balanceText = await getFinalBalanceText(threadID, userID);

    const reward = await awardPlayer(threadID, userID, "8ball", true);

    const finalText = [
      "╭━━━━━━━━━━━━━━━━━━━━╮", "    🎱 8BALL       ", "╰━━━━━━━━━━━━━━━━━━━━╯", "",
      `Your question: ${question}`, "",
      `✨ ${response} ✨`, "",
      `💰 Coins: +${reward.coins}`, "", balanceText,
    ].join("\n");

    const edited = await editMessageSafe(api, finalText, animator.messageID);
    if (!edited) await sendMessageAsync(api, threadID, finalText);
  } catch (error) {
    unlockGame(threadID, userID);
    console.error("[games] 8ball:", error);
    await safeReply(api, event, "❌ 8Ball failed.");
  }

  unlockGame(threadID, userID);
}

// ============================================================
// REPLY HELPER
// ============================================================

async function safeReply(api, event, text) {
  try {
    const threadID = String(event.threadID);
    const messageID = event.messageID;
    if (messageID && api.setMessageReaction) {
      await new Promise((resolve) => {
        api.setMessageReaction("❌", messageID, () => resolve(), true);
      });
    }
    await sendMessageAsync(api, threadID, text);
  } catch (error) {
    console.error("[games] safeReply:", error);
  }
}

// ============================================================
// MAIN DISPATCHER
// ============================================================

async function handleGameCommand(api, event, command, args) {
  const cmd = String(command || "").toLowerCase();

  if (cmd === "trivia") await handleTrivia(api, event);
  else if (cmd === "rps") await handleRPS(api, event, args);
  else if (cmd === "roll") await handleRoll(api, event, args);
  else if (cmd === "guess") await handleGuess(api, event, args);
  else if (cmd === "coinflip") await handleCoinFlip(api, event, args);
  else if (cmd === "blackjack") await handleBlackjack(api, event);
  else if (cmd === "slots") await handleSlots(api, event);
  else if (cmd === "math") await handleMath(api, event);
  else if (cmd === "riddle") await handleRiddle(api, event);
  else if (cmd === "8ball") await handleEightBall(api, event, args);
  else await safeReply(api, event, `❌ Unknown game: ${cmd}`);
}

async function handleGameResponse(api, event, responseText) {
  const threadID = String(event.threadID);
  const userID = String(event.senderID);
  const session = getSession(threadID, userID);

  if (!session) return false;

  if (session.type === "trivia") return resolveTrivia(api, event, responseText);
  if (session.type === "riddle") return resolveRiddle(api, event, responseText);
  if (session.type === "guess") return resolveGuess(api, event, responseText);
  if (session.type === "blackjack") return resolveBlackjack(api, event, responseText);
  if (session.type === "math") return resolveMath(api, event, responseText);

  return false;
}

module.exports = {
  handleGameCommand,
  handleGameResponse,
  lockGame,
  unlockGame,
};
