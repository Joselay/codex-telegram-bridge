# Codex Telegram Bridge

Local Telegram control for a Codex App Server thread.

This project is intentionally local-first:

- Telegram talks to this bridge.
- This bridge spawns `codex app-server` over stdio.
- Codex works on your local project folder.
- Every bridge launch starts a fresh Codex thread, even for the same project.
- `cdxyt` is yolo mode: `approvalPolicy: "never"` and `sandbox: "danger-full-access"`.
- The default model is `gpt-5.5`, configurable with `CODEX_MODEL`.
- The default reasoning level is `high`, configurable with `CODEX_REASONING_LEVEL`.

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

## Telegram Commands

- `/start` - show current bridge status
- `/status` - show active project/thread
- `/session` - show active project/thread
- `/interrupt` - interrupt current Codex turn
- `/stop` - stop the bridge process

Any normal text message is sent to the active Codex thread.

Photos and documents are downloaded locally and sent to Codex. Images are passed as
Codex `localImage` inputs when the selected model supports image input; other files
are saved locally and sent as file paths for Codex to inspect.

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
- the path must resolve inside `TELEGRAM_FILE_SEND_ROOTS`
- the file must be under `TELEGRAM_FILE_SEND_MAX_MB`
- obvious secrets and credentials are blocked

Relevant optional `.env` settings:

```bash
# Comma-separated roots the bridge may upload from. Defaults to your home directory.
TELEGRAM_FILE_SEND_ROOTS=~

# Max outbound upload size in MB. Defaults to 50.
TELEGRAM_FILE_SEND_MAX_MB=50
```

## Warning

Yolo mode lets Codex edit files and run commands without approval. Keep this bridge local, use only your Telegram user ID, and do not expose Codex App Server to the network.
