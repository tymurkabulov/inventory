import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { api, type Condition, type Item, type Movement, statusOf } from '../../api';
import { fmtAgo, fmtDateTime, fmtQty, useI18n } from '../../i18n';
import { useNow } from '../../hooks';
import {
  Box,
  Button,
  ConditionMark,
  ConfirmSheet,
  cx,
  ErrorNote,
  Field,
  Input,
  Label,
  levelOf,
  QtyStepper,
  Select,
  Sheet,
  StatusBadge,
  Textarea,
  useToast,
} from '../../ui';
import { useCategories, useSaveItem } from './items';

const CONDITIONS: Condition[] = ['ok', 'repair', 'broken'];

export function ItemPanel({
  positionId,
  item,
  categories,
  onClose,
}: {
  positionId: string;
  item: Item | null;
  categories: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t, lang } = useI18n();
  const now = useNow();
  const save = useSaveItem(positionId);
  const listId = useId();
  const units = t('item.units').split(',');

  const [f, setF] = useState({
    name: item?.name ?? '',
    category: item?.category ?? '',
    unit: item?.unit ?? units[0]!,
    qty: item ? String(item.qty) : '0',
    min: item ? String(item.min_qty) : '',
    acceptable: item ? String(item.acceptable_qty) : '',
    ideal: item ? String(item.ideal_qty) : '',
    condition: (item?.condition ?? 'ok') as Condition,
    comment: item?.comment ?? '',
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Пока справочник не пришёл, показываем то, что уже есть на доске.
  const known = useCategories().data ?? categories;

  const num = (v: string) => (v.trim() === '' ? NaN : Number(v.replace(',', '.')));
  const qty = num(f.qty);
  const min = num(f.min);
  const acc = num(f.acceptable);
  const ideal = num(f.ideal);
  const thresholdsOk = [min, acc, ideal].every(Number.isFinite) && min >= 0 && min < acc && acc <= ideal;
  const thresholdError = [min, acc, ideal].every(Number.isFinite) && !thresholdsOk ? t('item.thresholdError') : null;
  const valid = f.name.trim() !== '' && Number.isFinite(qty) && qty >= 0 && thresholdsOk;

  const movements = useQuery({
    queryKey: ['movements', item?.id],
    queryFn: ({ signal }) => api.get<Movement[]>(`/items/${item!.id}/movements`, signal),
    enabled: !!item,
    // Открыли карточку — спрашиваем заново: остаток мог измениться минуту назад.
    refetchOnMount: 'always',
  });

  const del = useMutation({
    mutationFn: () => api.post(`/items/${item!.id}/delete`),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['board', positionId] }),
        qc.invalidateQueries({ queryKey: ['admin'] }),
      ]);
      toast(t('item.deleted'));
      onClose();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    save.mutate(
      {
        id: item?.id,
        name: f.name.trim(),
        category: f.category.trim(),
        unit: f.unit.trim() || units[0]!,
        // Остаток существующей строки правится степпером, в форме его поля нет.
        // Слать сюда f.qty нельзя: это снимок на момент открытия карточки, и он
        // затрёт число, которое за это время поставили с другого телефона.
        ...(item ? {} : { qty }),
        min_qty: min,
        acceptable_qty: acc,
        ideal_qty: ideal,
        condition: f.condition,
        comment: f.comment,
        // Строка могла измениться, пока карточка открыта: сервер сверит снимок
        // и откажет, вместо того чтобы молча вернуть её к прежнему состоянию.
        expected_updated_at: item?.updated_at,
      },
      { onSuccess: onClose },
    );
  }

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const numeric = { inputMode: 'decimal' as const, className: 'text-right' };
  const level = item ? levelOf(item.status, item.full_stock) : Number.isFinite(qty) && thresholdsOk ? levelOf(statusOf(qty, min, acc), qty >= ideal) : null;

  return (
    <Sheet
      open
      onClose={onClose}
      title={item ? item.name : t('item.new')}
      footer={
        <>
          <Button variant="green" block icon="check" disabled={!valid} busy={save.isPending} type="submit" form="item-form">
            {t('common.save')}
          </Button>
          <Button variant="gray" block onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {item && (
            <Button variant="red" block icon="trash" onClick={() => setConfirmDelete(true)}>
              {t('item.delete')}
            </Button>
          )}
        </>
      }
    >
      {item && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {level && <StatusBadge level={level} />}
            <ConditionMark condition={item.condition} />
            <span className="tnum text-xs text-muted">
              {fmtQty(lang, item.qty)} / {fmtQty(lang, item.ideal_qty)} {item.unit}
            </span>
          </div>
          {/* Отметка «проверил» видна здесь: она может быть свежее последней смены числа. */}
          <div className="text-xs text-muted">
            {t('col.updated')} {fmtAgo(lang, item.updated_at, now)}
            {item.updated_by_callsign ? ` · ${item.updated_by_callsign}` : ''}
          </div>
        </div>
      )}

      {item && (
        <QtyStepper
          value={item.qty}
          saveLabel={t('common.save')}
          onSave={(next, expected) => save.mutate({ id: item.id, qty: next, expected_qty: expected }, { onSuccess: onClose })}
        />
      )}

      <form id="item-form" onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t('item.name')}>
          {(id) => <Input id={id} required maxLength={80} value={f.name} onChange={set('name')} autoFocus={!item} />}
        </Field>

        <div className="grid grid-cols-2 gap-2">
          {/* Категории — общий справочник роты, новые здесь не заводят:
              иначе на каждой позиции появляются свои написания одного и того же. */}
          <Field label={t('item.category')}>
            {(id) => (
              <Select id={id} value={f.category} onChange={set('category')}>
                <option value="">{t('item.noCategory')}</option>
                {/* Старое значение строки показываем, даже если его убрали из справочника. */}
                {(known.includes(f.category) || f.category === '' ? known : [...known, f.category]).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('item.unit')}>
            {(id) => (
              <>
                <Input id={id} list={`${listId}-u`} maxLength={12} value={f.unit} onChange={set('unit')} />
                <datalist id={`${listId}-u`}>
                  {units.map((u) => (
                    <option key={u} value={u} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        </div>

        {!item && (
          <Field label={t('item.qty')}>{(id) => <Input id={id} required {...numeric} value={f.qty} onChange={set('qty')} />}</Field>
        )}

        <Field label={t('item.condition')}>
          {(id) => (
            <Select id={id} value={f.condition} onChange={set('condition')}>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {t(`condition.${c}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div>
          <Label>{t('item.thresholds')}</Label>
          <div className="grid grid-cols-3 gap-2">
            <Field label={t('item.min')}>{(id) => <Input id={id} required {...numeric} value={f.min} onChange={set('min')} />}</Field>
            <Field label={t('item.acceptable')}>
              {(id) => <Input id={id} required {...numeric} value={f.acceptable} onChange={set('acceptable')} />}
            </Field>
            <Field label={t('item.ideal')}>
              {(id) => <Input id={id} required {...numeric} value={f.ideal} onChange={set('ideal')} />}
            </Field>
          </div>
          <p className={cx('mt-1.5 text-xs', thresholdError ? 'text-red-ink' : 'text-muted')}>
            {thresholdError ?? t('item.thresholdHint')}
          </p>
        </div>

        <Field label={t('item.comment')}>
          {(id) => <Textarea id={id} maxLength={280} rows={3} value={f.comment} onChange={set('comment')} />}
        </Field>

        <ErrorNote error={save.error ?? del.error} />
      </form>

      {item && (
        <div>
          <Label>{t('item.movements')}</Label>
          {movements.data && movements.data.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {movements.data.map((m) => (
                <li key={m.id} className="grid grid-cols-[8px_1fr] gap-2 border-b border-line py-2 text-sm">
                  <i aria-hidden className="mt-1.5 size-2 bg-accent" />
                  <div>
                    <b className="tnum">
                      {m.qty_before === null ? t('item.created') : `${fmtQty(lang, m.qty_before)} → `}
                      {fmtQty(lang, m.qty_after)} {item.unit}
                    </b>
                    <div className="text-xs text-muted">
                      {fmtDateTime(lang, m.created_at)}
                      {m.created_by_callsign ? ` · ${m.created_by_callsign}` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">{movements.isPending ? t('common.loading') : t('item.noMovements')}</p>
          )}
        </div>
      )}

      {item && (
        <div className="grid grid-cols-2 gap-2">
          <Box label={t('item.min')}>{fmtQty(lang, item.min_qty)}</Box>
          <Box label={t('item.acceptable')}>{fmtQty(lang, item.acceptable_qty)}</Box>
        </div>
      )}

      <ConfirmSheet
        open={confirmDelete}
        title={t('item.confirmDeleteTitle')}
        confirmLabel={t('item.delete')}
        busy={del.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => del.mutate()}
      >
        {t('item.confirmDeleteText', { name: item?.name ?? '' })}
      </ConfirmSheet>
    </Sheet>
  );
}
