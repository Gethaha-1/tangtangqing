export const SYNC_TYPES = [
  "fleet_settings",
  "category",
  "vehicle",
  "trip",
  "trip_expense",
  "trip_income",
  "maintenance",
] as const;

export type SyncType = (typeof SYNC_TYPES)[number];
export type SyncOp = "put" | "delete";

export type SyncOperation = {
  op: SyncOp;
  type: SyncType;
  id: string;
  data?: Record<string, unknown>;
  expectedVersion: number;
};

export type SyncRequest = {
  clientSchemaVersion: number;
  operationId: string;
  operations: SyncOperation[];
  finalize: boolean;
};

export type VersionDecision = "create" | "update" | "conflict";

export function classifyVersion(
  expectedVersion: number,
  currentVersion: number | null,
): VersionDecision {
  if (expectedVersion === 0 && currentVersion === null) return "create";
  if (
    expectedVersion > 0 &&
    currentVersion !== null &&
    expectedVersion === currentVersion
  ) {
    return "update";
  }
  return "conflict";
}

export function roleCanWriteVehicle(
  role: "owner" | "driver",
  hasActiveAssignment: boolean,
): boolean {
  return role === "owner" || hasActiveAssignment;
}

export function rejectOwnershipFields(
  data: Record<string, unknown>,
): void {
  const forbidden = new Set([
    "fleetid",
    "userid",
    "ownerid",
    "createdbyuserid",
    "role",
    "roles",
    "permission",
    "permissions",
    "member",
    "memberid",
    "membership",
    "membershipid",
    "fleetmemberid",
    "identity",
    "identityid",
    "provider",
    "providersubject",
    "assignment",
    "assignmentid",
    "assignments",
    "vehicleassignment",
    "vehicleassignmentid",
    "vehicleassignments",
    "assigneduserid",
  ]);
  for (const field of Object.keys(data)) {
    const normalized = field.replace(/[_-]/g, "").toLowerCase();
    if (forbidden.has(normalized)) {
      throw new RecordValidationError(
        "ownership_field_forbidden",
        "不能由客户端指定身份、成员、角色、分配或车队归属",
      );
    }
  }
}

export type SyncResult =
  | {
      op: SyncOp;
      type: SyncType;
      id: string;
      status: "applied";
      version: number;
      data?: Record<string, unknown>;
    }
  | {
      op: SyncOp;
      type: SyncType;
      id: string;
      status: "conflict";
      version: number | null;
      current: Record<string, unknown> | null;
      error: { code: "version_conflict"; message: string };
    }
  | {
      op: SyncOp;
      type: SyncType;
      id: string;
      status: "rejected";
      error: { code: string; message: string };
    };

export function summarizeSyncResults(results: SyncResult[]) {
  return {
    hasConflicts: results.some((result) => result.status === "conflict"),
    hasRejected: results.some((result) => result.status === "rejected"),
  };
}

export function shouldMarkFleetInitialized(results: SyncResult[]): boolean {
  return (
    results.length > 0 &&
    results.every((result) => result.status === "applied")
  );
}

export class RecordValidationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordValidationError";
    this.code = code;
  }
}

export type NormalizedFuelData = {
  fuelUnitPriceX10000: number | null;
  fuelVolumeMl: number | null;
};

export type FuelData = {
  unitPrice: string;
  liters: string;
};

