# Local turn diagnostics

## Purpose and ownership

Implement a persisted diagnostics view for each LibreChat assistant response in
our self-hosted LLM setup. A response may contain several model requests and tool
calls. Show those calls individually, their relationships and measured timings,
not just a token count on the final text.

Keep the existing product boundaries:

- LibreChat captures the turn, model and tool lifecycle, stores diagnostics with
  the conversation's access boundary, and displays them.
- llm-router measures routing and queue wait for requests passing through it.
- llama-server reports its own token usage and inference timings.
- llm-hub continues onboarding and qualifying models, tools and engine builds.
  It is not a runtime tracing database or chat proxy.
- fleet-ops deploys pinned builds and configuration. Do not deploy this work to
  the running cluster, change the current image pin, or restart live services.

No Langfuse service, external telemetry destination, new database service or
browser extension is required. Existing Langfuse integrations must keep working.

## Baseline and local fork

The combined implementation lives in the public fork
`https://github.com/sandeepshelke/LibreChat`, branch `local-image-preview`,
kept rebased on upstream `main`. Branch `tool-rounds` of the same fork holds
the host-side tool-round fix alone; `local-image-preview` adds diagnostics,
the info button and the image recipe on top of it. The matching agents
changes live in `https://github.com/sandeepshelke/agents`, branch
`tool-rounds`, rebased on agents `main` (4.0.4). The local checkout is
`sandbox/librechat/librechat-pr`. Fork publication does not deploy an image or
open an upstream pull request.

Router and deployment configuration changes are outside this fork. The local
diagnostics mode remains opt-in; missing provider/router measurements are
omitted rather than fabricated.

## Reuse these existing surfaces

Read the fork's `AGENTS.md` before implementation.

- `packages/api/src/traces/types.ts` defines a provider-neutral `TraceReader`.
- `packages/api/src/traces/handlers.ts` already gates reads by authenticated
  user, tenant and conversation ownership, validates identifiers, applies
  disclosure policy, and distinguishes missing data from failed reads.
- `api/server/routes/traces.js` currently wires that reader to Langfuse.
- `packages/data-provider/src/types/traces.ts` defines records, usage, pages,
  detail responses and errors. It already has parent IDs, response message IDs,
  cache-read/write counts and first-completion timestamps.
- `client/src/components/Chat/Trace/` already has a viewer, timeline, ledger,
  inspector, turn grouping, pagination and tests. Extend these, do not build a
  parallel diagnostics application.
- `packages/api/src/agents/toolTiming.ts` and the agent callbacks already track
  tool preparation and dispatch/completion. Dispatch is an SDK handoff, not
  proof that a remote tool host started executing.
- `api/server/controllers/agents/client.js` has fresh-run, resume and title
  flows. Put new behavior in TypeScript under `packages/api`, keeping CJS edits
  to dependency/handler wiring.
- `llm-router/src/proxy.rs` measures queue wait before forwarding and streams
  responses without buffering. `record.rs` reads final usage/timings;
  `shared.rs` stores arrival/start/end, selected backend, status and token counts.

Verify which controller actually serves the deployed custom OpenAI-compatible
endpoints with MCP enabled; do not instrument only an unused legacy path.

## Configuration and compatibility

Add an opt-in local diagnostics mode to the existing trace configuration.
Default behavior must remain unchanged. Resolve settings in one shared helper,
including runtime/admin overrides, and expose them through the existing startup
config rather than a new discovery request.

Local mode must work without Langfuse keys or trace sampling. Selecting local
storage must select the local reader explicitly; do not silently fall back to
Langfuse or hide a failed local read as an empty trace. Existing deployments using
Langfuse keep their existing reader and behavior.

Use the existing trace record limits where appropriate; any new per-turn storage
limit must be schema-configurable, bounded, and explicitly reported when reached.
Diagnostics off must not install response-body interception or make extra
diagnostics database calls.

Document the exact YAML needed for local mode. Update the fleet-ops template to
support an opt-in setting whose default is off; do not enable it on the current
upstream image. Keep model selection, MCP defaults, summarization, account copy,
uploads and authentication unchanged.

