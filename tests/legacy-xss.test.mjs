import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import "../src/domain.js";

const ledgerSource = readFileSync(
  new URL("../legacy/ledger.html", import.meta.url),
  "utf8",
);
const Domain = globalThis.TTQDomain;

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = ledgerSource.indexOf(marker);
  assert.notEqual(start, -1, `legacy/ledger.html 缺少 ${name}()`);
  const bodyStart = ledgerSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < ledgerSource.length; index += 1) {
    if (ledgerSource[index] === "{") depth += 1;
    if (ledgerSource[index] === "}") {
      depth -= 1;
      if (depth === 0) return ledgerSource.slice(start, index + 1);
    }
  }
  throw new Error(`${name}() 大括号没有闭合`);
}

function compileLedgerFunctions(names, globals = {}) {
  const context = vm.createContext({ ...globals });
  const source = [
    ...names.map(extractFunction),
    `this.__exports = { ${names.join(", ")} };`,
  ].join("\n");
  new vm.Script(source, { filename: "legacy/ledger.html" }).runInContext(
    context,
  );
  return { context, functions: context.__exports };
}

function baseData() {
  return {
    schemaVersion: 2,
    settings: {
      theme: "day",
      lastReportSeen: "",
      lastBackupAt: "",
      activeVehicleId: "all",
      periodStartDate: "2026-01-01",
      periodEndDate: "2026-12-31",
    },
    categories: { expense: [], income: [] },
    vehicles: [Domain.legacyVehicle()],
    trips: [],
    maintenance: [],
  };
}

const attributeAttack = '" autofocus onfocus="globalThis.__ttqXss=1';
const htmlAttack = '<img src=x onerror="globalThis.__ttqXss=1">';

function maliciousBackup() {
  const vehicleId = `vehicle-${attributeAttack}`;
  const expenseCategoryId = `expense-${attributeAttack}`;
  const incomeCategoryId = `income-${attributeAttack}`;
  const tripId = `trip-${attributeAttack}`;
  return {
    schemaVersion: 2,
    settings: {
      theme: "day",
      activeVehicleId: "all",
      periodStartDate: "2026-01-01",
      periodEndDate: "2026-12-31",
    },
    vehicles: [
      {
        id: vehicleId,
        name: `主车 ${htmlAttack}`,
        plateNo: `鲁A ${htmlAttack}`,
        active: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    categories: {
      expense: [
        {
          id: expenseCategoryId,
          name: `油费 ${htmlAttack}`,
          icon: htmlAttack,
          builtin: false,
          active: true,
        },
      ],
      income: [
        {
          id: incomeCategoryId,
          name: `运费 ${htmlAttack}`,
          icon: htmlAttack,
          builtin: false,
          active: true,
        },
      ],
    },
    trips: [
      {
        id: tripId,
        vehicleId,
        startDate: "2026-07-01",
        endDate: "2026-07-02",
        status: "closed",
        createdAt: "2026-07-01T00:00:00.000Z",
        closedAt: "2026-07-02T00:00:00.000Z",
        expenses: [
          {
            id: `entry-${attributeAttack}`,
            catId: expenseCategoryId,
            amount: 88.5,
            date: "2026-07-01",
            note: `加油 ${htmlAttack}`,
          },
        ],
        incomes: [
          {
            id: `income-entry-${attributeAttack}`,
            catId: incomeCategoryId,
            amount: 300,
            date: "2026-07-02",
          },
        ],
      },
    ],
    maintenance: [
      {
        id: `maintenance-${attributeAttack}`,
        vehicleId,
        date: "2026-07-03",
        amount: 20,
        note: `补胎 ${htmlAttack}`,
      },
    ],
  };
}

test("文本、属性和 category.icon 使用不同的安全出口", () => {
  const { functions } = compileLedgerFunctions([
    "esc",
    "attrEsc",
    "safeIconText",
  ]);

  assert.equal(
    functions.esc(`<b title="'">&`),
    "&lt;b title=&quot;&#39;&quot;&gt;&amp;",
  );
  assert.equal(
    functions.attrEsc(attributeAttack),
    "&quot; autofocus onfocus=&quot;globalThis.__ttqXss=1",
  );
  assert.equal(functions.safeIconText("🛣️"), "🛣️");
  assert.equal(functions.safeIconText(htmlAttack), "❔");
  assert.equal(functions.attrEsc("a\nb"), "a&#10;b");
});

test("恶意 schema v2 备份经过真实渲染器后不能生成标签或新属性", () => {
  const state = Domain.migrate(maliciousBackup(), baseData());
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        innerHTML: "",
        textContent: "",
        style: {},
        dataset: {},
        addEventListener() {},
      });
    }
    return elements.get(selector);
  };

  const { context, functions } = compileLedgerFunctions(
    [
      "esc",
      "attrEsc",
      "safeIconText",
      "vehicleScopeHTML",
      "tripCardHTML",
      "renderQuickChips",
      "renderQuickBatch",
      "renderVehicles",
      "renderTripDetail",
    ],
    {
      S: state,
      TTQDomain: Domain,
      $: element,
      activeVehicleId: () => state.settings.activeVehicleId,
      vehicleById: (id) =>
        state.vehicles.find((vehicle) => vehicle.id === id) || {
          id,
          name: "（未知车辆）",
          plateNo: "",
        },
      vehicleLabel: (id) => {
        const vehicle = state.vehicles.find((item) => item.id === id);
        return (
          vehicle.name + (vehicle.plateNo ? ` · ${vehicle.plateNo}` : "")
        );
      },
      catById: (id) =>
        [...state.categories.expense, ...state.categories.income].find(
          (category) => category.id === id,
        ) || { id, name: "（已删科目）", icon: "❔" },
      openTrip: () => null,
      tripTotals: Domain.tripTotals,
      tripSeq: (trip) =>
        Domain.tripSeq(
          state,
          trip,
          state.settings.periodStartDate,
          state.settings.periodEndDate,
        ),
      tripDays: () => 2,
      fmt: (value) => String(value),
      fmtMD: (value) => (value ? value.slice(5) : "—"),
      commonAmounts: () => [],
      quickTripId: state.trips[0].id,
      quickCatId: state.categories.expense[0].id,
      quickDrafts: state.trips[0].expenses,
      quickBatchSubmitting: false,
      quickBatchAwaitingConfirmation: false,
      detailTripId: state.trips[0].id,
      moneyCents: (value) => String(value),
      unitPriceX10000: (value) => String(value),
      volumeMl: (value) => String(value),
      closeSheet() {},
      syncBusinessWriteControls() {},
      renderQuickEntryMode() {},
      renderQuickBatchBadge() {},
    },
  );

  const vehicle = state.vehicles[0];
  const category = state.categories.expense[0];
  const trip = state.trips[0];
  const entry = trip.expenses[0];

  const scopeHtml = functions.vehicleScopeHTML();
  const cardHtml = functions.tripCardHTML(trip);
  functions.renderQuickChips();
  functions.renderQuickBatch();
  functions.renderVehicles();
  functions.renderTripDetail();
  const rendered = [
    scopeHtml,
    cardHtml,
    element("#quickChips").innerHTML,
    element("#quickBatchList").innerHTML,
    element("#vehicleList").innerHTML,
    element("#tripDetail").innerHTML,
  ];

  for (const html of rendered) {
    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /<script\b/i);
    assert.equal(context.__ttqXss, undefined);
  }

  assert.match(scopeHtml, /&lt;img src=x onerror=/);
  assert.ok(
    scopeHtml.includes(
      `data-vehicle-scope="${functions.attrEsc(vehicle.id)}"`,
    ),
  );
  assert.ok(cardHtml.includes(`data-trip="${functions.attrEsc(trip.id)}"`));

  const quickHtml = element("#quickChips").innerHTML;
  assert.ok(
    quickHtml.includes(`data-cat="${functions.attrEsc(category.id)}"`),
  );
  assert.match(quickHtml, /<em>❔<\/em>/);
  assert.match(quickHtml, /油费 &lt;img src=x onerror=/);

  const quickBatchHtml = element("#quickBatchList").innerHTML;
  assert.ok(quickBatchHtml.includes(`data-quick-draft="${functions.attrEsc(entry.id)}"`));
  assert.match(quickBatchHtml, /加油 &lt;img src=x onerror=/);
  assert.match(quickBatchHtml, /aria-label="修改 油费 &lt;img src=x onerror=/);

  const vehicleHtml = element("#vehicleList").innerHTML;
  assert.ok(
    vehicleHtml.includes(
      `data-vehicle-edit="${functions.attrEsc(vehicle.id)}"`,
    ),
  );
  assert.match(vehicleHtml, /鲁A &lt;img src=x onerror=/);

  const detailHtml = element("#tripDetail").innerHTML;
  assert.ok(
    detailHtml.includes(`data-entry="${functions.attrEsc(entry.id)}"`),
  );
  assert.match(detailHtml, /加油 &lt;img src=x onerror=/);
  assert.match(detailHtml, /<span class="ric">❔<\/span>/);
});

