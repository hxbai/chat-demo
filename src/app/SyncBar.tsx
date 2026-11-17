import { useEffect, useState } from 'react'
import { pb } from '../services/pocketbase.js'
import * as db from '../services/chat/db.js'
import {
  bindHistorySync,
  migrateBrowserHistory,
  saveConflictsAsCopies,
  useChatStore,
} from '../services/chat/store.js'
import './sync.css'

export const SyncBar = () => {
  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState('')
  const [localCount, setLocalCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const ready = useChatStore((s) => s.ready)
  const saveError = useChatStore((s) => Object.values(s.sessionSaveErrors).some(Boolean))
  const streaming = useChatStore((s) => Object.keys(s.streaming).length > 0)
  const replacing = useChatStore((s) => s.importingHistory)
  useEffect(bindHistorySync, [])
  useEffect(() => {
    void db
      .localHistoryAvailable()
      .then(setLocalCount)
      .catch(() => {})
  }, [])
  useEffect(() => {
    const offline = () => setOnline(false)
    const online = () => setOnline(true)
    const failed = () =>
      setError(
        'Cannot reach the server. Reconnecting automatically; unsaved chats stay on this device.'
      )
    const synced = () => setError('')
    window.addEventListener('offline', offline)
    window.addEventListener('online', online)
    window.addEventListener('ds-chat-sync-error', failed)
    window.addEventListener('ds-chat-synced', synced)
    return () => {
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
      window.removeEventListener('ds-chat-sync-error', failed)
      window.removeEventListener('ds-chat-synced', synced)
    }
  }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="sync-bar" aria-label="History sync">
      <span
        className={`sync-status ${saveError || !online || error ? 'sync-warning' : ''}`}
        role="status"
      >
        {!online
          ? 'Offline · changes stay on this device until saved'
          : saveError
            ? 'History has unsaved changes'
            : streaming
              ? 'Reply in progress · saving periodically'
              : !ready
                ? 'Connecting to history…'
                : 'Server history · automatic sync'}
      </span>
      {localCount > 0 && (
        <button
          disabled={busy || streaming || replacing || !ready || saveError}
          onClick={() =>
            void run(async () => {
              await migrateBrowserHistory()
              setLocalCount(0)
            })
          }
        >
          Import {localCount} browser chats
        </button>
      )}
      <button
        disabled={busy || streaming || replacing || saveError || !ready}
        onClick={() =>
          void run(async () => {
            await db.hasPendingWrites()
            pb.authStore.clear()
            window.location.reload()
          })
        }
      >
        Sign out
      </button>
      {saveError && (
        <div className="sync-error" role="alert">
          Changes are kept on this device until the server accepts them. If another device edited
          the same chat, save your version as a separate copy.
          <button
            disabled={busy || streaming || replacing}
            onClick={() => void run(saveConflictsAsCopies)}
          >
            Save conflicting chats as copies
          </button>
          {!pb.authStore.isValid && (
            <button onClick={() => window.location.reload()}>Sign in again</button>
          )}
        </div>
      )}
      {error && (
        <span className="sync-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