## Record and identity contract

Use additive typed fields on the existing provider-neutral contract. Keep raw
provider payloads and internal URLs out of it.

A turn is one assistant response attempt, identified by the existing response
message ID plus the run incarnation where the framework can reuse that ID.
Associate it with authenticated user, tenant, conversation and parent user
message using server-owned context, never request-supplied ownership fields.

Each model/tool call has a unique record ID, a parent record ID and a turn ID.
Use framework run/tool-call IDs where reliable. Distinguish retries, parallel
calls, regenerated responses, resumed segments and concurrent chats. Do not join
by model name, prompt text, timestamp proximity or process-global mutable state.

Record the following, where actually observable:

- Turn: accepted/start/end, terminal state, capture completeness.
- Model attempt: logical model, safe selected-backend label, start/end,
  first-generation event, queue wait, input/output/cache counts, provider
  inference timings, safe status/error code, retry/attempt association.
- Tool: safe tool/server name, preparation and dispatch/completion, status,
  tool-call ID, parent generation/round and safe failure classification.

Reuse existing status representations when they express the state. Extend them
additively when necessary to distinguish cancelled, interrupted, incomplete and
failed work. An aborted call must never appear as successful. A paused approval
is not a tool execution failure. Browser disconnection is not necessarily
cancellation in LibreChat's resumable generation system.

## Measurement definitions

Durations use a monotonic clock within their measuring process. Wall-clock ISO
timestamps locate records on the timeline. Never subtract wall clocks across
hosts to infer duration. Values are finite, nonnegative, with explicit units.
Missing is not zero; do not manufacture values from character counts.

| Metric                       | Definition                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Turn elapsed                 | Accepted turn to terminal response, excluding unrelated title generation                                            |
| Router queue wait            | Router pool-acquire wait measured by the router, not total HTTP time                                                |
| Model-call elapsed           | Physical request start to body completion/error/cancellation                                                        |
| First-generation latency     | Physical request start to first nonempty generated text, reasoning or tool-call delta; say which semantics are used |
| First visible answer latency | Only if separately observed; do not label reasoning/tool output as visible answer                                   |
| Input tokens                 | Provider-reported total input, including cache-read tokens where that provider defines it that way                  |
| Cache-read tokens            | Provider-reported reused input; zero only when explicitly reported                                                  |
| Output tokens                | Provider-reported generated tokens; retain reasoning breakdown when reported                                        |
| Decode speed                 | Provider output count divided by provider decode duration; unavailable without compatible numerator and denominator |
| Tool elapsed                 | SDK dispatch to observed completion; do not call it remote CPU/execution time                                       |

For llama-server, `cache_n + prompt_n` is total input, `cache_n` is cache read,
`predicted_n` is output, and `predicted_ms` is provider decode duration.
Validate these fields independently. Cache use is not an extra token charge on
top of total input. OpenAI `usage` and llama-server `timings` may coexist:
normalize once, do not count both.

Preserve raw measurements as typed numeric fields with their source/semantics,
not as a JSON blob in a text inspector. Show queue wait as unavailable on direct
backends or older routers. Show first-generation latency as unavailable for a
non-streaming response unless there is a real provider measurement.

Do not sum parallel durations into wall-clock turn latency. Sum model token
usage once per physical attempt; mark totals partial when any included call
lacks usage. Separate title/activity-label/background calls from response work.
Record them under their existing origin/role where instrumented, not in the
answer's main throughput or latency.

## Capture and router integration

Prefer existing run/model/tool hooks. Share capture logic between initial and
resumed runs; do not duplicate instrumentation in every controller.
Tool errors include tools returning an error result without throwing.

For OpenAI-compatible transport, capture usage and llama-server timings even
when the SDK drops extension fields. Instrument the actual response stream with
a bounded incremental parser/pass-through; never buffer the full answer, consume
it twice, write per token to Mongo, or change the bytes delivered to the SDK.
Handle SSE frames split across arbitrary byte/UTF-8 boundaries, multiple events
per chunk, usage-only final chunks, CRLF, `[DONE]`, non-stream JSON, HTTP errors
and malformed/truncated responses. Missing final usage after abort stays missing.
Only advertise measurements actually seen. Avoid retaining request/response
content in the capture layer.

