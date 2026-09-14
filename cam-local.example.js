// Local overrides for this deployment. Copy to cam-local.js and edit.
// cam-local.js is gitignored, so a git pull will never touch it.
//
// Only include the values you want to change. Anything left out keeps the
// default from cam-config.js.

window.CAM_LOCAL = {
  password: 'set-a-real-password-here',

  // Optional: rename seats if your stream IDs differ.
  // streamIds: { player1: 'tnt-troy' },

  // Optional: give one person a heavier audio chain without restating the
  // others. The gate is aggressive, so only use it where it is needed.
  // audioChain: {
  //   player3: '&lowcut=100&compressor&noisegate&noisegatesettings=3,20,2500'
  // },

  // Optional: lower this if anyone's connection struggles.
  // videoBitrate: 900
};
