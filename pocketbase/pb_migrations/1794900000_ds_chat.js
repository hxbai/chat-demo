migrate(
  (app) => {
    const users = new Collection({
      type: 'auth',
      name: 'chat_users',
      listRule: 'id = @request.auth.id',
      viewRule: 'id = @request.auth.id',
      createRule: null,
      updateRule: null,
      deleteRule: null,
      passwordAuth: { enabled: true, identityFields: ['email'] },
    })
    app.save(users)
    const owner = {
      type: 'relation',
      name: 'owner',
      collectionId: users.id,
      required: true,
      maxSelect: 1,
      cascadeDelete: true,
    }
    app.save(
      new Collection({
        type: 'base',
        name: 'chat_sessions',
        listRule: 'owner = @request.auth.id',
        viewRule: 'owner = @request.auth.id',
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          owner,
          { type: 'text', name: 'sid', required: true, max: 200 },
          { type: 'json', name: 'payload', maxSize: 20000000 },
          { type: 'json', name: 'summary', maxSize: 100000 },
          { type: 'number', name: 'revision', required: true, onlyInt: true, min: 1 },
          { type: 'bool', name: 'deleted' },
        ],
        indexes: ['CREATE UNIQUE INDEX idx_chat_session_owner_sid ON chat_sessions (owner, sid)'],
      })
    )
    app.save(
      new Collection({
        type: 'base',
        name: 'chat_files',
        listRule: 'owner = @request.auth.id',
        viewRule: 'owner = @request.auth.id',
        createRule: '@request.auth.id != "" && owner = @request.auth.id',
        updateRule: null,
        deleteRule: null,
        fields: [
          owner,
          { type: 'text', name: 'fid', required: true, max: 200 },
          {
            type: 'file',
            name: 'original',
            required: true,
            maxSelect: 1,
            maxSize: 100000000,
            protected: true,
          },
          { type: 'text', name: 'mime', max: 200 },
        ],
        indexes: ['CREATE UNIQUE INDEX idx_chat_file_owner_fid ON chat_files (owner, fid)'],
      })
    )
    const settings = app.settings()
    settings.meta.appName = 'ds-chat'
    settings.rateLimits.enabled = true
    settings.backups.cron = '0 3 * * *'
    settings.backups.cronMaxKeep = 7
    app.save(settings)
  },
  (app) => {
    for (const name of ['chat_files', 'chat_sessions', 'chat_users']) {
      app.delete(app.findCollectionByNameOrId(name))
    }
  }
)
