// Audio questions: shared by the host, player and viewer pages.
// ----------------------------------------------------------------------------
// The server decides when a clip plays; every page follows along. Each page
// keeps one <audio> element for the whole session, so a clip is not cut off
// when the page redraws. Play and stop commands arrive as a token that changes
// on every press, which is how a page tells "play it again" from "still
// playing". The server also sends when the clip started, so a page that loads
// mid-clip joins at the right point instead of starting from the top.

const QuizAudio = (function () {
  const player = new Audio();
  player.preload = 'auto';

  let lastToken = null;
  let currentSrc = null;
  let muted = false;
  let onBlocked = null;

  // --- Playback -------------------------------------------------------------

  function setSource(src) {
    if (src === currentSrc) return;
    currentSrc = src;
    player.pause();
    if (src) {
      player.src = src;
    } else {
      player.removeAttribute('src');
      player.load();
    }
  }

  function tryPlay() {
    if (muted) return;
    const attempt = player.play();
    if (attempt && attempt.catch) {
      attempt.catch(() => {
        // The browser refused to start sound without a click on the page.
        if (onBlocked) onBlocked();
      });
    }
  }

  // Called with every state update.
  function sync(state) {
    const q = state && state.currentQuestion;
    const inQuestion = state && state.gameStarted && !state.showRoundIntro && q;
    const src = inQuestion && q.questionAudio ? '/uploads/' + q.questionAudio : null;

    setSource(src);
    if (!src) {
      lastToken = null;
      return;
    }

    const audio = state.audio || {};
    if (audio.token === lastToken) return;
    lastToken = audio.token;

    if (audio.playing) {
      const elapsed = audio.startedAt && state.serverNow
        ? Math.max(0, (state.serverNow - audio.startedAt) / 1000)
        : 0;
      const start = () => {
        if (player.duration && elapsed >= player.duration) return;
        try { player.currentTime = elapsed; } catch (err) { /* not seekable yet */ }
        tryPlay();
      };
      if (player.readyState >= 1) start();
      else player.addEventListener('loadedmetadata', start, { once: true });
    } else {
      player.pause();
      try { player.currentTime = 0; } catch (err) { /* nothing loaded */ }
    }
  }

  // For the button shown when the browser blocked playback.
  function resume() {
    tryPlay();
  }

  function setMuted(value) {
    muted = !!value;
    player.muted = muted;
    if (muted) player.pause();
  }

  // --- Waveform -------------------------------------------------------------

  const peakCache = {};

  async function loadPeaks(url, bars) {
    const key = url + '|' + bars;
    if (peakCache[key]) return peakCache[key];

    const data = await (await fetch(url)).arrayBuffer();
    // An offline context decodes without needing a click on the page.
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buffer = await ctx.decodeAudioData(data);

    const channel = buffer.getChannelData(0);
    const size = Math.floor(channel.length / bars) || 1;
    const peaks = [];
    let loudest = 0;
    for (let i = 0; i < bars; i++) {
      let max = 0;
      const startAt = i * size;
      for (let j = 0; j < size; j++) {
        const value = Math.abs(channel[startAt + j] || 0);
        if (value > max) max = value;
      }
      peaks.push(max);
      if (max > loudest) loudest = max;
    }
    const normalised = peaks.map(p => (loudest ? p / loudest : 0));
    peakCache[key] = normalised;
    return normalised;
  }

  // Draws the clip's waveform into a canvas and keeps a played/unplayed
  // split moving while this page is playing that clip. The played part is
  // full brightness and the rest dimmed, so the split reads on brightness
  // alone rather than on colour.
  async function drawWaveform(canvas) {
    const url = canvas.dataset.src;
    if (!url || canvas.dataset.drawn === url) return;
    canvas.dataset.drawn = url;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    canvas.width = width;
    canvas.height = height;

    const barWidth = Math.max(2, Math.round(5 * dpr));
    const gap = Math.max(1, Math.round(3 * dpr));
    const bars = Math.max(8, Math.floor(width / (barWidth + gap)));

    let peaks;
    try {
      peaks = await loadPeaks(url, bars);
    } catch (err) {
      return;
    }

    const colour = canvas.dataset.colour || '#ffb400';
    const g = canvas.getContext('2d');

    function frame() {
      if (!canvas.isConnected || canvas.dataset.drawn !== url) return;

      const playingThis = currentSrc && url.endsWith(currentSrc.replace(/^.*\//, ''));
      const progress = playingThis && player.duration
        ? player.currentTime / player.duration
        : 0;

      g.clearRect(0, 0, width, height);
      const mid = height / 2;
      for (let i = 0; i < peaks.length; i++) {
        const barHeight = Math.max(2 * dpr, peaks[i] * height * 0.9);
        const x = i * (barWidth + gap);
        g.globalAlpha = i / peaks.length < progress ? 1 : 0.35;
        g.fillStyle = colour;
        g.fillRect(x, mid - barHeight / 2, barWidth, barHeight);
      }
      g.globalAlpha = 1;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function drawAll(root) {
    (root || document).querySelectorAll('canvas.waveform').forEach(drawWaveform);
  }

  return {
    sync,
    resume,
    setMuted,
    drawAll,
    set onBlocked(fn) { onBlocked = fn; },
    get element() { return player; }
  };
})();
