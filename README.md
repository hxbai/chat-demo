# DS Chat

A personal, self-hosted fork of [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo), with **PocketBase-backed chat history and attachments shared across devices**. DeepSeek API keys and preferences remain in each browser.

## Access

Open the private app from a device connected to your tailnet. Sign in with the **same chat account** on your laptop and phone. Configure the DeepSeek API key separately in each device's Settings. The server hosts history; DeepSeek still performs inference, uploads and speech processing.

## Install and run

Requires Node.js 22.12+, pnpm, and a supported PocketBase platform. The included service installer targets Linux with systemd. The setup script installs PocketBase **0.40.6** and verifies the download against its published checksum.

```sh
pnpm install --frozen-lockfile
pnpm setup:pocketbase
pnpm build
pnpm start
```

`setup:pocketbase` downloads the pinned official release and verifies its SHA-256 against the published checksums. Do not replace the binary while the service is running; stop it before upgrading.

Open `http://127.0.0.1:8091` to create the first chat account. Registration closes once that account exists. To permit initial setup at a private Tailscale origin, set `DS_CHAT_SETUP_ORIGIN` to that exact HTTPS origin when starting the server. Passwords must match and contain at least 12 characters. The app account is a regular `chat_users` account, not a PocketBase superuser.

Serve a new instance through an **unused** Tailscale HTTPS port:

```sh
# First inspect your existing routes. Do not reset the configuration.
tailscale serve status
sudo tailscale serve --bg --https=8446 http://127.0.0.1:8091
```

Serve is private to the tailnet, subject to its access rules. The app also requires sign-in. Always use the same URL on a device: API keys, sign-in tokens and recovery storage are scoped to the browser origin. Access through Tailscale HTTPS also supports microphone access.

## Startup and operations

To install the user service, replace the example origin below with your own private Tailscale HTTPS origin:

```sh
DS_CHAT_SETUP_ORIGIN=https://YOUR-MACHINE.YOUR-TAILNET.ts.net:8446 pnpm service:install
```

Run `loginctl enable-linger "$USER"` if user lingering is not enabled and the service must start without an interactive login (your OS may require sudo).

```sh
systemctl --user status ds-chat
systemctl --user restart ds-chat
systemctl --user stop ds-chat
journalctl --user -u ds-chat -n 50
```

Service definition: `~/.config/systemd/user/ds-chat.service`. After editing hooks or migrations, restart the service. After editing the frontend, run `pnpm build`, then reload the app. The service uses the checkout's `dist/` directory directly.

For frontend development, keep PocketBase running on 8091 and run `pnpm dev` on `http://127.0.0.1:8090`. That development server proxies `/api` to PocketBase. First-account setup should use the production app on 8091 or its configured private HTTPS origin.

## Model and reasoning controls

Click the model/effort label beneath the composer to choose **DeepSeek Flash** (`deepseek-flash`) or **DeepSeek V4 Pro** (`deepseek-v4-pro`), and **Off / Low / High / Max** reasoning effort. The existing DeepThink toggle switches reasoning off/on while retaining your last effort level. Defaults preserve the upstream behavior: Flash with reasoning off, or your previously saved DeepThink preference.

These preferences are saved per device. Every reply stores its model and effort with its history on the server; continuation and upload retries retain the original reply's settings. New messages and regenerated replies use the current selection. ZIP exports include optional `ds_chat_model` and `ds_chat_effort` fields so ds-chat can restore these settings; older upstream archives remain supported.

The Anthropic-compatible endpoint accepts effort through `output_config.effort` when thinking is enabled. The picker exposes the distinct supported values rather than aliases. V4 Pro does not accept image input: the menu indicates this limitation, and incompatible image requests show an explanation before inference is sent. Select Flash and regenerate for image conversations.

