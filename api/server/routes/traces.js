const express = require('express');
const {
  createTraceHandlers,
  limiterCache,
  createTraceReadLimiter,
  createLocalTraceReader,
  createLocalResponseStatsReader,
  createSourceTraceReader,
  createLangfuseTraceReader,
  GenerationJobManager,
  resolveLangfuseReadDestinations,
} = require('@librechat/api');
const configMiddleware = require('~/server/middleware/config/app');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

/** A generation owns a response while its job for the conversation is still running. */
async function isGenerationLive({ conversationId, messageId }) {
  const job = await GenerationJobManager.getJobStore().getJob(conversationId);
  const owner = job?.responseMessageId ?? job?.metadata?.responseMessageId;
  return job?.status === 'running' && (owner == null || owner === messageId);
}

/** The conversation's running generation, for every stored row at once. */
async function getLiveGeneration({ conversationId }) {
  const job = await GenerationJobManager.getJobStore().getJob(conversationId);
  return job?.status === 'running'
    ? { responseMessageId: job.responseMessageId ?? job.metadata?.responseMessageId }
    : null;
}

const handlers = createTraceHandlers({
  reader: createSourceTraceReader({
    langfuse: createLangfuseTraceReader({
      getConversationTraceRefs: db.getConversationTraceRefs,
      hasSampledTraceMessage: db.hasSampledTraceMessage,
      resolveDestinations: resolveLangfuseReadDestinations,
      fetch: (url, init) => fetch(url, init),
    }),
    local: createLocalTraceReader(
      {
        listTurnDiagnostics: db.listTurnDiagnostics,
        listTurnDiagnosticMessageIds: db.listTurnDiagnosticMessageIds,
      },
      { isGenerationLive },
    ),
  }),
  stats: createLocalResponseStatsReader(
    { listTurnDiagnosticSummaries: db.listTurnDiagnosticSummaries },
    { getLiveGeneration },
  ),
  getConvoOwnership: db.getConvoOwnership,
});
const traceReadLimiter = createTraceReadLimiter({
  store: limiterCache('trace_viewer_user_limiter'),
});

router.use(requireJwtAuth, configMiddleware);
router.get('/:conversationId/availability', handlers.availability);
router.get('/:conversationId/summaries', traceReadLimiter, handlers.summaries);
router.get('/:conversationId/records', traceReadLimiter, handlers.records);
router.get('/:conversationId/records/:recordId', traceReadLimiter, handlers.record);

module.exports = router;
