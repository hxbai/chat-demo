module.exports = {
  validate(session) {
    if (
      !session ||
      typeof session.id !== 'string' ||
      !session.id ||
      session.id.length > 200 ||
      typeof session.title !== 'string' ||
      session.title.length > 10000 ||
      !Number.isFinite(session.createdAt) ||
      !Number.isFinite(session.updatedAt) ||
      !Array.isArray(session.messages)
    )
      throw new BadRequestError('Invalid conversation.')
  },
  save(app, owner, session, revision, deleted, allowRevive = false) {
    this.validate(session)
    if (!Number.isInteger(revision) || revision < 0) throw new BadRequestError('Invalid revision.')
    const records = app.findRecordsByFilter(
      'chat_sessions',
      'owner = {:owner} && sid = {:sid}',
      '',
      1,
      0,
      { owner, sid: session.id }
    )
    const record = records[0] || new Record(app.findCollectionByNameOrId('chat_sessions'))
    const current = records.length ? record.getInt('revision') : 0
    if (
      current !== revision ||
      (records.length && record.getBool('deleted') && !deleted && !allowRevive)
    ) {
      throw new ApiError(
        409,
        'This conversation changed on another device. Save your version as a copy.'
      )
    }
    record.set('owner', owner)
    record.set('sid', session.id)
    record.set('revision', current + 1)
    record.set('deleted', deleted)
    record.set('payload', deleted ? null : session)
    record.set('summary', {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    })
    app.save(record)
    return { revision: current + 1 }
  },
}