Add response metadata to llm-router using additive headers:

- `X-LLM-Router-Queue-Ms`: measured queue wait in milliseconds.
- `X-LLM-Router-Backend`: safe configured backend name, not host/IP/URL.

Read these on LibreChat's server-side transport and bind them to that exact
attempt. Set/overwrite them at the router, never trust backend-supplied versions.
Apply queue measurement to timeout/error responses when it exists; omit backend
when none was selected. Do not require shared-state recording for the headers.
Preserve response bodies, streaming, hop-by-hop filtering, cancellation, status
codes, slot release and old-client compatibility. Treat invalid header values as
unavailable with bounded safe diagnostics, not as zero.

If a correlation header is needed, generate a fresh opaque ID per physical
request at the authenticated server boundary and use it consistently; never put
user IDs, chat text or credentials into a model-facing header. No publicly
accessible router job-record endpoint is needed.

## Persistence and authorization

Implement a local `TraceReader` over LibreChat's existing Mongo database.
Prefer a bounded diagnostics snapshot attached to the existing assistant message
and its normal persistence lifecycle over a new tracing service. Reuse durable
job state for partial capture where practical. Keep database methods and schema
in `packages/data-schemas`, with plain typed dependency interfaces elsewhere.

Persist completed, failed, cancelled and paused/resumed turns, not just successes.
Restoring a conversation after browser/API restart must show the saved data.
If a process crash prevents final capture, show incomplete/unavailable; never
guess a successful ending. Include explicit capture truncation/failure state.
If embedding cannot preserve required lifecycle data, justify a separate
collection before adopting it, including bounded retention and conversation/user
deletion integration.

Read/list/detail must all enforce user, tenant, conversation, message, and record
membership. Availability cannot reveal another user's record existence. Respect
temporary-chat retention and deletion behavior. Copied/imported/forked messages
must not inherit pointers claiming another run's diagnostics. Shared/public
conversation views must not gain access to private diagnostics.

By default store only allowlisted IDs, numeric measurements, safe labels and
status codes. No prompts, completions, tool arguments/results, credentials,
headers, raw exceptions or stack traces. Do not let `showInputOutput` accidentally
expose data local mode did not intentionally collect.

Diagnostics failures must not break a working chat. Catch at the capture
boundary, log safe error metadata with correlation and mark capture incomplete;
do not silently claim complete diagnostics. Failed reads use the existing
non-success response contract, not an empty successful result.

## User experience

Add a discoverable Diagnostics/Trace action beside each assistant response,
opening the existing viewer focused on that response. Retain the conversation
trace entry point. Do not show only a conversation-wide view with no turn link.

Show turn elapsed, model/tool call counts, input/output/cache totals and
completeness. Expand model attempts to see routing, queue wait, first-generation
latency, generation speed and outcome. Show tool calls and errors as separate
records in execution order with parent relationships and parallel overlap.
Expose safe error codes, not raw messages that may contain secrets.

Use existing primitives, semantic theme roles, localization (English keys only),
React Query and feature-owned state. Cover disabled, no data/old message, loading,
running/partial, paused, complete, cancelled, error, truncated and read-failure
states. Unknown measurements say unavailable, not `0 ms`, `0 tokens` or `NaN`.
Keyboard and screen-reader access must work.

## Acceptance criteria

1. A real LibreChat request path using a local fake OpenAI-compatible server and
   fake tool produces a saved turn with model -> tool -> model records. Reopen
   the saved turn and see the same values in the viewer.
2. A deterministic streaming fixture reports input 120, cache read 80, output
   20 and decode 2000 ms. Display 120 input, 80 cached, 20 output, 10 tokens/s;
   never 200 input. Queue 250 ms is distinct from first-generation latency.
