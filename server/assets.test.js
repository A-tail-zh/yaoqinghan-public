import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'
import sharp from 'sharp'
import { createAssetRouter, publicContent, validateAssets } from './assets.js'

test('uploaded assets stay private until published, support range requests, and expire', async t => {
  const mediaDir = await mkdtemp(join(tmpdir(), 'invitation-assets-'))
  const assets = new Map()
  const invitation = { published_json: null, expired: null }
  let disconnectAfterInsert = false
  const pool = { async execute(sql, values) {
    if (sql.includes('INSERT INTO assets')) {
      const [id, kind, mime_type, storage_key] = values
      assets.set(id, { id, kind, mime_type, storage_key })
      if (disconnectAfterInsert) throw new Error('connection lost after insert')
      return [{ affectedRows: 1 }]
    }
    if (sql.includes('FROM invitations')) return [[invitation]]
    return [values.map(id => assets.get(id)).filter(Boolean)]
  } }
  const app = express()
  app.use(createAssetRouter({ pool, mediaDir, requireAdmin(req, res, next) {
    if (req.headers.authorization !== 'test') return res.sendStatus(401)
    next()
  } }))
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: { code: error.code } }))
  const server = app.listen(0, '127.0.0.1')
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(mediaDir, { recursive: true, force: true })
  })
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: 'test' }
  const admin = '/api/admin/assets'
  const upload = (bytes, auth = headers) => {
    const body = new FormData()
    body.set('file', new Blob([bytes], { type: 'image/png' }), 'preview.png')
    return fetch(base + admin, { method: 'POST', headers: auth, body })
  }
  assert.equal((await upload('not a PNG', {})).status, 401)
  assert.equal((await upload('<svg xmlns="http://www.w3.org/2000/svg"/>')).status, 415)
  assert.deepEqual(await readdir(join(mediaDir, '.upload')), [])
  const damaged = await upload(Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64'))
  assert.equal(damaged.status, 415)
  assert.equal((await damaged.json()).error.code, 'INVALID_IMAGE')
  assert.equal(assets.size, 0)
  assert.deepEqual(await readdir(join(mediaDir, '.upload')), [])
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336644' } }).png().toBuffer()
  const missingPixels = png.subarray(0, png.length - 20)
  assert.equal((await sharp(missingPixels).metadata()).width, 2)
  assert.equal((await upload(missingPixels)).status, 415)
  assert.equal(assets.size, 0)
  assert.deepEqual(await readdir(join(mediaDir, '.upload')), [])
  assert.equal((await upload(Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]))).status, 413)
  const response = await upload(png)
  assert.equal(response.status, 201)
  const { id, kind, previewUrl } = await response.json()
  assert.equal(kind, 'image')
  assert.equal((await fetch(base + previewUrl)).status, 401)
  assert.equal((await fetch(base + previewUrl, { headers })).status, 200)

  const mp3 = Buffer.alloc(417 * 2)
  const frameHeader = Buffer.from([255, 251, 144, 100])
  frameHeader.copy(mp3)
  frameHeader.copy(mp3, 417)
  const audioResponse = await upload(mp3)
  assert.equal(audioResponse.status, 201)
  const audio = await audioResponse.json()
  assert.equal(audio.kind, 'audio')

  const content = { venue: { imageId: id }, invitation: { title: { type: 'image', assetId: id, alt: '标题' } }, bgmId: null }
  await validateAssets(content, pool, mediaDir)
  await assert.rejects(validateAssets({ bgmId: id }, pool, mediaDir), { status: 400, code: 'INVALID_ASSET' })
  const visible = publicContent(content)
  const imageUrl = visible.venue.imageUrl
  assert.deepEqual(visible.invitation.title, { type: 'image', imageUrl, alt: '标题' })
  assert.equal(visible.bgmUrl, null)
  assert.equal(publicContent(content, true).venue.imageUrl, previewUrl)
  assert.equal((await fetch(base + imageUrl)).status, 404)

  const published = { ...content, bgmId: audio.id }
  await validateAssets(published, pool, mediaDir)
  invitation.published_json = JSON.stringify(published)
  assert.equal((await fetch(base + imageUrl)).status, 200)
  const partial = await fetch(base + publicContent(published).bgmUrl, { headers: { Range: 'bytes=0-3' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-type'), 'audio/mpeg')
  assert.equal(partial.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), frameHeader)
  invitation.expired = 1
  assert.equal((await fetch(base + imageUrl)).status, 410)
  assert.equal((await fetch(base + previewUrl, { headers })).status, 200)

  await rm(join(mediaDir, assets.get(id).storage_key))
  await assert.rejects(validateAssets(content, pool, mediaDir), { status: 400, code: 'INVALID_ASSET' })
  assert.equal((await fetch(base + previewUrl, { headers })).status, 404)

  disconnectAfterInsert = true
  assert.equal((await upload(png)).status, 500)
  const saved = [...assets.values()].at(-1)
  await validateAssets({ imageId: saved.id }, pool, mediaDir)
})
