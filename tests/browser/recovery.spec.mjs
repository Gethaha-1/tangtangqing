import { test, expect } from '@playwright/test';

function fixture(count = 0, closed = false) {
  return { schemaVersion: 2, settings: { theme: 'day', activeVehicleId: 'all', periodStartDate: '2026-01-01', periodEndDate: '2026-12-31' },
    categories: { expense: [{ id: 'fuel', name: '油费', icon: '⛽', active: true }, { id: 'toll', name: '路桥费', icon: '路', active: true }], income: [{ id: 'cargo', name: '运费', active: true }, { id: 'back', name: '返程收入', active: true }] },
    vehicles: [{ id: 'vehicle_default', name: '本地测试车', plateNo: '', active: true }],
    trips: [{ id: 'test-trip', vehicleId: 'vehicle_default', startDate: '2026-09-01', endDate: closed ? '2026-09-03' : null, status: closed ? 'closed' : 'open',
      expenses: Array.from({ length: count }, (_, i) => ({ id: 'backup-e-' + i, catId: 'toll', amount: 10.25, date: '2026-09-02', note: '隔离备份测试' })), incomes: [] }], maintenance: [] };
}
async function post(page, path, value = {}) {
  return page.evaluate(async ({ path, value }) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TTQ-Request': 'ledger-v1' }, body: JSON.stringify(value) });
    if (!response.ok) throw new Error('Isolated test HTTP ' + response.status);
    return response.json();
  }, { path, value });
}
async function ready(page) { await expect(page.locator('body')).not.toHaveClass(/session-locked/); }
async function number(page, selector, value) {
  const input = page.locator(selector);
  await expect(input).toHaveAttribute('readonly', '');
  await expect(input).toHaveAttribute('inputmode', 'none');
  await input.click();
  await page.locator('[data-number-key="clear"]').click();
  for (const digit of value) await page.locator('[data-number-key="' + digit + '"]').click();
  await page.locator('[data-number-key="ok"]').click();
  await expect(page.locator('#sheet-number')).toBeHidden();
}
async function drafts(page) {
  const remote = await post(page, '/api/bootstrap');
  return page.evaluate(async remote => {
    const scope = window.TTQAuthClient.createStorageScope(null, remote.fleet, remote.membership);
    return window.TTQDraftStore.createVault(scope.id).list();
  }, remote);
}
async function addToll(page) {
  await page.locator('[data-act="quick"]').first().click();
  await page.locator('#quickChips [data-cat="toll"]').click();
  await page.locator('#quickPad [data-k="2"]').click();
  await page.locator('#quickPad [data-k="0"]').click();
  await page.locator('#quickPad [data-k="ok"]').click();
  await expect(page.locator('#quickBatchOpen')).toHaveText('清单 1');
  await expect(page.locator('#quickDraftStatus')).toContainText('草稿已暂存本机');
}
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => console.error('Isolated browser error:', error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('Isolated browser console:', message.text()); });
  await page.goto('/ledger');
  await ready(page);
  const target = fixture();
  const remote = await post(page, '/api/bootstrap');
  const operations = await page.evaluate(({ target, records }) => window.TTQCloudSync.planSync(window.TTQDomain.migrate(target, target), records), { target, records: remote.records });
  // Fixture cleanup may exceed the normal batch bound after the large restore
  // test; use its real staged protocol, never bypass the 500-operation API.
  if (operations.length <= 500) await post(page, '/api/sync', { clientSchemaVersion: 5, operationId: crypto.randomUUID(), operations, finalize: true });
  else {
    const prepared = await page.evaluate(operations => window.TTQRecovery.prepare(operations), operations);
    const id = crypto.randomUUID();
    await post(page, '/api/restore', { clientSchemaVersion: 5, action: 'start', id, baseVersion: remote.fleet.version, manifest: prepared.manifest });
    for (let ordinal = 0; ordinal < prepared.payloads.length; ordinal++) await post(page, '/api/restore', { clientSchemaVersion: 5, action: 'chunk', id, ordinal, payload: prepared.payloads[ordinal] });
    await post(page, '/api/restore', { clientSchemaVersion: 5, action: 'commit', id });
  }
  await page.reload(); await ready(page);
});

