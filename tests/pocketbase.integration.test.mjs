import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, cp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createServer } from 'node:net'
import PocketBase from 'pocketbase'
import { unzipSync } from 'fflate'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export async function fixture({ empty = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ds-chat-test-'))
  await cp(path.join(root, 'pocketbase/pb_migrations'), path.join(directory, 'migrations'), {
    recursive: true,
  })
  if (!empty)
    await writeFile(
      path.join(directory, 'migrations/1794900002_test.js'),
      `migrate((app) => {
    for (const [email, password] of [['owner@example.test', 'test-password-for-primary-user'], ['other@example.test', 'test-password-for-other-user']]) {
      const user = new Record(app.findCollectionByNameOrId('chat_users'))
      user.set('email', email); user.set('password', password); app.save(user)
    }
    const admin = new Record(app.findCollectionByNameOrId('_superusers'))
    admin.set('email', 'admin@example.test'); admin.set('password', 'test-password-for-backup-admin'); app.save(admin)
  })`
    )
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  socket.close()
  await once(socket, 'close')
  const url = `http://127.0.0.1:${port}`
  let server
  async function start() {
    server = spawn(
      path.join(root, 'pocketbase/pocketbase'),
      [
        'serve',
        `--http=127.0.0.1:${port}`,
        `--dir=${directory}/data`,
        `--migrationsDir=${directory}/migrations`,
        `--hooksDir=${root}/pocketbase/pb_hooks`,
        `--publicDir=${root}/dist`,
      ],
      {
        stdio: 'ignore',
        env: { ...process.env, DS_CHAT_SETUP_ORIGIN: 'https://ds-chat.test-tailnet.ts.net:8446' },
      }
    )
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${url}/api/health`)).ok) return
      } catch {}
      if (server.exitCode !== null) throw new Error('Test PocketBase failed to start')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Test PocketBase startup timed out')
  }
  async function stop() {
    server.kill()
    await once(server, 'exit')
  }
  await start()
  const client = new PocketBase(url)
  client.autoCancellation(false)
  if (!empty)
    await client
      .collection('chat_users')
      .authWithPassword('owner@example.test', 'test-password-for-primary-user')
  return {
    url,
    client,
    directory,
    restart: async () => {
      await stop()
      await start()
    },
    close: async () => {
      await stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
export const session = (id = 'test-conversation') => ({
  id,
  title: 'Shared history',
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: 'q1',
  messages: [
    {
      id: 'q1',
      role: 'user',
      content: 'Preserve branches',
      files: [],
      createdAt: 1,
      parentId: null,
      selectedChildId: 'a2',
    },
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'First answer' }],
      createdAt: 2,
      model: 'deepseek-flash',
      prefix: true,
      status: 'done',
      parentId: 'q1',
    },
    {
      id: 'a2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Alternate answer' }],
      createdAt: 3,
      model: 'deepseek-flash',
      prefix: true,
      status: 'done',
      parentId: 'q1',
    },
  ],
})

if (process.argv[1] === fileURLToPath(import.meta.url))
  test('PocketBase isolation, revisions, files, replacement and tombstones', async () => {
    const f = await fixture()
    const pb = f.client
    try {
      const guest = new PocketBase(f.url)
      await assert.rejects(
        guest.send('/api/ds-chat/save', {
          method: 'POST',
          body: { session: session(), revision: 0 },
        }),
        (e) => e.status === 401
      )
      const account = await guest.send('/api/ds-chat/setup', { method: 'GET' })
      assert.equal(account.needsSetup, false)
      await assert.rejects(
        guest.collection('chat_users').create({
          email: 'uninvited@example.test',
          password: 'uninvited-password',
          passwordConfirm: 'uninvited-password',
        })
      )
      await assert.rejects(
        guest.send('/api/ds-chat/setup', {
          method: 'POST',
          headers: { Origin: 'http://127.0.0.1:8091' },
          body: { email: 'uninvited@example.test', password: 'uninvited-password' },
        }),
        (e) => e.status === 403
      )
      const saved = await pb.send('/api/ds-chat/save', {
        method: 'POST',
        body: { session: session(), revision: 0 },
      })
      assert.equal(saved.revision, 1)
      const record = await pb
        .collection('chat_sessions')
        .getFirstListItem('sid="test-conversation"')
      assert.deepEqual(record.payload, session())
      await assert.rejects(
        pb.collection('chat_sessions').update(record.id, { payload: session() }),
        (e) => e.status === 403
      )
      await assert.rejects(
        pb.send('/api/ds-chat/save', {
          method: 'POST',
          body: { session: { ...session(), title: 'Stale overwrite' }, revision: 0 },
        }),
        (e) => e.status === 409
      )
      // Two devices with the same revision: exactly one succeeds.
      const updates = await Promise.allSettled(
        ['laptop', 'phone'].map((title) =>
          pb.send('/api/ds-chat/save', {
            method: 'POST',
            body: { session: { ...session(), title }, revision: 1 },
          })
        )
      )
      assert.equal(updates.filter((r) => r.status === 'fulfilled').length, 1)
      assert.equal(updates.find((r) => r.status === 'rejected').reason.status, 409)
      const other = new PocketBase(f.url)
      await other
        .collection('chat_users')
        .authWithPassword('other@example.test', 'test-password-for-other-user')
      assert.equal((await other.collection('chat_sessions').getFullList()).length, 0)
      await assert.rejects(
        other.collection('chat_sessions').getOne(record.id),
        (e) => e.status === 404
      )
      const body = new FormData()
      body.set('owner', pb.authStore.record.id)
      body.set('fid', 'test-file')
      body.set('original', new Blob(['attachment contents']), 'test.txt')
      const file = await pb.collection('chat_files').create(body)
      const fileUrl = pb.files.getURL(file, file.original)
      assert.equal((await fetch(fileUrl)).status, 404)
      const token = await pb.files.getToken()
      assert.equal(
        await (await fetch(pb.files.getURL(file, file.original, { token }))).text(),
        'attachment contents'
      )
      const otherToken = await other.files.getToken()
      assert.equal(
        (await fetch(pb.files.getURL(file, file.original, { token: otherToken }))).status,
        404
      )
      // History replacement is transactional and rejects stale snapshots / duplicate ids.
      await assert.rejects(
        pb.send('/api/ds-chat/replace', {
          method: 'POST',
          body: { sessions: [], expected: [{ sid: 'test-conversation', revision: 1 }] },
        }),
        (e) => e.status === 409
      )
      await assert.rejects(
        pb.send('/api/ds-chat/replace', {
          method: 'POST',
          body: {
            sessions: [session('new'), session('new')],
            expected: [{ sid: 'test-conversation', revision: 2 }],
          },
        }),
        (e) => e.status === 400
      )
      assert.equal(
        (await pb.collection('chat_sessions').getFullList({ filter: 'deleted=false' })).length,
        1
      )
      await pb.send('/api/ds-chat/replace', {
        method: 'POST',
        body: {
          sessions: [session('imported')],
          expected: [{ sid: 'test-conversation', revision: 2 }],
        },
      })
      assert.equal(
        (await pb.collection('chat_sessions').getFirstListItem('sid="test-conversation"')).deleted,
        true
      )
      await assert.rejects(
        pb.send('/api/ds-chat/save', { method: 'POST', body: { session: session(), revision: 3 } }),
        (e) => e.status === 409
      )
      assert.deepEqual(
        (await pb.collection('chat_sessions').getFirstListItem('sid="imported"')).payload,
        session('imported')
      )
      await f.restart()
      assert.deepEqual(
        (await pb.collection('chat_sessions').getFirstListItem('sid="imported"')).payload,
        session('imported')
      )
      const admin = new PocketBase(f.url)
      await admin
        .collection('_superusers')
        .authWithPassword('admin@example.test', 'test-password-for-backup-admin')
      const settings = await admin.settings.getAll()
      assert.equal(settings.backups.cron, '0 3 * * *')
      assert.equal(settings.backups.cronMaxKeep, 7)
      await admin.backups.create('integration-backup.zip')
      const zip = unzipSync(
        await readFile(path.join(f.directory, 'data/backups/integration-backup.zip'))
      )
      assert.ok(zip['data.db'])
      assert.ok(Object.keys(zip).some((name) => name.includes(file.original)))
      await pb.send('/api/ds-chat/replace', {
        method: 'POST',
        body: { sessions: [session()], expected: [{ sid: 'imported', revision: 1 }] },
      })
      assert.equal(
        (await pb.collection('chat_sessions').getFirstListItem('sid="test-conversation"')).deleted,
        false
      )
      console.log(
        'Verified authentication, account isolation, conflict rejection, atomic replacement, tombstones and protected attachments.'
      )
    } finally {
      await f.close()
    }
  })

if (process.argv[1] === fileURLToPath(import.meta.url))
  test('First-account setup accepts only configured origins and closes after setup', async () => {
    const f = await fixture({ empty: true })
    try {
      const body = {
        email: 'personal@example.test',
        password: 'test-private-setup-password',
        passwordConfirm: 'test-private-setup-password',
      }
      assert.equal((await f.client.send('/api/ds-chat/setup', { method: 'GET' })).needsSetup, true)
      await assert.rejects(
        f.client.send('/api/ds-chat/setup', {
          method: 'POST',
          body,
          headers: { Origin: 'https://unrelated.example' },
        }),
        (e) => e.status === 403
      )
      await f.client.send('/api/ds-chat/setup', {
        method: 'POST',
        body,
        headers: { Origin: 'https://ds-chat.test-tailnet.ts.net:8446' },
      })
      await f.client.collection('chat_users').authWithPassword(body.email, body.password)
      assert.equal((await f.client.send('/api/ds-chat/setup', { method: 'GET' })).needsSetup, false)
      await assert.rejects(
        f.client.send('/api/ds-chat/setup', {
          method: 'POST',
          body,
          headers: { Origin: 'https://ds-chat.test-tailnet.ts.net:8446' },
        }),
        (e) => e.status === 403
      )
    } finally {
      await f.close()
    }
  })

test('Project folders are private to their owner', async () => {
  const f = await fixture()
  try {
    const project = await f.client
      .collection('chat_projects')
      .create({ name: 'Private work', owner: f.client.authStore.record.id })
    const other = new PocketBase(f.url)
    await other
      .collection('chat_users')
      .authWithPassword('other@example.test', 'test-password-for-other-user')
    assert.equal((await other.collection('chat_projects').getFullList()).length, 0)
    await assert.rejects(other.collection('chat_projects').update(project.id, { name: 'Stolen' }))
    await assert.rejects(other.collection('chat_projects').delete(project.id))
    await assert.rejects(
      f.client.collection('chat_projects').update(project.id, { owner: other.authStore.record.id })
    )
    await f.client.collection('chat_projects').update(project.id, { name: 'Renamed' })
    assert.equal((await f.client.collection('chat_projects').getOne(project.id)).name, 'Renamed')
  } finally {
    await f.close()
  }
})