3. Split SSE/UTF-8/CRLF, final usage-only and non-stream JSON fixtures preserve
   exactly the original response bytes and parse only supported measurements.
4. Parallel tools/model attempts and two simultaneous users/chats retain their
   own IDs. Retry/regenerate/resume does not overwrite or double-count records.
5. Tool error results, thrown errors, HTTP 429/500, queue timeout, abort and
   missing final usage have honest status/completeness and no fabricated values.
6. A direct backend without router headers succeeds; queue and backend are
   unavailable. An older provider without usage still shows measured durations.
7. Cross-user, cross-tenant, cross-conversation and forged message/record reads
   fail, including availability/detail/cursor paths. No sensitive fixture strings
   appear in diagnostics, API results or user-visible error text.
8. With diagnostics off, existing chat, traces and Langfuse tests retain their
   behavior. No diagnostics network destination or storage access is introduced.
9. Router tests verify metadata on success/failure, tampered upstream headers,
   unchanged streaming bytes, cancellation and slot release.
10. Focused capture/database/route/component tests pass. Build and typecheck every
    changed TypeScript workspace; run relevant router tests and formatting/lint.
    Follow the repository's lighthouse requirement if changing startup/message
    loading; explicitly report infrastructure blockers rather than claiming a
    pass. Do not run a full monorepo test suite merely for convenience.

## Delivery

Implement and validate locally using Sonnet 5.5. Keep changes reviewable and
focused. Add the exact build/configuration instructions and verified limitations
to this document as implementation settles. Do not mark acceptance criteria
complete based only on helper unit tests: exercise actual controller wiring,
persistence and the per-response UI entry point.

Use existing build scripts/Dockerfile with source commit metadata. Do not copy
the pinned image's production node_modules to the host (native dependencies and
development tools differ). Install dependencies only after a validation command
shows they are missing, or after a necessary manifest change.

Stop and report if a hard blocker makes a required surface unreachable. Do not
substitute a static mock page or an unconnected capture library for the feature.
No live deployment, remote writes, automatic commits, hosted fork or PR.

The user is offline: proceed autonomously without waiting for clarification.
Finish with a screenshot of the implemented diagnostics UI rendered locally with
deterministic non-sensitive fixture data. Prefer a real local end-to-end run; a
component/browser harness using the actual production component is acceptable
if full-stack startup is blocked, but label that distinction explicitly. Do not
present a mockup as the implemented app. Store screenshots in the session's
`files/` artifact directory and report their absolute paths.

## Implementation notes (local fork, uncommitted)

Status: implemented and validated locally on `llm-cluster` (upstream v0.8.8). Nothing was committed, pushed or deployed, and the deployed image pin is unchanged. This section was revised after review; the "Review fixes" list says what changed and the limitations are listed plainly.

### What exists