test('one round trip saves outbound allocation and treats explicit return actual 0 as 0', async ({ page }) => {
  const initial = await post(page, '/api/bootstrap');
  const initialTrip = initial.records.find(row => row.type === 'trip' && row.id === 'test-trip');
  await post(page, '/api/sync', { clientSchemaVersion: 5, operationId: crypto.randomUUID(), finalize: true, operations: [
    { op: 'delete', type: 'trip', id: initialTrip.id, expectedVersion: initialTrip.version },
  ] });
  await page.reload(); await ready(page);
  await page.locator('[data-act="start"]').click();
  await page.locator('#startAddShipper').click();
  await page.locator('[data-start-show-new]').click();
  await page.locator('#startNewShipperName').fill('王师傅');
  await page.locator('#startNewMarketName').fill('北市场');
  await page.locator('#startNewMarketRegion').fill('济南');
  await page.locator('#startNewShipperAdd').click();
  await number(page, '#startTotalFreight', '6000');
  await expect(page.locator('#startTotals')).toContainText('¥6,000');
  await expect(page.locator('#startDraftStatus')).toContainText('草稿已暂存本机');
  await page.locator('#btnStartGo').click();
  await expect(page.locator('#sheet-start')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/is-saving/);

  await page.locator('[data-act="return"][data-trip]').click();
  await number(page, '#returnLoadedTons', '30');
  await number(page, '#returnUnitPrice', '240');
  await number(page, '#returnActual', '0');
  await page.locator('#returnPickupCity').fill('德州');
  await page.locator('#returnPickupCounty').fill('德城区');
  await page.locator('#returnPickupLocation').getByLabel('厂家 / 地点').fill('城北粮库');
  await page.locator('#returnPickupLocation').getByLabel('进出道路').fill('东门限高');
  await page.locator('#returnDeliveryCity').fill('济南');
  await page.locator('#returnDeliveryLocation').getByLabel('厂家 / 地点').fill('南站货场');
  await expect(page.locator('#returnReceivable')).toHaveText('¥7200.00');
  await expect(page.locator('#returnEffective')).toHaveText('¥0.00');
  await expect(page.locator('#returnBasis')).toHaveText('按实收');
  await page.locator('#returnStage').click();
  await expect(page.locator('#returnStaged')).toContainText('实收已填，首页按实收');
  await page.locator('#returnSave').click();
  await expect(page.locator('#sheet-return')).toBeHidden();

  await expect.poll(async () => {
    const remote = await post(page, '/api/bootstrap');
    const trip = remote.records.find(row => row.type === 'trip');
    return trip && trip.data.business;
  }).toMatchObject({
    outbound: { totalFreight: 6000, finalTotal: 6000, allocations: [{ shipperName: '王师傅', marketName: '北市场', allocatedAmount: 6000, finalAmount: 6000 }] },
    returnTrip: { loadedTons: '30', unitPrice: '240', receivableAmount: 7200, actualReceivedAmount: 0, effectiveAmount: 0 },
  });
  const remote = await post(page, '/api/bootstrap');
  expect(remote.records.find(row => row.type === 'fleet_settings').data.business.shippers[0].markets[0].region).toBe('济南');
  expect(remote.records.find(row => row.type === 'fleet_settings').data.business.places).toHaveLength(2);
  expect(remote.records.filter(row => row.type === 'trip_income')).toHaveLength(0);
  await page.locator('#nav [data-v="trips"]').click();
  await page.locator('#tripList [data-trip]').click();
  await expect(page.locator('#tripDetail')).toContainText('装车位置');
  await expect(page.locator('#tripDetail')).toContainText('德州德城区 · 城北粮库');
  await expect(page.locator('#tripDetail')).toContainText('道路：东门限高');
  await expect(page.locator('#tripDetail')).toContainText('济南 · 南站货场');
});

