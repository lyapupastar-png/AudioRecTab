# Audio Recording Tab (AudioRecTab)

A Firefox extension that records the sound playing in a browser tab and
saves it as an MP3 or WAV file. Only the chosen tab is recorded: other
tabs, notifications and system sounds stay out of the file.

## Features

- Record the current tab with one click, or with a hotkey
  (`Alt+Shift+R` by default).
- Works without the toolbar button: an icon in the address bar opens the
  window (`Alt+Shift+O`), a hotkey saves the whole track (`Alt+Shift+S`) and
  reports progress in the tab title, and the settings page (Add-ons and
  themes → AudioRecTab → Settings) holds the options and a link to change
  the shortcuts.
- "Wait for sound" mode (`Alt+Shift+W`): recording starts when audio
  begins and stops when the track ends or after 5 seconds of pause.
- MP3 (selectable bitrate) or WAV output, with a file name template.
- Media from other sites and endless internet radio streams
  (Icecast/Shoutcast, MP3 and AAC) are supported.
- Recording from an audio device (microphone, virtual cable, Stereo Mix,
  PipeWire/PulseAudio monitor) for sound a tab does not hand over, with a
  built-in setup guide for macOS, Windows and Linux.
- Save a whole track at once, without playing it: direct audio files, HLS
  playlists (TS or fMP4 segments; AAC, MP3, Opus; AES-128) and, where a site
  has no HLS, DASH manifests (fMP4 or WebM). On other players the original
  audio the player loads is collected and saved as soon as the whole track
  has loaded or played (or on request). Live streams and DRM-protected music
  can only be recorded.
- An option to ignore the site's player volume and the tab mute, so the
  recording keeps the full level.
- Unsaved recordings survive a browser crash and can be saved afterwards.
- Interface in English, Russian and Ukrainian.

Requires Firefox 140 or newer (Firefox for Android 142 or newer).

## Privacy

The extension collects no data and sends nothing to the developer or any
third party. See [PRIVACY.md](PRIVACY.md).

## Building from source

Requirements: Node.js 20+ and npm.

```sh
npm ci
npm run build   # copies src/ and the LAME encoder into dist/
npm run pack    # builds release/audio_recording_tab-<version>.xpi
npm run lint    # web-ext lint
```

The build does not transpile or minify the extension code: `dist/` is
`src/` plus `lame.min.js` and its license, copied unchanged from the
[lamejs](https://www.npmjs.com/package/lamejs) package (version 1.2.1).

To try the build, open `about:debugging#/runtime/this-firefox` in Firefox
and choose "Load Temporary Add-on…" with `dist/manifest.json` or the
`.xpi` from `release/`.

## Tests

`npm test` runs an encoder unit test and end-to-end tests in a temporary
Firefox profile (Selenium + geckodriver). The end-to-end tests also need
`ffmpeg` on the `PATH`; set `FIREFOX_BIN` if Firefox is not in its
default location.

## License

Copyright (C) 2026 SPYder4

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the
Free Software Foundation, version 3. See [LICENSE](LICENSE).

The bundled MP3 encoder lamejs is distributed under the GNU LGPL
(see `LICENSE-lamejs.txt` in the built package).
