import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateRsvp, rsvpFilters } from './rsvps.js';
test('姓名电话规范化，人数保持含本人正整数', () => {
  assert.deepEqual(validateRsvp({ name: ' 张三 ', phone: '+86 138-0000-0000', partySize: 2 }, randomUUID()), { name: '张三', phone: '+8613800000000', partySize: 2 });
  for (const partySize of [0, -1, 1.5, '2', 4294967296]) assert.throws(() => validateRsvp({ name: 'A', phone: '13800000000', partySize }, randomUUID()));
  assert.throws(() => validateRsvp({ name: 'A', phone: '1------', partySize: 1 }, randomUUID()));
});
test('筛选使用北京时间整日边界并拒绝非法范围', () => {
  const result = rsvpFilters({ keyword: '测试%', minPartySize: '2', maxPartySize: '10', dateFrom: '2026-11-13', dateTo: '2026-11-13' });
  assert.deepEqual(result.values.slice(0, 4), ['测试%', '测试%', 2, 10]);
  assert.equal(result.values[4].toISOString(), '2026-11-12T16:00:00.000Z');
  assert.equal(result.values[5].toISOString(), '2026-11-13T16:00:00.000Z');
  for (const query of [{ dateFrom: '2026-02-30' }, { minPartySize: '10', maxPartySize: '2' }, { dateFrom: '2026-11-14', dateTo: '2026-11-13' }, { keyword: ['a'] }]) assert.throws(() => rsvpFilters(query));
});
