const assert = require("node:assert/strict");
const test = require("node:test");
const { createIdempotentAction } = require("../simulation-idempotency");

test("concurrent duplicate incidents share one notification operation", async () => {
  const runOnce = createIdempotentAction();
  let sendCount = 0;
  let release;
  const providerResponse = new Promise((resolve) => {
    release = resolve;
  });
  const send = async () => {
    sendCount += 1;
    return providerResponse;
  };

  const first = runOnce("incident-1", send);
  const second = runOnce("incident-1", send);
  release({ sentCount: 2 });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(sendCount, 1);
  assert.equal(firstResult.duplicate, false);
  assert.equal(secondResult.duplicate, true);
  assert.deepEqual(firstResult.result, secondResult.result);
});

test("separate incidents each notify and failed attempts are not replayed", async () => {
  const runOnce = createIdempotentAction();
  let sendCount = 0;
  const send = async () => {
    sendCount += 1;
    if (sendCount === 1) throw new Error("provider unavailable");
    return { sentCount: 1 };
  };

  await assert.rejects(runOnce("incident-1", send), /provider unavailable/);
  await assert.rejects(runOnce("incident-1", send), /provider unavailable/);
  const nextIncident = await runOnce("incident-2", send);

  assert.equal(sendCount, 2);
  assert.equal(nextIncident.duplicate, false);
  assert.deepEqual(nextIncident.result, { sentCount: 1 });
});
