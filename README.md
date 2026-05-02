# Codex Telegram Bridge

Local Telegram control for a Codex App Server thread.

This project is intentionally local-first:

- Telegram talks to this bridge.
- This bridge spawns `codex app-server` over stdio.
- Codex works on your local project folder.
- Every bridge launch starts a fresh Codex thread, even for the same project.
- There is intentionally no resume/session-restore path.
- The bridge does not persist its own session store.
- Telegram attachments, voice scratch files, and Codex-created Telegram-only files use a per-run OS temp folder and are cleaned up.
- `cdxyt` is yolo mode: `approvalPolicy: "never"` and `sandbox: "danger-full-access"`.
- The Codex model is fixed to `gpt-5.5`.
- The Codex reasoning level is fixed to `high`.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with your Telegram bot token and your Telegram user ID.

## Run

```bash
npm run dev -- --cwd "$PWD" --yolo
```

Recommended zsh function:

```zsh
cdxyt() {
  (cd /Users/smaetongmenglay/Documents/development/me-and-codex && npm run dev -- --cwd "$PWD" --yolo)
}
```

## Telegram Messages

Every private text message from the allowed Telegram user is sent to the active
Codex thread, including slash-prefixed text.

English Telegram voice messages are downloaded locally, transcribed with
`whisper.cpp`, and sent to the active Codex thread as text. When a turn starts
from a voice message, the bridge sends Codex's final answer back as a Telegram
voice note by default. Voice replies are generated locally with macOS `say` and
encoded to Opus with `ffmpeg`.

Photos and documents are downloaded to the bridge temp folder and sent to Codex.
Images are passed as Codex `localImage` inputs when the selected model supports
image input; other files are sent as temp file paths for Codex to inspect. The
downloaded files are deleted when the turn finishes or fails.

Codex can also ask the bridge to send a local file back to Telegram. For example:

```text
I believe my CV is somewhere in Documents/cv, not sure. Please check and send it here.
```

Codex searches locally. If it finds one clear safe match, it emits an internal
marker and the bridge sends the file. If there are multiple plausible matches,
Codex should list choices and wait for you to pick one.

Outbound markers supported by the bridge:

- `[[telegram_send_file:/absolute/path]]` - send the original file with `sendDocument`
- `[[telegram_send_photo:/absolute/path]]` - send an inline Telegram photo with `sendPhoto`
- `[[telegram_send_both:/absolute/path]]` - send an inline photo preview, then the original file

For images, `sendDocument` is the uncompressed/original option. Telegram photos
sent with `sendPhoto` may be compressed or resized by Telegram.

The bridge validates every outbound file before upload:

- the path must exist and be a regular file
- the path must resolve inside your home directory or the bridge temp folder
- the file must be under 50 MB
- obvious secrets and credentials are blocked

When Codex creates a file only for Telegram delivery, the bridge instructs it to
write that file under the per-run temp folder. Files uploaded from that folder are
deleted after successful Telegram upload. Existing files outside the bridge temp
folder are never auto-deleted after upload.

The only `.env` settings are the Telegram bot token and allowed Telegram user ID:

```bash
TELEGRAM_BOT_TOKEN=123456:replace_me
TELEGRAM_ALLOWED_USER_ID=123456789
```

Other local settings are intentionally hardcoded for this personal bridge: file
uploads are allowed from your home directory, outbound uploads are capped at
50 MB, voice input is English-only through
`~/whisper.cpp-build/bin/whisper-cli` with the model at
`~/whisper-models/ggml-large-v3-turbo-q5_0.bin`, voice replies are enabled,
voice replies are capped at 3500 characters, and `ffmpeg`/macOS `say` are
discovered from the usual local paths.

## Warning

Yolo mode lets Codex edit files and run commands without approval. Keep this bridge local, use only your Telegram user ID, and do not expose Codex App Server to the network.