References: [DeepSeek Messages API](https://api-docs.deepseek.com/api/create-message/) and [thinking-mode controls](https://api-docs.deepseek.com/guides/thinking_mode/).

Requests use `safety_check: { level: "low" }`, DeepSeek's default content checks, rather than the upstream demo's optional additional `high` review. This can reduce additional-review refusals, but the provider may still refuse requests, including web-tool requests. The app continues to honor refusal responses and does not recover or display refused answer text.

## History behavior

- Full conversations, including alternate message branches, are stored as JSON in `chat_sessions`; immutable original attachments are stored as protected files in `chat_files`.
- Realtime notifications trigger refreshes; a five-second fallback poll handles reconnects and missed events. Local edits and generated replies are not replaced by background refreshes.
- Replies are checkpointed about every three seconds, when the page hides, and when generation ends. The last few seconds can be lost if the browser or device abruptly crashes; generating replies do not continue on the server after the generating browser closes.
- Unsynced snapshots and pending original files are written to a per-account IndexedDB recovery store before network saves. Retry is automatic while the app is open. The app requires a server connection to load after a fresh page navigation; it is not an offline-installed app.
- Every server write checks its expected revision in a transaction. Stale saves are rejected instead of silently replacing another device's work. Use **Save conflicting chats as copies** to preserve the losing version as a separate conversation.
- Sign-out is disabled while changes are unsaved or generation is active. Other tabs reload if the signed-in account changes.
- Deleting a conversation writes a tombstone so an old device cannot silently recreate it. Import can explicitly restore an archived conversation.

## Existing history and archives

If this origin already has chats in the upstream app's `chat-demo` IndexedDB, **Import browser chats** copies them to the server without deleting the originals. Existing server conversations with matching IDs are preserved, and the imported version gets a new ID. Browsers cannot read storage belonging to another origin: export from the old app and import its ZIP from Settings if necessary.

Settings → Data → Import and Delete all chats operate on the **shared server history for all devices**. Import validates and stages the archive locally, uploads its images, then replaces the server conversation set in a single transaction. Concurrent server changes cause replacement to fail rather than erase those changes. The JSON replacement request is limited to PocketBase's default 32 MiB request size; each individual conversation JSON is limited to 20 MB.

Use **Projects → New folder** in the sidebar to organize conversations. Each folder has a **+** button to start a chat inside it; use a chat's **Move to folder** menu item to move existing chats or return them to the main list. Folders can be collapsed, renamed, or deleted. Deleting a folder keeps its chats in the main list. Folder names and membership sync with your account. After updating an existing installation, restart PocketBase so it applies the new `chat_projects` migration before using the new frontend.

Folder organization is included in full server backups. The upstream conversation ZIP format does not include folders, so ZIP imports return chats to the main list.

The upstream ZIP format exports conversations and available original **images**, with metadata for other attachments. It excludes API keys and preferences. Server backups, described below, include all locally stored attachments.

For recovery, unused server attachments are retained when chats are deleted or history is replaced. They consume disk until an administrator removes them or restores/cleans the database. Uploaded files at DeepSeek are separate and are not removed by ds-chat.

## Backups and restore

The initial migration configures PocketBase's built-in backups for **daily with the cron expression `0 3 * * *`**, keeping the most recent **seven scheduled backups**. Backups are full snapshots of the database and locally uploaded files in `pocketbase/pb_data/backups/`. Scheduled backups run while PocketBase is running; monitor backup creation and disk space.

The live database and attachments are in `pocketbase/pb_data/`. They and the executable are ignored by Git. **Keep this directory on local disk.** Copy completed backup ZIPs to another disk/machine for protection against disk failure; local backups alone do not protect against failure of the disk that hosts the application.

PocketBase's admin dashboard is at `/_/`. A separate superuser account is needed to administer accounts, backups or restores. If one has not been configured, find the one-time installer link in the server's initial logs (`journalctl --user -u ds-chat`); do not share that link. App credentials are not superuser credentials. Email delivery/password-reset recovery requires SMTP configuration.

To restore using a backup ZIP: stop the service, move the existing `pb_data` aside, extract the backup into a new `pocketbase/pb_data/`, restrict permissions to your user, and start the service. Keep the old directory until the restored history and attachments have been verified. Never copy the live SQLite files as a backup while PocketBase is writing; use its backup feature or stop the service first.

## Validation

```sh
pnpm type
pnpm lint
pnpm build
pnpm test:integration
pnpm test:browser
```

Integration tests start PocketBase with **temporary databases**, testing account isolation, revision conflicts, protected files, atomic replacement, first-account setup, backups and persistence across a restart. Browser tests use separate browser contexts to check device sync, branch fidelity, per-device API keys, offline recovery and conflict copies. Browser tests use `/usr/bin/google-chrome` by default; set `CHROME_PATH` to another installed Chromium executable. Tests do not call the live DeepSeek API or touch your personal chat database.

PocketBase remains pre-1.0: review its changelog and back up before upgrades. Schema migrations live in `pocketbase/pb_migrations/`; custom routes are in `pocketbase/pb_hooks/`.

## License

MIT, inherited from the upstream project. Include `LICENSE` when distributing the app. Dependencies retain their respective licenses.
