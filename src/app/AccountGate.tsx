import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { pb } from '../services/pocketbase.js'
import './sync.css'

export const AccountGate = ({ children }: { children: ReactNode }) => {
  const [ready, setReady] = useState(false)
  const [setup, setSetup] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const check = async () => {
    setBusy(true)
    setError('')
    try {
      const status = await pb.send<{ needsSetup: boolean }>('/api/ds-chat/setup', { method: 'GET' })
      setSetup(status.needsSetup)
      if (pb.authStore.isValid) {
        try {
          await pb.collection('chat_users').authRefresh()
          setReady(true)
        } catch (e) {
          if ((e as { status?: number }).status === 401) {
            pb.authStore.clear()
          } else {
            throw e
          }
        }
      }
    } catch {
      setError('Cannot connect to the chat server. Check the connection and retry.')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void check()
  }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (setup) {
        await pb.send('/api/ds-chat/setup', {
          method: 'POST',
          body: { email, password, passwordConfirm: confirm },
        })
        setSetup(false)
      }
      await pb.collection('chat_users').authWithPassword(email, password)
      setPassword('')
      setConfirm('')
      setReady(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }
  if (ready) {
    return <>{children}</>
  }
  return (
    <main className="account-page">
      <form className="account-card" onSubmit={(event) => void submit(event)}>
        <h1>DS Chat</h1>
        <h2>{setup ? 'Create your chat account' : 'Sign in to your chats'}</h2>
        <p>
          {setup
            ? 'Create your shared chat account here. Then sign in with it on your laptop and phone.'
            : 'Use the same account on your laptop and phone to share history.'}
        </p>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            minLength={12}
            autoComplete={setup ? 'new-password' : 'current-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {setup && (
          <label>
            Confirm password
            <input
              type="password"
              minLength={12}
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <button disabled={busy} type="submit">
          {busy ? 'Connecting…' : setup ? 'Create account' : 'Sign in'}
        </button>
        {error && (
          <button type="button" disabled={busy} onClick={() => void check()}>
            Retry connection
          </button>
        )}
        <p className="account-note">
          Your DeepSeek API key stays on each device. Conversations and attachments are saved on
          your server.
        </p>
      </form>
    </main>
  )
}
