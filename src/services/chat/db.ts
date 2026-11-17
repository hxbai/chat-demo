import { openDB, type IDBPDatabase } from 'idb'
import { ClientResponseError, type RecordModel } from 'pocketbase'
import { pb } from '../pocketbase.js'
import * as local from './localDb.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

export type { StoredFile } from './localDb.js'
export {
  addStagingSession,
  clearStaging,
  saveStagingFiles,
  updateStagingFileTypes,
  reportStorageError,
} from './localDb.js'

type RemoteSession = RecordModel & {
  sid: string
  revision: number
  payload: Session
  summary: SessionSummary
  deleted: boolean
}
export type Recovery = {
  session: Session
  files: local.StoredFile[]
  revision: number
  writeId: string
}
const revisions = new Map<string, number>()
const historySnapshot = new Map<string, number>()
let listedRevisions = new Map<string, number>()
export const acceptHistorySnapshot = () => {
  historySnapshot.clear()
  for (const [sid, revision] of listedRevisions) {
    historySnapshot.set(sid, revision)
  }
}
export const conflicts = new Set<string>()
let queue: Promise<unknown> = Promise.resolve()
const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
  const task = queue.then(run)
  queue = task.catch(() => {})
  return task
}
const owner = () => {
  if (!pb.authStore.record?.id) {
    throw new Error('Please sign in again.')
  }
  return pb.authStore.record.id
}
// Unsynced snapshots survive reloads and network failures, isolated by account.
const recoveryConnections = new Map<string, Promise<IDBPDatabase>>()
const recoveryDB = () => {
  const id = owner()
  let connection = recoveryConnections.get(id)
  if (!connection) {
    connection = openDB(`ds-chat-recovery-${id}`, 1, {
      upgrade(db) {
        db.createObjectStore('pending', { keyPath: 'session.id' })
        db.createObjectStore('meta')
      },
    }).catch((error: unknown) => {
      recoveryConnections.delete(id)
      throw error
    })
    recoveryConnections.set(id, connection)
  }
  return connection
}
export const pendingRecovery = async (): Promise<Recovery[]> =>
  (await recoveryDB()).getAll('pending')
export const hasPendingWrites = () => queue
const remoteRecords = () =>
  pb.collection<RemoteSession>('chat_sessions').getFullList({
    fields: 'id,sid,revision,summary,deleted',
    filter: 'deleted = false',
  })
const getRemote = async (id: string): Promise<RemoteSession | undefined> => {
  try {
    return await pb
      .collection<RemoteSession>('chat_sessions')
      .getFirstListItem(pb.filter('sid = {:sid}', { sid: id }))
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) {
      return undefined
    }
    throw error
  }
}
export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const records = await remoteRecords()
  listedRevisions = new Map(records.map((record) => [record.sid, record.revision]))
  const byId = new Map(records.map((r) => [r.sid, r.summary]))
  for (const recovery of await pendingRecovery()) {
    revisions.set(recovery.session.id, recovery.revision)
    byId.set(recovery.session.id, toSessionSummary(recovery.session))
  }
  return [...byId.values()]
}
export const loadSession = async (id: string): Promise<Session | undefined> => {
  const recovery = (await (await recoveryDB()).get('pending', id)) as Recovery | undefined
  if (recovery) {
    revisions.set(id, recovery.revision)
    return recovery.session
  }
  const record = await getRemote(id)
  if (!record || record.deleted) {
    return undefined
  }
  revisions.set(id, record.revision)
  return record.payload
}

export const readSessionSnapshot = async (id: string, cached?: Session) => {
  const revision = revisions.get(id)
  if (cached && revision !== undefined && listedRevisions.get(id) === revision) {
    return { session: cached, revision }
  }
  const record = await getRemote(id)
  return record && !record.deleted
    ? { session: record.payload, revision: record.revision }
    : undefined
}
export const acceptSessionSnapshot = (id: string, revision: number) => revisions.set(id, revision)

