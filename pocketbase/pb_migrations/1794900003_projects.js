migrate(
  (app) => {
    const rule = '@request.auth.id != "" && owner = @request.auth.id'
    app.save(
      new Collection({
        type: 'base',
        name: 'chat_projects',
        listRule: rule,
        viewRule: rule,
        createRule: rule,
        updateRule: rule + ' && @request.body.owner:changed = false',
        deleteRule: rule,
        fields: [
          {
            type: 'relation',
            name: 'owner',
            collectionId: app.findCollectionByNameOrId('chat_users').id,
            required: true,
            maxSelect: 1,
            cascadeDelete: true,
          },
          { type: 'text', name: 'name', required: true, max: 100 },
        ],
      })
    )
  },
  (app) => app.delete(app.findCollectionByNameOrId('chat_projects'))
)