const MAX_AMOUNT_CENTS = 99_999_999_999n;
const MAX_FUEL_UNIT_PRICE_X10000 = 9_999_999n;
const MAX_FUEL_VOLUME_ML = 100_000_000n;
const FUEL_AMOUNT_TOLERANCE_CENTS = 1n;
const MAX_WEIGHT_MILLI = 100_000_000n;
const MAX_BOX_SLOT_MILLI = 100_000_000n;
const DEFAULT_CARGO_CATALOGS = {
  outbound: [
    { id: "produce", name: "拉菜", active: true, builtin: true, sortOrder: 0 },
    { id: "general", name: "普货", active: true, builtin: true, sortOrder: 1 },
    { id: "other", name: "其他", active: true, builtin: true, sortOrder: 2 },
  ],
  return: [
    { id: "corn", name: "玉米", active: true, builtin: true, sortOrder: 0 },
    { id: "corn_flakes", name: "玉米片", active: true, builtin: true, sortOrder: 1 },
    { id: "soybean", name: "大豆", active: true, builtin: true, sortOrder: 2 },
    { id: "rice", name: "稻谷", active: true, builtin: true, sortOrder: 3 },
    { id: "general", name: "普货", active: true, builtin: true, sortOrder: 4 },
    { id: "other", name: "其他", active: true, builtin: true, sortOrder: 5 },
  ],
} as const;

const PUT_ORDER: Record<SyncType, number> = {
  category: 0,
  vehicle: 1,
  trip: 2,
  trip_expense: 3,
  trip_income: 3,
  maintenance: 4,
  fleet_settings: 5,
};

const DELETE_ORDER: Record<SyncType, number> = {
  trip_expense: 0,
  trip_income: 0,
  maintenance: 1,
  trip: 2,
  category: 3,
  vehicle: 4,
  fleet_settings: 5,
};

export function orderSyncOperations(
  operations: SyncOperation[],
): SyncOperation[] {
  const seen = new Set<string>();
  for (const operation of operations) {
    const key = `${operation.type}\u0000${operation.id}`;
    if (seen.has(key)) {
      throw new RecordValidationError(
        "duplicate_operation",
        `同一批次不能重复同步 ${operation.type}:${operation.id}`,
      );
    }
    seen.add(key);
  }

  return operations
    .map((operation, originalIndex) => ({ operation, originalIndex }))
    .sort((left, right) => {
      if (left.operation.op !== right.operation.op) {
        return left.operation.op === "delete" ? -1 : 1;
      }
      const order =
        left.operation.op === "put" ? PUT_ORDER : DELETE_ORDER;
      if (
        left.operation.op === "put" &&
        left.operation.type === "vehicle" &&
        right.operation.type === "vehicle"
      ) {
        const leftActive = left.operation.data?.active !== false ? 1 : 0;
        const rightActive = right.operation.data?.active !== false ? 1 : 0;
        if (leftActive !== rightActive) return rightActive - leftActive;
      }
      return (
        order[left.operation.type] - order[right.operation.type] ||
        left.originalIndex - right.originalIndex
      );
    })
    .map(({ operation }) => operation);
}

export function parseSyncOperations(input: unknown): SyncOperation[] {
  if (!isObject(input) || !Array.isArray(input.operations)) {
    throw new RecordValidationError(
      "invalid_body",
      "请求必须包含 operations 数组",
    );
  }
  rejectOwnershipFields(input);
  if (input.operations.length > 500) {
    throw new RecordValidationError(
      "batch_too_large",
      "一次最多同步 500 条记录",
    );
  }

  return input.operations.map((value, index) => {
    if (!isObject(value)) {
      throw new RecordValidationError(
        "invalid_operation",
        `第 ${index + 1} 条同步记录格式不正确`,
      );
    }
    rejectOwnershipFields(value);

    const op = value.op;
    const type = value.type;
    const id = requiredId(value.id, "id");
    const expectedVersion =
      value.expectedVersion == null ? 0 : value.expectedVersion;

    if (op !== "put" && op !== "delete") {
      throw new RecordValidationError(
        "invalid_operation",
        `第 ${index + 1} 条记录的 op 不正确`,
      );
    }
    if (
      typeof type !== "string" ||
      !SYNC_TYPES.includes(type as SyncType)
    ) {
      throw new RecordValidationError(
        "invalid_type",
        `第 ${index + 1} 条记录的 type 不正确`,
      );
    }
    if (
      !Number.isSafeInteger(expectedVersion) ||
      Number(expectedVersion) < 0
    ) {
      throw new RecordValidationError(
        "invalid_version",
        `第 ${index + 1} 条记录的 expectedVersion 不正确`,
      );
    }
    if (op === "put" && !isObject(value.data)) {
      throw new RecordValidationError(
        "missing_data",
        `第 ${index + 1} 条新增或更新记录缺少 data`,
      );
    }

    return {
      op,
      type: type as SyncType,
      id,
      data: isObject(value.data) ? value.data : undefined,
      expectedVersion: Number(expectedVersion),
    };
  });
}

