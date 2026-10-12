# Audio Recording Tab Privacy Policy

**Last updated:** October 2026

## Data collection

Audio Recording Tab does **not** collect, store remotely or transmit any
personal data. There is no analytics, telemetry, tracking or user account.

## What stays on your computer

- **Recordings.** Audio is encoded locally in the browser and saved with
  Firefox's downloads to your computer. While a recording is in progress,
  the encoded audio is kept in the extension's local storage (IndexedDB)
  so that it can be recovered after a crash; it is deleted once the file
  is saved or discarded.
- **Settings.** Bitrate, file name template and the last chosen audio
  device are kept in the extension's local storage, together with local
  timing statistics of device recordings used to detect audio glitches.
  Nothing of this leaves your computer.

## Network access

The extension makes no requests of its own. When a page plays audio from
another site, or an endless internet radio stream, the extension downloads
that same media address so that it can be recorded, exactly as the page
itself does. Nothing is sent to the developer or to any other server.

## Permissions

- **Access to all websites** — to capture the audio that pages play and
  to read media that a page loads from other sites.
- **Downloads** — to save the recorded file.
- **Storage** — to keep settings and unfinished recordings locally.
- **Microphone (only when you choose to record from an audio device)** —
  Firefox asks for it; virtual audio devices count as microphones.

## Contact

Questions and issues: https://github.com/lyapupastar-png
