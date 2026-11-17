import { createHash } from 'node:crypto'
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { unzipSync } from 'fflate'
const version = '0.40.6'
const platform = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform]
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
if (!platform || !arch)
  throw new Error('Unsupported platform. Download PocketBase manually from its official releases.')
const filename = `pocketbase_${version}_${platform}_${arch}.zip`
const base = `https://github.com/pocketbase/pocketbase/releases/download/v${version}`
async function download(name) {
  const response = await fetch(`${base}/${name}`)
  if (!response.ok) throw new Error(`Download failed: ${name} (${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}
const [archive, checksums] = await Promise.all([download(filename), download('checksums.txt')])
const expected = checksums
  .toString()
  .split('\n')
  .find((line) => line.trim().endsWith(filename))
  ?.split(/\s+/)[0]
if (!expected || createHash('sha256').update(archive).digest('hex') !== expected)
  throw new Error('PocketBase checksum verification failed')
const destination = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../pocketbase')
const executable = process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase'
await mkdir(destination, { recursive: true })
await writeFile(path.join(destination, executable), unzipSync(archive)[executable])
await chmod(path.join(destination, executable), 0o755)
console.log(`Installed PocketBase ${version} with verified SHA-256 checksum.`)