export function parseSyncRequest(input: unknown): SyncRequest {
  if (!isObject(input)) {
    throw new RecordValidationError(
      "invalid_body",
      "请求必须是 JSON 对象",
    );
  }
  const clientSchemaVersion = requireClientSchemaVersion(input.clientSchemaVersion);
  const operations = orderSyncOperations(parseSyncOperations(input));
  if (operations.some((operation) => operation.op === "put" && operation.type === "trip_income")) {
    throw new RecordValidationError(
      "legacy_income_read_only",
      "旧版手工收入保持只读；请通过去程或返程清单登记运输收入",
    );
  }
  return {
    clientSchemaVersion,
    operationId: requiredOperationId(input.operationId),
    operations,
    finalize: !("finalize" in input) || input.finalize !== false,
  };
}

export function requireClientSchemaVersion(value: unknown): number {
  if (value !== 5) {
    throw new RecordValidationError(
      "client_upgrade_required",
      "页面版本已过期，请刷新后再继续记账；本次没有写入",
    );
  }
  return 5;
}

export function requiredOperationId(value: unknown): string {
  const operationId = typeof value === "string" ? value.trim() : "";
  if (
    operationId.length < 8 ||
    operationId.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(operationId)
  ) {
    throw new RecordValidationError(
      "invalid_operation_id",
      "operationId 必须是 8 到 160 位的稳定请求标识",
    );
  }
  return operationId;
}

export function canonicalSyncPayload(
  operations: SyncOperation[],
  finalize: boolean,
  clientSchemaVersion = 5,
): string {
  return canonicalJson({ clientSchemaVersion, finalize, operations });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requiredId(value: unknown, field: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 160 || /[\u0000-\u001f]/.test(id)) {
    throw new RecordValidationError(
      "invalid_id",
      `${field} 不能为空且不能超过 160 个字符`,
    );
  }
  return id;
}

export function requiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) {
    throw new RecordValidationError(
      "invalid_text",
      `${field} 不能为空且不能超过 ${maxLength} 个字符`,
    );
  }
  return text;
}

export function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const text = value == null ? "" : String(value).trim();
  if (text.length > maxLength) {
    throw new RecordValidationError(
      "invalid_text",
      `${field} 不能超过 ${maxLength} 个字符`,
    );
  }
  return text;
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function sortOrder(value: unknown): number {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RecordValidationError(
      "invalid_sort_order",
      "sortOrder 必须是非负整数",
    );
  }
  return Number(value);
}

export function dateValue(value: unknown, field: string): string {
  const date = typeof value === "string" ? value : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RecordValidationError(
      "invalid_date",
      `${field} 必须是 YYYY-MM-DD 日期`,
    );
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new RecordValidationError("invalid_date", `${field} 不是有效日期`);
  }
  return date;
}

export function optionalIsoDateTime(
  value: unknown,
  field: string,
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new RecordValidationError(
      "invalid_datetime",
      `${field} 不是有效时间`,
    );
  }
  return new Date(value).toISOString();
}

export function amountToCents(value: unknown): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || number < 0 || number > 999_999_999.99) {
    throw new RecordValidationError(
      "invalid_amount",
      "金额必须是非负数字且不能超过 999999999.99",
    );
  }
  return Math.round(number * 100);
}

export function centsToAmount(value: unknown): number {
  return Number(value || 0) / 100;
}

/**
 * Validate the optional structured fuel payload and convert it to the integer
 * database representation. A fuel expense without `fuel` is an intentional
 * legacy record; any present payload must be complete and consistent.
 */
