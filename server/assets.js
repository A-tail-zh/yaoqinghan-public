import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { lstat, readFile, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Router } from 'express'
import { fileTypeFromFile } from 'file-type'
import multer from 'multer'
import sharp from 'sharp'

const imageLimit = 10 * 1024 * 1024
const audioLimit = 20 * 1024 * 1024
const formats = new Map([
  ['image/jpeg', { kind: 'image', ext: 'jpg', limit: imageLimit }],
  ['image/png', { kind: 'image', ext: 'png', limit: imageLimit }],
  ['image/webp', { kind: 'image', ext: 'webp', limit: imageLimit }],
  ['audio/mpeg', { kind: 'audio', ext: 'mp3', limit: audioLimit }],
])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const adminPath = '/api/admin/assets'
const publicPath = '/api/public/invitation/assets'

function referenceKind(key, object) {
  if (key === 'bgmId') return 'audio'
  if (key === 'imageId' || key.endsWith('ImageId') || (key === 'assetId' && object.type === 'image')) return 'image'
}

function mapContent(value, mapReference) {
  if (Array.isArray(value)) return value.map(item => mapContent(item, mapReference))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const kind = referenceKind(key, value)
    return kind ? mapReference(key, item, kind) : [key, mapContent(item, mapReference)]
  }))
}

function references(content) {
  const result = []
  mapContent(content, (key, id, kind) => {
    if (id != null) result.push({ id, kind })
    return [key, id]
  })
  return result
}

function hasStorageKey(id, asset) {
  const format = formats.get(asset?.mime_type)
  return format && format.kind === asset.kind && asset.storage_key === `${id}.${format.ext}`
}

export async function validateAssets(content, connection, mediaDir = process.env.MEDIA_DIR || resolve(import.meta.dirname, 'media')) {
  const refs = references(content)
  if (!refs.length) return
  const invalidAsset = () => Object.assign(new Error('所选素材不存在或类型不匹配'), {
    status: 400,
    code: 'INVALID_ASSET',
  })
  const ids = [...new Set(refs.map(({ id }) => id))]
  if (ids.some(id => typeof id !== 'string' || !uuid.test(id))) throw invalidAsset()
  const [rows] = await connection.execute(
    `SELECT id, kind, mime_type, storage_key FROM assets WHERE id IN (${ids.map(() => '?').join(', ')})`, ids,
  )
  const assets = new Map(rows.map(asset => [asset.id, asset]))
  if (refs.some(({ id, kind }) => assets.get(id)?.kind !== kind)) throw invalidAsset()
  await Promise.all(ids.map(async id => {
    const asset = assets.get(id)
    if (!hasStorageKey(id, asset)) throw invalidAsset()
    const file = await lstat(resolve(mediaDir, asset.storage_key)).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!file?.isFile()) throw invalidAsset()
  }))
}

export function publicContent(content, admin = false) {
  const basePath = admin ? adminPath : publicPath
  return mapContent(content, (key, id) => [
    key === 'assetId' ? 'imageUrl' : key.replace(/Id$/, 'Url'),
    id == null ? null : `${basePath}/${encodeURIComponent(id)}`,
  ])
}

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } })
}

export function createAssetRouter({ pool, requireAdmin, mediaDir }) {
  const router = Router()
  const root = resolve(mediaDir)
  const tempDir = resolve(root, '.upload')
  mkdirSync(tempDir, { recursive: true })
  const upload = multer({
    dest: tempDir,
    limits: { fileSize: audioLimit + 1, files: 1, fields: 0 },
  }).single('file')

  router.post(adminPath, requireAdmin, (req, res, next) => {
    upload(req, res, error => {
      if (error?.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'FILE_TOO_LARGE', '文件超过大小限制')
      if (error instanceof multer.MulterError) return fail(res, 400, 'INVALID_UPLOAD', '请上传一个文件')
      next(error)
    })
  }, async (req, res) => {
    const file = req.file
    if (!file) return fail(res, 400, 'INVALID_UPLOAD', '请选择文件')
    let insertStarted = false
    let result
    try {
      const detected = await fileTypeFromFile(file.path).catch(error => {
        if (error.name !== 'EndOfStreamError') throw error
      })
      const format = formats.get(detected?.mime)
      if (!format || detected.ext !== format.ext) {
        await rm(file.path, { force: true })
        return fail(res, 415, 'UNSUPPORTED_FILE', '仅支持 JPEG、PNG、WebP 图片和 MP3 音乐')
      }
      if (file.size > format.limit) {
        await rm(file.path, { force: true })
        return fail(res, 413, 'FILE_TOO_LARGE', '文件超过大小限制')
      }
      if (format.kind === 'image') {
        await sharp(await readFile(file.path)).stats().catch(() => {
          throw Object.assign(new Error('图片文件损坏或无法读取，请重新选择有效图片'), {
            status: 415, code: 'INVALID_IMAGE',
          })
        })
      }

      const id = randomUUID()
      const storageKey = `${id}.${format.ext}`
      const destination = resolve(root, storageKey)
      await rename(file.path, destination)
      insertStarted = true
      await pool.execute(
        `INSERT INTO assets (id, kind, mime_type, storage_key, original_name, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [id, format.kind, detected.mime, storageKey, [...file.originalname].slice(0, 255).join(''), file.size],
      )
      result = { id, kind: format.kind, previewUrl: `${adminPath}/${id}` }
    } catch (error) {
      // A disconnected write may already have committed, so preserve the final file.
      if (!insertStarted) await rm(file.path, { force: true })
      throw error
    }
    res.status(201).json(result)
  })

  async function sendAsset(req, res, next) {
    const id = req.params.id
    if (!uuid.test(id)) return fail(res, 404, 'ASSET_NOT_FOUND', '素材不存在')
    const [rows] = await pool.execute('SELECT kind, mime_type, storage_key FROM assets WHERE id = ?', [id])
    const asset = rows[0]
    if (!hasStorageKey(id, asset)) {
      return fail(res, 404, 'ASSET_NOT_FOUND', '素材不存在')
    }
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': asset.mime_type })
    res.sendFile(asset.storage_key, { root, cacheControl: false, lastModified: false }, error => {
      if (!error) return
      if (error.status === 404 && !res.headersSent) return fail(res, 404, 'ASSET_NOT_FOUND', '素材文件不存在')
      next(error)
    })
  }

  router.get(`${adminPath}/:id`, requireAdmin, sendAsset)
  router.get(`${publicPath}/:id`, async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    const [rows] = await pool.execute(
      'SELECT published_json, UTC_TIMESTAMP(3) >= expires_at AS expired FROM invitations WHERE id = 1',
    )
    const invitation = rows[0]
    if (Number(invitation?.expired) === 1) return fail(res, 410, 'INVITATION_EXPIRED', '邀请函已到期')
    const content = typeof invitation?.published_json === 'string'
      ? JSON.parse(invitation.published_json)
      : invitation?.published_json
    if (!references(content).some(({ id }) => id === req.params.id)) {
      return fail(res, 404, 'ASSET_NOT_FOUND', '素材不存在')
    }
    return sendAsset(req, res, next)
  })

  return router
}
