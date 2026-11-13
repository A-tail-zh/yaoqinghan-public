import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import express from 'express'
import mysql from 'mysql2/promise'
import sharp from 'sharp'
import { createAssetRouter, publicContent, validateAssets } from './assets.js'
import { installAuth, requireAdmin } from './auth.js'
import { createContentRouter, initialContent } from './content.js'
import { createRsvpRouter } from './rsvps.js'

const { DB_NAME, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, ADMIN_USERNAME, ADMIN_PASSWORD } = process.env

test('publishes assets and records RSVPs through the real MySQL API', {
  skip: !DB_NAME && 'Run with node --env-file=.env.test --test integration.test.js from server',
}, async () => {
  assert.equal(DB_NAME, 'invitation_h5_test', 'Integration tests require the isolated test database')
  assert.ok(DB_HOST && DB_PORT && DB_USER && DB_PASSWORD && ADMIN_USERNAME && ADMIN_PASSWORD, 'Test credentials are missing')
  const pool = mysql.createPool({
    host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
    timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true,
  })
  const mediaDir = await mkdtemp(join(tmpdir(), 'invitation-integration-'))
  let server
  let migrated = false
  const clearRows = async () => {
    for (const table of ['rsvps', 'assets', 'sessions', 'invitations']) await pool.query(`DELETE FROM ${table}`)
  }

  try {
    const [[db]] = await pool.query('SELECT DATABASE() AS name')
    assert.equal(db.name, 'invitation_h5_test')
    const sql = await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8')
    for (const statement of sql.split(';').filter(value => value.trim())) await pool.query(statement)
    migrated = true
    await clearRows()
    await pool.execute('INSERT INTO invitations (id,draft_json) VALUES (1,?)', [JSON.stringify(initialContent)])

    const app = express()
    app.use(express.json({ limit: '1mb' }))
    installAuth(app, pool)
    app.use(createContentRouter({
      pool, requireAdmin, publicContent,
      validateAssets: (content, connection) => validateAssets(content, connection, mediaDir),
    }))
    app.use(createAssetRouter({ pool, requireAdmin, mediaDir }))
    app.use(createRsvpRouter({ pool, requireAdmin }))
    app.use((error, _req, res, _next) => {
      res.status(error.status || 500).json({ error: { code: error.code } })
    })
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}`
    const origin = (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:3080').split(',')[0]
    let cookie
    async function request(path, { method = 'GET', body, headers = {} } = {}) {
      if (cookie && path.startsWith('/api/admin/')) headers.cookie = cookie
      if (body && !(body instanceof FormData)) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(body)
      }
      return fetch(base + path, { method, body, headers: { origin, ...headers } })
    }
    async function json(response, status) {
      const body = await response.json()
      assert.equal(response.status, status, body.error?.code)
      return body
    }
    const publicPath = '/api/public/invitation'
    const draftPath = '/api/admin/invitation/draft'
    const publish = revision => request('/api/admin/invitation/publish', { method: 'POST', body: { revision } })
    const saveDraft = (revision, content) => request(draftPath, { method: 'PUT', body: { revision, content } })
    const input = { name: '验收宾客', phone: '+86 13800138000', partySize: 2 }
    const submit = (key, body = input) => request(`${publicPath}/rsvps`, {
      method: 'POST', body, headers: { 'Idempotency-Key': key },
    })

    assert.equal((await request(draftPath)).status, 401)
    assert.equal((await request('/api/admin/rsvps')).status, 401)
    assert.equal((await json(await request(publicPath), 404)).error.code, 'INVITATION_NOT_PUBLISHED')
    assert.equal((await submit(randomUUID())).status, 404)
    assert.equal((await request('/api/admin/session', {
      method: 'POST', body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }, headers: { origin: 'https://example.invalid' },
    })).status, 403)
    const login = await request('/api/admin/session', {
      method: 'POST', body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    })
    await json(login, 200)
    cookie = login.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie?.startsWith('invitation.sid='), 'Admin login must create a session')
    assert.equal((await json(await request('/api/admin/session'), 200)).username, ADMIN_USERNAME)

    const originalImage = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#53634d' } }).webp().toBuffer()
    const form = new FormData()
    form.append('file', new Blob([originalImage], { type: 'image/webp' }), 'test-image.webp')
    const uploaded = await json(await request('/api/admin/assets', { method: 'POST', body: form }), 201)
    const preview = await request(uploaded.previewUrl)
    assert.equal(preview.status, 200)
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), originalImage)

    const draft = await json(await request(draftPath), 200)
    draft.content.invitation.leftDoorImageId = uploaded.id
    const saved = await json(await saveDraft(draft.revision, draft.content), 200)
    const first = await json(await publish(saved.revision), 200)
    assert.ok(Date.parse(first.firstPublishedAt) < Date.parse(first.expiresAt))
    const firstPublic = await json(await request(publicPath), 200)
    const publicImageUrl = firstPublic.content.invitation.leftDoorImageUrl
    const publicImage = await request(publicImageUrl)
    assert.equal(publicImage.status, 200)
    assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), originalImage)

    saved.content.venue.name = '更新后地点'
    const revised = await json(await saveDraft(saved.revision, saved.content), 200)
    assert.equal((await json(await request(publicPath), 200)).content.venue.name, initialContent.venue.name)
    assert.equal((await publish(saved.revision)).status, 409)
    const second = await json(await publish(revised.revision), 200)
    assert.equal(second.firstPublishedAt, first.firstPublishedAt)
    assert.equal(second.expiresAt, first.expiresAt)
    assert.equal((await json(await request(publicPath), 200)).content.venue.name, '更新后地点')

    const key = randomUUID()
    const created = await json(await submit(key), 201)
    assert.deepEqual(await json(await submit(key), 200), created)
    assert.equal((await json(await submit(key, { ...input, partySize: 3 }), 409)).error.code, 'IDEMPOTENCY_CONFLICT')
    const concurrentKey = randomUUID()
    const concurrent = await Promise.all([submit(concurrentKey), submit(concurrentKey)])
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 201])
    const [firstConcurrent, secondConcurrent] = await Promise.all(concurrent.map(response => response.json()))
    assert.deepEqual(firstConcurrent, secondConcurrent)

    const list = await json(await request('/api/admin/rsvps'), 200)
    assert.equal(list.items.length, 2)
    assert.equal(list.items[0].phone, '+8613800138000')
    assert.equal(list.items[0].partySize, 2)
    assert.equal(list.totalPartySize, '4')
    const filtered = await json(await request('/api/admin/rsvps?minPartySize=3'), 200)
    assert.equal(filtered.items.length, 0)
    assert.equal(filtered.totalPartySize, '4')
    assert.equal(filtered.filteredPartySize, '0')
    const paginated = await json(await request('/api/admin/rsvps?limit=1&keyword=1380013'), 200)
    assert.equal(paginated.items.length, 1)
    assert.equal(paginated.filteredPartySize, '4')
    assert.equal(paginated.filteredRecords, '2')
    assert.ok(paginated.nextCursor)
    const secondPage = await json(await request(`/api/admin/rsvps?limit=1&keyword=1380013&beforeId=${paginated.nextCursor}`), 200)
    assert.equal(secondPage.items.length, 1)
    assert.equal(secondPage.totalPartySize, '4')
    assert.equal(secondPage.nextCursor, null)
    await pool.execute('UPDATE invitations SET expires_at = UTC_TIMESTAMP(3) WHERE id = 1')
    const expired = await Promise.all([request(publicPath), request(publicImageUrl), submit(randomUUID())])
    for (const response of expired) {
      assert.equal((await json(response, 410)).error.code, 'INVITATION_EXPIRED')
    }
    assert.equal((await publish(revised.revision)).status, 410)
    assert.equal((await json(await request('/api/admin/rsvps'), 200)).items.length, 2)
    assert.equal((await request(draftPath)).status, 200)

    // 2028-02-29 00:30 in Shanghai falls on February 28 in UTC.
    const [[leap]] = await pool.query(`
      SELECT DATE_FORMAT(DATE_SUB(DATE_ADD(DATE_ADD(CAST('2028-02-28 16:30:00.123' AS DATETIME(3)),
        INTERVAL 8 HOUR), INTERVAL 1 YEAR), INTERVAL 8 HOUR), '%Y-%m-%d %H:%i:%s.%f') AS expires
    `)
    assert.equal(leap.expires, '2029-02-27 16:30:00.123000')
  } finally {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      if (migrated) await clearRows()
    } finally {
      await pool.end()
      await rm(mediaDir, { recursive: true, force: true })
    }
  }
})
