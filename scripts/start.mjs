import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(
  path.join(root, 'pocketbase', process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase'),
  [
    'serve',
    '--http=127.0.0.1:8091',
    `--dir=${root}/pocketbase/pb_data`,
    `--hooksDir=${root}/pocketbase/pb_hooks`,
    `--migrationsDir=${root}/pocketbase/pb_migrations`,
    `--publicDir=${root}/dist`,
  ],
  { cwd: root, stdio: 'inherit', env: process.env }
)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (error) => {
  console.error(error.message)
  process.exit(1)
})
