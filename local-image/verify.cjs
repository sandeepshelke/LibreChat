const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');

const base = 'http://127.0.0.1:3199';
const output = process.env.VERIFY_OUTPUT;
assert(output, 'VERIFY_OUTPUT must name an evidence directory');
const user = {
  name: 'Image Fixture',
  email: process.env.VERIFY_EMAIL ?? `image-fixture-${process.pid}@example.test`,
  username: `imagefixture${process.pid}`,
  password: 'Fixture-only-pass-123',
  confirm_password: 'Fixture-only-pass-123',
};

async function api(endpoint, body, token) {
  const response = await fetch(`${base}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `${endpoint} returned ${response.status}: ${await response.clone().text()}`);
  const text = await response.text();
  assert(
    response.headers.get('content-type')?.includes('application/json'),
    `${endpoint} returned a non-JSON response: ${text}`,
  );
  return JSON.parse(text);
}

async function waitForSummary(conversationId, count, token) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const page = await api(`/api/traces/${conversationId}/summaries`, undefined, token);
    if (page.summaries.length === count) return page.summaries;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Expected ${count} persisted response summaries`);
}

function readRequests() {
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'exec',
        'librechat-image-verify-model',
        'node',
        '-e',
        'fetch("http://127.0.0.1:4010/requests").then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e);process.exit(1)})',
      ],
      { encoding: 'utf8' },
    ),
  );
}

