import { useT } from '../../i18n';
import { Button, Chip, SearchInput, Select, StickyTools } from '../../ui';
import { type Counts, type Filter, FILTERS } from './filters';

/** Полоса над списком: статусы, поиск, категория. Липнет к верху при прокрутке. */
export function BoardFilters({
  filter,
  counts,
  categories,
  category,
  query,
  canAdd,
  onFilter,
  onCategory,
  onQuery,
  onAdd,
}: {
  filter: Filter;
  counts: Counts;
  categories: string[];
  category: string;
  query: string;
  canAdd: boolean;
  onFilter: (f: Filter) => void;
  onCategory: (c: string) => void;
  onQuery: (q: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  return (
    <StickyTools>
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 lg:flex-wrap lg:overflow-visible">
        {FILTERS.map((f) => (
          <Chip key={f.id} active={filter === f.id} count={counts[f.id]} onClick={() => onFilter(f.id)}>
            {t(f.label)}
          </Chip>
        ))}
      </div>
      <p className="my-2 text-xs text-muted">{t('board.critAlways')}</p>
      <div className="flex gap-2">
        <SearchInput value={query} onChange={onQuery} placeholder={t('board.search')} />
        {categories.length > 0 && (
          <Select
            aria-label={t('board.category')}
            value={category}
            onChange={(e) => onCategory(e.target.value)}
            className="max-w-37"
          >
            <option value="">{t('board.allCategories')}</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        )}
        {/* На телефоне добавление живёт в нижней панели — здесь оно только мешало бы поиску. */}
        {canAdd && (
          <div className="hidden lg:block">
            <Button variant="blue" icon="plus" onClick={onAdd}>
              {t('board.addRow')}
            </Button>
          </div>
        )}
      </div>
    </StickyTools>
  );
}
