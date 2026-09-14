const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Data locations. Both default to the app directory so local development is
// unchanged, but can be pointed at persistent storage when deployed so that
// a redeploy (git pull) doesn't overwrite the live question bank or uploads.
const BANK_FILE = process.env.BANK_FILE || path.join(__dirname, 'rounds-bank.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

// Shared secret the host page must present on every control endpoint. Set this
// in the environment for any deployment. If it is missing one is generated at
// startup and logged, which keeps local development working but means the
// secret changes on every restart.
const HOST_SECRET = process.env.HOST_SECRET || crypto.randomBytes(24).toString('hex');
if (!process.env.HOST_SECRET) {
  console.warn('HOST_SECRET not set. Using generated secret for this run: ' + HOST_SECRET);
}

// Viewers watching via a stream are behind the live game by the broadcast
// delay. Serving them a snapshot from this many seconds ago keeps the app in
// step with what they are actually watching. 0 disables the delay.
const VIEWER_DELAY_SECONDS = Number(process.env.VIEWER_DELAY_SECONDS || 0);

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOAD_DIR));

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    cb(null, unique + path.extname(file.originalname));
  }
});
const ALLOWED_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.test(file.mimetype)) {
      return cb(null, false);
    }
    cb(null, true);
  }
});

function emptyPlayer() {
  return {
    name: null,
    answer: null,
    correct: null,
    score: 0,
    token: null,
    micMuted: false,
    cameraOff: false,
    cardImage: null
  };
}

let players = {
  player1: emptyPlayer(),
  player2: emptyPlayer(),
  player3: emptyPlayer(),
  player4: emptyPlayer()
};

let revealed = false;
let rounds = [];
let gameStarted = false;
let currentRoundIndex = 0;
let currentQuestionIndex = 0;
let hostName = null;
let showRoundIntro = false;
let bankedRounds = [];

function loadBank() {
  try {
    const data = fs.readFileSync(BANK_FILE, 'utf8');
    bankedRounds = JSON.parse(data);
  } catch (err) {
    bankedRounds = [];
  }
}

function saveBank() {
  fs.writeFileSync(BANK_FILE, JSON.stringify(bankedRounds, null, 2));
}

loadBank();

// --- Authentication -------------------------------------------------------

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireHost(req, res, next) {
  if (!safeEqual(req.get('X-Host-Secret'), HOST_SECRET)) {
    return res.status(401).json({ success: false, message: 'Host authentication required' });
  }
  next();
}

// Identifies the caller from their player token, if they have one. Returns the
// slot name or null. Used to decide what a given client is allowed to see.
function slotForToken(req) {
  const token = req.get('X-Player-Token');
  if (!token) return null;
  for (const slot of Object.keys(players)) {
    if (players[slot].token && safeEqual(token, players[slot].token)) return slot;
  }
  return null;
}

function requirePlayer(req, res, next) {
  const slot = slotForToken(req);
  if (!slot) {
    return res.status(401).json({ success: false, message: 'Claim a player slot first' });
  }
  req.playerSlot = slot;
  next();
}

// --- State projection -----------------------------------------------------
// The server is the only place that holds unrevealed answers. Every client
// gets a view built for its role; nothing is filtered in the browser.

function projectQuestion(question, isHost) {
  if (!question) return null;
  const showAnswer = isHost || revealed;
  return {
    question: question.question,
    questionImage: question.questionImage || null,
    answer: showAnswer ? question.answer : null,
    answerImage: showAnswer ? (question.answerImage || null) : null
  };
}

function projectPlayers(isHost, ownSlot) {
  const out = {};
  for (const slot of Object.keys(players)) {
    const player = players[slot];
    const canSeeAnswer = isHost || revealed || slot === ownSlot;
    out[slot] = {
      name: player.name,
      answer: canSeeAnswer ? player.answer : null,
      hasAnswered: player.answer !== null,
      correct: revealed || isHost ? player.correct : null,
      score: player.score,
      micMuted: player.micMuted,
      cameraOff: player.cameraOff,
      cardImage: player.cardImage
    };
  }
  return out;
}