test("持久化字段的模板回归检查要求属性转义和安全图标文本", () => {
  assert.match(ledgerSource, /function attrEsc\(value\)/);
  assert.match(ledgerSource, /function safeIconText\(value\)/);
  assert.doesNotMatch(
    ledgerSource,
    /\+\s*[a-zA-Z_$][\w$]*\.icon\s*\+/,
  );
  assert.doesNotMatch(
    ledgerSource,
    /(?:data-[\w-]+|id|value)="[^"\n]*'\s*\+\s*(?:[a-zA-Z_$][\w$]*\.)?(?:id|catId|vehicleId)\s*\+/,
  );

  const iconSinks = ledgerSource.match(/safeIconText\(c\.icon\)/g) || [];
  assert.ok(iconSinks.length >= 7, "所有科目图标 innerHTML sink 都应安全输出");
  assert.match(
    ledgerSource,
    /data-entry="' \+ attrEsc\(e\.id\)/,
  );
  assert.match(
    ledgerSource,
    /data-maint="' \+ attrEsc\(m\.id\)/,
  );
});

test("油费按车辆卡片不会把恶意 vehicleName 变成 HTML", () => {
  const { functions } = compileLedgerFunctions(["esc", "fuelCardHTML"], {
    moneyCents: (value) => String(value),
    volumeMl: (value) => String(value),
    unitPriceX10000: (value) => String(value ?? "—"),
    vehicleById: () => ({ name: htmlAttack }),
  });
  const html = functions.fuelCardHTML(
    {
      fuel: {
        totalCostCents: 100,
        volumeMl: 1000,
        weightedUnitPriceX10000: 10000,
        minUnitPriceX10000: 10000,
        maxUnitPriceX10000: 10000,
        coverage: { structuredRecords: 1, totalRecords: 1 },
        legacyCoverageWarning: `警告 ${htmlAttack}`,
        byVehicle: [
          {
            vehicleId: "v1",
            vehicleName: `一号车 ${htmlAttack}`,
            totalCostCents: 100,
            volumeMl: 1000,
          },
        ],
      },
    },
    true,
  );
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /一号车 &lt;img src=x onerror=/);
  assert.match(html, /警告 &lt;img src=x onerror=/);
});
