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

// Code a player must enter to take a seat. /player is public, so without one
// anyone who finds the address can sit down, answer, and put their camera on
// the stream.
//
// The host sets it from the host page. It is saved to a settings file beside
// the question bank so a restart keeps it; PLAYER_CODE in the environment is
// only the starting value used when no code has been saved yet.
const SETTINGS_FILE = path.join(path.dirname(BANK_FILE), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch (err) {
    return {};
  }
}

function saveSettings(settings) {
  // Write to a temporary file then rename, so a crash mid-write can never
  // leave a half-written settings file behind.
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

const savedSettings = loadSettings();
let joinCode = typeof savedSettings.joinCode === 'string'
  ? savedSettings.joinCode
  : (process.env.PLAYER_CODE || '').trim();

if (!joinCode) {
  console.warn('No join code set. Anyone can take a seat until the host sets one.');
}

// Camera stream IDs are random and issued by the server, never fixed. The room
// password has to be readable by every browser that joins, so a fixed, guessable
// ID would let a stranger publish into a seat before its player arrived.
function newStreamId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

app.use(express.json());

// Only files the pages actually use are served from the app folder: images at
// the top level and the three browser scripts. Serving the whole folder
// exposed the git repo, the server source, the seed question bank and more.
const PUBLIC_SCRIPTS = new Set(['cam-config.js', 'cam-local.js', 'quiz-audio.js']);
const PUBLIC_IMAGE = /^[\w.-]+\.(png|jpe?g|gif|webp|svg|ico)$/i;

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const name = req.path.slice(1);
  if (name.includes('/')) return next();
  if (!PUBLIC_SCRIPTS.has(name) && !PUBLIC_IMAGE.test(name)) return next();
  res.sendFile(path.join(__dirname, name), { dotfiles: 'deny' }, err => {
    if (err) next();
  });
});
app.use('/uploads', express.static(UPLOAD_DIR, { dotfiles: 'deny', index: false }));

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

// Audio questions. Separate from the image uploader: different types, and a
// larger limit since a few seconds of music is bigger than a picture.
const ALLOWED_AUDIO_TYPES = /^audio\/(mpeg|mp3|wav|x-wav|wave|vnd\.wave|ogg|webm|mp4|x-m4a|m4a|aac|x-aac|flac|x-flac)$/;

const audioUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_AUDIO_TYPES.test(file.mimetype));
  }
});

function emptyPlayer() {
  return {
    name: null,
    answer: null,
    correct: null,
    score: 0,
    token: null,
    micMuted: true,
    cameraOff: false,
    cardImage: null,
    // Issued on claim. Only shown to the viewer once the player's camera
    // reports it is publishing, which leaves no gap for anyone else to take it.
    streamId: null,
    camLive: false
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

// Audio clip playback, driven by the host. The token changes on every play or
// stop so each page can tell a new command from one it has already acted on;
// startedAt lets a page that loads mid-clip join at the right point.
let audioPlaying = false;
let audioToken = 0;
let audioStartedAt = null;

function stopAudio() {
  audioPlaying = false;
  audioToken++;
  audioStartedAt = null;
}
let hostCameraOff = false;
let hostCardImage = null;
let hostStreamId = newStreamId('tnt_host');
let hostCamLive = false;
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
    // How the question text is laid over an image. Defaults keep older
    // saved rounds, which have neither field, behaving as before.
    showText: question.showText !== false,
    textPosition: question.textPosition || 'bottom',
    questionAudio: question.questionAudio || null,
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
      cardImage: player.cardImage,
      streamId: player.camLive ? player.streamId : null
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
    hostCameraOff,
    hostCardImage,
    // The host's feed, once the host page says its camera is publishing.
    hostStreamId: hostCamLive ? hostStreamId : null,
    joinCodeRequired: !!joinCode,
    showRoundIntro,
    audio: {
      playing: audioPlaying,
      token: audioToken,
      startedAt: audioStartedAt
    },
    // Lets a page work out how far into a clip it should be, without
    // depending on its own clock agreeing with the server's.
    serverNow: Date.now()
  };

  // Only the host receives the loaded rounds, which contain every answer.
  if (isHost) {
    state.rounds = rounds;
    state.joinCode = joinCode;
    // The host page needs its stream ID before the camera is up.
    state.myStreamId = hostStreamId;
  }

  // A player's page learns which seat the server thinks it holds, rather than
  // trusting what it remembered locally, plus the stream ID to publish on.
  if (role === 'player') {
    state.you = ownSlot
      ? { slot: ownSlot, streamId: players[ownSlot].streamId }
      : null;
  }

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

app.post('/api/upload/audio', requireHost, (req, res) => {
  audioUpload.single('audio')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Audio is too large (20MB maximum)'
        : 'Upload failed';
      return res.status(400).json({ success: false, message });
    }
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Only MP3, WAV, OGG, M4A, AAC, WebM and FLAC audio is accepted'
      });
    }
    res.json({ success: true, filename: req.file.filename });
  });
});