function buildState(role, ownSlot) {
  const isHost = role === 'host';
  const currentRound = rounds[currentRoundIndex] || null;
  const currentQuestion = currentRound ? currentRound.questions[currentQuestionIndex] : null;

  const state = {
    players: projectPlayers(isHost, ownSlot),
    revealed,
    gameStarted,
    roundCount: rounds.length,
    currentRoundIndex,
    currentRoundTitle: currentRound ? currentRound.title : null,
    currentQuestion: projectQuestion(currentQuestion, isHost),
    currentQuestionIndex,
    questionsInRound: currentRound ? currentRound.questions.length : 0,
    hostName,
    showRoundIntro
  };

  // Only the host receives the loaded rounds, which contain every answer.
  if (isHost) state.rounds = rounds;

  return state;
}

// --- Viewer delay ---------------------------------------------------------
// A short rolling history of viewer-facing snapshots, so viewers can be served
// the state as it was N seconds ago rather than the live state.

const snapshots = [];

function recordSnapshot() {
  if (VIEWER_DELAY_SECONDS <= 0) return;
  const now = Date.now();
  snapshots.push({ at: now, state: buildState('viewer', null) });
  const cutoff = now - (VIEWER_DELAY_SECONDS + 30) * 1000;
  while (snapshots.length && snapshots[0].at < cutoff) snapshots.shift();
}

if (VIEWER_DELAY_SECONDS > 0) {
  setInterval(recordSnapshot, 250).unref();
}

function viewerState() {
  if (VIEWER_DELAY_SECONDS <= 0) return buildState('viewer', null);
  const target = Date.now() - VIEWER_DELAY_SECONDS * 1000;
  let chosen = null;
  for (const snapshot of snapshots) {
    if (snapshot.at <= target) chosen = snapshot;
    else break;
  }
  // Before enough history has accumulated, show the pre-game state rather than
  // leaking the live one.
  return chosen ? chosen.state : buildState('viewer', null);
}

// express.static serves cam-local.js when it exists. When it does not, this
// keeps the page from logging a 404 for an optional file.
app.get('/cam-local.js', (req, res) => {
  res.type('application/javascript').send('// no local overrides\n');
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/host', (req, res) => {
  res.sendFile(__dirname + '/host.html');
});

app.get('/player', (req, res) => {
  res.sendFile(__dirname + '/player.html');
});

app.get('/viewer', (req, res) => {
  res.sendFile(__dirname + '/viewer.html');
});

app.post('/api/upload', requireHost, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image is too large (5MB maximum)'
        : 'Upload failed';
      return res.status(400).json({ success: false, message });
    }
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Only PNG, JPEG, GIF and WebP images are accepted'
      });
    }
    res.json({ success: true, filename: req.file.filename });
  });
});

app.post('/api/claim', (req, res) => {
  const { slot, name } = req.body;
  if (players[slot] && players[slot].name === null) {
    const token = crypto.randomBytes(18).toString('hex');
    players[slot].name = typeof name === 'string' ? name.slice(0, 40) : 'Player';
    players[slot].token = token;
    return res.json({ success: true, token });
  }
  res.json({ success: false, message: 'Slot already taken' });
});

app.post('/api/submit', (req, res) => {
  const { answer } = req.body;
  const slot = slotForToken(req);
  if (!slot) {
    return res.status(401).json({ success: false, message: 'Claim a player slot first' });
  }
  players[slot].answer = typeof answer === 'string' ? answer.slice(0, 500) : '';
  res.json({ success: true });
});

app.post('/api/reveal', requireHost, (req, res) => {
  revealed = true;
  res.json({ success: true });
});

app.post('/api/mark', requireHost, (req, res) => {
  const { slot, value } = req.body;
  const player = players[slot];
  if (!player) return res.json({ success: false });

  if (player.correct === true && value !== true) {
    player.score -= 1;
  }
  if (value === true && player.correct !== true) {
    player.score += 1;
  }
  player.correct = value;

  res.json({ success: true });
});

app.post('/api/score/adjust', requireHost, (req, res) => {
  const { slot, delta } = req.body;
  if (players[slot]) {
    players[slot].score += delta;
  }
  res.json({ success: true });
});

app.post('/api/release', requireHost, (req, res) => {
  const { slot } = req.body;
  if (players[slot]) {
    players[slot] = emptyPlayer();
  }
  res.json({ success: true });
});

// Full reset: clears players, scores, and game/round progress (keeps the round library and tonight's loaded rounds)
app.post('/api/game/reset', requireHost, (req, res) => {
  players = {
    player1: emptyPlayer(),
    player2: emptyPlayer(),
    player3: emptyPlayer(),
    player4: emptyPlayer()
  };
  revealed = false;
  gameStarted = false;
  currentRoundIndex = 0;
  currentQuestionIndex = 0;
  showRoundIntro = false;
  res.json({ success: true });
});

