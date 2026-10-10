import type { TResponseStats, TResponseStatsCall } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { presentTool } from './present';

type Translate = (key: TranslationKeys, options?: Record<string, string | number>) => string;

const SEPARATOR = ' · ';

const formats = new Map<string, { one: Intl.NumberFormat; whole: Intl.NumberFormat }>();

function numberFormats(language?: string) {
  const key = language ?? '';
  const cached = formats.get(key);
  if (cached) {
    return cached;
  }
  let locale: string | undefined;
  try {
    locale =
      language != null && Intl.NumberFormat.supportedLocalesOf(language).length > 0
        ? language
        : undefined;
  } catch {
    locale = undefined;
  }
  const created = {
    one: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    whole: new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: false }),
  };
  formats.set(key, created);
  return created;
}

const positive = (value?: number): value is number =>
  value != null && Number.isFinite(value) && value > 0;

/** A figure that would print as 0.0 at one decimal is left out rather than shown as zero. */
const showsAsTenths = (value?: number, scale = 1): value is number =>
  positive(value) && Math.round((value / scale) * 10) > 0;

/** Tokens from 1000 up read as `41.2K` with one decimal. */
export function formatCount(value: number, language?: string): string {
  const { one, whole } = numberFormats(language);
  return value >= 1000 ? `${one.format(value / 1000)}K` : whole.format(value);
}

export function formatSeconds(ms: number, language?: string): string {
  return numberFormats(language).one.format(ms / 1000);
}

/** One decimal under 100 tokens per second, otherwise whole numbers. */
export function formatSpeed(value: number, language?: string): string {
  const { one, whole } = numberFormats(language);
  const tenth = Math.round(value * 10) / 10;
  return tenth < 100 ? one.format(tenth) : whole.format(value);
}

const secondsPart = (
  key: TranslationKeys,
  ms: number | undefined,
  t: Translate,
  language?: string,
): string[] => (showsAsTenths(ms, 1000) ? [t(key, { 0: formatSeconds(ms, language) })] : []);

const speedPart = (
  key: TranslationKeys,
  value: number | undefined,
  t: Translate,
  language?: string,
): string[] => (showsAsTenths(value) ? [t(key, { 0: formatSpeed(value, language) })] : []);

const STATE_KEY: Partial<Record<TResponseStats['state'], TranslationKeys>> = {
  paused: 'com_ui_response_stats_state_paused',
  failed: 'com_ui_response_stats_state_failed',
  cancelled: 'com_ui_response_stats_state_cancelled',
  interrupted: 'com_ui_response_stats_state_interrupted',
  incomplete: 'com_ui_response_stats_state_incomplete',
};

const FIRST_KEY = {
  text: 'com_ui_response_stats_first_text',
  reasoning: 'com_ui_response_stats_first_reasoning',
  tool_call: 'com_ui_response_stats_first_tool_call',
} as const satisfies Record<string, TranslationKeys>;

/** The short line: only reported figures that show as something above zero; a state other than completed leads it. */
export function statsLine(stats: TResponseStats, t: Translate, language?: string): string {
  const parts: string[] = [];
  const state = STATE_KEY[stats.state];
  if (state != null) {
    parts.push(t(state));
  }
  parts.push(...secondsPart('com_ui_response_stats_seconds', stats.elapsedMs, t, language));
  if (stats.modelCalls > 0) {
    parts.push(
      t(
        stats.modelCalls === 1 ? 'com_ui_response_stats_calls_one' : 'com_ui_response_stats_calls',
        { count: stats.modelCalls },
      ),
    );
  }
  if (stats.toolCalls > 0) {
    parts.push(
      t(stats.toolCalls === 1 ? 'com_ui_response_stats_tools_one' : 'com_ui_response_stats_tools', {
        count: stats.toolCalls,
      }),
    );
  }
  if (positive(stats.input)) {
    parts.push(
      positive(stats.cacheRead)
        ? t('com_ui_response_stats_input_cached', {
            0: formatCount(stats.input, language),
            1: formatCount(stats.cacheRead, language),
          })
        : t('com_ui_response_stats_input', { 0: formatCount(stats.input, language) }),
    );
  }
  if (positive(stats.output)) {
    parts.push(t('com_ui_response_stats_output', { 0: formatCount(stats.output, language) }));
  }
  parts.push(...speedPart('com_ui_response_stats_prefill', stats.prefillTps, t, language));
  parts.push(...speedPart('com_ui_response_stats_decode', stats.decodeTps, t, language));
  if (stats.partial) {
    parts.push(t('com_ui_response_stats_partial'));
  }
  return parts.join(SEPARATOR);
}

function callLine(
  call: TResponseStatsCall,
  index: number,
  t: Translate,
  language?: string,
): string {
  const parts = [t('com_ui_response_stats_call', { 0: index + 1 })];
  parts.push(...secondsPart('com_ui_response_stats_seconds', call.elapsedMs, t, language));
  parts.push(...secondsPart('com_ui_response_stats_queue', call.queueMs, t, language));
  parts.push(
    ...secondsPart(
      call.firstGenerationKind != null
        ? FIRST_KEY[call.firstGenerationKind]
        : 'com_ui_response_stats_first_generation',
      call.firstGenerationMs,
      t,
      language,
    ),
  );
  if (positive(call.newTokens)) {
    parts.push(t('com_ui_response_stats_new', { 0: formatCount(call.newTokens, language) }));
  } else if (positive(call.input)) {
    parts.push(t('com_ui_response_stats_input', { 0: formatCount(call.input, language) }));
  }
  if (positive(call.cacheRead)) {
    parts.push(t('com_ui_response_stats_cached', { 0: formatCount(call.cacheRead, language) }));
  }
  if (positive(call.output)) {
    parts.push(t('com_ui_response_stats_output', { 0: formatCount(call.output, language) }));
  }
  parts.push(...speedPart('com_ui_response_stats_prefill', call.prefillTps, t, language));
  parts.push(...speedPart('com_ui_response_stats_decode', call.decodeTps, t, language));
  return parts.join(SEPARATOR);
}

/** The tool as the viewer names it: a built-in's friendly name, or an MCP tool beside its server. */
function toolLabel(name: string | undefined, t: Translate): string {
  if (name == null || name === '') {
    return t('com_ui_response_stats_tool');
  }
  const { title, caption } = presentTool(name, { localize: t });
  return caption != null
    ? t('com_ui_response_stats_tool_server', { 0: title, 1: caption })
    : t('com_ui_response_stats_tool_named', { 0: title });
}

/** One line per answer model call in order, then one per tool call; plain text. */
export function statsRows(stats: TResponseStats, t: Translate, language?: string): string[] {
  const calls = stats.calls.map((call, index) => callLine(call, index, t, language));
  const tools = stats.tools.map((tool) =>
    [
      toolLabel(tool.name, t),
      ...secondsPart('com_ui_response_stats_seconds', tool.elapsedMs, t, language),
    ].join(SEPARATOR),
  );
  return [...calls, ...tools];
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** The tooltip renders sanitized HTML for its line breaks, so every row is escaped first. */
export const rowsToHtml = (rows: string[]): string =>
  rows.map((row) => row.replace(/[&<>"]/g, (char) => ESCAPES[char])).join('<br>');
