import { Router } from 'express'

const slots = ['brand', 'title', 'greeting', 'details']
const decorations = ['backgroundImageId', 'leftDoorImageId', 'rightDoorImageId', 'sealImageId']
const rsvpFields = ['title', 'nameLabel', 'phoneLabel', 'partySizeLabel', 'submitLabel']
const reservedPageIds = new Set(['invitation', 'map', 'venue', 'rsvp'])
const identifier = /^[a-zA-Z0-9_-]{1,64}$/

export const initialContent = {
  invitation: {
    brand: { type: 'text', text: '活动邀请' },
    title: { type: 'text', text: 'Invitation 邀请函' },
    greeting: { type: 'text', text: '诚挚邀请您参加本次活动' },
    details: { type: 'text', text: '活动时间与流程请以主办方通知为准。' },
    backgroundImageId: null,
    leftDoorImageId: null,
    rightDoorImageId: null,
    sealImageId: null,
  },
  displayPages: [
    { id: 'agenda', title: '活动安排', body: '欢迎参加本次活动，具体安排请以主办方通知为准。', imageId: null },
    { id: 'about', title: '活动介绍', body: '期待与您相聚。', imageId: null },
  ],
  venue: { title: '活动地点', name: '地点待公布', address: '详细地址请以主办方通知为准', imageId: null },
  rsvp: { title: '出席回执', nameLabel: '姓名', phoneLabel: '手机号', partySizeLabel: '出行人数', submitLabel: '提交' },
  bgmId: null,
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function requireKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length
      || fields.some((field) => !Object.hasOwn(value, field))) {
    throw httpError(400, 'INVALID_CONTENT', `${label} 的字段不完整或包含未知字段`)
  }
}

function requireText(value, limit, label, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value.trim())) {
    throw httpError(400, 'INVALID_CONTENT', `${label} 需要有效文本，最多 ${limit} 字`)
  }
}

function requireAsset(value, label, optional = true) {
  if (optional && value === null) return
  if (typeof value !== 'string' || !identifier.test(value)) {
    throw httpError(400, 'INVALID_CONTENT', `${label} 的素材 ID 无效`)
  }
}

export function validateContent(content) {
  requireKeys(content, ['invitation', 'displayPages', 'venue', 'rsvp', 'bgmId'], '邀请函配置')
  const { invitation, displayPages, venue, rsvp, bgmId } = content
  requireKeys(invitation, [...slots, ...decorations], '邀请页')
  for (const field of slots) {
    const slot = invitation[field]
    if (slot?.type === 'text') {
      requireKeys(slot, ['type', 'text'], field)
      requireText(slot.text, 500, field)
    } else if (slot?.type === 'image') {
      requireKeys(slot, ['type', 'assetId', 'alt'], field)
      requireAsset(slot.assetId, field, false)
      requireText(slot.alt, 500, field)
    } else {
      throw httpError(400, 'INVALID_CONTENT', `${field} 需要配置为文字或图片`)
    }
  }
  for (const field of decorations) requireAsset(invitation[field], field)

  if (!Array.isArray(displayPages) || displayPages.length > 30) {
    throw httpError(400, 'INVALID_CONTENT', '展示页最多 30 页')
  }
  const pageIds = new Set(reservedPageIds)
  for (const page of displayPages) {
    requireKeys(page, ['id', 'title', 'body', 'imageId'], '展示页')
    if (typeof page.id !== 'string' || !identifier.test(page.id) || pageIds.has(page.id)) {
      throw httpError(400, 'INVALID_CONTENT', '展示页 ID 无效或重复')
    }
    pageIds.add(page.id)
    requireText(page.title, 100, '展示页标题')
    requireText(page.body, 3000, '展示页正文', true)
    requireAsset(page.imageId, '展示页图片')
  }

  requireKeys(venue, ['title', 'name', 'address', 'imageId'], '地点页')
  requireText(venue.title, 100, '地点页标题')
  requireText(venue.name, 100, '地点名称')
  requireText(venue.address, 250, '地点地址')
  requireAsset(venue.imageId, '地点图片')
  requireKeys(rsvp, rsvpFields, '回执页')
  for (const field of rsvpFields) requireText(rsvp[field], 60, field)
  requireAsset(bgmId, '背景音乐')
  return content
}

export function collectAssetIds(content) {
  const images = new Set([
    ...decorations.map((field) => content.invitation[field]),
    ...slots.map((field) => content.invitation[field].assetId),
    ...content.displayPages.map((page) => page.imageId),
    content.venue.imageId,
  ].filter(Boolean))
  return { images, audio: new Set(content.bgmId ? [content.bgmId] : []) }
}