const uploadFiles = async (files: local.StoredFile[]) => {
  for (const { id, blob } of files) {
    const existing = await pb
      .collection('chat_files')
      .getList(1, 1, { filter: pb.filter('fid = {:id}', { id }) })
    if (existing.totalItems) {
      continue
    }
    const body = new FormData()
    body.set('owner', owner())
    body.set('fid', id)
    body.set('mime', blob.type)
    body.set('original', blob, 'attachment')
    try {
      await pb.collection('chat_files').create(body)
    } catch (error) {
      // Another device may have uploaded the shared immutable attachment first.
      const found = await pb
        .collection('chat_files')
        .getList(1, 1, { filter: pb.filter('fid = {:id}', { id }) })
      if (!found.totalItems) {
        throw error
      }
    }
  }
}
// Local writes have their own queue so a slow network never delays the recovery snapshot.
let localWrites: Promise<unknown> = Promise.resolve()
const persistRecovery = (session: Session, files: local.StoredFile[]) => {
  const task = localWrites.then(async () => {
    const db = await recoveryDB()
    // Keep revision reads and snapshot replacement atomic with sync acknowledgements.
    const tx = db.transaction('pending', 'readwrite')
    const previous = (await tx.store.get(session.id)) as Recovery | undefined
    const allFiles = [
      ...new Map([...(previous?.files ?? []), ...files].map((f) => [f.id, f])).values(),
    ]
    const revision = previous?.revision ?? revisions.get(session.id) ?? 0
    await tx.store.put({
      session,
      files: allFiles,
      revision,
      writeId: crypto.randomUUID(),
    } satisfies Recovery)
    await tx.done
  })
  localWrites = task.catch(() => {})
  return task
}
const syncPending = async (id: string) => {
  const db = await recoveryDB()
  const snapshot = (await db.get('pending', id)) as Recovery | undefined
  if (!snapshot) {
    return
  }
  try {
    await uploadFiles(snapshot.files)
    const result = await pb.send<{ revision: number }>('/api/ds-chat/save', {
      method: 'POST',
      body: { session: snapshot.session, revision: snapshot.revision },
    })
    revisions.set(id, result.revision)
    historySnapshot.set(id, result.revision)
    conflicts.delete(id)
    const tx = db.transaction('pending', 'readwrite')
    const latest = (await tx.store.get(id)) as Recovery | undefined
    if (latest?.writeId === snapshot.writeId) {
      await tx.store.delete(id)
    } else if (latest) {
      await tx.store.put({ ...latest, revision: result.revision })
    }
    await tx.done
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 409) {
      conflicts.add(id)
    }
    throw error
  }
}
const writeSession = async (session: Session, files: local.StoredFile[]) => {
  await persistRecovery(session, files)
  await syncPending(session.id)
}
export const saveSession = (session: Session, files: local.StoredFile[] = []): Promise<void> => {
  const cached = persistRecovery(session, files)
  return enqueue(async () => {
    await cached
    await syncPending(session.id)
  })
}
export const saveFiles = (files: local.StoredFile[]): Promise<void> =>
  enqueue(() => uploadFiles(files))
export const loadFile = async (id: string): Promise<Blob | undefined> => {
  for (const recovery of await pendingRecovery()) {
    const file = recovery.files.find((f) => f.id === id)
    if (file) {
      return file.blob
    }
  }
  let record: RecordModel
  try {
    record = await pb.collection('chat_files').getFirstListItem(pb.filter('fid = {:id}', { id }))
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) {
      return undefined
    }
    throw error
  }
  const token = await pb.files.getToken()
  const response = await fetch(pb.files.getURL(record, record.original, { token }))
  if (!response.ok) {
    throw new Error(`Attachment download failed (${response.status}).`)
  }
  return new Blob([await response.blob()], { type: record.mime || 'application/octet-stream' })
}
export const deleteSession = (id: string): Promise<void> =>
  enqueue(async () => {
    await localWrites
    const record = await getRemote(id)
    if (record && !record.deleted) {
      const result = await pb.send<{ revision: number }>('/api/ds-chat/save', {
        method: 'POST',
        body: {
          session: record.payload,
          revision: revisions.get(id) ?? record.revision,
          deleted: true,
        },
      })
      revisions.set(id, result.revision)
    }
    await (await recoveryDB()).delete('pending', id)
    historySnapshot.delete(id)
    conflicts.delete(id)
  })

// Keep archive validation/staging local; replace the remote history in one transaction.
export const commitStaging = (): Promise<SessionSummary[]> =>
  enqueue(async () => {
    await localWrites
    const staging = await openDB('chat-demo')
    const sessions = (await staging.getAll('sessionsStaging')) as Session[]
    const files = (await staging.getAll('filesStaging')) as local.StoredFile[]
    await uploadFiles(files)
    const expected = [...historySnapshot].map(([sid, revision]) => ({ sid, revision }))
    // The revisions must come from the snapshot that the UI displayed, not a fresh snapshot.
    await pb.send('/api/ds-chat/replace', { method: 'POST', body: { sessions, expected } })
    revisions.clear()
    historySnapshot.clear()
    conflicts.clear()
    await (
      await recoveryDB()
    )
      .clear('pending')
      .catch(local.reportStorageError('clear recovery after server history replacement'))
    await local
      .clearStaging()
      .catch(local.reportStorageError('clear staging after server history replacement'))
    return sessions.map(toSessionSummary)
  })

export const localHistoryAvailable = async () => {
  if (await (await recoveryDB()).get('meta', 'browser-history-imported')) {
    return 0
  }
  return (await local.loadSessionSummaries()).length
}
export const importBrowserHistory = (): Promise<void> =>
  enqueue(async () => {
    for (const summary of await local.loadSessionSummaries()) {
      let session = await local.loadSession(summary.id)
      if (!session) {
        continue
      }
      if (await getRemote(session.id)) {
        session = {
          ...session,
          id: crypto.randomUUID(),
          title: `${session.title || 'Chat'} (browser import)`,
        }
      }
      const ids = new Set(
        session.messages.flatMap((m) => (m.role === 'user' ? m.files.map((f) => f.id) : []))
      )
      const files: local.StoredFile[] = []
      for (const id of ids) {
        const blob = await local.loadFile(id)
        if (blob) {
          files.push({ id, blob })
        }
      }
      await writeSession(session, files)
    }
    await (await recoveryDB()).put('meta', true, 'browser-history-imported')
  })
export const discardRecovery = async (id: string) => {
  await (await recoveryDB()).delete('pending', id)
  historySnapshot.delete(id)
  conflicts.delete(id)
  revisions.delete(id)
}