test('refresh restores the list, unfinished expression, note and original record IDs', async ({ page }, testInfo) => {
  await addToll(page);
  const id = (await drafts(page))[0].value.entries[0].id;
  await page.locator('#quickPad [data-k="3"]').click();
  await page.locator('#quickPad [data-k="＋"]').click();
  await page.locator('#quickPad [data-k="5"]').click();
  await page.locator('#quickNoteBtn').click();
  await page.locator('#quickNote').fill('这笔还没有加入清单');
  await expect(page.locator('#quickDraftStatus')).toContainText('草稿已暂存本机');
  await page.reload(); await ready(page);
  await expect(page.locator('#recoveryPanel')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('draft-recovery.png'), fullPage: true });
  await page.getByRole('button', { name: '继续填写', exact: true }).click();
  await expect(page.locator('#quickBatchOpen')).toHaveText('清单 1');
  await expect(page.locator('#quickAmt')).toHaveText('3+5');
  await expect(page.locator('#quickNote')).toHaveValue('这笔还没有加入清单');
  expect((await drafts(page))[0].value.entries[0].id).toBe(id);
  expect((await post(page, '/api/bootstrap')).records.filter(row => row.type === 'trip_expense')).toHaveLength(0);
});

test('empty return and changed-then-reverted form exit without save prompts, even without IndexedDB', async ({ page }) => {
  await page.addInitScript(() => { indexedDB.open = () => { throw new DOMException('测试存储不可用', 'SecurityError'); }; });
  await page.reload(); await ready(page);
  let writes = 0;
  page.on('request', request => { if (request.url().endsWith('/api/sync')) writes++; });
  await page.locator('[data-act="return"]').first().click();
  await page.locator('[data-business-exit="return"]').click();
  await expect(page.locator('#sheet-return')).toBeHidden();
  await expect(page.locator('#confirmMask')).not.toHaveClass(/on/);
  await page.locator('[data-act="return"]').first().click();
  await number(page, '#returnLoadedTons', '30');
  await number(page, '#returnLoadedTons', '');
  await page.locator('[data-business-exit="return"]').click();
  await expect(page.locator('#sheet-return')).toBeHidden();
  expect(writes).toBe(0);
});

test('discard closes return, drains draft writes and never uploads; a fresh open is clean', async ({ page }) => {
  let writes = 0;
  page.on('request', request => { if (request.url().endsWith('/api/sync')) writes++; });
  await page.locator('[data-act="return"]').first().click();
  await number(page, '#returnLoadedTons', '30');
  await number(page, '#returnUnitPrice', '240');
  await page.locator('#returnStage').click();
  await page.locator('[data-business-discard="return"]').click();
  await expect(page.locator('#sheet-return')).toBeHidden();
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
  await page.locator('[data-act="return"]').first().click();
  await expect(page.locator('#returnLoadedTons')).toHaveValue('');
  await page.locator('[data-business-exit="return"]').click();
  await expect(page.locator('#sheet-return')).toBeHidden();
  expect(writes).toBe(0);
});

