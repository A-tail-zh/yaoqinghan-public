import { readFile } from 'node:fs/promises';
import { pool } from './db.js';
import { initialContent } from './content.js';

try {
  const sql = await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8');
  for (const statement of sql.split(';').filter(value => value.trim())) await pool.query(statement);
  await pool.execute('INSERT IGNORE INTO invitations (id,draft_json) VALUES (1,?)', [JSON.stringify(initialContent)]);
  console.log('Database initialized. Existing content preserved.');
} finally {
  await pool.end();
}
