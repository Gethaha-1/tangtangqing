import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import "../src/domain.js";
import "../src/cloud-sync.js";

const source = readFileSync(new URL("../legacy/ledger.html", import.meta.url), "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  let start = source.indexOf(marker);
  assert.notEqual(start, -1, `缺少 ${name}()`);
  const asyncStart = source.lastIndexOf("async ", start);
  if (asyncStart >= 0 && source.slice(asyncStart + 6, start) === "") start = asyncStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name}() 没有闭合`);
}

function compile(names, globals = {}) {
  const context = vm.createContext({ ...globals });
  new vm.Script(
    `${names.map(extractFunction).join("\n")}\nthis.out={${names.join(",")}};`,
  ).runInContext(context);
  return context.out;
}

function compileWithContext(names, globals = {}) {
  const context = vm.createContext({ ...globals });
  new vm.Script(
    `${names.map(extractFunction).join("\n")}\nthis.out={${names.join(",")}};`,
  ).runInContext(context);
  return { functions: context.out, context };
}

function fuelRoot(values) {
  const inputs = Object.entries({ totalAmount: "", unitPrice: "", liters: "", ...values })
    .map(([field, value]) => ({
      dataset: { fuelField: field },
      value,
      attributes: {},
      focused: false,
      setAttribute(name, next) { this.attributes[name] = next; },
      focus() { this.focused = true; },
    }));
  const alert = { textContent: "" };
  const status = { textContent: "" };
  return {
    dataset: {},
    inputs,
    alert,
    status,
    querySelectorAll(selector) {
      return selector === "[data-fuel-field]" ? inputs : [];
    },
    querySelector(selector) {
      if (selector === ".fuel-error") return alert;
      if (selector === ".fuel-status") return status;
      if (selector === "[data-fuel-field]") return inputs[0];
      const match = /^\[data-fuel-field="([^"]+)"\]$/.exec(selector);
      return match ? inputs.find((item) => item.dataset.fuelField === match[1]) : null;
    },
  };
}

test("fuel 表单只用领域联算并支持结构化与旧油费两条保存路径", () => {
  const functions = compile(
    ["parseLegacyFuelAmount", "fuelFormValues", "setFuelCalculatedStatus", "setFuelFormError", "reportFuelFormError", "resolveFuelForm"],
    { TTQDomain: globalThis.TTQDomain },
  );

  const structured = functions.resolveFuelForm(
    fuelRoot({ totalAmount: "300", unitPrice: "7.5" }),
    false,
  );
  assert.equal(structured.ok, true);
  assert.equal(structured.amount, 300);
  assert.equal(structured.fuel.unitPrice, "7.5");
  assert.equal(structured.fuel.liters, "40");

  const legacy = functions.resolveFuelForm(fuelRoot({ totalAmount: "300" }), true);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.amount, 300);
  assert.equal(legacy.fuel, null);

  const invalidLegacy = functions.resolveFuelForm(
    fuelRoot({ totalAmount: "300.001" }),
    true,
  );
  assert.equal(invalidLegacy.ok, false);
  assert.equal(invalidLegacy.error.code, "invalid-amount");

  assert.equal(functions.parseLegacyFuelAmount("1e2").ok, false);
  assert.equal(functions.parseLegacyFuelAmount("999999999.99").ok, true);
  assert.equal(functions.parseLegacyFuelAmount("1000000000").error.code, "out-of-range");

  const emptyRoot = fuelRoot({});
  assert.equal(functions.resolveFuelForm(emptyRoot, false).ok, false);
  assert.match(emptyRoot.alert.textContent, /任意两项/);
  assert.equal(emptyRoot.inputs[0].focused, true);
  assert.ok(emptyRoot.inputs.every((input) => input.attributes["aria-invalid"] === "true"));

  const silentRoot = fuelRoot({ unitPrice: "7.5" });
  assert.equal(functions.resolveFuelForm(silentRoot, true, false).ok, false);
  assert.equal(silentRoot.alert.textContent, "");

  const invalid = functions.resolveFuelForm(
    fuelRoot({ totalAmount: "300.001", unitPrice: "7.5" }),
    false,
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "too-many-decimals");
  assert.match(source, /TTQDomain\.calculateFuelFields\(values\)/);
  assert.doesNotMatch(extractFunction("resolveFuelForm"), /Math\.round\(/);
});

test("快记、支出编辑、补录都接入三字段 fuel，普通支出仍保留金额盘", () => {
  for (const prefix of ["quick", "amt"]) {
    for (const field of ["Total", "Price", "Liters"]) {
      assert.match(
        source,
        new RegExp(`id="${prefix}Fuel${field}"[^>]*type="text"|type="text"[^>]*id="${prefix}Fuel${field}"`),
      );
    }
  }
  assert.match(source, /fuelFormHTML\('bf', \{\}, true\)/);
  assert.match(source, /inputmode="none" readonly autocomplete="off"/);
  assert.doesNotMatch(source, /data-fuel-field[^>]*inputmode="decimal"|inputmode="decimal"[^>]*data-fuel-field/);
  assert.match(extractFunction("initFuelKeyboard"), /'backspace'/);
  assert.match(source, /data-fuel-key="next">下一项/);
  assert.match(source, /data-business-write>✓ 记 上/);
  assert.match(source, /setFuelCalculatedStatus\(root, nextCalculated \|\| null\)/);
  assert.match(source, /id="quickPad"/);
  assert.match(source, /id="amtPad"/);
  assert.match(source, /nextTrip\.expenses\.push\([^\n]*catId: 'fuel'[^\n]*fuel: resolved\.fuel/);
  assert.match(source, /x\.fuel \? \{ fuel: x\.fuel \} : \{\}/);
  assert.match(source, /originalCatId: en\.catId, fuel: en\.fuel \|\| null/);
  assert.match(source, /if \(nextEntry\.catId === 'fuel' && fuel\) nextEntry\.fuel = fuel;\s*else delete nextEntry\.fuel;/);
  assert.match(source, /if \(quickCatId === 'fuel'\)[\s\S]*?updateFuelForm\(\$\('#quickFuelForm'\), input\)/);
  assert.match(extractFunction("renderQuickChips"), /<button type="button" class="chip/);
  assert.match(extractFunction("renderAmtChips"), /<button type="button" class="chip/);
  assert.ok(extractFunction("quickFuelSave").indexOf("resolveFuelForm") < extractFunction("quickFuelSave").indexOf("guardOnce"));
});

test("油费自带数字键盘保留手输原文，只格式化系统联算项", () => {
  const functions = compile(
    ["fuelFormValues", "setFuelCalculatedStatus", "setFuelFormError", "updateFuelForm", "nextFuelInputValue", "formatSmartFuelPriceDigits", "nextFuelPriceInputValue"],
    { TTQDomain: globalThis.TTQDomain },
  );
  assert.equal(functions.nextFuelInputValue("", "7", 4, 3, true), "7");
  assert.equal(functions.nextFuelInputValue("7", ".", 4, 3, false), "7.");
  assert.equal(functions.nextFuelInputValue("7.", "6", 4, 3, false), "7.6");
  assert.equal(functions.nextFuelInputValue("7.6667", "8", 4, 3, false), "7.6667");
  assert.equal(functions.nextFuelInputValue("7.6667", "8", 4, 3, true), "8");
  assert.equal(functions.nextFuelInputValue("12.3", "backspace", 4, 3, false), "12.");
  assert.equal(functions.nextFuelInputValue("12.3", "clear", 4, 3, false), "");

  assert.equal(functions.formatSmartFuelPriceDigits("5"), "5.00");
  assert.equal(functions.formatSmartFuelPriceDigits("56"), "5.60");
  assert.equal(functions.formatSmartFuelPriceDigits("566"), "5.66");
  assert.equal(functions.formatSmartFuelPriceDigits("1222"), "12.22");
  let smart = functions.nextFuelPriceInputValue("", "", false, "5", true);
  assert.equal(smart.value, "5.00");
  smart = functions.nextFuelPriceInputValue(smart.value, smart.rawDigits, smart.manualDecimal, "6", false);
  assert.equal(smart.value, "5.60", "自动补零后必须仍能接收第二位数字");
  smart = functions.nextFuelPriceInputValue(smart.value, smart.rawDigits, smart.manualDecimal, "6", false);
  assert.equal(smart.value, "5.66");
  smart = functions.nextFuelPriceInputValue(smart.value, smart.rawDigits, smart.manualDecimal, "9", false);
  assert.equal(smart.value, "56.69");
  const capped = functions.nextFuelPriceInputValue(smart.value, smart.rawDigits, smart.manualDecimal, "8", false);
  assert.equal(capped.value, "56.69", "自动推算最多接收四位数字");
  let manual = functions.nextFuelPriceInputValue("", "", false, "5", true);
  manual = functions.nextFuelPriceInputValue(manual.value, manual.rawDigits, manual.manualDecimal, ".", false);
  assert.equal(manual.value, "5.");
  manual = functions.nextFuelPriceInputValue(manual.value, manual.rawDigits, manual.manualDecimal, "6", false);
  assert.equal(manual.value, "5.6", "手动小数点必须覆盖智能划分");

  const root = fuelRoot({ totalAmount: "300", unitPrice: "7" });
  const price = root.inputs.find((input) => input.dataset.fuelField === "unitPrice");
  const liters = root.inputs.find((input) => input.dataset.fuelField === "liters");
  functions.updateFuelForm(root, price);
  assert.equal(price.value, "7", "手输油价不能被补成固定四位小数");
  assert.equal(liters.value, "42.857");
  assert.equal(root.dataset.calculatedField, "liters");

  price.value = functions.nextFuelInputValue(price.value, ".", 4, 3, false);
  functions.updateFuelForm(root, price);
  price.value = functions.nextFuelInputValue(price.value, "6", 4, 3, false);
  functions.updateFuelForm(root, price);
  assert.equal(price.value, "7.6", "第二个数字必须能继续追加");
  assert.equal(liters.value, "39.474");
  assert.equal(root.inputs.find((input) => input.dataset.fuelField === "totalAmount").value, "300");
});

test("首页、统计与三种报告 scope 统一使用净利润和 buildReportSummary", () => {
  const { formatScaledInteger } = compile(["formatScaledInteger"]);
  assert.equal(formatScaledInteger(150001, 3, 3), "150.001");
  assert.equal(formatScaledInteger(76667, 4, 4), "7.6667");
  assert.equal(formatScaledInteger(-12345, 2, 2), "−123.45");
  assert.match(source, /本 账 期 净 利 润/);
  assert.match(source, /\$\('#homeProfit'\)\.textContent = '¥ ' \+ fmt\(st\.netProfit\)/);
  assert.match(source, /趟次支出占收入（维修另列）/);
  assert.match(extractFunction("renderStats"), /TTQDomain\.buildReportSummary/);
  assert.match(extractFunction("renderStats"), /\$\('#statFuel'\)/);
  assert.match(extractFunction("renderStats"), /TTQDomain\.closedTripsInPeriod\(S, summary\.scope\.start, summary\.scope\.end, scope\)/);
  assert.match(source, /月度趟次利润（维修另列）/);
  assert.match(extractFunction("genReport"), /\{ start: periodStart\(\), end: periodEnd\(\), vehicleId \}/);
  assert.match(extractFunction("genReport"), /\{ month: request, vehicleId \}/);
  assert.match(extractFunction("genReport"), /\{ year, vehicleId \}/);
  assert.match(source, /monthKeysForScope\(summary\.scope\.start, summary\.scope\.end\)/);
  assert.match(source, /本范围只有 ' \+ rows\.length \+ ' 个月，不作趋势比较/);
});

test("schema v3 备份在写入前后都执行 conservation，且不展示 fingerprint", () => {
  const exportEntry = extractFunction("exportData");
  const exported = extractFunction("exportSnapshot");
  const imported = extractFunction("importData");
  assert.match(exportEntry, /Store\.membership\.role !== 'owner'/);
  assert.match(exportEntry, /isPartialDriverSnapshot\(S\)/);
  assert.match(exported, /format: 'tangtangqing-schema-v3'/);
  assert.match(exported, /schemaVersion: TTQDomain\.SCHEMA_VERSION/);
  assert.match(exported, /backupScope: partial \? 'driver-visible-partial' : 'full-fleet'/);
  assert.match(exported, /restorable: !partial/);
  assert.match(exported, /conservation: TTQCloudSync\.summarizeState\(payload\)/);
  assert.match(imported, /TTQCloudSync\.compareConservation\(\s*meta\.conservation,\s*TTQCloudSync\.summarizeState\(migrated\)/);
  assert.match(imported, /TTQCloudSync\.compareConservation\(candidate, S\)/);
  assert.match(imported, /旧版备份没有内嵌 fuel 守恒摘要/);
  assert.doesNotMatch(source, /textContent\s*=\s*[^;]*fingerprint|innerHTML\s*=\s*[^;]*fingerprint/);
});

test("再次恢复同一备份生成新 operationId，同一次失败重试保留原 id", () => {
  let sequence = 0;
  const { createImportOperationId } = compile(
    ["createImportOperationId"],
    {
      TTQCloudSync: {
        snapshotFingerprint: () => "same-fingerprint",
        createOperationId: () => `write-${++sequence}`,
      },
    },
  );
  const candidate = { schemaVersion: 3 };
  const first = createImportOperationId(candidate);
  const second = createImportOperationId(candidate);
  assert.equal(first, "json-import:same-fingerprint:write-1");
  assert.equal(second, "json-import:same-fingerprint:write-2");
  assert.notEqual(first, second);

  const imported = extractFunction("importData");
  assert.match(imported, /const importOperationId = createImportOperationId\(candidate\)/);
  assert.match(imported, /operationId: importOperationId/);
  assert.doesNotMatch(imported, /operationId: 'json-import:' \+ fingerprint/);
  assert.match(source, /pendingAction = action;/);
  assert.match(source, /inFlight = postAction\(pendingAction\)/);
});

test("顶层 v3 不能靠删除 meta 降级，真正 v2 仍兼容", () => {
  const { inspectBackupEnvelope } = compile([
    "isPartialDriverSnapshot",
    "inspectBackupEnvelope",
  ]);
  assert.equal(inspectBackupEnvelope({ schemaVersion: 2 }).legacy, true);
  assert.equal(inspectBackupEnvelope({ schemaVersion: 3 }).ok, false);
  const valid = {
    schemaVersion: 3,
    _backupMeta: {
      format: "tangtangqing-schema-v3",
      schemaVersion: 3,
      appVersion: "1.5.0",
      exportedAt: "2026-08-09T00:00:00.000Z",
      sourceFleetId: "",
      conservation: {
        counts: { vehicles: 0, expenseCategories: 0, incomeCategories: 0, trips: 0, tripExpenses: 0, tripIncomes: 0, maintenance: 0 },
        amounts: { tripExpenses: 0, tripIncomes: 0, maintenance: 0 },
        exactAmounts: { tripExpensesCents: "0", tripIncomesCents: "0", maintenanceCents: "0" },
        fuel: { structuredRecords: 0, legacyRecords: 0, totalVolumeMl: 0, structuredCostCents: 0, fingerprint: "" },
      },
    },
  };
  assert.equal(inspectBackupEnvelope(valid).ok, true);
  valid.settings = { _ownerRecordsWritable: false };
  const partialBySettings = inspectBackupEnvelope(valid);
  assert.equal(partialBySettings.ok, false);
  assert.match(partialBySettings.error, /部分数据/);
  delete valid.settings;
  valid._backupMeta.backupScope = "driver-visible-partial";
  valid._backupMeta.restorable = false;
  assert.equal(inspectBackupEnvelope(valid).ok, false);
  valid._backupMeta.backupScope = "full-fleet";
  valid._backupMeta.restorable = true;
  assert.equal(inspectBackupEnvelope(valid).ok, true);
  delete valid._backupMeta.conservation;
  assert.equal(inspectBackupEnvelope(valid).ok, false);

  const imported = extractFunction("importData");
  assert.ok(
    imported.indexOf("inspectBackupEnvelope(obj)") <
      imported.indexOf("const migrated = migrate(obj)"),
    "裁剪备份必须在迁移、差异规划和任何写入前拒绝",
  );
});

test("报告空交集和非法年份留在原页并给可访问提示", () => {
  const elements = new Map([
    ["#reportScopeError", { textContent: "" }],
    ["#repMonth", { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, focus() { this.focused = true; } }],
    ["#repYear", { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, focus() { this.focused = true; } }],
  ]);
  let opened = 0;
  const globals = {
    $: (selector) => elements.get(selector) || null,
    toast() {},
    activeVehicleId: () => "all",
    vehicleById: () => ({ name: "一号车" }),
    periodStart: () => "2026-01-01",
    periodEnd: () => "2026-12-31",
    periodLabel: () => "2026-01-01 至 2026-12-31",
    S: {},
    TTQDomain: { buildReportSummary: () => ({ scope: { empty: true } }) },
    openSheet() { opened += 1; },
  };
  const functions = compile(["reportScopeFailure", "clearReportScopeFailure", "genReport"], globals);
  const empty = functions.genReport("2025-12");
  assert.equal(empty.ok, false);
  assert.match(elements.get("#reportScopeError").textContent, /没有交集/);
  assert.equal(elements.get("#repMonth").focused, true);
  assert.equal(opened, 0);

  const invalidYear = functions.genReport({ year: "0999" });
  assert.equal(invalidYear.ok, false);
  assert.match(elements.get("#reportScopeError").textContent, /1000 至 9999/);
  assert.equal(elements.get("#repYear").focused, true);
});

test("fuel 与报告新增 innerHTML sink 对持久化文本执行转义", () => {
  assert.match(source, /fuelText \? '<span class="num">' \+ esc\(fuelText\)/);
  assert.match(source, /esc\(item\.vehicleName \|\| vehicleById\(item\.vehicleId\)\.name\)/);
  assert.match(source, /\$\('#reportText'\)\.textContent = lastReport\.text/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*lastReport\.text/);
});

test("收车 preview 拒绝缺失和倒序日期，并明确区分零收入与正收入", () => {
  const { buildCloseTripPreview } = compile(["buildCloseTripPreview"]);
  const state = {
    trips: [{
      id: "trip-1",
      vehicleId: "vehicle-1",
      startDate: "2026-08-05",
      expenses: [{ amount: 100 }, { amount: 20.5 }],
    }],
  };

  assert.equal(buildCloseTripPreview(state, { tripId: "missing", inc: {} }, "2026-08-06").code, "missing");
  assert.equal(buildCloseTripPreview(state, { tripId: "trip-1", inc: {} }, "").code, "missing-date");
  assert.equal(buildCloseTripPreview(state, { tripId: "trip-1", inc: {} }, "2026-02-30").code, "invalid-date");
  assert.equal(buildCloseTripPreview(state, { tripId: "trip-1", inc: {} }, "2026-08-04").code, "date-before");

  const zero = buildCloseTripPreview(state, { tripId: "trip-1", inc: {} }, "2026-08-06");
  assert.equal(zero.ok, true);
  assert.equal(zero.code, "noincome");
  assert.equal(zero.income, 0);
  assert.equal(zero.expense, 120.5);
  assert.equal(zero.profit, -120.5);
  assert.deepEqual(Array.from(zero.incomeEntries), []);

  const ready = buildCloseTripPreview(
    state,
    { tripId: "trip-1", inc: { cargo: 300, other: 50, ignored: 0 } },
    "2026-08-06",
  );
  assert.equal(ready.code, "ready");
  assert.equal(ready.income, 350);
  assert.equal(ready.expense, 120.5);
  assert.equal(ready.profit, 229.5);
  assert.deepEqual(
    Array.from(ready.incomeEntries, (entry) => ({ ...entry })),
    [
      { catId: "cargo", amount: 300, date: "2026-08-06" },
      { catId: "other", amount: 50, date: "2026-08-06" },
    ],
  );
});

test("两处滑轨被可访问的全宽按钮和嵌套确认 sheet 完整替换", () => {
  assert.doesNotMatch(source, /slide-close|slide-thumb|initSlide|SVG_CHEV|ttqReset|doCloseTrip/);
  assert.match(source, /data-act="openclose"[^>]*data-trip="[^\n]*data-business-write[^>]*>🏁 确认收车/);
  assert.match(source, /id="btnCloseReview"[^>]*data-business-write[^>]*aria-haspopup="dialog"/);
  assert.match(source, /id="btnCloseConfirm"[^>]*data-business-write[^>]*aria-describedby="closeConfirmStatus"/);
  assert.match(source, /id="sheet-close-confirm" role="dialog" aria-modal="true" aria-labelledby="closeConfirmTitle"/);
  assert.match(source, /id="sheet-close" role="dialog" aria-modal="true" aria-labelledby="closeTitle"/);
  assert.match(source, /id="closeConfirmWarning" role="alert" hidden/);
  assert.match(source, /id="closeConfirmStatus" role="status" aria-live="polite"/);
  assert.match(source, /\.close-action \{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(source, /syncBusinessWriteControls\(box\)/);
  assert.match(source, /dataResolver\('\[data-act="openclose"\]\[data-trip\]'/);
  assert.match(source, /e\.target\.closest\('\.chips,\.quick-amt,\.pill-row,\.pad,\.close-action'\)/);
  assert.match(source, /data-act="goclose" data-business-write/);
  assert.match(extractFunction("renderTripDetail"), /syncBusinessWriteControls\(\$\('#tripDetail'\)\)/);
});

test("sheet 模态隔离覆盖首页两层、详情三层，并在逐层关闭后恢复交互", () => {
  function fakeElement(id, on = false, titleId = "") {
    const attributes = new Map();
    const classes = new Set(on ? ["on"] : []);
    const title = titleId ? { id: titleId } : null;
    return {
      id,
      inert: false,
      attributes,
      classList: {
        contains(name) { return classes.has(name); },
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
      },
      querySelector(selector) { return selector === ".shead h3" ? title : null; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      removeAttribute(name) { attributes.delete(name); },
      hasAttribute(name) { return attributes.has(name); },
      getAttribute(name) { return attributes.get(name) ?? null; },
    };
  }

  const main = fakeElement("view-home", true);
  const nav = fakeElement("nav", true);
  const trip = fakeElement("sheet-trip", true, "tripTitle");
  const close = fakeElement("sheet-close", true, "closeTitle");
  const confirm = fakeElement("sheet-close-confirm", true, "closeConfirmTitle");
  const hidden = fakeElement("sheet-hidden", false, "hiddenTitle");
  const stack = ["sheet-trip", "sheet-close", "sheet-close-confirm"];
  const { syncSheetModality } = compile(
    ["setLayerInert", "ensureSheetDialog", "syncSheetModality"],
    {
      sheetStack: stack,
      $$: (selector) => selector === ".view,#nav" ? [main, nav] : [trip, close, confirm, hidden],
    },
  );

  syncSheetModality();
  assert.equal(main.inert, true);
  assert.equal(nav.inert, true);
  assert.equal(trip.inert, true);
  assert.equal(close.inert, true);
  assert.equal(confirm.inert, false);
  assert.equal(confirm.getAttribute("aria-modal"), "true");
  assert.equal(confirm.getAttribute("aria-labelledby"), "closeConfirmTitle");
  assert.equal(hidden.inert, false, "隐藏 sheet 不得残留 inert");
  assert.equal(hidden.getAttribute("aria-hidden"), "true");

  stack.pop();
  confirm.classList.remove("on");
  syncSheetModality();
  assert.equal(close.inert, false, "详情→结算→确认的第三层关闭后应恢复结算层");
  assert.equal(trip.inert, true);

  stack.splice(0, 1);
  trip.classList.remove("on");
  stack.push("sheet-close-confirm");
  confirm.classList.add("on");
  syncSheetModality();
  assert.equal(close.inert, true);
  assert.equal(confirm.inert, false, "首页→结算→确认只允许第二层确认交互");

  stack.length = 0;
  close.classList.remove("on");
  confirm.classList.remove("on");
  syncSheetModality();
  assert.equal(main.inert, false);
  assert.equal(nav.inert, false);
  assert.equal(main.hasAttribute("aria-hidden"), false);
  assert.equal(hidden.inert, false);
});

test("重复收车伪激活在修改 closeCtx 前拒绝，并聚焦当前顶层", () => {
  const initialContext = { tripId: "trip-a", inc: { cargo: 100 } };
  const top = { id: "sheet-close-confirm" };
  let focused = null;
  let writeChecks = 0;
  let opened = 0;
  const { functions, context } = compileWithContext(
    ["closeFlowActive", "focusCurrentTopSheet", "openCloseSheet"],
    {
      closeCtx: initialContext,
      sheetStack: ["sheet-close", "sheet-close-confirm"],
      sheetTransitions: { "sheet-close": {}, "sheet-close-confirm": {} },
      document: { getElementById: (id) => id === top.id ? top : null },
      TTQUITransition: { focusElement: (element) => { focused = element; } },
      canStartBusinessWrite: () => { writeChecks += 1; return true; },
      openSheet: () => { opened += 1; return true; },
    },
  );

  assert.equal(functions.openCloseSheet("trip-b", {}), false);
  assert.equal(context.closeCtx.tripId, "trip-a");
  assert.equal(context.closeCtx, initialContext);
  assert.equal(writeChecks, 0);
  assert.equal(opened, 0);
  assert.equal(focused, top);
  const body = extractFunction("openCloseSheet");
  assert.ok(body.indexOf("closeFlowActive()") < body.indexOf("closeCtx ="));
});

test("顶层 sheet 圈定 Tab、Escape 走统一历史关闭，IME 不受影响", () => {
  const first = { hidden: false, disabled: false, getAttribute: () => null, closest: () => null };
  const last = { hidden: false, disabled: false, getAttribute: () => null, closest: () => null };
  const top = {
    id: "sheet-close-confirm",
    querySelectorAll: () => [first, last],
    contains: (element) => element === first || element === last,
  };
  let activeElement = last;
  let focused = null;
  let closed = null;
  const documentStub = {
    get activeElement() { return activeElement; },
    getElementById: () => top,
  };
  const functions = compile(
    ["sheetFocusableElements", "handleSheetKeydown"],
    {
      sheetStack: [top.id],
      document: documentStub,
      $: () => null,
      TTQUITransition: { focusElement: (element) => { focused = element; activeElement = element; } },
      closeSheet: (element) => { closed = element; },
    },
  );
  const event = (key, extras = {}) => ({
    key,
    defaultPrevented: false,
    isComposing: false,
    keyCode: 0,
    shiftKey: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    ...extras,
  });

  const tab = event("Tab");
  functions.handleSheetKeydown(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(focused, first);

  activeElement = first;
  const shiftTab = event("Tab", { shiftKey: true });
  functions.handleSheetKeydown(shiftTab);
  assert.equal(focused, last);

  const escape = event("Escape");
  functions.handleSheetKeydown(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(closed, top);

  closed = null;
  functions.handleSheetKeydown(event("Escape", { isComposing: true, keyCode: 229 }));
  assert.equal(closed, null);

  let visualTarget = null;
  const { closeTopSheet } = compile(["closeTopSheet"], {
    sheetStack: ["sheet-trip", "sheet-close", "sheet-close-confirm"],
    document: { getElementById: (id) => ({ id }) },
    closeSheetVisual: (element) => { visualTarget = element.id; },
  });
  assert.equal(closeTopSheet(), true);
  assert.equal(visualTarget, "sheet-close-confirm");
});

test("收车最终提交快速连点只执行一次，失败留在确认层，成功才回首页", async () => {
  const functionNames = [
    "buildCloseTripPreview",
    "closePreviewError",
    "renderCloseConfirmation",
    "closeCommitFailureMessage",
    "confirmCloseTrip",
  ];
  const makeElements = () => new Map([
    ["#closeDate", { value: "2026-08-06" }],
    ["#sheet-close-confirm", { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelectorAll() { return []; }, matches() { return false; } }],
    ["#btnCloseConfirm", { textContent: "确认收车" }],
    ["#closeConfirmStatus", { textContent: "" }],
    ["#closeConfirmVehicle", { textContent: "" }],
    ["#closeConfirmDate", { textContent: "" }],
    ["#closeConfirmIncome", { textContent: "" }],
    ["#closeConfirmExpense", { textContent: "" }],
    ["#closeConfirmProfit", { textContent: "" }],
    ["#closeConfirmWarning", { hidden: true }],
  ]);
  const makeState = () => ({
    trips: [{
      id: "trip-1",
      vehicleId: "vehicle-1",
      startDate: "2026-08-05",
      endDate: null,
      status: "open",
      expenses: [{ amount: 100 }],
      incomes: [],
    }],
  });
  const base = (state, elements) => ({
    S: state,
    closeCtx: { tripId: "trip-1", inc: { cargo: 300 } },
    $: (selector) => elements.get(selector),
    vehicleById: () => ({ name: "一号车" }),
    vehicleLabel: () => "一号车",
    fmt: (value) => String(value),
    syncBusinessWriteControls() {},
    uid: () => "income-1",
    tripTotals: (trip) => ({ profit: trip.incomes.reduce((sum, entry) => sum + entry.amount, 0) - 100 }),
    tripSeq: () => 1,
    toast() {},
    closeAllSheets() {},
    showView() {},
  });

  let writes = 0;
  const duplicateState = makeState();
  const duplicateElements = makeElements();
  const duplicate = compile(functionNames, {
    ...base(duplicateState, duplicateElements),
    guardOnce: () => false,
    submitBusinessMutation: async () => { writes += 1; return { ok: true }; },
  });
  assert.equal((await duplicate.confirmCloseTrip()).duplicate, true);
  assert.equal(writes, 0);

  let closed = 0;
  let shown = 0;
  const failedState = makeState();
  const failedElements = makeElements();
  const failed = compile(functionNames, {
    ...base(failedState, failedElements),
    guardOnce: () => true,
    submitBusinessMutation: async () => ({ ok: false, conflict: true }),
    closeAllSheets: () => { closed += 1; },
    showView: () => { shown += 1; },
  });
  const failure = await failed.confirmCloseTrip();
  assert.equal(failure.ok, false);
  assert.equal(closed, 0);
  assert.equal(shown, 0);
  assert.match(failedElements.get("#closeConfirmStatus").textContent, /没有收车/);
  assert.equal(failedElements.get("#btnCloseConfirm").textContent, "确认收车");
  assert.equal(failedElements.get("#sheet-close-confirm").attributes["aria-busy"], "false");

  const savedState = makeState();
  const savedElements = makeElements();
  let savedClosed = 0;
  let savedShown = "";
  let successToast = "";
  const succeeded = compile(functionNames, {
    ...base(savedState, savedElements),
    guardOnce: () => true,
    submitBusinessMutation: async (mutator) => { mutator(savedState); return { ok: true }; },
    closeAllSheets: () => { savedClosed += 1; },
    showView: (view) => { savedShown = view; },
    toast: (message) => { successToast = message; },
  });
  const success = await succeeded.confirmCloseTrip();
  assert.equal(success.ok, true);
  assert.equal(savedState.trips[0].status, "closed");
  assert.equal(savedState.trips[0].endDate, "2026-08-06");
  assert.equal(savedState.trips[0].incomes[0].amount, 300);
  assert.equal(savedClosed, 1);
  assert.equal(savedShown, "home");
  assert.match(successToast, /已收车/);

  const { closeCommitFailureMessage } = compile(["closeCommitFailureMessage"]);
  assert.match(closeCommitFailureMessage({ conflict: true }), /云端已有新改动/);
  assert.match(closeCommitFailureMessage({ validation: true }), /服务器没有接受/);
  assert.match(closeCommitFailureMessage({ readonly: true }), /只读模式/);
  assert.match(closeCommitFailureMessage({}), /未收到服务器确认/);
  assert.doesNotMatch(extractFunction("confirmCloseTrip"), /\bask\s*\(|confirmMask/);
  const finalFlow = extractFunction("confirmCloseTrip");
  assert.ok(finalFlow.indexOf("guardOnce()") < finalFlow.indexOf("buildCloseTripPreview"));
  assert.equal((finalFlow.match(/submitBusinessMutation\(/g) || []).length, 1);
});