app.get('/api/bank', requireHost, (req, res) => {
  res.json({ bankedRounds });
});

app.post('/api/bank/add', requireHost, (req, res) => {
  const { title, questions } = req.body;
  if (title && Array.isArray(questions) && questions.length > 0) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    bankedRounds.push({ id, title, questions });
    saveBank();
  }
  res.json({ success: true, bankedRounds });
});

app.post('/api/bank/edit', requireHost, (req, res) => {
  const { id, title, questions } = req.body;
  const round = bankedRounds.find(r => r.id === id);
  if (round) {
    round.title = title;
    round.questions = questions;
    saveBank();
  }
  res.json({ success: true, bankedRounds });
});

app.post('/api/bank/delete', requireHost, (req, res) => {
  const { id } = req.body;
  bankedRounds = bankedRounds.filter(r => r.id !== id);
  saveBank();
  res.json({ success: true, bankedRounds });
});

app.post('/api/rounds/select', requireHost, (req, res) => {
  const { ids } = req.body;
  if (Array.isArray(ids)) {
    rounds = ids
      .map(id => bankedRounds.find(r => r.id === id))
      .filter(r => r)
      .map(r => ({ title: r.title, questions: r.questions }));
    gameStarted = false;
    currentRoundIndex = 0;
    currentQuestionIndex = 0;
    showRoundIntro = false;
    revealed = false;
  }
  res.json({ success: true, roundCount: rounds.length });
});

app.post('/api/game/start', requireHost, (req, res) => {
  if (rounds.length > 0) {
    gameStarted = true;
    currentRoundIndex = 0;
    currentQuestionIndex = 0;
    showRoundIntro = true;
  }
  res.json({ success: true, started: gameStarted });
});

app.post('/api/round/begin', requireHost, (req, res) => {
  showRoundIntro = false;
  res.json({ success: true });
});

app.post('/api/next', requireHost, (req, res) => {
  for (const slot in players) {
    players[slot].answer = null;
    players[slot].correct = null;
  }
  revealed = false;

  const currentRound = rounds[currentRoundIndex];
  let roundChanged = false;

  if (currentRound && currentQuestionIndex < currentRound.questions.length - 1) {
    currentQuestionIndex++;
  } else if (currentRoundIndex < rounds.length - 1) {
    currentRoundIndex++;
    currentQuestionIndex = 0;
    roundChanged = true;
  }

  if (roundChanged) {
    showRoundIntro = true;
  }

  res.json({ success: true });
});

app.post('/api/host/name', requireHost, (req, res) => {
  const { name } = req.body;
  hostName = name && name.trim() ? name.trim() : null;
  res.json({ success: true });
});

// Host and players. The role is derived from credentials, never from the
// request asking for one.
app.get('/api/state', (req, res) => {
  if (safeEqual(req.get('X-Host-Secret'), HOST_SECRET)) {
    return res.json(buildState('host', null));
  }
  const slot = slotForToken(req);
  res.json(buildState('player', slot));
});

// A player reporting their own feed state, so the viewer page can show a
// mic-off badge or swap in their card. The mic and camera are actually
// stopped in the browser; this is only how the broadcast layer finds out.
app.post('/api/player/status', requirePlayer, (req, res) => {
  const player = players[req.playerSlot];
  if (typeof req.body.micMuted === 'boolean') player.micMuted = req.body.micMuted;
  if (typeof req.body.cameraOff === 'boolean') player.cameraOff = req.body.cameraOff;
  res.json({ success: true, micMuted: player.micMuted, cameraOff: player.cameraOff });
});

// Players upload their own card. Same limits as the host upload path; the
// host secret is deliberately not needed here.
app.post('/api/player/card', requirePlayer, (req, res) => {
  upload.single('card')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image is too large (5MB maximum)'
        : 'Upload failed';
      return res.status(400).json({ success: false, message });
    }
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Only PNG, JPEG, GIF and WebP images are accepted'
      });
    }
    players[req.playerSlot].cardImage = req.file.filename;
    res.json({ success: true, filename: req.file.filename });
  });
});

app.post('/api/player/card/clear', requirePlayer, (req, res) => {
  players[req.playerSlot].cardImage = null;
  res.json({ success: true });
});

// Unauthenticated, delayed, and safe to cache at the edge.
app.get('/api/state/viewer', (req, res) => {
  res.set('Cache-Control', 'public, max-age=1');
  res.json(viewerState());
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});