- **Config** (`packages/data-provider`): `interface.traceViewer.source` (`langfuse` default, or `local`) and `maxLocalRecordsPerTurn` (default 200, 1-1000). `librechat.example.yaml` documents both. Local mode needs `enabled: true` and `source: local`; everything is off by default and Langfuse mode is untouched.
- **Capture** (`packages/api/src/traces/{meter,capture,controller}.ts`): a byte-transparent wrapper around the provider `fetch` (one HTTP request is one model record), a tool observer (prepared, dispatched, completed, failed, paused), and a per-turn snapshot. `controller.ts` holds the logic the CJS controllers call (turn-state resolution, restore, tool-error callback, fetch wrapping, title wrapping, late re-save). `packages/api/src/agents/run.ts` meters custom/OpenAI-compatible root agents and, for those, their summarization model; other providers get a `models_not_captured` note.
- **Wiring** (CJS only, thin): `initialize.js` creates the capture only in local mode; `callbacks.js`, `client.js` (`chatCompletion`, `resumeCompletion`, `titleConvo`), `BaseClient.js`, `request.js` (failed and disconnect-cancelled turns) and `resume.js` (re-pause, final save, failed resume) persist `turnDiagnostics` on the assistant message, re-keyed to the saved message id.
- **Persistence** (`packages/data-schemas`): `message.turnDiagnostics` (`select: false`, never in client message selects, stripped by `withoutTraceRefs` on import/fork/message writes), plus user/tenant/conversation-scoped `listTurnDiagnostics` (optional `messageId`, inclusive/exclusive `through`) and `listTurnDiagnosticMessageIds`.
- **Reader** (`packages/api/src/traces/local.ts`): a provider-neutral `TraceReader` and a source dispatcher used by `api/server/routes/traces.js`. Cursors are opaque and validated; records whose ids do not match their row are dropped; tool names are redacted unless `showToolNames`.
- **UI** (`client/src/components/Chat/Trace`): a per-response "Response diagnostics" action in `HoverButtons`, a focus atom that narrows the existing viewer to one response, a `TurnPanel` (state, elapsed, segments, answer calls, title/summary calls, input/cache/output totals, capture notes) and inspector fields (outcome, error code, HTTP status, attempt, tool results used, backend, router queue wait, first-generation latency and kind, prompt time, decode time and speed, dispatch-to-completion). A metric nobody reported reads "Unavailable", never zero. English locale keys only.
- **Router** (`/home/ipc/workspace/llm-router`): additive `x-llm-router-queue-ms` and `x-llm-router-backend` response headers on proxied job responses (`src/proxy.rs`, `tests/router.rs`), documented in the router README. Upstream-supplied values are removed first, the backend name is token-validated, streaming and cancellation are unchanged. `cargo fmt` and `cargo clippy --all-targets -D warnings` pass. Capture validates the headers again and records `router_header_invalid` otherwise.

### Review fixes

1. **Ancestry is proven, never guessed.** A tool's parent is the model whose own response stream carried that `tool_call` id. A model's parent comes only from the tool-result ids in its own request body (chat `role: tool` after the last assistant message, Responses `function_call_output`): one result gives `parentId`, several give `dependsOn` with a null `parentId`, none gives a root. Concurrent models and parallel tools therefore never form a chain by time or order. The body is parsed transiently and only ids are kept.
2. **Tool elapsed is monotonic only.** `elapsedMs` is completion minus dispatch on the process monotonic clock, only when both were observed in the same segment; otherwise it is absent. There is no wall-clock subtraction, no cap, and the "tool preparation" row was removed. A tool resumed without a re-dispatch has no elapsed.
3. **The meter is bounded.** One event line (1M chars), one event (256 lines / 1M chars) and the JSON picker are capped however chunks fall. Overflow counts as unreadable and adds a `response_unreadable` note. `finish()` flushes a final frame without a blank line before reading, and a non-stream body only counts as terminated when its JSON document closed; otherwise the call is `incomplete`. `usage_missing` fires when a completed call lacks input or output. Bytes are always forwarded unchanged.
4. **Terminal outcomes.** `resolveTurnState` makes a caught terminal error `failed`, the step limit `incomplete`, cancellation `cancelled`, a pending approval `paused`. A failed or missing seed read marks the turn `capture_failed`. A resume that fails after earlier segments were restored saves `failed` diagnostics. A stored `running` snapshot that no live job for the conversation owns is shown as `interrupted` with a `process_ended` note; with no job lookup or on lookup failure the stored state is shown as is.
5. **Local reader limits.** `maxRecords` also applies to the first oversized turn, with a within-turn cursor; availability is not capped; `?message=<id>` reads one old turn without loading earlier ones (the viewer sends it from its focus); an invalid cursor is `invalid_request`.
6. **Auxiliary calls.** Summarization (root custom/OpenAI-compatible agents) and title calls are recorded with `origin: summarization|title`, shown with their own labels, and excluded from the answer's call, token and cache totals. Subagent model calls are not captured; when a subagent update occurs the turn is marked `subagents_not_captured` and incomplete rather than complete.
7. **Boundaries.** The new helper logic lives in `packages/api`; CJS only wires. `FetchLike` is a real `fetch`-compatible signature without `as never` casts. The unrelated `isSubagent` refactors in `run.ts` were reverted.