async function main() {
  const requestOffset = readRequests().length;
  if (!process.env.VERIFY_EMAIL) {
    await api('/api/auth/register', user);
  }
  const { token } = await api('/api/auth/login', { email: user.email, password: user.password });
  assert(token, 'Fixture login did not return a token');
  const agent = await api(
    '/api/agents',
    {
      name: 'Local image verification',
      provider: 'Fixture',
      model: 'qwen-fixture',
      tools: ['lookup_weather_mcp_fixture'],
      instructions: 'Use the fixture tools to check the weather.',
      model_parameters: {},
    },
    token,
  );
  assert(agent.id, 'Fixture agent was not created');

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(`${base}/login`);
    await page.fill('input[name="email"]', user.email);
    await page.fill('input[name="password"]', user.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/c\//);
    await page.goto(`${base}/c/new?agent_id=${agent.id}`);
    await page.locator('#prompt-textarea').fill('Check the weather in Oslo, Bergen and Tromsø.');
    await page.locator('#prompt-textarea').press('Enter');
    await page
      .getByTestId('screenshot-target')
      .getByText('Verified weather in Oslo, Bergen and Tromsø.', { exact: true })
      .waitFor({ timeout: 60000 });
    const button = page.getByTestId('response-stats-button');
    await button.waitFor({ timeout: 15000 });
    assert.equal(await button.innerText(), '', 'Statistics must not occupy the action bar');
    assert.equal(
      await page.getByTestId('response-diagnostics-button').count(),
      0,
      'Duplicate diagnostics button',
    );
    await page.screenshot({ path: path.join(output, 'info-button.png') });
    await button.hover();
    const tooltip = page.getByRole('tooltip');
    await tooltip.waitFor();
    const tooltipText = await tooltip.innerText();
    assert.match(tooltipText, /3 calls/);
    assert.match(tooltipText, /3 tools/);
    assert.match(tooltipText, /call 1/);
    assert.match(tooltipText, /call 3/);
    assert.match(tooltipText, /lookup_weather/);
    await page.screenshot({ path: path.join(output, 'info-button-tooltip.png') });
    const conversationId = new URL(page.url()).pathname.split('/').pop();
    const [summary] = await waitForSummary(conversationId, 1, token);
    assert.equal(summary.state, 'completed');
    assert.equal(summary.modelCalls, 3);
    assert.equal(summary.toolCalls, 3);
    assert.equal(summary.input, 600);
    assert.equal(summary.cacheRead, 450);
    assert.equal(summary.output, 60);
    const saved = JSON.parse(
      execFileSync(
        'docker',
        [
          'exec',
          'librechat-image-verify-mongo',
          'mongosh',
          'LibreChatImageVerify',
          '--quiet',
          '--eval',
          `const row=db.messages.findOne({messageId:${JSON.stringify(summary.messageId)}}); print(JSON.stringify({content:row.content,diagnostics:row.turnDiagnostics}));`,
        ],
        { encoding: 'utf8' },
      ),
    );
    const toolParts = saved.content.filter((part) => part.type === 'tool_call');
    assert.equal(toolParts.length, 3);
    assert(
      toolParts.every((part) => Number.isInteger(part.response_index)),
      'Missing persisted response_index',
    );
    assert.equal(
      toolParts[0].response_index,
      toolParts[1].response_index,
      'Parallel calls must share a response',
    );
    assert.notEqual(
      toolParts[1].response_index,
      toolParts[2].response_index,
      'Successive tool rounds must differ',
    );

    await page.locator('#prompt-textarea').fill('Continue with a short confirmation.');
    await page.locator('#prompt-textarea').press('Enter');
    await page
      .getByTestId('screenshot-target')
      .getByText('Follow-up complete.', { exact: true })
      .waitFor({ timeout: 60000 });
    await waitForSummary(conversationId, 2, token);
    const requests = readRequests().slice(requestOffset);
    fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2));
    fs.writeFileSync(path.join(output, 'saved-turn.json'), JSON.stringify(saved, null, 2));
    const streamed = requests.filter((request) => request.stream);
    assert.equal(streamed.length, 4, 'Expected three first-turn calls and one follow-up');
    const prefix = streamed[2].messages;
    const preambles = prefix
      .filter((message) => message.tool_calls?.length)
      .map((message) => message.content);
    assert.deepEqual(preambles, [
      '  Let me check Oslo and Bergen.\n',
      '\nNext, I will check Tromsø.  ',
    ]);
    assert(
      saved.content
        .filter((part) => part.type === 'text')
        .every((part) => part.tool_call_ids == null),
      'Fixture must cover ordinary streamed text without tool_call_ids',
    );
    assert.deepEqual(
      streamed[3].messages.slice(0, prefix.length),
      prefix,
      'Reconstructed next-turn request changed the original prefix',
    );
    assert.deepEqual(
      streamed[3].messages
        .filter((message) => message.tool_calls?.length)
        .map((message) => message.tool_calls.length),
      [2, 1],
    );

    // The refresh after the follow-up answer, and its retries up to 3 s apart, can land late;
    // count only the reload's reads.
    let lastSummaryRead = Date.now();
    const noteSummaryRead = (request) => {
      if (new URL(request.url()).pathname.endsWith('/summaries')) lastSummaryRead = Date.now();
    };
    page.on('request', noteSummaryRead);
    while (Date.now() - lastSummaryRead < 4000) await page.waitForTimeout(250);
    page.off('request', noteSummaryRead);
    let summaryReads = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/summaries')) summaryReads++;
    });
    await page.reload();
    await page.getByTestId('response-stats-button').first().waitFor();
    await page.waitForTimeout(500);
    assert.equal(summaryReads, 1, 'Reload must load all response stats in a single request');
    const info = page.getByTestId('response-stats-button').first();
    await page.mouse.move(0, 0);
    await info.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert(
      await info.evaluate((element) => element === document.activeElement),
      'Info button must be keyboard accessible',
    );
    await page.getByRole('tooltip').waitFor();
    await page.screenshot({ path: path.join(output, 'info-button-keyboard.png') });
    await page.keyboard.press('Enter');
    await page.getByTestId('trace-viewer').waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(output, 'info-button-viewer.png') });
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 780 },
      isMobile: true,
      hasTouch: true,
      storageState: await context.storageState(),
    });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(`${base}/c/${conversationId}`);
    await mobilePage.getByTestId('response-stats-button').first().waitFor();
    assert.equal(
      await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      'Info button must not cause mobile horizontal overflow',
    );
    await mobilePage.screenshot({ path: path.join(output, 'info-button-mobile.png') });
    await mobilePage.getByTestId('response-stats-button').first().tap();
    await mobilePage.getByTestId('trace-viewer').waitFor({ timeout: 15000 });
    await mobile.close();
    assert.deepEqual(browserErrors, []);
    const evidence = {
      preambles,
      imageId: execFileSync(
        'docker',
        ['inspect', 'librechat-image-verify-app', '--format', '{{.Image}}'],
        { encoding: 'utf8' },
      ).trim(),
      fixtureEmail: user.email,
      conversationId,
      summary,
      persistedResponseIndices: toolParts.map((part) => part.response_index),
      nextRequestPrefixEqual: true,
      reloadSummaryReads: summaryReads,
      mobileTapOpensViewer: true,
      browserErrors,
    };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
