import { memo } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { TTraceRecord, TTraceTurnSummary } from 'librechat-data-provider';
import { OUTCOME_LABEL, NOTE_LABEL, totalsOf } from './diagnostics';
import { formatTokens } from '~/utils/tokens';
import { useTraceFormat } from './format';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * One locally captured response: how it ended, what it cost in time and tokens, and
 * everything the capture could not see. A metric nobody reported reads "Unavailable",
 * never zero.
 */
function TurnPanel({ turn, records }: { turn: TTraceTurnSummary; records: TTraceRecord[] }) {
  const localize = useLocalize();
  const format = useTraceFormat();
  const totals = totalsOf(records);
  const unavailable = localize('com_ui_trace_unavailable');
  const tokens = (value?: number) => (value != null ? formatTokens(value) : unavailable);
  const running = turn.state === 'running';
  const items: Array<{ key: string; label: string; value: string }> = [
    {
      key: 'elapsed',
      label: localize('com_ui_trace_turn_elapsed'),
      value: format.duration(turn.elapsedMs ?? 0),
    },
    {
      key: 'models',
      label: localize('com_ui_trace_turn_model_calls'),
      value: String(totals.modelCalls),
    },
    {
      key: 'tools',
      label: localize('com_ui_trace_turn_tool_calls'),
      value: String(totals.toolCalls),
    },
    ...(totals.auxiliaryCalls > 0
      ? [
          {
            key: 'auxiliary',
            label: localize('com_ui_trace_turn_auxiliary_calls'),
            value: String(totals.auxiliaryCalls),
          },
        ]
      : []),
    { key: 'input', label: localize('com_ui_trace_usage_input'), value: tokens(totals.input) },
    {
      key: 'cache',
      label: localize('com_ui_trace_usage_cache_read'),
      value: tokens(totals.cacheRead),
    },
    { key: 'output', label: localize('com_ui_trace_usage_output'), value: tokens(totals.output) },
  ];
  if (turn.segments > 1) {
    items.splice(1, 0, {
      key: 'segments',
      label: localize('com_ui_trace_turn_segments'),
      value: String(turn.segments),
    });
  }
  const caveats = [
    ...turn.notes.map((note) => localize(NOTE_LABEL[note])),
    ...(totals.partial && !turn.notes.includes('usage_missing')
      ? [localize('com_ui_trace_note_usage_missing')]
      : []),
  ];
  const incomplete = !turn.complete && !running && turn.state !== 'paused';

  return (
    <section
      aria-label={localize('com_ui_trace_turn_title')}
      data-testid="trace-turn-panel"
      className="border-border-light bg-surface-primary-alt flex flex-col gap-2 rounded-xl border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{localize('com_ui_trace_turn_title')}</h3>
        <span
          data-testid="trace-turn-state"
          className={cn(
            'rounded-full border px-2 py-0.5 text-xs',
            turn.state === 'failed' &&
              'border-status-error-border bg-status-error-subtle text-status-error',
            (turn.state === 'cancelled' ||
              turn.state === 'interrupted' ||
              turn.state === 'incomplete' ||
              turn.state === 'paused') &&
              'border-status-warning-border bg-status-warning-subtle text-status-warning',
            (turn.state === 'completed' || running) && 'border-border-light text-text-secondary',
          )}
        >
          {localize(OUTCOME_LABEL[turn.state])}
        </span>
        {incomplete && (
          <span className="text-text-secondary text-xs">
            {localize('com_ui_trace_turn_incomplete')}
          </span>
        )}
      </div>
      <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
        {items.map((item) => (
          <div key={item.key} className="flex items-baseline gap-1.5">
            <dt className="text-text-secondary text-xs">{item.label}</dt>
            <dd className="font-medium tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
      {caveats.length > 0 && (
        <ul className="text-text-secondary flex flex-col gap-0.5 text-xs">
          {caveats.map((caveat) => (
            <li key={caveat} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              {caveat}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default memo(TurnPanel);
