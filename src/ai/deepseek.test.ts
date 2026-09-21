import assert from "node:assert/strict";
import { test } from "node:test";
import { DeepSeekClient, DeepSeekError } from "./deepseek.js";

const request = { system: "Return JSON", user: "Generate a weekly digest", maxTokens: 6_000 };

function completion(content: string, finishReason = "stop") {
  return Response.json({
    model: "test-model",
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

function mockClient(responses: Response[], maxAttempts = 3) {
  const bodies: unknown[] = [];
  const delays: number[] = [];
  const client = new DeepSeekClient({
    apiKey: "test-key",
    maxAttempts,
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const response = responses.shift();
      assert.ok(response, "unexpected extra API request");
      return response;
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  return { client, bodies, delays };
}

test("valid JSON succeeds without a retry and preserves metadata", async () => {
  const { client, bodies, delays } = mockClient([completion('{"headline":"Weekly news"}')]);
  assert.deepEqual(await client.completeJson(request), {
    value: { headline: "Weekly news" },
    model: "test-model",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  });
  assert.equal(bodies.length, 1);
  assert.deepEqual(delays, []);
});

for (const content of ['{"headline":', "", "not JSON"]) {
  test(`retries invalid completion ${JSON.stringify(content)} and returns valid JSON`, async () => {
    const { client, bodies, delays } = mockClient([
      completion(content), completion('{"headline":"Recovered"}'),
    ]);
    assert.deepEqual((await client.completeJson(request)).value, { headline: "Recovered" });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(delays.length, 1);
    assert.ok(delays[0]! >= 500 && delays[0]! <= 750);
  });
}

test("persistent invalid JSON fails after the bounded attempt budget", async () => {
  const { client, bodies, delays } = mockClient(Array.from({ length: 3 }, () => completion("bad")));
  await assert.rejects(client.completeJson(request), (error: unknown) =>
    error instanceof DeepSeekError && error.code === "invalid_json" && /after 3 attempts/.test(error.message));
  assert.equal(bodies.length, 3);
  assert.equal(delays.length, 2);
});

test("maxAttempts of one disables retries", async () => {
  const { client, bodies, delays } = mockClient([completion("bad")], 1);
  await assert.rejects(client.completeJson(request), { code: "invalid_json" });
  assert.equal(bodies.length, 1);
  assert.equal(delays.length, 0);
});

test("HTTP and JSON failures share one total retry budget", async () => {
  const { client, bodies, delays } = mockClient([
    new Response("unavailable", { status: 503 }), completion("bad"), completion("bad"),
  ]);
  await assert.rejects(client.completeJson(request), { code: "invalid_json" });
  assert.equal(bodies.length, 3);
  assert.equal(delays.length, 2);
});

test("authentication failures are not retried", async () => {
  const { client, bodies, delays } = mockClient([new Response("unauthorized", { status: 401 })]);
  await assert.rejects(client.completeJson(request), { code: "http_401", status: 401 });
  assert.equal(bodies.length, 1);
  assert.equal(delays.length, 0);
});

test("known truncation keeps its distinct error and is not retried unchanged", async () => {
  const { client, bodies, delays } = mockClient([completion('{"headline":', "length")]);
  await assert.rejects(client.completeJson(request), { code: "truncated_response" });
  assert.equal(bodies.length, 1);
  assert.equal(delays.length, 0);
});