export function normalizeFuelData(
  categoryId: string,
  amount: unknown,
  fuel: unknown,
): NormalizedFuelData {
  if (categoryId !== "fuel") {
    if (fuel !== undefined) {
      throw new RecordValidationError(
        "fuel_metadata_forbidden",
        "只有油费支出可以携带 fuel 元数据",
      );
    }
    return { fuelUnitPriceX10000: null, fuelVolumeMl: null };
  }
  if (fuel === undefined) {
    return { fuelUnitPriceX10000: null, fuelVolumeMl: null };
  }
  if (!isObject(fuel)) {
    throw new RecordValidationError(
      "invalid_fuel_metadata",
      "fuel 必须同时包含 unitPrice 和 liters",
    );
  }
  const keys = Object.keys(fuel);
  if (
    !Object.hasOwn(fuel, "unitPrice") ||
    !Object.hasOwn(fuel, "liters") ||
    keys.some((key) => key !== "unitPrice" && key !== "liters")
  ) {
    throw new RecordValidationError(
      "invalid_fuel_metadata",
      "fuel 必须且只能包含 unitPrice 和 liters",
    );
  }

  const amountCents = decimalUnits(
    amount,
    2,
    MAX_AMOUNT_CENTS,
    "fuel.totalAmount",
    true,
  );
  const fuelUnitPriceX10000 = decimalUnits(
    fuel.unitPrice,
    4,
    MAX_FUEL_UNIT_PRICE_X10000,
    "fuel.unitPrice",
    false,
  );
  const fuelVolumeMl = decimalUnits(
    fuel.liters,
    3,
    MAX_FUEL_VOLUME_ML,
    "fuel.liters",
    false,
  );
  const expectedAmountCents = roundHalfUp(
    fuelUnitPriceX10000 * fuelVolumeMl,
    100_000n,
  );
  const difference =
    amountCents >= expectedAmountCents
      ? amountCents - expectedAmountCents
      : expectedAmountCents - amountCents;
  if (amountCents === 0n || difference > FUEL_AMOUNT_TOLERANCE_CENTS) {
    throw new RecordValidationError(
      "fuel_amount_inconsistent",
      "油费总价与单价、升数不一致（允许固定 0.01 元误差）",
    );
  }

  return {
    fuelUnitPriceX10000: Number(fuelUnitPriceX10000),
    fuelVolumeMl: Number(fuelVolumeMl),
  };
}

/** Rebuild canonical sync data from the two nullable database columns. */
export function fuelDataFromScaled(
  unitPriceX10000: unknown,
  volumeMl: unknown,
): FuelData | undefined {
  if (unitPriceX10000 == null && volumeMl == null) return undefined;
  if (
    !Number.isSafeInteger(unitPriceX10000) ||
    !Number.isSafeInteger(volumeMl) ||
    Number(unitPriceX10000) <= 0 ||
    Number(volumeMl) <= 0 ||
    BigInt(Number(unitPriceX10000)) > MAX_FUEL_UNIT_PRICE_X10000 ||
    BigInt(Number(volumeMl)) > MAX_FUEL_VOLUME_ML
  ) {
    throw new RecordValidationError(
      "invalid_stored_fuel_metadata",
      "数据库中的 fuel 定点字段不完整或超出范围",
    );
  }
  return {
    unitPrice: scaledToCanonical(BigInt(Number(unitPriceX10000)), 4),
    liters: scaledToCanonical(BigInt(Number(volumeMl)), 3),
  };
}

