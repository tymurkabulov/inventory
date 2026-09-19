import type { Item, Status } from '../../api';
import type { Key } from '../../i18n';

export type Filter = 'all' | Status | 'full' | 'repair' | 'broken';

export const FILTERS: Array<{ id: Filter; label: Key }> = [
  { id: 'all', label: 'filter.all' },
  { id: 'red', label: 'filter.red' },
  { id: 'yellow', label: 'filter.yellow' },
  { id: 'green', label: 'filter.green' },
  { id: 'full', label: 'status.full' },
  { id: 'repair', label: 'condition.repair' },
  { id: 'broken', label: 'condition.broken' },
];

export type Counts = Record<Filter, number>;

export function countItems(items: Item[]): Counts {
  const c: Counts = { all: items.length, red: 0, yellow: 0, green: 0, full: 0, repair: 0, broken: 0 };
  for (const it of items) {
    c[it.status]++;
    if (it.full_stock) c.full++;
    if (it.condition === 'repair') c.repair++;
    if (it.condition === 'broken') c.broken++;
  }
  return c;
}

/** Критичная строка не прячется: фильтры и поиск применяются только к остальным. */
export function visibleItems(items: Item[], filter: Filter, category: string, query: string): Item[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (it.status === 'red') return true;
    if (filter === 'full' && !it.full_stock) return false;
    if (filter === 'repair' && it.condition !== 'repair') return false;
    if (filter === 'broken' && it.condition !== 'broken') return false;
    if ((filter === 'red' || filter === 'yellow' || filter === 'green') && it.status !== filter) return false;
    if (category && it.category !== category) return false;
    if (q && !`${it.name} ${it.category} ${it.comment}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
