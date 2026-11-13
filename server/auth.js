import session from 'express-session';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';

class MysqlSessionStore extends session.Store {
  constructor(pool) { super(); this.pool = pool; }
  get(id, callback) {
    this.pool.execute('SELECT data FROM sessions WHERE id=? AND expires_at>UTC_TIMESTAMP(3)', [id])
      .then(([rows]) => callback(null, rows[0]?.data || null)).catch(callback);
  }
  set(id, data, callback) {
    this.pool.execute('REPLACE INTO sessions (id,data,expires_at) VALUES (?,?,?)',
      [id, JSON.stringify(data), new Date(data.cookie.expires)])
      .then(() => callback()).catch(callback);
  }
  destroy(id, callback) {
    this.pool.execute('DELETE FROM sessions WHERE id=?', [id]).then(() => callback()).catch(callback);
  }
}

export function requireAdmin(req, res, next) {
  if (!req.session?.username) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
  next();
}

export function installAuth(app, pool) {
  if (!process.env.SESSION_SECRET || !process.env.ADMIN_PASSWORD_HASH) throw new Error('Missing authentication configuration');
  const origins = new Set((process.env.ALLOWED_ORIGINS || 'http://localhost:3080,http://127.0.0.1:3080,http://localhost:5189,http://127.0.0.1:5189').split(','));
  app.use('/api/admin', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origins.has(req.get('origin'))) {
      return res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: '请求来源不允许' } });
    }
    next();
  });
  app.use('/api/admin', session({
    name: 'invitation.sid', secret: process.env.SESSION_SECRET,
    store: new MysqlSessionStore(pool), resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 8 * 60 * 60 * 1000 },
  }));
  app.post('/api/admin/session', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }), (req, res, next) => {
    const { username, password } = req.body || {};
    const [salt, expected] = process.env.ADMIN_PASSWORD_HASH.split(':');
    if (typeof password !== 'string' || password.length > 256 || username !== process.env.ADMIN_USERNAME ||
        !timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex'))) {
      return res.status(401).json({ error: { code: 'INVALID_LOGIN', message: '账号或密码错误' } });
    }
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.username = username;
      req.session.save(error => error ? next(error) : res.json({ username }));
    });
  });
  app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ username: req.session.username }));
  app.delete('/api/admin/session', requireAdmin, (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('invitation.sid');
      res.sendStatus(204);
    });
  });
}