app.post('/api/audio/play', requireHost, (req, res) => {
  audioPlaying = true;
  audioToken++;
  audioStartedAt = Date.now();
  res.json({ success: true });
});

app.post('/api/audio/stop', requireHost, (req, res) => {
  stopAudio();
  res.json({ success: true });
});

app.post('/api/claim', (req, res) => {
  const { slot, name, code } = req.body;
  if (joinCode && !safeEqual(String(code || '').trim(), joinCode)) {
    return res.status(403).json({ success: false, message: 'Wrong join code' });
  }
  if (!players[slot]) {
    return res.json({ success: false, message: 'No such seat' });
  }
  if (players[slot].name !== null) {
    return res.json({ success: false, message: 'Slot already taken' });
  }
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  const token = crypto.randomBytes(18).toString('hex');
  players[slot].name = cleanName || 'Player';
  players[slot].token = token;
  players[slot].streamId = newStreamId('tnt_' + slot.replace('player', 'p'));
  players[slot].camLive = false;
  res.json({ success: true, token, streamId: players[slot].streamId });
});

app.post('/api/submit', (req, res) => {
  const { answer } = req.body;
  const slot = slotForToken(req);
  if (!slot) {
    return res.status(401).json({ success: false, message: 'Claim a player slot first' });
  }
  if (revealed) {
    return res.status(409).json({ success: false, message: 'Answers are closed' });
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
  if (players[slot] && Number.isFinite(Number(delta))) {
    players[slot].score += Number(delta);
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
  stopAudio();
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
    stopAudio();
  }
  res.json({ success: true, roundCount: rounds.length });
});

app.post('/api/game/start', requireHost, (req, res) => {
  if (rounds.length > 0) {
    gameStarted = true;
    currentRoundIndex = 0;
    currentQuestionIndex = 0;
    showRoundIntro = true;
    stopAudio();
  }
  res.json({ success: true, started: gameStarted });
});

app.post('/api/round/begin', requireHost, (req, res) => {
  showRoundIntro = false;
  stopAudio();
  res.json({ success: true });
});

app.post('/api/next', requireHost, (req, res) => {
  for (const slot in players) {
    players[slot].answer = null;
    players[slot].correct = null;
  }
  revealed = false;
  stopAudio();

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

// Sets the join code for new seats. Players already seated keep their seats;
// the code is only checked when someone sits down. An empty code turns the
// check off.
app.post('/api/host/joincode', requireHost, (req, res) => {
  const code = typeof req.body.code === 'string' ? req.body.code.trim().slice(0, 40) : '';
  try {
    saveSettings(Object.assign(loadSettings(), { joinCode: code }));
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Could not save the join code' });
  }
  joinCode = code;
  res.json({ success: true, joinCode });
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

// The host's own feed state and card. Host-authenticated rather than
// player-authenticated, since the host holds no player slot.
app.post('/api/host/status', requireHost, (req, res) => {
  if (typeof req.body.cameraOff === 'boolean') hostCameraOff = req.body.cameraOff;
  if (typeof req.body.camLive === 'boolean') hostCamLive = req.body.camLive;
  res.json({ success: true, cameraOff: hostCameraOff });
});

app.post('/api/host/card', requireHost, (req, res) => {
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
    hostCardImage = req.file.filename;
    res.json({ success: true, filename: req.file.filename });
  });
});

// A player reporting their own feed state, so the viewer page can show a
// mic-off badge or swap in their card. The mic and camera are actually
// stopped in the browser; this is only how the broadcast layer finds out.
app.post('/api/player/status', requirePlayer, (req, res) => {
  const player = players[req.playerSlot];
  if (typeof req.body.micMuted === 'boolean') player.micMuted = req.body.micMuted;
  if (typeof req.body.cameraOff === 'boolean') player.cameraOff = req.body.cameraOff;
  if (typeof req.body.camLive === 'boolean') player.camLive = req.body.camLive;
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