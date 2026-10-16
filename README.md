# Revin-MD WhatsApp Bot

Revin-MD is a Node.js WhatsApp bot. This guide covers running it on a VPS, Render, or Heroku.

## Requirements and important notes

- Use Node.js 22 or newer. The `.song` command uses Node as yt-dlp's JavaScript runtime.
- Install FFmpeg for `.song` audio conversion. It is included in the Docker image below.
- Run exactly one bot instance for each WhatsApp account. Multiple instances can compete for the same connection and session.
- The bot stores its WhatsApp login under `auth/`. Keep that directory on persistent storage and private. Never commit `auth/` or `.env` to GitHub.
- On first start, scan the pairing QR code shown in the process logs. Keep the `auth/` directory when updating the bot so it stays logged in.

Configure the environment by copying `.env.example` to `.env` on a VPS, or by adding the same variables in the hosting provider's environment settings. `SONG_COOKIES_FILE` is optional and should only be set when a cookies file is available at that path.

## VPS (Ubuntu or Debian)

1. Install Git, FFmpeg, Node.js 22+, and npm. For example, install Git and FFmpeg with:

   ```sh
   sudo apt update
   sudo apt install -y git ffmpeg
   ```

   Install Node.js 22 or newer using the [official Node.js download instructions](https://nodejs.org/en/download). Confirm with `node --version` and `npm --version`.

2. Clone the repo and install its dependencies:

   ```sh
   git clone https://github.com/Revnin/Revin-md.git
   cd Revin-md
   npm ci
   cp .env.example .env
   nano .env
   ```

3. Start it under PM2 and pair WhatsApp:

   ```sh
   sudo npm install --global pm2
   pm2 start index.js --name revin-md
   pm2 logs revin-md
   ```

   Scan the QR code shown in the logs. Then enable startup on reboot:

   ```sh
   pm2 startup
   ```

   Run the `sudo ...` command printed by PM2, then save the process list:

   ```sh
   pm2 save
   ```

   Keep the checkout, `.env`, and `auth/` directory on the VPS. To update later:

   ```sh
   cd Revin-md
   git pull --ff-only
   npm ci
   pm2 restart revin-md --update-env
   ```

## Render

Use a **Background Worker** because this bot maintains an outgoing WhatsApp connection and does not serve an HTTP website. A persistent disk is required to keep the WhatsApp login across restarts and deploys. See Render's [Docker](https://render.com/docs/docker), [Background Worker](https://render.com/docs/background-workers), and [Persistent Disk](https://render.com/docs/disks) documentation.

1. Connect this GitHub repo in Render and create a Background Worker with Docker as its runtime. The included `Dockerfile` installs FFmpeg and starts the bot.
2. Add a persistent disk and set its mount path to `/app/auth`. This matches the directory where the bot stores its WhatsApp session. Do not scale this service above one instance.
3. Add the variables from `.env.example` in the service's Environment settings. Do not upload `.env` or WhatsApp credentials to the repo.
4. Deploy, open the service logs, and scan the pairing QR code on first start.

## Heroku

This repo includes a Dockerfile so the bot can run as a Heroku worker with FFmpeg installed. Heroku's dyno filesystem is ephemeral, so the `auth/` session is lost when the dyno restarts or is replaced. You may need to scan a new QR code after restarts. For a persistent WhatsApp session, use a VPS or Render with a persistent disk, or add external session storage before using Heroku. See Heroku's [Container Registry](https://devcenter.heroku.com/articles/container-registry-and-runtime) and [dyno filesystem](https://devcenter.heroku.com/articles/dyno-isolation) documentation.

1. Install the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) and Docker, then log in:

   ```sh
   heroku login
   heroku container:login
   ```

2. From the repo directory, create a Heroku app using the container stack (or select an existing app):

   ```sh
   heroku create YOUR-APP-NAME --stack container
   ```

3. Add the variables from `.env.example` as Heroku config vars. For example:

   ```sh
   heroku config:set BOT_NAME="Revin-MD" PREFIX="." OWNER_NAME="Revin" -a YOUR-APP-NAME
   ```

4. Build and release the worker image, then start one worker dyno:

   ```sh
   heroku container:push worker -a YOUR-APP-NAME
   heroku container:release worker -a YOUR-APP-NAME
   heroku ps:scale worker=1 -a YOUR-APP-NAME
   heroku logs --tail -a YOUR-APP-NAME
   ```

   Scan the QR code in the logs. Heroku does not persist the `auth/` directory across dyno restarts.

## Troubleshooting

- **No QR code or login loop:** check the logs and confirm the `auth/` directory is writable and persistent.
- **`.song` fails:** verify Node.js is version 22 or newer and FFmpeg is installed. If YouTube requests authentication, configure `SONG_COOKIES_FILE` to point to a valid cookies file stored securely on the host.
- **Bot disconnects after deploy/restart:** confirm only one instance is running and that the platform preserves `auth/`.
