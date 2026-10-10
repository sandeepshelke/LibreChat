import axios from 'axios';
import type { TTraceErrorCode, TTraceErrorResponse } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

const ERROR_MESSAGES: Partial<Record<TTraceErrorCode, TranslationKeys>> = {
  invalid_request: 'com_ui_trace_error_changed',
  not_found: 'com_ui_trace_error_not_found',
  rate_limited: 'com_ui_trace_error_rate_limited',
  timeout: 'com_ui_trace_error_timeout',
  unauthorized: 'com_ui_trace_error_unauthorized',
  unsupported: 'com_ui_trace_error_unsupported',
};

/** The stable code the trace routes answer a failed read with; never the error's own text. */
export function traceErrorCode(error: unknown): TTraceErrorCode | undefined {
  return axios.isAxiosError<TTraceErrorResponse>(error)
    ? error.response?.data?.errorCode
    : undefined;
}

export function traceErrorMessageKey(error: unknown): TranslationKeys {
  const code = traceErrorCode(error);
  return (code != null ? ERROR_MESSAGES[code] : undefined) ?? 'com_ui_trace_error_generic';
}
