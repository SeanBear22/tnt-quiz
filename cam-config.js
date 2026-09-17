// VDO.Ninja configuration
// ----------------------------------------------------------------------------
// Everything to do with the webcam feeds is configured here, so stream IDs and
// per-person audio tweaks can be changed without touching page markup.
//
// Deployment-specific values (the room password above all) belong in
// cam-local.js, which is gitignored. Copy cam-local.example.js to
// cam-local.js and edit that instead of this file, so a git pull never
// collides with local settings. See the bottom of this file.
//
// Audio and video travel together in one stream per person, so they stay in
// sync with no offset needed anywhere.

const VDO = {
  // Shared room. Change the password before the first real session; anyone
  // with it can join the call.
  room: 'tntquiz',
  password: 'change-me-before-going-live',

  // Stream ID per seat. These are what the viewer page views, so they must
  // match what each person pushes.
  // Underscores, not hyphens. VDO.Ninja sanitises stream IDs when publishing
  // and a hyphen comes back as an underscore, so a hyphenated ID here
  // publishes as something the viewer link never finds.
  streamIds: {
    host: 'tnt_host',
    player1: 'tnt_p1',
    player2: 'tnt_p2',
    player3: 'tnt_p3',
    player4: 'tnt_p4'
  },

  // Audio chain applied at the source, so each person can be tuned to their
  // own room. lowcut removes desk rumble and fan hum; compressor evens out
  // anyone who leans away from the mic mid-sentence.
  //
  // If someone turns out to be in a genuinely noisy room, give them their own
  // entry with a gate, for example:
  //   player3: '&lowcut=100&compressor&noisegate&noisegatesettings=3,20,2500'
  // The gate is aggressive: a gated guest is inaudible while someone else is
  // talking, so only use it where it is needed.
  //
  // Do not add &proaudio or &stereo here. They disable echo cancellation,
  // auto gain and noise suppression.
  audioChain: {
    default: '&lowcut=100&compressor'
  },

  // Outbound video. 1200kbps keeps six simultaneous uploads comfortable on a
  // domestic connection. Raise it if the picture looks soft.
  videoBitrate: 1200,

  // Mirror the feed on the viewer page. Off by default, which is what the
  // camera actually sees: anything with writing on it reads correctly, and
  // that is normally what you want going out on a broadcast. Set to true if
  // you would rather everyone appear as they see themselves. Can be set per
  // seat with an object, e.g. mirror: { player2: true }.
  mirror: false
};

// Apply cam-local.js if one is present. Top-level keys replace the defaults;
// streamIds and audioChain are merged key by key so a local file can override
// one seat without restating all of them.
if (typeof window !== 'undefined' && window.CAM_LOCAL) {
  const local = window.CAM_LOCAL;
  Object.keys(local).forEach(key => {
    if (key === 'streamIds' || key === 'audioChain') {
      Object.assign(VDO[key], local[key]);
    } else {
      VDO[key] = local[key];
    }
  });
}

// Link each person opens (embedded in the quiz page). Pushes their camera and
// mic into the room, and plays back everyone else's audio.
function vdoPushUrl(seat) {
  const id = VDO.streamIds[seat];
  if (!id) return null;
  const audio = VDO.audioChain[seat] || VDO.audioChain.default;
  return 'https://vdo.ninja/?' + [
    'room=' + encodeURIComponent(VDO.room),
    'password=' + encodeURIComponent(VDO.password),
    'push=' + encodeURIComponent(id),
    'webcam',
    // Without autostart the guest is shown VDO.Ninja's join screen with a
    // START button. Camera permission is not requested until that is clicked,
    // and device labels stay blank until permission is granted.
    'autostart',
    'quality=1',
    'videobitrate=' + VDO.videoBitrate,
    'cleanoutput'
  ].join('&') + audio;
}

// Link the viewer page uses per frame. Pulls one person's stream, with the UI
// stripped so only the picture lands inside the frame cutout.
function vdoViewUrl(seat) {
  const id = VDO.streamIds[seat];
  if (!id) return null;

  // Load /viewer?camdebug to keep VDO.Ninja's own UI and messages visible.
  // cleanoutput and transparent hide connection errors, which makes a frame
  // that is failing look identical to one that is simply empty.
  const debug = typeof location !== 'undefined'
    && location.search.indexOf('camdebug') !== -1;

  // Load /viewer?noaudio for a silent copy of the viewer page. Each frame
  // carries its own copy of the room audio, so anyone who also has the player
  // or host page open hears everyone twice. OBS should use the plain /viewer
  // URL; people should use this one.
  const silent = typeof location !== 'undefined'
    && location.search.indexOf('noaudio') !== -1;

  const params = [
    'view=' + encodeURIComponent(id),
    'room=' + encodeURIComponent(VDO.room),
    'password=' + encodeURIComponent(VDO.password),
    // Without &solo, a room URL makes this frame join as a publisher and ask
    // for a camera, instead of watching the stream named in &view.
    'solo'
  ];

  // Zoom and crop the video so it fills the frame cutout instead of sitting
  // letterboxed inside it.
  params.push('cover');

  if (silent) params.push('noaudio');

  const mirror = typeof VDO.mirror === 'object'
    ? !!VDO.mirror[seat]
    : !!VDO.mirror;
  if (mirror) params.push('mirror=1');

  if (!debug) params.push('cleanoutput', 'transparent');

  return 'https://vdo.ninja/?' + params.join('&');
}
