# Codex Telegram Bridge

A local TypeScript bridge for controlling a Codex App Server thread from Telegram.

The bridge listens to private Telegram messages from one allowed user, forwards
them to a fresh local Codex thread, and sends Codex replies back to Telegram.
It can handle text, English voice messages, photos, documents, and safe file
delivery back to Telegram.

## Overview

- Starts `codex app-server` locally over stdio.
- Creates a fresh Codex thread on every bridge launch.
- Runs against the project directory passed with `--cwd`.
- Accepts messages only from `TELEGRAM_ALLOWED_USER_ID`.
- Stores Telegram attachments and temporary delivery files in a per-run temp folder.
- Runs Codex in YOLO mode with `approvalPolicy="never"` and `sandbox="danger-full-access"`.

## Requirements

- Node.js and npm
- Codex CLI available as `codex`
- A Telegram bot token
- Your Telegram user ID
- For voice support: `whisper.cpp`, a local Whisper model, `ffmpeg`, and macOS `say`

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:replace_me
TELEGRAM_ALLOWED_USER_ID=replace_me
```

## Run

From this bridge project:

```bash
npm run dev -- --cwd /path/to/project --yolo
```

Useful shell shortcut:

```zsh
cdxyt() {
  local cdxyt_cwd="$PWD"
  (cd /path/to/codex-telegram-bridge && npm run dev -- --cwd "$cdxyt_cwd" --yolo "$@")
}
```

Then run `cdxyt` inside the project you want Codex to work on. The name is
shorthand for Codex YOLO Telegram.

## Build

```bash
npm run build
npm start -- --cwd /path/to/project --yolo
```

## Safety

This bridge is intended for local personal use. YOLO mode lets Codex edit files
and run commands without approval, so keep the bot restricted to your Telegram
user ID and do not expose it publicly.
