import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, type Board as BoardData } from '../../api';
import { intlLocale, useI18n } from '../../i18n';
import { useNow, usePageTitle } from '../../hooks';
import { Banner, BottomBar, Button, Empty, ErrorNote, Loading } from '../../ui';
import { BoardCards } from './BoardCards';
import { BoardFilters } from './BoardFilters';
import { BoardTable } from './BoardTable';
import { countItems, type Filter, visibleItems } from './filters';
import { ItemPanel } from './ItemPanel';
import { useSaveItem } from './items';

/** Экран позиции: данные и состояние фильтров здесь, отрисовка — в BoardCards/BoardTable. */
export function Board({ positionId, isOwn }: { positionId: string; isOwn: boolean }) {
  const { t, lang } = useI18n();
  const now = useNow();
  const board = useQuery({
    queryKey: ['board', positionId],
    queryFn: () => api.get<BoardData>(`/positions/${positionId}/board`),
    refetchInterval: 30_000,
    // Открыли экран — спрашиваем сервер заново: остаток могли поправить с другого телефона.
    refetchOnMount: 'always',
  });
  const { mutate: saveItem } = useSaveItem(positionId);

  const [filter, setFilter] = useState<Filter>('all');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  // Храним только id: сама строка всегда берётся из свежих данных доски,
  // иначе открытая карточка живёт снимком на момент нажатия.
  const [panel, setPanel] = useState<{ itemId: string | null } | null>(null);

  const position = board.data?.position;
  const people = board.data?.people ?? [];
  usePageTitle(
    position?.name ?? 'Horizon',
    position
      ? `${t('people.count', { count: people.length })} · ${t('pos.staleAfter', { hours: position.stale_after_hours })}`
      : undefined,
  );

  const items = board.data?.items ?? [];
  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, intlLocale(lang))),
    [items, lang],
  );
  const counts = useMemo(() => countItems(items), [items]);
  const visible = useMemo(() => visibleItems(items, filter, category, query), [items, filter, category, query]);

  if (board.isPending) return <Loading />;
  if (board.error) return <ErrorNote error={board.error} />;

  const stale = items.some((i) => i.stale);
  const canAdd = !!position?.is_active;
  const panelItem = panel?.itemId ? (items.find((i) => i.id === panel.itemId) ?? null) : null;
  const saveQty = (id: string, qty: number) => saveItem({ id, qty });

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {stale && <Banner>{t('board.staleHint')}</Banner>}

        <BoardFilters
          filter={filter}
          counts={counts}
          categories={categories}
          category={category}
          query={query}
          canAdd={canAdd}
          onFilter={setFilter}
          onCategory={setCategory}
          onQuery={setQuery}
          onAdd={() => setPanel({ itemId: null })}
        />

        <div className="min-h-0 flex-1 overflow-auto">
          {items.length === 0 ? (
            <div className="p-3">
              <Empty title={t('board.empty')}>{isOwn ? t('board.emptyOwn') : t('board.emptyOther')}</Empty>
            </div>
          ) : (
            <>
              <BoardCards items={visible} now={now} onOpen={(item) => setPanel({ itemId: item.id })} onSaveQty={saveQty} />
              <BoardTable items={visible} now={now} onOpen={(item) => setPanel({ itemId: item.id })} onSaveQty={saveQty} />
            </>
          )}
        </div>

        {canAdd && (
          <BottomBar>
            <Button variant="blue" icon="plus" block onClick={() => setPanel({ itemId: null })}>
              {t('board.addRow')}
            </Button>
          </BottomBar>
        )}
      </div>

      {/* Строку могли удалить с другого телефона — тогда карточке нечего показывать. */}
      {panel && (panel.itemId === null || panelItem) && (
        <ItemPanel positionId={positionId} item={panelItem} categories={categories} onClose={() => setPanel(null)} />
      )}
    </>
  );
}
