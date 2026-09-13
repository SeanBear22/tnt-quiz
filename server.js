const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

const BANK_FILE = __dirname + '/rounds-bank.json';
const UPLOAD_DIR = __dirname + '/uploads';

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

let players = {
  player1: { name: null, answer: null, correct: null, score: 0 },
  player2: { name: null, answer: null, correct: null, score: 0 },
  player3: { name: null, answer: null, correct: null, score: 0 },
  player4: { name: null, answer: null, correct: null, score: 0 }
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

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.json({ success: false });
  }
  res.json({ success: true, filename: req.file.filename });
});

app.post('/api/claim', (req, res) => {
  const { slot, name } = req.body;
  if (players[slot] && players[slot].name === null) {
    players[slot].name = name;
    return res.json({ success: true });
  }
  res.json({ success: false, message: 'Slot already taken' });
});

app.post('/api/submit', (req, res) => {
  const { slot, answer } = req.body;
  if (players[slot]) {
    players[slot].answer = answer;
  }
  res.json({ success: true });
});

app.post('/api/reveal', (req, res) => {
  revealed = true;
  res.json({ success: true });
});

app.post('/api/mark', (req, res) => {
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

app.post('/api/score/adjust', (req, res) => {
  const { slot, delta } = req.body;
  if (players[slot]) {
    players[slot].score += delta;
  }
  res.json({ success: true });
});

app.post('/api/release', (req, res) => {
  const { slot } = req.body;
  if (players[slot]) {
    players[slot] = { name: null, answer: null, correct: null, score: 0 };
  }
  res.json({ success: true });
});

// Full reset: clears players, scores, and game/round progress (keeps the round library and tonight's loaded rounds)
app.post('/api/game/reset', (req, res) => {
  players = {
    player1: { name: null, answer: null, correct: null, score: 0 },
    player2: { name: null, answer: null, correct: null, score: 0 },
    player3: { name: null, answer: null, correct: null, score: 0 },
    player4: { name: null, answer: null, correct: null, score: 0 }
  };
  revealed = false;
  gameStarted = false;
  currentRoundIndex = 0;
  currentQuestionIndex = 0;
  showRoundIntro = false;
  res.json({ success: true });
});

app.get('/api/bank', (req, res) => {
  res.json({ bankedRounds });
});

app.post('/api/bank/add', (req, res) => {
  const { title, questions } = req.body;
  if (title && Array.isArray(questions) && questions.length > 0) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    bankedRounds.push({ id, title, questions });
    saveBank();
  }
  res.json({ success: true, bankedRounds });
});

app.post('/api/bank/edit', (req, res) => {
  const { id, title, questions } = req.body;
  const round = bankedRounds.find(r => r.id === id);
  if (round) {
    round.title = title;
    round.questions = questions;
    saveBank();
  }
  res.json({ success: true, bankedRounds });
});

app.post('/api/bank/delete', (req, res) => {
  const { id } = req.body;
  bankedRounds = bankedRounds.filter(r => r.id !== id);
  saveBank();
  res.json({ success: true, bankedRounds });
});

app.post('/api/rounds/select', (req, res) => {
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

app.post('/api/game/start', (req, res) => {
  if (rounds.length > 0) {
    gameStarted = true;
    currentRoundIndex = 0;
    currentQuestionIndex = 0;
    showRoundIntro = true;
  }
  res.json({ success: true, started: gameStarted });
});

app.post('/api/round/begin', (req, res) => {
  showRoundIntro = false;
  res.json({ success: true });
});

app.post('/api/next', (req, res) => {
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

app.post('/api/host/name', (req, res) => {
  const { name } = req.body;
  hostName = name && name.trim() ? name.trim() : null;
  res.json({ success: true });
});

app.get('/api/state', (req, res) => {
  const currentRound = rounds[currentRoundIndex] || null;
  const currentQuestion = currentRound ? currentRound.questions[currentQuestionIndex] : null;

  res.json({
    players,
    revealed,
    gameStarted,
    roundCount: rounds.length,
    rounds,
    currentRoundIndex,
    currentRoundTitle: currentRound ? currentRound.title : null,
    currentQuestion,
    currentQuestionIndex,
    questionsInRound: currentRound ? currentRound.questions.length : 0,
    hostName,
    showRoundIntro
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});