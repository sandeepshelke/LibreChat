const http = require('node:http');
const fs = require('node:fs');
let sequence = 0;
const requests = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

http
  .createServer(async (req, res) => {
    if (req.url === '/requests') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(requests));
    }
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'qwen-fixture', object: 'model' }] }));
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      return res.end();
    }
    let raw = '';
    for await (const data of req) raw += data;
    const body = JSON.parse(raw);
    requests.push(body);
    fs.writeFileSync('/tmp/fixture-requests.json', JSON.stringify(requests, null, 2));
    const messages = body.messages ?? [];
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Local image verification' } }],
          usage: { prompt_tokens: 40, completion_tokens: 6 },
        }),
      );
    }
    const users = messages.filter((message) => message.role === 'user');
    const toolResults = messages.filter((message) => message.role === 'tool').length;
    const first = toolResults === 0;
    const cities =
      users.length > 1 || toolResults >= 3 ? [] : first ? ['Oslo', 'Bergen'] : ['Tromsø'];
    const base = {
      id: `fixture-response-${++sequence}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'qwen-fixture',
    };
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-llm-router-queue-ms': '100',
      'x-llm-router-backend': 'isolated-fixture',
    });
    const send = (value) => res.write(`data: ${JSON.stringify({ ...base, ...value })}\n\n`);
    const choice = (delta, finish_reason = null) =>
      send({
        choices: [{ index: 0, delta, finish_reason }],
      });
    await sleep(150);
    if (cities.length) {
      choice({
        role: 'assistant',
        content: first ? '  Let me check Oslo and Bergen.\n' : '\nNext, I will check Tromsø.  ',
      });
      choice({
        role: 'assistant',
        content: null,
        tool_calls: cities.map((city, index) => ({
          index,
          id: `call_${city}`,
          type: 'function',
          function: { name: 'lookup_weather_mcp_fixture', arguments: JSON.stringify({ city }) },
        })),
      });
      choice({}, 'tool_calls');
    } else {
      choice({
        role: 'assistant',
        content:
          users.length > 1 ? 'Follow-up complete.' : 'Verified weather in Oslo, Bergen and Tromsø.',
      });
      choice({}, 'stop');
    }
    send({
      choices: [],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 20,
        total_tokens: 220,
        prompt_tokens_details: { cached_tokens: 150 },
      },
      timings: { prompt_n: 50, prompt_ms: 100, predicted_n: 20, predicted_ms: 200, cache_n: 150 },
    });
    res.end('data: [DONE]\n\n');
  })
  .listen(4010, '0.0.0.0', () => console.log('Isolated fixture model ready'));