function decimalUnits(
  value: unknown,
  scale: number,
  maximum: bigint,
  field: string,
  allowZero: boolean,
): bigint {
  let text: string;
  if (typeof value === "number" && Number.isFinite(value)) {
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    text = "";
  }
  const error = (message: string): never => {
    throw new RecordValidationError(
      "invalid_fuel_number",
      message,
    );
  };
  if (text.length > 32) {
    return error(`${field} 超出支持范围`);
  }
  if (/[eE]/.test(text)) {
    return error(`${field} 必须使用普通十进制，不能使用指数形式`);
  }
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text);
  if (!match) {
    return error(`${field} 必须是正的普通十进制数`);
  }
  const integer = match[1] || "0";
  const fraction = (match[2] !== undefined ? match[2] : match[3]) || "";
  if (fraction.length > scale) {
    return error(`${field} 最多保留 ${scale} 位小数`);
  }
  const factor = 10n ** BigInt(scale);
  const units =
    BigInt(integer) * factor +
    BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  if ((!allowZero && units === 0n) || units > maximum) {
    return error(`${field} 必须大于零且不能超过支持范围`);
  }
  return units;
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function scaledToCanonical(units: bigint, scale: number): string {
  const factor = 10n ** BigInt(scale);
  const integer = units / factor;
  const fraction = String(units % factor).padStart(scale, "0");
  return `${integer}.${fraction}`
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
}

function businessText(
  value: unknown,
  field: string,
  maxLength: number,
  required = false,
): string {
  const text = value == null ? "" : String(value).trim();
  if ((required && !text) || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new RecordValidationError(
      "invalid_business_data",
      `${field}${required ? "不能为空、" : ""}不能含控制字符且不能超过 ${maxLength} 个字符`,
    );
  }
  return text;
}

function businessId(value: unknown, field: string): string {
  return businessText(value, field, 160, true);
}

function boundedBusinessData(value: Record<string, unknown>): Record<string, unknown> {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_000_000) {
    throw new RecordValidationError(
      "invalid_business_data",
      "业务资料超出 1 MB 限制",
    );
  }
  return value;
}

function businessRefKey(shipperId: string, marketId: string): string {
  return JSON.stringify([shipperId, marketId]);
}

function optionalBusinessUnits(
  value: unknown,
  scale: number,
  maximum: bigint,
  field: string,
  allowZero: boolean,
): bigint | null {
  if (value == null || value === "") return null;
  return decimalUnits(value, scale, maximum, field, allowZero);
}

function businessLocation(value: unknown): Record<string, unknown> {
  const source = isObject(value) ? value : {};
  const result: Record<string, unknown> = {
    placeId: businessText(source.placeId, "常用地点标识", 160),
    region: businessText(source.region, "市县", 80),
    name: businessText(source.name, "厂家或地点", 120),
    roadNote: businessText(source.roadNote, "道路备注", 300),
    handlingNote: businessText(source.handlingNote, "装卸备注", 300),
    note: businessText(source.note, "地点提醒", 500),
  };
  for (const field of ["city", "county"]) {
    if (source[field] !== undefined) result[field] = businessText(source[field], field === "city" ? "市" : "区县", 40);
  }
  if (source.latitude != null && source.latitude !== "") {
    const latitude = Number(source.latitude);
    const longitude = Number(source.longitude);
    if (
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
    ) {
      throw new RecordValidationError("invalid_business_data", "地点坐标无效");
    }
    result.latitude = latitude;
    result.longitude = longitude;
  }
  return result;
}

