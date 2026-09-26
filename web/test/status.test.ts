import { describe, expect, it } from 'vitest';

import { statusOf } from '../src/api';

/**
 * Формула цвета намеренно продублирована: клиент красит строку сразу, не дожидаясь
 * ответа. Расхождение с базой означает, что человек видит один цвет, а сохраняется
 * другой. Та же таблица лежит в server/test/db.test.ts и сверяется с horizon.status().
 */
const CASES: Array<[qty: number, min: number, acceptable: number, status: 'red' | 'yellow' | 'green']> = [
  [0, 1, 2, 'red'],
  [18, 20, 50, 'red'],
  [1.5, 2, 3, 'red'],
  [20, 20, 50, 'yellow'],
  [35, 20, 50, 'yellow'],
  [2.5, 2, 3, 'yellow'],
  [0, 0, 1, 'yellow'],
  [50, 20, 50, 'green'],
  [80, 20, 50, 'green'],
];

describe('statusOf', () => {
  it.each(CASES)('%s при мин %s и приемлемом %s — %s', (qty, min, acceptable, expected) => {
    expect(statusOf(qty, min, acceptable)).toBe(expected);
  });
});
