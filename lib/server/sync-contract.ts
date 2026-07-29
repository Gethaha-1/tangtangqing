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
  return {
    operationId: requiredOperationId(input.operationId),
    operations: orderSyncOperations(parseSyncOperations(input)),
    finalize: !("finalize" in input) || input.finalize !== false,
  };
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
): string {
  return canonicalJson({ finalize, operations });
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
