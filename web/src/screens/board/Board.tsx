import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Board as BoardData, type Item } from '../../api';
import { intlLocale, useI18n } from '../../i18n';
import { useNow } from '../../hooks';
import { Banner, BottomBar, Button, Empty, ErrorNote, Loading, PageTitle } from '../../ui';
import { BoardCards } from './BoardCards';
import { BoardFilters } from './BoardFilters';
import { BoardTable } from './BoardTable';
import { countItems, type Filter, visibleItems } from './filters';
import { ItemPanel } from './ItemPanel';
import { useCategories, useSaveItem } from './items';

/** Пока доска грузится, `?? []` создавал бы новый массив на каждый рендер, и
    React Compiler пересчитывал бы производные ниже вхолостую. */
const NO_ITEMS: Item[] = [];

/** Экран позиции: данные и состояние фильтров здесь, отрисовка — в BoardCards/BoardTable. */
export function Board({ positionId, isOwn }: { positionId: string; isOwn: boolean }) {
  const { t, lang } = useI18n();
  const now = useNow();
  const board = useQuery({
    queryKey: ['board', positionId],
    queryFn: ({ signal }) => api.get<BoardData>(`/positions/${positionId}/board`, signal),
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
  const title = position ? (
    <PageTitle
      title={position.name}
      meta={`${t('people.count', { count: people.length })} · ${t('pos.staleAfter', { hours: position.stale_after_hours })}`}
    />
  ) : null;

  const items = board.data?.items ?? NO_ITEMS;
  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, intlLocale(lang)),
  );
  // Фильтру нужны категории, которые на доске есть; карточке — весь справочник
  // роты. Тянем его здесь, чтобы к открытию карточки он уже лежал в кэше и
  // список не подменялся на глазах.
  const dictionary = useCategories().data;
  const counts = countItems(items);
  const visible = visibleItems(items, filter, category, query);

  if (board.isPending) return <Loading />;
  if (board.error) return <ErrorNote error={board.error} />;

  const stale = items.some((i) => i.stale);
  const canAdd = !!position?.is_active;
  const panelItem = panel?.itemId ? (items.find((i) => i.id === panel.itemId) ?? null) : null;
  const saveQty = (id: string, qty: number, expected: number) => saveItem({ id, qty, expected_qty: expected });

  return (
    <>
      {title}
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
        <ItemPanel
          positionId={positionId}
          item={panelItem}
          categories={dictionary ?? categories}
          onClose={() => setPanel(null)}
        />
      )}
    </>
  );
}