export function normalizeBusinessSettingsData(value: unknown): Record<string, unknown> {
  const source = isObject(value) ? value : {};
  const shippers = (Array.isArray(source.shippers) ? source.shippers : []).map((value) => {
    if (!isObject(value)) throw new RecordValidationError("invalid_business_data", "货主格式不正确");
    return {
      id: businessId(value.id, "货主标识"),
      name: businessText(value.name, "货主名称", 60, true),
      markets: (Array.isArray(value.markets) ? value.markets : []).map((market) => {
        if (!isObject(market)) throw new RecordValidationError("invalid_business_data", "市场格式不正确");
        return {
          id: businessId(market.id, "市场标识"),
          name: businessText(market.name, "市场名称", 100, true),
          region: businessText(market.region, "市场市县", 80),
        };
      }),
    };
  });
  const shipperIds = new Set<string>();
  const marketKeys = new Set<string>();
  for (const shipper of shippers) {
    if (shipperIds.has(shipper.id)) throw new RecordValidationError("invalid_business_data", "货主标识重复");
    shipperIds.add(shipper.id);
    for (const market of shipper.markets) {
      const key = businessRefKey(shipper.id, market.id);
      if (marketKeys.has(key)) throw new RecordValidationError("invalid_business_data", "同一货主的市场标识重复");
      marketKeys.add(key);
    }
  }
  const normalizeRef = (value: unknown) => {
    if (!isObject(value)) throw new RecordValidationError("invalid_business_data", "分组成员格式不正确");
    const ref = {
      shipperId: businessId(value.shipperId, "分组货主标识"),
      marketId: businessId(value.marketId, "分组市场标识"),
    };
    if (!marketKeys.has(businessRefKey(ref.shipperId, ref.marketId))) {
      throw new RecordValidationError("invalid_business_data", "货主分组引用了不存在的货主或市场");
    }
    return ref;
  };
  const shipperGroups = (Array.isArray(source.shipperGroups) ? source.shipperGroups : []).map((value) => {
    if (!isObject(value)) throw new RecordValidationError("invalid_business_data", "货主分组格式不正确");
    const members = (Array.isArray(value.members) ? value.members : []).map(normalizeRef);
    const keys = new Set(members.map((ref) => businessRefKey(ref.shipperId, ref.marketId)));
    if (keys.size !== members.length) throw new RecordValidationError("invalid_business_data", "分组成员重复");
    const mainRef = normalizeRef(value.mainRef);
    if (!keys.has(businessRefKey(mainRef.shipperId, mainRef.marketId))) {
      throw new RecordValidationError("invalid_business_data", "主货主必须同时在分组成员中");
    }
    return {
      id: businessId(value.id, "分组标识"),
      name: businessText(value.name, "分组名称", 60, true),
      mainRef,
      members,
    };
  });
  if (new Set(shipperGroups.map((group) => group.id)).size !== shipperGroups.length) {
    throw new RecordValidationError("invalid_business_data", "货主分组标识重复");
  }
  const places = (Array.isArray(source.places) ? source.places : []).map((value) => {
    if (!isObject(value)) throw new RecordValidationError("invalid_business_data", "地点格式不正确");
    const updatedAt = value.updatedAt == null || value.updatedAt === ""
      ? new Date(0).toISOString()
      : optionalIsoDateTime(value.updatedAt, "地点更新时间");
    return {
      ...businessLocation(value),
      id: businessId(value.id, "地点标识"),
      updatedAt,
    };
  });
  if (new Set(places.map((place) => place.id)).size !== places.length) {
    throw new RecordValidationError("invalid_business_data", "地点标识重复");
  }
  const cargoSource = isObject(source.cargoCatalogs) ? source.cargoCatalogs : {};
  const normalizeCargoCatalog = (direction: "outbound" | "return") => {
    const configured = Array.isArray(cargoSource[direction]) ? cargoSource[direction] : null;
    const values: readonly unknown[] = configured ?? DEFAULT_CARGO_CATALOGS[direction];
    const result = values.map((value, index) => {
      if (!isObject(value)) throw new RecordValidationError("invalid_business_data", "货物目录格式不正确");
      const requestedOrder = Number(value.sortOrder);
      return {
        id: businessId(value.id, `${direction === "outbound" ? "去程" : "返程"}货物标识`),
        name: businessText(value.name, "货物名称", 60, true),
        active: value.active !== false,
        builtin: value.builtin === true,
        sortOrder: Number.isSafeInteger(requestedOrder) && requestedOrder >= 0 ? requestedOrder : index,
      };
    });
    if (!result.length || !result.some((item) => item.active)) {
      throw new RecordValidationError("invalid_business_data", `${direction === "outbound" ? "去程" : "返程"}货物目录至少需要一个启用项`);
    }
    if (new Set(result.map((item) => item.id)).size !== result.length) {
      throw new RecordValidationError("invalid_business_data", `${direction === "outbound" ? "去程" : "返程"}货物标识重复`);
    }
    return result.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  };
  return boundedBusinessData({
    shippers,
    shipperGroups,
    places,
    cargoCatalogs: {
      outbound: normalizeCargoCatalog("outbound"),
      return: normalizeCargoCatalog("return"),
    },
  });
}