test('back closes return before cloud response, saves only staged data and reloads it from account', async ({ page }, testInfo) => {
  await page.locator('[data-act="return"]').first().click();
  await number(page, '#returnLoadedTons', '30.125');
  await number(page, '#returnUnitPrice', '240');
  await page.locator('#returnPickupCity').fill('济南市');
  await page.locator('#returnPickupCounty').fill('历城区');
  await page.locator('#returnStage').click();
  await page.locator('#returnDeliveryCity').fill('未加入的修改');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  await page.route('**/api/sync', async route => { writes++; await gate; await route.continue(); });
  try {
    await page.locator('[data-business-exit="return"]').click();
    await expect(page.locator('#sheet-return')).toBeHidden({ timeout: 1500 });
    await expect.poll(() => writes).toBe(1);
    expect((await post(page, '/api/bootstrap')).records.find(row => row.type === 'trip').data.business.returnTrip).toBeUndefined();
    await page.screenshot({ path: testInfo.outputPath('background-upload.png') });
  } finally { release(); }
  await expect(page.locator('body')).not.toHaveClass(/is-saving/);
  await expect.poll(async () => (await drafts(page))[0]?.value.dirty).toBe(true);
  await page.reload(); await ready(page);
  await page.locator('[data-act="return"]').first().click();
  await expect(page.locator('#returnLoadedTons')).toHaveValue('30.125');
  await expect(page.locator('#returnPickupCity')).toHaveValue('济南市');
  await expect(page.locator('#returnPickupCounty')).toHaveValue('历城区');
  await expect(page.locator('#returnDeliveryCity')).toHaveValue('');
  await page.locator('[data-business-exit="return"]').click();
  await expect(page.locator('#sheet-return')).toBeHidden();
  expect(writes).toBe(1);
});

test('browser back submits once; discarding a later edit preserves the cloud manifest', async ({ page }) => {
  let writes = 0;
  page.on('request', request => { if (request.url().endsWith('/api/sync')) writes++; });
  await page.locator('[data-act="return"]').first().click();
  await number(page, '#returnLoadedTons', '30');
  await number(page, '#returnUnitPrice', '240');
  await page.locator('#returnStage').click();
  await page.evaluate(() => history.back());
  await expect(page.locator('#sheet-return')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/is-saving/);
  await expect.poll(() => writes).toBe(1);
  const before = (await post(page, '/api/bootstrap')).records.find(row => row.type === 'trip');
  await page.locator('[data-act="return"]').first().click();
  await number(page, '#returnUnitPrice', '350');
  await page.locator('#returnStage').click();
  await page.locator('[data-business-discard="return"]').click();
  await expect(page.locator('#sheet-return')).toBeHidden();
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
  const after = (await post(page, '/api/bootstrap')).records.find(row => row.type === 'trip');
  expect(after).toEqual(before);
  expect(writes).toBe(1);
});

test('empty new start closes directly and discard clears unfinished shipper controls', async ({ page }) => {
  const initial = await post(page, '/api/bootstrap');
  const trip = initial.records.find(row => row.type === 'trip');
  await post(page, '/api/sync', { clientSchemaVersion: 5, operationId: crypto.randomUUID(), finalize: true, operations: [
    { op: 'delete', type: 'trip', id: trip.id, expectedVersion: trip.version }
  ] });
  await page.reload(); await ready(page);
  let writes = 0;
  page.on('request', request => { if (request.url().endsWith('/api/sync')) writes++; });
  await page.locator('[data-act="start"]').click();
  await page.locator('[data-business-exit="start"]').click();
  await expect(page.locator('#sheet-start')).toBeHidden();
  await expect(page.locator('#confirmMask')).not.toHaveClass(/on/);
  await page.locator('[data-act="start"]').click();
  await page.locator('#startAddShipper').click();
  await page.locator('[data-start-show-new]').click();
  await page.locator('#startNewShipperName').fill('放弃的名字');
  await number(page, '#startTotalFreight', '100');
  await page.locator('[data-business-discard="start"]').click();
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
  await page.locator('[data-act="start"]').click();
  await expect(page.locator('#startNewShipperName')).toHaveValue('');
  await expect(page.locator('#startTotalFreight')).toHaveValue('');
  expect(writes).toBe(0);
});

