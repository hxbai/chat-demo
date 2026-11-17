// Callbacks execute in separate JS contexts; helpers are loaded with require.
routerAdd('GET', '/api/ds-chat/setup', (e) => {
  return e.json(200, { needsSetup: $app.countRecords('chat_users') === 0 })
})
routerAdd('POST', '/api/ds-chat/setup', (e) => {
  // First-account creation is allowed only from the configured private app origins.
  const origin = e.request.header.get('Origin')
  const allowedOrigins = [
    'http://127.0.0.1:8091',
    'http://localhost:8091',
    $os.getenv('DS_CHAT_SETUP_ORIGIN'),
  ].filter(Boolean)
  if (!allowedOrigins.includes(origin) || !['127.0.0.1', '::1'].includes(e.remoteIP())) {
    throw new ForbiddenError(
      'Create the first account using the configured private ds-chat address.'
    )
  }
  const body = e.requestInfo().body
  $app.runInTransaction((app) => {
    if (app.countRecords('chat_users') !== 0) throw new ForbiddenError('Setup is already complete.')
    if (
      typeof body.password !== 'string' ||
      body.password.length < 12 ||
      body.password !== body.passwordConfirm
    ) {
      throw new BadRequestError('Passwords must match and contain at least 12 characters.')
    }

    const record = new Record(app.findCollectionByNameOrId('chat_users'))
    record.set('email', body.email)
    record.set('password', body.password)
    record.set('passwordConfirm', body.passwordConfirm)
    app.save(record)
  })
  return e.json(200, { success: true })
})
routerAdd(
  'POST',
  '/api/ds-chat/save',
  (e) => {
    const helper = require(__hooks + '/chat-utils.js')
    const body = e.requestInfo().body
    let result
    $app.runInTransaction((app) => {
      result = helper.save(app, e.auth.id, body.session, body.revision, body.deleted === true)
    })
    return e.json(200, result)
  },
  $apis.requireAuth('chat_users')
)
routerAdd(
  'POST',
  '/api/ds-chat/replace',
  (e) => {
    const helper = require(__hooks + '/chat-utils.js')
    const body = e.requestInfo().body
    if (!Array.isArray(body.sessions) || !Array.isArray(body.expected))
      throw new BadRequestError('Invalid history.')
    $app.runInTransaction((app) => {
      const records = app.findRecordsByFilter('chat_sessions', 'owner = {:owner}', '', 0, 0, {
        owner: e.auth.id,
      })
      // Compare the entire snapshot so import/delete-all cannot erase another device's changes.
      const live = records.filter((r) => !r.getBool('deleted'))
      if (
        live.length !== body.expected.length ||
        live.some(
          (r) =>
            !body.expected.some(
              (x) => x.sid === r.getString('sid') && x.revision === r.getInt('revision')
            )
        )
      ) {
        throw new ApiError(
          409,
          'History changed on another device. Reload before replacing history.'
        )
      }
      const ids = new Set()
      for (const session of body.sessions) {
        helper.validate(session)
        if (ids.has(session.id)) throw new BadRequestError('Duplicate conversation id.')
        ids.add(session.id)
        const existing = records.find((r) => r.getString('sid') === session.id)
        helper.save(
          app,
          e.auth.id,
          session,
          existing ? existing.getInt('revision') : 0,
          false,
          true
        )
      }
      for (const record of live) {
        if (!ids.has(record.getString('sid'))) {
          record.set('deleted', true)
          record.set('payload', null)
          record.set('revision', record.getInt('revision') + 1)
          app.save(record)
        }
      }
    })
    return e.json(200, { success: true })
  },
  $apis.requireAuth('chat_users')
)
