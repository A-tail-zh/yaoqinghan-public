import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { installAuth, requireAdmin } from './auth.js';
import { createContentRouter } from './content.js';
import { createAssetRouter, validateAssets, publicContent } from './assets.js';
import { createRsvpRouter } from './rsvps.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '1mb' }));
installAuth(app, pool);
app.use(createContentRouter({ pool, requireAdmin, validateAssets, publicContent }));
app.use(createAssetRouter({ pool, requireAdmin, mediaDir: path.resolve(process.env.MEDIA_DIR || path.join(directory, 'media')) }));
app.use(createRsvpRouter({ pool, requireAdmin }));
app.get('/api/health', async (req, res) => { await pool.query('SELECT 1'); res.json({ status: 'ok' }); });
app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }));
app.use('/admin', express.static(path.join(directory, '../admin/dist')));
app.get('/admin/{*path}', (req, res) => res.sendFile(path.join(directory, '../admin/dist/index.html')));
if (process.env.H5_DIST_DIR) {
  const h5Directory = path.resolve(process.env.H5_DIST_DIR);
  app.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const [[invitation]] = await pool.query('SELECT first_published_at,expires_at <= UTC_TIMESTAMP(3) AS expired FROM invitations WHERE id=1');
    if (!invitation?.first_published_at) return res.status(404).type('text').send('邀请函尚未发布');
    if (Number(invitation.expired) === 1) return res.status(410).type('text').send('邀请函已到期');
    next();
  });
  app.use(express.static(h5Directory, { cacheControl: false }));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(h5Directory, 'index.html')));
}
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error('Request failed', error.code || error.name);
  res.status(status).json({ error: { code: error.code || 'SERVER_ERROR', message: status >= 500 ? '服务暂时不可用，请重试' : error.message } });
});
const server = app.listen(Number(process.env.PORT || 3080), process.env.HOST || '127.0.0.1', () => console.log('Invitation API and admin ready'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