test('background return rejection remains recoverable and editable without a revision conflict', async ({ page }) => {
  await page.locator('[data-act="return"]').first().click();
  await number(page, '#returnLoadedTons', '30');
  await number(page, '#returnUnitPrice', '240');
  await page.locator('#returnStage').click();
  await page.route('**/api/sync', route => route.fulfill({ status: 422, json: { error: { code: 'batch_rejected', message: '测试拒绝' } } }));
  await page.locator('[data-business-exit="return"]').click();
  await expect(page.locator('#sheet-return')).toBeHidden();
  await expect(page.getByRole('button', { name: '继续填写', exact: true })).toBeVisible();
  expect((await drafts(page))[0].value.pending).toBeFalsy();
  await page.getByRole('button', { name: '继续填写', exact: true }).click();
  await number(page, '#returnUnitPrice', '250');
  await page.locator('#returnStage').click();
  await expect(page.locator('#returnDraftStatus')).toContainText('草稿已暂存本机');
  await page.unroute('**/api/sync');
  await page.locator('[data-business-exit="return"]').click();
  await expect(page.locator('#sheet-return')).toBeHidden();
  await expect.poll(async () => (await post(page, '/api/bootstrap')).records.find(row => row.type === 'trip').data.business.returnTrip?.unitPrice).toBe('250');
});

test('background return lost response has one journal and one business update after receipt recovery', async ({ page }) => {
  await page.locator('[data-act="return"]').first().click();
  await number(page, '#returnLoadedTons', '30');
  await number(page, '#returnUnitPrice', '240');
  await page.locator('#returnStage').click();
  let writes = 0;
  await page.route('**/api/sync', async route => { writes++; await route.fetch(); await route.abort('failed'); });
  await page.locator('[data-business-exit="return"]').click();
  await expect(page.locator('#sheet-return')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/is-readonly/);
  expect(await drafts(page)).toHaveLength(1);
  await page.reload(); await ready(page);
  await page.getByRole('button', { name: '核对并继续', exact: true }).click();
  await expect(page.locator('#recoveryPanel')).toBeHidden();
  const remote = await post(page, '/api/bootstrap');
  expect(remote.records.filter(row => row.type === 'trip_income')).toHaveLength(0);
  expect(remote.records.find(row => row.type === 'trip').data.business.returnTrip).toMatchObject({
    loadedTons: '30', unitPrice: '240', effectiveAmount: 7200,
  });
  expect(writes).toBe(1);
});

test('quick list back uploads in background, retains unstaged input; discard uploads nothing', async ({ page }) => {
  await addToll(page);
  await page.locator('#quickBatchOpen').click();
  await page.locator('#quickBatchDiscard').click();
  await expect(page.locator('#sheet-quick-batch')).toBeHidden();
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
  expect((await post(page, '/api/bootstrap')).records.filter(row => row.type === 'trip_expense')).toHaveLength(0);
  await addToll(page);
  await page.locator('#quickPad [data-k="3"]').click();
  await page.locator('#quickBatchOpen').click();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sync', async route => { await gate; await route.continue(); });
  try {
    await page.locator('#sheet-quick-batch [data-close]').click();
    await expect(page.locator('#sheet-quick')).toBeHidden({ timeout: 1500 });
    await expect(page.locator('#sheet-quick-batch')).toBeHidden();
  } finally { release(); }
  await expect(page.locator('body')).not.toHaveClass(/is-saving/);
  expect((await post(page, '/api/bootstrap')).records.filter(row => row.type === 'trip_expense')).toHaveLength(1);
  await expect.poll(async () => (await drafts(page))[0]?.value.expression).toBe('3');
  expect((await drafts(page))[0].value.entries).toHaveLength(0);
});