const selectInvitation = `
  SELECT draft_json, published_json, draft_revision,
    DATE_FORMAT(first_published_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS first_published_at,
    DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at,
    expires_at <= UTC_TIMESTAMP(3) AS expired
  FROM invitations WHERE id = 1
`

async function getInvitation(executor, lock = false) {
  const [[row]] = await executor.query(lock ? `${selectInvitation} FOR UPDATE` : selectInvitation)
  if (!row) throw new Error('Invitation row has not been initialized')
  return row
}

function readContent(value) {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function publicationDates(row) {
  return {
    firstPublishedAt: row.first_published_at?.replace(/(\.\d{3})\d{3}Z$/, '$1Z') ?? null,
    expiresAt: row.expires_at?.replace(/(\.\d{3})\d{3}Z$/, '$1Z') ?? null,
  }
}

function draftResponse(row) {
  return { revision: row.draft_revision, content: readContent(row.draft_json), ...publicationDates(row) }
}

function requireRevision(revision, row) {
  if (!Number.isInteger(revision) || revision < 0) {
    throw httpError(400, 'INVALID_REVISION', '草稿版本无效')
  }
  if (revision !== row.draft_revision) {
    throw httpError(409, 'DRAFT_CONFLICT', '草稿已更新，请重新加载')
  }
}

async function withTransaction(pool, run) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    try {
      const result = await run(connection)
      await connection.commit()
      return result
    } catch (error) {
      await connection.rollback()
      throw error
    }
  } finally {
    connection.release()
  }
}

export function createContentRouter({ pool, requireAdmin, validateAssets, publicContent }) {
  const router = Router()

  router.get('/api/public/invitation', async (_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    try {
      const row = await getInvitation(pool)
      if (!row.first_published_at) {
        throw httpError(404, 'INVITATION_NOT_PUBLISHED', '邀请函尚未发布')
      }
      if (Number(row.expired) === 1) throw httpError(410, 'INVITATION_EXPIRED', '邀请函已过期')
      res.json({ ...publicationDates(row), content: publicContent(readContent(row.published_json)) })
    } catch (error) {
      next(error)
    }
  })

  router.get('/api/admin/invitation/draft', requireAdmin, async (_req, res, next) => {
    try {
      res.json(draftResponse(await getInvitation(pool)))
    } catch (error) {
      next(error)
    }
  })

  router.put('/api/admin/invitation/draft', requireAdmin, async (req, res, next) => {
    try {
      requireKeys(req.body, ['revision', 'content'], '草稿请求')
      const { revision, content } = req.body
      validateContent(content)
      const draft = await withTransaction(pool, async (connection) => {
        const row = await getInvitation(connection, true)
        requireRevision(revision, row)
        await validateAssets(content, connection)
        await connection.execute(
          'UPDATE invitations SET draft_json = ?, draft_revision = draft_revision + 1 WHERE id = 1',
          [JSON.stringify(content)],
        )
        return draftResponse(await getInvitation(connection))
      })
      res.json(draft)
    } catch (error) {
      next(error)
    }
  })

  router.post('/api/admin/invitation/publish', requireAdmin, async (req, res, next) => {
    try {
      requireKeys(req.body, ['revision'], '发布请求')
      const draft = await withTransaction(pool, async (connection) => {
        const row = await getInvitation(connection, true)
        requireRevision(req.body.revision, row)
        if (Number(row.expired) === 1) throw httpError(410, 'INVITATION_EXPIRED', '邀请函已过期')
        const content = validateContent(readContent(row.draft_json))
        await validateAssets(content, connection)

        // The anniversary follows the Asia/Shanghai calendar and is stored in UTC.
        const [result] = await connection.execute(`
          UPDATE invitations
          SET published_json = draft_json,
            first_published_at = COALESCE(first_published_at, UTC_TIMESTAMP(3)),
            expires_at = COALESCE(expires_at,
              DATE_SUB(DATE_ADD(DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 8 HOUR), INTERVAL 1 YEAR), INTERVAL 8 HOUR))
          WHERE id = 1 AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))
        `)
        if (!result.affectedRows) throw httpError(410, 'INVITATION_EXPIRED', '邀请函已过期')
        return draftResponse(await getInvitation(connection))
      })
      res.json(draft)
    } catch (error) {
      next(error)
    }
  })

  return router
}
