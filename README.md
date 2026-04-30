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

## Warning

Yolo mode lets Codex edit files and run commands without approval. Keep this bridge local, use only your Telegram user ID, and do not expose Codex App Server to the network.