### Fleet configuration

`fleet-ops` now wires this as opt-in (done by the parent task, not in this repository): `llm-cluster/{cluster.defaults.toml,cluster_config.py,deploy_librechat.yml,README.md,tests/test_cluster_config.py}` add `[librechat].diagnostics_enabled` (default `false`) -> `librechat_diagnostics_enabled` -> generated `interface.traceViewer {enabled: true, source: local, showToolNames: true}`, only when opted in. Six LibreChat config/deploy tests pass, comparing the rendered config with the option on and off with no other change. The image pin is unchanged. The user's edits in `fleet-ops/docs/*/TODO.md` are untouched. For a hand-managed deployment the equivalent is:

```yaml
interface:
  traceViewer:
    enabled: true
    source: local
    showToolNames: true # optional
```

and a build that contains this work must be rolled out first.

### Known limitations

- Only the agent chat path is captured. The `responses.js` and `openai.js` API-compatible controllers are not instrumented.
- Providers other than custom/OpenAI-compatible are not measured (`models_not_captured`); the same note appears when such a provider summarizes or titles.
- Subagent child-graph model calls are not captured (`subagents_not_captured`).
- A resume that fails before its seed is restored leaves the stored `paused` snapshot as it was. A title that finishes after the response was saved is re-saved only if the response snapshot had already settled.
- A turn left `running` by a killed process is shown as interrupted after checking job ownership; the stored data itself is not rewritten. A failed job lookup returns a read error, not an assertion that the turn is still running.
- A model call's ancestry is unknown when its request body carries no tool-result ids the capture saw; it then shows as a root.
- `showInputOutput` has no effect in local mode (only metadata is stored); `getRecord` returns `contentAvailable: false`.
- With diagnostics off there is no fetch wrapping and no extra database work.

### Build, run and validate

```bash
npm ci --ignore-scripts
npm run build:packages            # data-provider, data-schemas, api, client package
(cd client && npm run build)      # serves from client/dist
# configure librechat.yaml as above, then:
npm run backend
```

Validation (all local): `npx tsc --noEmit` in `packages/{data-provider,data-schemas,api}` and `client` (clean); jest for `packages/api/src/traces` and `src/agents` (4,681 tests), `packages/data-schemas` message specs, `packages/data-provider/specs/config-schemas.spec.ts`, `api/server/controllers/agents`, `api/server/services/Endpoints/agents`, `api/server/routes/__tests__/traces.spec.js` and `client/src/components/Chat/{Trace,Messages}`; eslint and prettier on all touched files; `cargo test` for `llm-router` in the `rust:1-slim-bookworm` image. `npm run lighthouse` needs `CHROME_PATH` and `LIGHTHOUSE_CHROME_FLAGS=--no-sandbox` on this host (Chrome refuses to start without a sandbox otherwise); with them the median LCP was 4,124 and 4,114 ms against the 4,500 ms budget (one run on a loaded host measured 4,549 ms and failed; CLS and TBT were within budget in every run).

A full local end-to-end run was repeated after the fixes: the real server on a temporary MongoDB, an OpenAI-compatible fixture that returns two parallel tool calls and then an answer (with router headers, llama.cpp-style `timings`, a title response), and a stdio MCP fixture, driven in headless Chromium. It showed the title call apart from the answer, both tools under the first model, the second model with "Tool results used 2", elapsed values from the monotonic clock, and totals of 2 model calls, 2 tool calls, input 300, cache 200, output 32 with the title call counted separately. The scratch harness and processes were removed; the harness copy is kept with the session screenshots.

### Response stats line (local fork, uncommitted)

An info icon in each saved answer's action bar, for `traceViewer.source: local` only. Hover or keyboard focus shows a tooltip with the totals, for example `34.1 s · 2 calls · 2 tools · 41.2K in (38.0K cached) · 812 out · prefill 410 t/s · decode 21.3 t/s`, followed by the answer model calls in order and then the tool calls. No statistics text occupies the action bar. The newest answer always shows the icon; older ones show it on row hover or focus, and touch devices keep it visible. Enter, a click or a tap opens the existing viewer on that response. When stats are available this replaces the separate diagnostics button; other trace sources retain their existing viewer button. Totals and detail rows are formatted only on first interaction, including summaries without per-call records.

