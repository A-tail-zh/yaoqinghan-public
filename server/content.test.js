import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { collectAssetIds, createContentRouter, initialContent, validateContent } from './content.js'

test('validates the invitation schema and collects referenced assets', () => {
  const content = structuredClone(initialContent)
  content.invitation.brand = { type: 'image', assetId: 'brand_1', alt: '活动标识' }
  content.venue.imageId = 'venue-1'
  content.bgmId = 'audio-1'
  assert.equal(validateContent(content), content)
  assert.deepEqual(collectAssetIds(content), {
    images: new Set(['brand_1', 'venue-1']),
    audio: new Set(['audio-1']),
  })
  content.displayPages[1].id = content.displayPages[0].id
  assert.throws(() => validateContent(content), { code: 'INVALID_CONTENT' })
  content.displayPages[1].id = 'about'
  content.venue.imageId = '../map.png'
  assert.throws(() => validateContent(content), { code: 'INVALID_CONTENT' })
})

test('publishes a snapshot with a fixed deadline and rejects stale drafts or expired publishing', async (t) => {
  const row = {
    draft_json: initialContent,
    published_json: null,
    draft_revision: 1,
    first_published_at: null,
    expires_at: null,
    expired: null,
  }
  const db = {
    query: async () => [[structuredClone(row)]],
    getConnection: async () => db,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    async execute(sql, params) {
      if (sql.includes('draft_revision = draft_revision + 1')) {
        row.draft_json = JSON.parse(params[0])
        row.draft_revision++
      } else {
        assert.match(sql, /expires_at > UTC_TIMESTAMP\(3\)/)
        row.published_json = structuredClone(row.draft_json)
        row.first_published_at ??= '2026-11-13T05:00:00.123000Z'
        row.expires_at ??= '2027-11-13T05:00:00.123000Z'
        row.expired = '0'
      }
      return [{ affectedRows: 1 }]
    },
  }
  const app = express()
  app.use(express.json())
  app.use(createContentRouter({
    pool: db,
    requireAdmin: (req, res, next) => req.get('authorization') ? next() : res.sendStatus(401),
    validateAssets: async (content, connection) => {
      assert.equal(connection, db)
      if (content.bgmId === 'missing') {
        throw Object.assign(new Error('missing'), { code: 'INVALID_ASSET', status: 400 })
      }
    },
    publicContent: (content) => content,
  }))
  app.use((error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: { code: error.code, message: error.message } })
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/api`
  const read = () => fetch(`${base}/public/invitation`)
  const admin = (path, method = 'GET', body) => fetch(`${base}/admin/invitation/${path}`, {
    method,
    headers: { authorization: 'test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  assert.equal((await fetch(`${base}/admin/invitation/draft`)).status, 401)
  const unavailable = await read()
  assert.equal(unavailable.status, 404)
  assert.equal(unavailable.headers.get('cache-control'), 'no-store')
  assert.equal((await unavailable.json()).error.code, 'INVITATION_NOT_PUBLISHED')

  const first = await admin('publish', 'POST', { revision: 1 })
  assert.equal(first.status, 200)
  const firstDeadline = (await first.json()).expiresAt
  assert.equal(firstDeadline, '2027-11-13T05:00:00.123Z')
  const content = structuredClone(initialContent)
  content.venue.name = '更新后的地点'
  const bad = await admin('draft', 'PUT', { revision: 1, content: { ...content, bgmId: 'missing' } })
  assert.equal((await bad.json()).error.code, 'INVALID_ASSET')
  const updated = await admin('draft', 'PUT', { revision: 1, content })
  assert.equal(updated.status, 200)
  assert.equal((await updated.json()).revision, 2)
  assert.equal((await (await read()).json()).content.venue.name, initialContent.venue.name)
  assert.equal((await admin('publish', 'POST', { revision: 1 })).status, 409)

  const second = await admin('publish', 'POST', { revision: 2 })
  assert.equal(second.status, 200)
  assert.equal((await second.json()).expiresAt, firstDeadline)
  assert.equal((await (await read()).json()).content.venue.name, content.venue.name)

  row.expired = '1'
  assert.equal((await read()).status, 410)
  assert.equal((await admin('publish', 'POST', { revision: 2 })).status, 410)
  assert.equal((await admin('draft')).status, 200)
})