test('location fills split city/county and ignores late responses after manual edit or discard', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = resolve => resolve({ coords: { latitude: 36.6, longitude: 117.1 } });
  });
  await page.reload(); await ready(page);
  const response = { provider: 'amap', coordinateSystem: 'WGS84', city: '济南市', county: '历城区' };
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/location/reverse', async route => {
    calls++;
    if (calls === 2) await gate;
    await route.fulfill({ json: response });
  });
  await page.locator('[data-act="return"]').first().click();
  await page.locator('[data-return-location-current="pickup"]').click();
  await expect(page.locator('#returnPickupCity')).toHaveValue('济南市');
  await expect(page.locator('#returnPickupCounty')).toHaveValue('历城区');
  await page.locator('#returnPickupCity').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('split-location.png') });
  await page.locator('[data-return-location-current="delivery"]').click();
  await page.locator('#returnDeliveryCity').fill('手工城市');
  release();
  await expect(page.locator('[data-return-location-current="delivery"]')).toBeEnabled();
  await expect(page.locator('#returnDeliveryCity')).toHaveValue('手工城市');
  await number(page, '#returnLoadedTons', '29.950');
  await page.locator('#returnLoadedTons').click();
  await page.screenshot({ path: testInfo.outputPath('large-number-pad.png') });
  await page.locator('#sheet-number [data-close]').click();
  await page.locator('[data-business-discard="return"]').click();
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
});

test('save all refuses to silently discard unfinished input', async ({ page }) => {
  await addToll(page);
  await page.locator('#quickPad [data-k="3"]').click();
  await page.locator('#quickBatchOpen').click();
  await page.locator('#quickBatchSave').click();
  expect((await post(page, '/api/bootstrap')).records.filter(row => row.type === 'trip_expense')).toHaveLength(0);
  await expect.poll(async () => (await drafts(page))[0].value.expression).toBe('3');
  await page.reload(); await ready(page);
  await page.getByRole('button', { name: '继续填写', exact: true }).click();
  await expect(page.locator('#quickAmt')).toHaveText('3');
});

test('definite rejection unfreezes the same draft for editing without a revision conflict', async ({ page }) => {
  await addToll(page);
  await page.route('**/api/sync', route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'batch_rejected', message: '测试明确拒绝' } }) }));
  await page.locator('#quickBatchOpen').click();
  await page.locator('#quickBatchSave').click();
  await expect(page.locator('#quickBatchStatus')).toContainText('服务器没有接受这批记录');
  await page.locator('[data-quick-edit]').first().click();
  await page.locator('#quickNoteBtn').click();
  await page.locator('#quickNote').fill('拒绝后仍可修正');
  await expect(page.locator('#quickDraftStatus')).toContainText('草稿已暂存本机');
  expect((await drafts(page))[0].value.note).toBe('拒绝后仍可修正');
  expect((await drafts(page))[0].value.pending).toBeFalsy();
});

test('unavailable local storage cannot claim a saved draft or send a business request', async ({ page }) => {
  await page.addInitScript(() => { indexedDB.open = () => { throw new DOMException('测试存储不可用', 'SecurityError'); }; });
  await page.reload(); await ready(page);
  await expect(page.locator('#recoveryMessage')).toContainText('本机暂存不可用');
  await page.locator('[data-act="quick"]').first().click();
  await page.locator('#quickChips [data-cat="toll"]').click();
  await page.locator('#quickPad [data-k="2"]').click();
  await page.locator('#quickPad [data-k="ok"]').click();
  await expect(page.locator('#quickDraftStatus')).toContainText('未能确认暂存');
  await page.locator('#quickBatchOpen').click();
  await page.locator('#quickBatchSave').click();
  expect((await post(page, '/api/bootstrap')).records.filter(row => row.type === 'trip_expense')).toHaveLength(0);
});

test('a committed batch with a lost response is checked after reload, never inserted twice', async ({ page }) => {
  await addToll(page);
  let writes = 0;
  await page.route('**/api/sync', async route => { writes++; await route.fetch(); await route.abort('failed'); });
  await page.locator('#quickBatchOpen').click();
  await page.locator('#quickBatchSave').click();
  await expect(page.locator('#quickBatchStatus')).toContainText('未收到云端确认');
  await page.reload(); await ready(page);
  await page.getByRole('button', { name: '核对并继续', exact: true }).click();
  await expect(page.locator('#recoveryPanel')).toBeHidden();
  expect((await drafts(page))).toHaveLength(0);
  expect((await post(page, '/api/bootstrap')).records.filter(row => row.type === 'trip_expense')).toHaveLength(1);
  expect(writes).toBe(1);
});

