import PocketBase from 'pocketbase'

// Same-origin API in production; the dev server proxies /api to PocketBase.
export const pb = new PocketBase(window.location.origin)
pb.autoCancellation(false)
pb.beforeSend = (url, options) => {
  // Do not let a half-open connection hold the save queue forever. Realtime uses EventSource.
  options.signal ??= AbortSignal.timeout(60000)
  return { url, options }
}

// Never keep an old account's in-memory chats after a different tab changes accounts.
let accountId = pb.authStore.record?.id
pb.authStore.onChange((_token, record) => {
  if (accountId && accountId !== record?.id) {
    window.location.reload()
  }
  accountId = record?.id
})