function businessCargoSnapshot(source: Record<string, unknown>, direction: "outbound" | "return") {
  const defaults = DEFAULT_CARGO_CATALOGS[direction];
  const hasV5Id = Object.prototype.hasOwnProperty.call(source, "cargoTypeId");
  const id = hasV5Id
    ? businessText(source.cargoTypeId, "货物标识", 160)
    : businessText(source.cargoType, "货物标识", 160) || defaults[0].id;
  if (!id) return { cargoTypeId: "", cargoTypeName: "" };
  const legacy = defaults.find((item) => item.id === id);
  const suppliedName = businessText(source.cargoTypeName, "货物名称", 60);
  const name = suppliedName || legacy?.name || "";
  if (hasV5Id && !name) {
    throw new RecordValidationError("invalid_business_data", "已选货物缺少名称快照");
  }
  return { cargoTypeId: id, cargoTypeName: name || id };
}

export function normalizeTripBusinessData(value: unknown): Record<string, unknown> {
  const source = isObject(value) ? value : {};
  const result: Record<string, unknown> = {};
  if (source.outbound != null) {
    if (!isObject(source.outbound)) throw new RecordValidationError("invalid_business_data", "去程清单格式不正确");
    const outbound = source.outbound;
    const totalFreight = decimalUnits(outbound.totalFreight, 2, MAX_AMOUNT_CENTS, "整车原定运费", false);
    const entries = Array.isArray(outbound.allocations) ? outbound.allocations : [];
    if (!entries.length) {
      result.outbound = {
        ...businessCargoSnapshot(outbound, "outbound"),
        totalFreight: centsToAmount(Number(totalFreight)),
        totalBoxSlots: "",
        allocatedTotal: 0,
        roundingTotal: 0,
        finalTotal: centsToAmount(Number(totalFreight)),
        allocations: [],
      };
    }
    if (entries.length) {
    const weighted = entries.map((value, index) => {
      if (!isObject(value)) throw new RecordValidationError("invalid_business_data", "去程货主格式不正确");
      const boxSlots = decimalUnits(value.boxSlots, 3, MAX_BOX_SLOT_MILLI, "箱位", false);
      return {
        value,
        index,
        boxSlots,
        share: 0n,
        remainder: 0n,
      };
    });
    const totalSlots = weighted.reduce((sum, item) => sum + item.boxSlots, 0n);
    for (const item of weighted) {
      const numerator = totalFreight * item.boxSlots;
      item.share = numerator / totalSlots;
      item.remainder = numerator % totalSlots;
    }
    let remaining = totalFreight - weighted.reduce((sum, item) => sum + item.share, 0n);
    [...weighted].sort((a, b) => a.remainder === b.remainder
      ? a.index - b.index
      : (a.remainder > b.remainder ? -1 : 1)).forEach((item) => {
        if (remaining > 0n) { item.share += 1n; remaining -= 1n; }
      });
    const allocations = weighted.sort((a, b) => a.index - b.index).map((item) => {
      const value = item.value;
      const rounding = optionalBusinessUnits(value.roundingAmount, 2, MAX_AMOUNT_CENTS, "协商抹零", true) ?? 0n;
      if (rounding > item.share) throw new RecordValidationError("invalid_business_data", "协商抹零不能大于个人分摊运费");
      return {
        id: businessId(value.id, "本趟货主清单标识"),
        shipperId: businessId(value.shipperId, "货主标识"),
        shipperName: businessText(value.shipperName, "货主名称", 60, true),
        marketId: businessId(value.marketId, "市场标识"),
        marketName: businessText(value.marketName, "市场名称", 100, true),
        marketRegion: businessText(value.marketRegion, "市场市县", 80),
        boxSlots: scaledToCanonical(item.boxSlots, 3),
        allocatedAmount: centsToAmount(Number(item.share)),
        roundingAmount: centsToAmount(Number(rounding)),
        finalAmount: centsToAmount(Number(item.share - rounding)),
      };
    });
    if (new Set(allocations.map((item) => item.id)).size !== allocations.length) {
      throw new RecordValidationError("invalid_business_data", "本趟货主清单标识重复");
    }
    const roundingTotal = allocations.reduce((sum, item) => sum + BigInt(amountToCents(item.roundingAmount)), 0n);
    result.outbound = {
      ...businessCargoSnapshot(outbound, "outbound"),
      totalFreight: centsToAmount(Number(totalFreight)),
      totalBoxSlots: scaledToCanonical(totalSlots, 3),
      allocatedTotal: centsToAmount(Number(totalFreight)),
      roundingTotal: centsToAmount(Number(roundingTotal)),
      finalTotal: centsToAmount(Number(totalFreight - roundingTotal)),
      allocations,
    };
    }
  }
  if (source.returnTrip != null) {
    if (!isObject(source.returnTrip)) throw new RecordValidationError("invalid_business_data", "返程清单格式不正确");
    const back = source.returnTrip;
    const loaded = decimalUnits(back.loadedTons, 3, MAX_WEIGHT_MILLI, "装车吨位", false);
    const price = decimalUnits(back.unitPrice, 2, MAX_AMOUNT_CENTS, "返程单价", false);
    const receivable = roundHalfUp(loaded * price, 1000n);
    if (receivable > MAX_AMOUNT_CENTS) throw new RecordValidationError("invalid_business_data", "返程应收运费超出支持范围");
    const actual = optionalBusinessUnits(back.actualReceivedAmount, 2, MAX_AMOUNT_CENTS, "实收运费", true);
    const unloaded = optionalBusinessUnits(back.unloadedTons, 3, MAX_WEIGHT_MILLI, "卸车吨位", false);
    const weightGain = unloaded != null && unloaded > loaded;
    if (weightGain && back.weightGainConfirmed !== true) throw new RecordValidationError("invalid_business_data", "卸车吨位大于装车吨位，需先人工确认");
    const referenceLossKg = unloaded == null || weightGain ? null : loaded - unloaded;
    const lossKg = optionalBusinessUnits(back.lossKg, 3, MAX_WEIGHT_MILLI * 1000n, "确认掉称", true);
    const deduction = optionalBusinessUnits(back.lossDeductionAmount, 2, MAX_AMOUNT_CENTS, "掉称扣款", true);
    result.returnTrip = {
      ...businessCargoSnapshot(back, "return"),
      loadedTons: scaledToCanonical(loaded, 3),
      unitPrice: scaledToCanonical(price, 2),
      receivableAmount: centsToAmount(Number(receivable)),
      actualReceivedAmount: actual == null ? null : centsToAmount(Number(actual)),
      effectiveAmount: centsToAmount(Number(actual == null ? receivable : actual)),
      unloadedTons: unloaded == null ? "" : scaledToCanonical(unloaded, 3),
      lossKg: lossKg == null ? "" : scaledToCanonical(lossKg, 3),
      lossReferenceKg: referenceLossKg == null ? "" : scaledToCanonical(referenceLossKg, 0),
      lossDeductionAmount: deduction == null ? null : centsToAmount(Number(deduction)),
      weightGainConfirmed: weightGain,
      pickupLocation: businessLocation(back.pickupLocation),
      deliveryLocation: businessLocation(back.deliveryLocation),
    };
  }
  return boundedBusinessData(result);
}

export function periodDays(start: string, end: string): number {
  const startTime = new Date(`${start}T00:00:00Z`).valueOf();
  const endTime = new Date(`${end}T00:00:00Z`).valueOf();
  return Math.round((endTime - startTime) / 86_400_000) + 1;
}

export function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
