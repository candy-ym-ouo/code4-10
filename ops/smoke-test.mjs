const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const configuredPassword = process.env.SMOKE_PASSWORD;
if (!configuredPassword) {
  throw new Error("SMOKE_PASSWORD is required");
}
let cookie = "";

async function callWithStatus(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("cookie", cookie);
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...options,
    headers,
    body: options.body instanceof FormData ? options.body : options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return { status: response.status, data: payload };
}

async function call(path, options = {}) {
  return (await callWithStatus(path, options)).data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const status = await call("/setup/status");
if (!status.data.initialized) {
  await call("/setup", { method: "POST", body: { displayName: "Smoke Test Operator", password: configuredPassword } });
  console.log("Initialized a new empty workspace.");
} else {
  await call("/auth/login", { method: "POST", body: { password: configuredPassword } });
}

const suffix = Date.now().toString(36);
const source = await call("/sources", { method: "POST", body: { name: `Smoke Source ${suffix}`, type: "PURCHASED" } });
const material = await call("/materials", {
  method: "POST",
  body: {
    code: `SMOKE-${suffix}`,
    name: `Smoke Material ${suffix}`,
    craftTypes: ["GENERAL"],
    stockUnit: "g",
    lowStockThreshold: "100",
    defaultColorName: "Original",
    defaultColorHex: "#8B5A2B",
    tags: ["smoke"]
  }
});
const batchPayload = {
  materialId: material.data.id,
  batchCode: `B-${suffix}`,
  sourceId: source.data.id,
  receivedAt: new Date().toISOString().slice(0, 10),
  initialQuantity: "1",
  entryUnit: "kg"
};
const [batchResult, repeatedBatchResult] = await Promise.all([
  callWithStatus("/batches", {
    method: "POST",
    headers: { "idempotency-key": `smoke-batch-${suffix}` },
    body: batchPayload
  }),
  callWithStatus("/batches", {
    method: "POST",
    headers: { "idempotency-key": `smoke-batch-${suffix}` },
    body: batchPayload
  })
]);
assert([200, 201].includes(batchResult.status) && [200, 201].includes(repeatedBatchResult.status), "Concurrent batch idempotency returned an unexpected status");
const batch = batchResult.status === 201 ? batchResult.data.data : repeatedBatchResult.data.data;
const repeatedBatch = batchResult.status === 201 ? repeatedBatchResult.data.data : batchResult.data.data;
assert(repeatedBatch.id === batch.id, "Batch idempotency returned a different batch");
const project = await call("/projects", {
  method: "POST",
  body: { name: `Smoke Project ${suffix}`, craftType: "GENERAL", status: "PLANNED" }
});
const requirement = await call(`/projects/${project.data.id}/requirements`, {
  method: "POST",
  body: { materialId: material.data.id, requiredQuantity: "500", unit: "g", purpose: "Smoke verification" }
});
const consumptionPayload = {
  projectId: project.data.id,
  projectRequirementId: requirement.data.id,
  batchId: batch.id,
  usedQuantity: "450",
  wasteQuantity: "50",
  unit: "g",
  purpose: "Smoke verification"
};
const [consumptionResult, repeatedConsumptionResult] = await Promise.all([
  callWithStatus("/consumptions", {
    method: "POST",
    headers: { "idempotency-key": `smoke-consumption-${suffix}` },
    body: consumptionPayload
  }),
  callWithStatus("/consumptions", {
    method: "POST",
    headers: { "idempotency-key": `smoke-consumption-${suffix}` },
    body: consumptionPayload
  })
]);
assert([200, 201].includes(consumptionResult.status) && [200, 201].includes(repeatedConsumptionResult.status), "Concurrent consumption idempotency returned an unexpected status");
const consumption = consumptionResult.status === 201 ? consumptionResult.data.data : repeatedConsumptionResult.data.data;
const repeatedConsumption = consumptionResult.status === 201 ? repeatedConsumptionResult.data.data : consumptionResult.data.data;
assert(repeatedConsumption.id === consumption.id, "Consumption idempotency returned a different row");
assert(consumption.totalQuantity === "500.000000", "Consumption total is incorrect");

const latestOccurredAt = new Date();
await call("/color-changes", {
  method: "POST",
  body: {
    batchId: batch.id,
    projectId: project.data.id,
    changeType: "OTHER",
    afterColorName: "Smoke Brown",
    afterColorHex: "#6B2F1F",
    affectedQuantity: "450",
    unit: "g",
    occurredAt: latestOccurredAt.toISOString()
  }
});
const backdatedColor = await call("/color-changes", {
  method: "POST",
  body: {
    batchId: batch.id,
    projectId: project.data.id,
    changeType: "OTHER",
    afterColorName: "Backdated Blue",
    afterColorHex: "#0000FF",
    occurredAt: new Date(latestOccurredAt.getTime() - 60_000).toISOString()
  }
});
assert(backdatedColor.data.isCurrent === false, "Backdated color was treated as current");

const afterConsumption = await call(`/batches/${batch.id}`);
assert(afterConsumption.data.remainingQuantity === "500.000000", "Batch balance after consumption is incorrect");
assert(afterConsumption.data.currentColorName === "Smoke Brown", "Current color was not updated");
const projectAfterConsumption = await call(`/projects/${project.data.id}`);
assert(projectAfterConsumption.data.requirements[0].actualQuantity === "500.000000", "Project actual quantity is incorrect");
assert(projectAfterConsumption.data.status === "IN_PROGRESS", "First consumption did not start the planned project");

await call(`/consumptions/${consumption.id}/reverse`, { method: "POST", body: { reason: "Automated smoke test reversal" } });
const afterReversal = await call(`/batches/${batch.id}`);
assert(afterReversal.data.remainingQuantity === "1000.000000", "Batch balance after reversal is incorrect");
assert(afterReversal.data.movements[0].type === "REVERSAL", "Reversal movement was not created");

const search = await call(`/materials?${new URLSearchParams({ q: `Smoke Material ${suffix}`, craftType: "GENERAL", color: "Smoke Brown", stockState: "in_stock" })}`);
assert(search.meta.total >= 1, "Material search did not find the smoke-test material");

// 批量补录：故意按倒序提交更早的三次历史变色，链尾仍必须是 Smoke Brown。
const bulkBase = latestOccurredAt.getTime() - 10 * 60_000;
const bulk = await call("/color-changes/bulk", {
  method: "POST",
  body: {
    batchId: batch.id,
    entries: [
      { changeType: "OTHER", afterColorName: "Smoke Oldest", afterColorHex: "#222222", occurredAt: new Date(bulkBase - 20_000).toISOString() },
      { changeType: "OTHER", afterColorName: "Smoke Middle", afterColorHex: "#444444", occurredAt: new Date(bulkBase - 10_000).toISOString() },
      { changeType: "OTHER", afterColorName: "Smoke Oldest2", afterColorHex: "#666666", occurredAt: new Date(bulkBase - 5_000).toISOString() }
    ]
  }
});
assert(bulk.data.data.length === 3, "Bulk backfill did not create three records");
assert(bulk.data.data.every((item) => item.isCurrent === false), "Backfilled history rows must not be current");
const afterBulk = await call(`/batches/${batch.id}`);
assert(afterBulk.data.currentColorName === "Smoke Brown", "Reverse-order bulk backfill changed the unique current color");
const orderedSeqs = afterBulk.data.colorChanges.map((item) => item.seq);
assert(orderedSeqs.every((seq, index) => index === 0 || seq < orderedSeqs[index - 1]), "Color chain seq is not ordered on the timeline");
assert(new Set(orderedSeqs).size === orderedSeqs.length, "Color chain seq is not unique");

// 删除链中误录（非当前色）：软删除后链序压实、前后衔接修复，当前色不变。
const misrecord = bulk.data.data.find((item) => item.afterColorName === "Smoke Middle");
await call(`/color-changes/${misrecord.id}`, { method: "DELETE" });
const afterDelete = await call(`/batches/${batch.id}`);
assert(afterDelete.data.currentColorName === "Smoke Brown", "Deleting a middle misrecord changed the current color");
const liveSeqs = afterDelete.data.colorChanges.map((item) => item.seq).sort((a, b) => a - b);
assert(liveSeqs.every((seq, index) => seq === index + 1), "Color chain seq has gaps after misrecord deletion");

// 归档批次禁止改色：建一个零余额批次，归档后新增与批量补录一律 409。
const emptyMaterial = await call("/materials", {
  method: "POST",
  body: { name: `Smoke Empty Material ${suffix}`, craftTypes: ["GENERAL"], stockUnit: "g", tags: ["smoke"] }
});
const emptyBatch = await call("/batches", {
  method: "POST",
  headers: { "Idempotency-Key": `smoke-empty-batch-${suffix}` },
  body: { materialId: emptyMaterial.data.id, receivedAt: new Date().toISOString().slice(0, 10), initialQuantity: "1", entryUnit: "g" }
});
await call(`/batches/${emptyBatch.data.id}/adjustments`, {
  method: "POST",
  headers: { "Idempotency-Key": `smoke-empty-adjust-${suffix}` },
  body: { direction: "OUT", quantity: "1000", unit: "g", reason: "Smoke test depletion for archive", version: 1 }
});
await call(`/batches/${emptyBatch.data.id}/archive`, { method: "POST" });
async function expectConflict(label, fn) {
  try {
    await fn();
    throw new Error(`${label}: archived batch mutation was not blocked`);
  } catch (error) {
    // call() 失败信息形如 "POST /path -> 409 {...}"。
    assert(/-> 409\b/.test(String(error.message)), `${label}: expected 409 conflict`);
  }
}
await expectConflict("archived create color", () => call("/color-changes", {
  method: "POST",
  body: { batchId: emptyBatch.data.id, changeType: "OTHER", afterColorName: "Nope", occurredAt: new Date().toISOString() }
}));
await expectConflict("archived bulk color", () => call("/color-changes/bulk", {
  method: "POST",
  body: { batchId: emptyBatch.data.id, entries: [{ changeType: "OTHER", afterColorName: "Nope", occurredAt: new Date().toISOString() }] }
}));

console.log(JSON.stringify({
  result: "PASS",
  sourceId: source.data.id,
  materialId: material.data.id,
  batchId: batch.id,
  projectId: project.data.id,
  consumptionId: consumption.id
}, null, 2));
