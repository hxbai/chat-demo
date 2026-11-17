import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.join(homedir(), '.config/systemd/user')
const origin = process.env.DS_CHAT_SETUP_ORIGIN || ''
if (origin && !/^https:\/\/[a-zA-Z0-9.-]+\.ts\.net(?::\d+)?$/.test(origin))
  throw new Error('Setup origin must be a private Tailscale HTTPS origin')
// Escape systemd specifiers and quoted argument characters for relocated checkouts.
const quote = (value) =>
  '"' + value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
await mkdir(directory, { recursive: true })
await writeFile(
  path.join(directory, 'ds-chat.service'),
  `[Unit]
Description=ds-chat PocketBase and web app
After=network.target

[Service]
Type=simple
WorkingDirectory=${root.replaceAll('%', '%%').replaceAll(' ', '\\x20')}
ExecStart=${quote(root + '/pocketbase/pocketbase')} serve --http=127.0.0.1:8091 ${quote('--dir=' + root + '/pocketbase/pb_data')} ${quote('--hooksDir=' + root + '/pocketbase/pb_hooks')} ${quote('--migrationsDir=' + root + '/pocketbase/pb_migrations')} ${quote('--publicDir=' + root + '/dist')}
Environment=${quote('DS_CHAT_SETUP_ORIGIN=' + origin)}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`
)
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
execFileSync('systemctl', ['--user', 'enable', '--now', 'ds-chat.service'], { stdio: 'inherit' })
console.log('ds-chat.service enabled. Use systemctl --user status ds-chat to inspect it.')