Provenance: everything comes from the stored `turnDiagnostics` snapshot; nothing new is captured and the router, capture and stored data are unchanged. One request per conversation, `GET /api/traces/:conversationId/summaries`, returns a compact summary and numeric tooltip rows for every saved answer. It reuses the trace routes' user, tenant and conversation checks, the read limiter and the `showToolNames` setting (tool names are left out of the response unless it is on). The database read projects only the fields it needs from the `select: false` snapshot in one query; the snapshot and summaries are never attached to the message DTO. Title and summarization calls are excluded. Prefill is `1000·Σ(input−cacheRead)/Σ prompt ms` and decode is `1000·Σ decode tokens/Σ decode ms`, each over only the calls that report every field needed; per-call speeds are never averaged. Only reported positive figures are shown, and `partial` is added when a call lacks usage or cache counts. A paused answer says "paused", a running answer shows nothing, and the first-generation time is labelled by what came first (text, reasoning or tool call), never as TTFT.

Display rules: figures are shown only when reported, with one decimal for seconds. A positive value that would print as `0.0` (for example a 40 ms queue wait) is omitted rather than shown as zero; the same applies to elapsed, first-generation and tool times and to speeds. Tool names use the viewer's presentation (MCP tools appear as `lookup_weather (fixture)`), and the server leaves names out unless `showToolNames` is on. `partial` is also set when records were truncated, subagents or models were not captured, capture failed, records were dropped, or the turn was left running by a process that ended, even if every retained record has usage. The tooltip is plain text built from escaped values (`&`, `<`, `>` and quotes are covered by tests) and is formatted only on first hover, focus or touch of that line, so a long history formats nothing it never shows. The line is a button: Tab reaches it, focus shows the tooltip, Enter or a click opens the viewer; on a touch screen a tap opens the viewer, which has everything the tooltip does.

Client: one query subscription in `ResponseStatsProvider` (mounted in `MessagesView`) feeds a map keyed by message id; rows read it without fetching. The provider refreshes when a run settles or pauses; the refresh cancels any older request still in flight, so a read that began before the save cannot overwrite it, and a pause and a settle in the same task make one request. Changing conversation while busy refreshes nothing for the old one. If the newest answer is still absent after a settle, it asks again at most twice (after 1 s, then 3 s), keyed on that answer's id; an answer that never gets stats (for example a provider that is not captured) therefore costs up to two extra requests per turn and then stops. There is no polling. Disabled, non-local or unsaved conversations make no request and render nothing. A failed read shows no line and one safe error toast per failure at the conversation level ("Response statistics couldn't be loaded. Reload the conversation to try again.", or the existing rate-limit message), never raw error text and never one per row; an empty page shows neither.

Server cost: the database read is one query with a minimal projection. Stored `running` rows (an abandoned turn) are classified together after at most one live-job lookup for the conversation, and none when no row is running; a failed lookup is a read error, not a claim that the turn is still running.

Measured locally (fixtures only, no model calls; not model performance numbers): Lighthouse with the repository's 250 ms per-query database delay, 60 answers with stored snapshots, three runs each. Disabled: 0 summaries requests, median LCP 4,243 ms, TBT 378 ms, CLS 0.017. Enabled (`source: local`): 1 summaries request (about 0.8 s under the delay, started after the messages arrive), 60 lines, median LCP 4,210 ms, TBT 432 ms, CLS 0.017, all within the 4,500/500/0.1 budgets; the roughly 50 ms of extra blocking time is the cost of rendering 60 tooltip anchors. Rendering 500 rows in jsdom took about 0.9 s enabled (one request, no tooltip formatted) and about 20 ms disabled. The existing availability observers also request availability several times per load when diagnostics are enabled; this predates the stats line and was not changed.

