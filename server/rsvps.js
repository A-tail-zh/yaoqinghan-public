import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

export function validateRsvp(body, key) {
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100 ||
      typeof body.phone !== 'string' || !/^[+]?[0-9][0-9 ()-]{5,30}$/.test(body.phone.trim()) ||
      !/^[+]?[0-9]{6,20}$/.test(body.phone.replace(/[ ()-]/g, '').trim()) ||
      !Number.isInteger(body.partySize) || body.partySize < 1 || body.partySize > 4294967295 ||
      typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    throw Object.assign(new Error('请填写有效的姓名、手机号和含本人的正整数人数，并提供提交键'), { status: 422, code: 'INVALID_RSVP' });
  }
  return { name: body.name.trim(), phone: body.phone.trim().replace(/[ ()-]/g, ''), partySize: body.partySize };
}

export function rsvpFilters(query) {
  const clauses = ['invitation_id=1'];
  const values = [];
  const invalid = () => Object.assign(new Error('请检查人数范围和提交日期，起始值不能大于结束值'), { status: 422, code: 'INVALID_FILTER' });
  if (query.keyword !== undefined && query.keyword !== '') {
    if (typeof query.keyword !== 'string' || query.keyword.length > 100) throw invalid();
    clauses.push('(LOCATE(?,name)>0 OR LOCATE(?,phone)>0)');
    values.push(query.keyword.trim(), query.keyword.trim());
  }
  for (const [key, operator] of [['minPartySize', '>='], ['maxPartySize', '<=']]) {
    if (query[key] === undefined || query[key] === '') continue;
    if (typeof query[key] !== 'string' || !/^[1-9][0-9]*$/.test(query[key]) || Number(query[key]) > 4294967295) throw invalid();
    clauses.push(`party_size ${operator} ?`);
    values.push(Number(query[key]));
  }
  if (query.minPartySize && query.maxPartySize && Number(query.minPartySize) > Number(query.maxPartySize)) throw invalid();
  for (const [key, operator] of [['dateFrom', '>='], ['dateTo', '<']]) {
    const date = query[key];
    if (date === undefined || date === '') continue;
    if (typeof date !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(date) || date > '9998-12-31') throw invalid();
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw invalid();
    clauses.push(`created_at ${operator} ?`);
    values.push(new Date(parsed.getTime() - 8 * 3600000 + (key === 'dateTo' ? 86400000 : 0)));
  }
  if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) throw invalid();
  return { where: clauses.join(' AND '), values };
}

export function createRsvpRouter({ pool, requireAdmin }) {
  const router = Router();
  router.post('/api/public/invitation/rsvps', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
    const key = req.get('Idempotency-Key');
    const input = validateRsvp(req.body, key);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[invitation]] = await connection.query('SELECT published_json,expires_at FROM invitations WHERE id=1 FOR UPDATE');
      const [[{ now }]] = await connection.query('SELECT UTC_TIMESTAMP(3) AS now');
      if (!invitation?.published_json) throw Object.assign(new Error('邀请函尚未发布'), { status: 404, code: 'INVITATION_NOT_PUBLISHED' });
      if (now >= invitation.expires_at) throw Object.assign(new Error('邀请函已到期'), { status: 410, code: 'INVITATION_EXPIRED' });
      const [[existing]] = await connection.execute('SELECT id,name,phone,party_size FROM rsvps WHERE invitation_id=1 AND submission_key=?', [key]);
      if (existing) {
        if (existing.name !== input.name || existing.phone !== input.phone || existing.party_size !== input.partySize) {
          throw Object.assign(new Error('提交键已用于其他内容'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
        }
        await connection.commit();
        return res.json({ id: String(existing.id) });
      }
      const [result] = await connection.execute('INSERT INTO rsvps (invitation_id,name,phone,party_size,submission_key,created_at) VALUES (1,?,?,?,?,?)', [input.name, input.phone, input.partySize, key, now]);
      await connection.commit();
      res.status(201).json({ id: String(result.insertId) });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  });
  router.get('/api/admin/rsvps', requireAdmin, async (req, res) => {
    const limit = Number(req.query.limit || 50);
    const beforeId = req.query.beforeId;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (beforeId !== undefined && (typeof beforeId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(beforeId)))) {
      return res.status(422).json({ error: { code: 'INVALID_PAGINATION', message: '分页参数无效' } });
    }
    const { where, values } = rsvpFilters(req.query);
    const params = [...values, ...(beforeId ? [beforeId] : []), limit + 1];
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(`SELECT id,name,phone,party_size AS partySize,created_at AS createdAt FROM rsvps WHERE ${where} ${beforeId ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`, params);
      const [[total]] = await connection.query('SELECT COALESCE(SUM(party_size),0) AS people FROM rsvps WHERE invitation_id=1');
      const [[filtered]] = await connection.query(`SELECT COALESCE(SUM(party_size),0) AS people,COUNT(*) AS records FROM rsvps WHERE ${where}`, values);
      await connection.commit();
      const items = rows.slice(0, limit).map(row => ({ ...row, id: String(row.id) }));
      res.json({ items, nextCursor: rows.length > limit ? items.at(-1).id : null,
        totalPartySize: String(total.people), filteredPartySize: String(filtered.people), filteredRecords: String(filtered.records) });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  });
  return router;
}
