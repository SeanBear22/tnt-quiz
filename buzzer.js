// Buzzer sounds and fast buzz updates, shared by the host, player and viewer
// pages.
//
// The normal state poll runs once a second, which is too slow for a buzzer:
// the sound would land up to a second after the press. While a buzzer round is
// on, this polls the tiny /api/buzz endpoint five times a second instead, and
// plays the winning seat's sound as soon as a new buzz appears.
//
// Sounds go through one AudioContext so they start without the delay an
// <audio> element has. Custom sounds are downloaded and decoded ahead of time.
// A seat with no custom sound gets the built-in buzzer, which is generated
// here rather than loaded from a file.
(function () {
  const MAX_SECONDS = 4;          // custom sounds are cut off after this
  const POLL_MS = 200;

  let ctx = null;
  let master = null;
  let playing = null;             // nodes of the sound currently playing
  const buffers = {};             // filename -> AudioBuffer (or a pending promise)
  let sounds = {};                // slot -> filename or null

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    }
    return ctx;
  }

  // Browsers keep audio switched off until the page has been clicked or a key
  // pressed. Any click or key on the page switches it on.
  function unlock() {
    const c = audio();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(type => {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  });

  function isBlocked() {
    const c = audio();
    return !c || c.state !== 'running';
  }

  function load(filename) {
    if (!filename || buffers[filename]) return;
    const c = audio();
    if (!c) return;
    buffers[filename] = fetch('/uploads/' + encodeURIComponent(filename))
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(data => new Promise((resolve, reject) => c.decodeAudioData(data, resolve, reject)))
      .then(buffer => { buffers[filename] = buffer; return buffer; })
      .catch(() => { delete buffers[filename]; return null; });
  }

  // Called with state.buzzerSounds on every state update. Cheap when nothing
  // has changed.
  function setSounds(map) {
    sounds = Object.assign({}, map || {});
    Object.values(sounds).forEach(load);
  }

  function stop() {
    if (!playing) return;
    playing.forEach(node => { try { node.stop(); } catch (e) {} });
    playing = null;
  }

  // The built-in buzzer: two slightly out-of-tune low tones, harsh and flat,
  // with a short hard stop. About 0.8 seconds.
  function playDefault(c) {
    const t = c.currentTime + 0.01;
    const length = 0.8;

    const env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.32, t + 0.012);
    env.gain.setValueAtTime(0.32, t + length - 0.07);
    env.gain.linearRampToValueAtTime(0, t + length);

    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2400;
    tone.Q.value = 0.7;
    tone.connect(env);
    env.connect(master);

    const a = c.createOscillator();
    a.type = 'square';
    a.frequency.value = 110;
    const b = c.createOscillator();
    b.type = 'sawtooth';
    b.frequency.value = 117;
    const bGain = c.createGain();
    bGain.gain.value = 0.8;

    a.connect(tone);
    b.connect(bGain);
    bGain.connect(tone);
    a.start(t);
    b.start(t);
    a.stop(t + length + 0.02);
    b.stop(t + length + 0.02);
    playing = [a, b];
  }

  // Plays the sound for a seat: its custom sound if one is set and loaded,
  // otherwise the built-in buzzer. Returns false if the browser is still
  // blocking audio.
  function play(slot, filenameOverride) {
    const c = audio();
    if (!c) return false;
    unlock();
    stop();
    const filename = filenameOverride !== undefined ? filenameOverride : sounds[slot];
    const buffer = filename ? buffers[filename] : null;
    if (buffer && typeof buffer.then !== 'function') {
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.connect(master);
      source.start(c.currentTime + 0.01, 0, Math.min(buffer.duration, MAX_SECONDS));
      playing = [source];
    } else {
      if (filename) load(filename);
      playDefault(c);
    }
    return c.state === 'running';
  }

  // Previews a sound before it is assigned, e.g. a file just picked on the
  // host page. Falls back to the built-in buzzer if it can't be decoded.
  function previewFile(file) {
    const c = audio();
    if (!c) return Promise.resolve(false);
    unlock();
    return file.arrayBuffer()
      .then(data => new Promise((resolve, reject) => c.decodeAudioData(data, resolve, reject)))
      .then(buffer => {
        stop();
        const source = c.createBufferSource();
        source.buffer = buffer;
        source.connect(master);
        source.start(c.currentTime + 0.01, 0, Math.min(buffer.duration, MAX_SECONDS));
        playing = [source];
        return buffer.duration;
      });
  }

  // --- Buzz updates -------------------------------------------------------
  // Buzz data arrives from two places: the full state poll (every second) and
  // the fast /api/buzz poll. feed() takes either, ignores anything older than
  // what it has already seen, and calls onChange with the newest. A new buzzId
  // plays that seat's sound, except on the very first update after the page
  // loads, so a refresh doesn't replay an old buzz.
  function createWatcher(options) {
    let latest = null;
    let lastBuzzId = null;
    let timer = null;
    let inFlight = false;

    function feed(buzz) {
      if (!buzz) return;
      if (latest && buzz.version < latest.version) return;
      const changed = !latest || buzz.version !== latest.version;
      latest = buzz;

      if (lastBuzzId === null) {
        lastBuzzId = buzz.buzzId;
      } else if (buzz.buzzId !== lastBuzzId) {
        lastBuzzId = buzz.buzzId;
        if (buzz.holder && options.sound !== false) play(buzz.holder);
        if (options.onBuzz) options.onBuzz(buzz);
      }
      if (changed && options.onChange) options.onChange(buzz);
      schedule();
    }

    async function poll() {
      timer = null;
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch('/api/buzz' + (options.viewer ? '?viewer=1' : ''), {
          headers: options.headers ? options.headers() : {},
          cache: 'no-store'
        });
        if (res.ok) feed(await res.json());
      } catch (e) {
        // A missed poll is fine; the next one or the state poll catches up.
      } finally {
        inFlight = false;
        schedule();
      }
    }

    // Only polls quickly while a buzzer round is on.
    function schedule() {
      if (timer || inFlight) return;
      if (!latest || !latest.round) return;
      timer = setTimeout(poll, POLL_MS);
    }

    return {
      feed,
      get latest() { return latest; }
    };
  }

  window.TNTBuzzer = { setSounds, play, stop, previewFile, isBlocked, unlock, createWatcher };
})();