Refresh safeguards: a completed resume retries when the stored summary still says "paused", even when the response id is unchanged. Starting generation cancels an earlier settle's retries; pending refreshes do nothing after navigation, unmounting or disabling diagnostics. Failed refreshes hide previously cached figures as well as showing the safe error toast.

Limitations: the retry bound means a slow save after a settle can still show its line only after a reload. A second pause with the same response id cannot distinguish an earlier paused snapshot from the new one until persistence catches up. A pause or abort was verified by unit tests, completion also end to end (the line appeared without a reload about 2.5 s after sending). Summaries share the trace limiter (30 requests a minute per user by default). Speeds need `timings` from the model server; otherwise they are omitted. Figures are as reported by the model server and router, not independently measured.

Fixture screenshots (from the production build and the local fixtures): `response-stats-line.png`, `response-stats-tooltip.png` (friendly tool names, no `queue 0.0 s`), `response-stats-keyboard-focus.png`, `response-stats-mobile-{line,tooltip}.png` and `response-stats-error.png`. Reproduce by running the saved e2e harness (`e2e-harness/start.sh` from a scratch directory inside the repo, then `setup.cjs` and `shoot-stats.cjs`) and removing it afterwards.

## Local deployable image

`Dockerfile.local` is upstream's `Dockerfile` plus one step: after `npm ci`, the agents package in
`node_modules` is replaced by `local-image/agents.tgz`, our build of the agents fork, after its
checksum is verified. The lockfile pins agents 4.0.4, the fork's base, so the rest of the locked
dependency tree is unchanged. Do not replace the tar overlay with `npm install --no-save`: that can
change unrelated transitive dependencies. The tarball still reports version 4.0.4; its checksum and
the image labels distinguish it from the published package. A release needs a proper version pin.

Build with `bash local-image/build.sh`. It refuses uncommitted changes, exports the last commit to
a temporary folder so local `node_modules`, logs and edits stay out, and tags the result
`librechat-local:diagnostics-tool-rounds-<commit>`. `npm ci` inside the build needs network access.
Labels name the commit and the agents revision and checksum. The image runs as the non-root `node`
user on port 3080 and needs the normal external MongoDB, runtime secrets, configuration and
persistent volumes. No database, fixture server, production configuration or credentials are
embedded.

Use this image in place of the upstream LibreChat application image in a deployment's Compose
configuration. To enable local diagnostics, include:

```yaml
interface:
  traceViewer:
    enabled: true
    source: local
    showToolNames: true
```

Leave the normal endpoint/model configuration in that deployment's `librechat.yaml`; do not deploy
`local-image/fixtures/config.yaml`, which is deliberately fixture-only. No live deployment or
registry push is performed by the local build.

Container verification, `bash local-image/verify.sh IMAGE EVIDENCE_DIR`, runs
`local-image/verify.cjs` against an isolated fixture environment:
the built image, disposable MongoDB, the model and MCP scripts under `local-image/fixtures`,
and an internal-only Docker network. `local-image/proxy.cjs` exposes the app on host loopback
port 3199 without giving the containers external network access. Set `VERIFY_CONTAINER_IP` to
the app's address for the proxy and `VERIFY_OUTPUT` to an evidence directory for the verifier.
The fixture app uses `SCHEDULES_SINGLE_PROCESS=true`, because it is explicitly a single replica.
The database uses the deployment's pinned MongoDB 8.0.20 image and at least 2 GiB of temporary
database filesystem capacity; the available 8.0.32 image refuses to start on this host's kernel.

The verifier checks three persisted tool calls (two parallel, then a separate round), ordinary
streamed text before both rounds without `tool_call_ids`, exact whitespace-preserving preambles,
next-turn serialized message-prefix equality, reported usage totals, one summary request on
reload, the icon-only toolbar, hover and keyboard details, opening the full viewer, and mobile
tap behavior. Measurements in the earlier section refer to the previous inline-stats UI;
the image verification is functional evidence, not a new Lighthouse or live-model speed benchmark.

The image built from this branch passes all of these checks.