test('large backup upload interruption preserves the old ledger; reload resumes the original job', async ({ page }) => {
  let failed = false;
  await page.route('**/api/restore', async route => {
    const input = route.request().postDataJSON();
    if (!failed && input.action === 'chunk' && input.ordinal === 1) { failed = true; return route.abort('failed'); }
    return route.continue();
  });
  await page.locator('#nav [data-v="more"]').click();
  await page.locator('input[type="file"]').setInputFiles({ name: 'isolated-v2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture(514, true))) });
  await expect(page.locator('#confirmMask')).toHaveClass(/on/);
  await page.locator('#confirmYes').click();
  await expect.poll(() => failed).toBe(true);
  await expect(page.locator('body')).toHaveClass(/is-readonly/);
  expect((await post(page, '/api/bootstrap')).records.filter(row => row.type === 'trip_expense')).toHaveLength(0);
  const id = (await drafts(page)).find(row => row.kind === 'restore').value.task.id;
  await page.reload(); await ready(page);
  await page.getByRole('button', { name: '核对并继续', exact: true }).click();
  await expect(page.locator('#recoveryPanel')).toBeHidden();
  expect((await post(page, '/api/bootstrap')).records.filter(row => row.type === 'trip_expense')).toHaveLength(514);
  expect((await post(page, '/api/restore', { clientSchemaVersion: 5, action: 'status', id })).status).toBe('complete');
});

test('two tabs cannot silently overwrite the same recovered draft', async ({ page, context }) => {
  await addToll(page);
  const second = await context.newPage(); await second.goto('/ledger'); await ready(second);
  await second.getByRole('button', { name: '继续填写', exact: true }).click();
  await second.locator('#quickNoteBtn').click();
  await second.locator('#quickNote').fill('第二页核对后修改');
  await expect(second.locator('#quickDraftStatus')).toContainText('草稿已暂存本机');
  await page.locator('#quickNoteBtn').click();
  await page.locator('#quickNote').fill('旧页面不能覆盖');
  await expect(page.locator('#quickDraftStatus')).toContainText('另一个页面');
  expect((await drafts(second))[0].value.note).toBe('第二页核对后修改');
});

test('a completed restore with later cloud edits can be acknowledged without replacing those edits', async ({ page }) => {
  let interrupted = false;
  await page.route('**/api/restore', async route => {
    const input = route.request().postDataJSON();
    if (input.action === 'commit' && !interrupted) {
      await route.fetch(); interrupted = true; return route.abort('failed');
    }
    return route.continue();
  });
  await page.locator('#nav [data-v="more"]').click();
  await page.locator('input[type="file"]').setInputFiles({ name:'completed.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(fixture(514, true))) });
  await page.locator('#confirmYes').click();
  await expect.poll(() => interrupted).toBe(true);
  await expect(page.locator('body')).toHaveClass(/is-readonly/);
  await post(page, '/api/sync', { clientSchemaVersion:5, operationId:crypto.randomUUID(), finalize:true, operations:[{op:'put',type:'maintenance',id:'after-restore',expectedVersion:0,data:{id:'after-restore',vehicleId:'vehicle_default',date:'2026-09-03',amount:123,note:'后续记账'}}] });
  await page.reload(); await ready(page);
  await page.getByRole('button', {name:'核对并继续',exact:true}).click();
  await expect(page.locator('body')).toHaveClass(/is-readonly/);
  await page.getByRole('button', {name:'核对已完成结果',exact:true}).click();
  await page.locator('#confirmYes').click();
  await expect(page.locator('#recoveryPanel')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/is-readonly/);
  const records = (await post(page,'/api/bootstrap')).records;
  expect(records.find(row=>row.id==='after-restore').data.amount).toBe(123);
  expect(records.filter(row=>row.type==='trip_expense')).toHaveLength(514);
});
