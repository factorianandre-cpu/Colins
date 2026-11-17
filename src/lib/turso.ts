/**
 * طبقة Turso — عميل واحد عبر HTTP (إلزامي للتوافق مع Vercel serverless: لا ملفات SQLite محلية).
 * الجداول تُنشأ عند أول وصول عبر ensureSchema (CREATE TABLE IF NOT EXISTS) فلا حاجة لأداة migrations.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;
// وعد واحد لإنشاء المخطط لكل نسخة process (كل وظيفة serverless تنشئه مرة عند أول طلب)
let _schemaPromise: Promise<void> | null = null;

export function getTurso(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    // لا نطبع أي قيم سرية هنا مطلقًا
    if (!url || !token) {
      throw new Error(
        "بيانات Turso غير مضبوطة: TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان في متغيرات البيئة"
      );
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

export async function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const db = getTurso();
      await db.execute(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
    })().catch((e) => {
      // عند الفشل نصف الوعد ليُعاد المحاولة في الطلب التالي
      _schemaPromise = null;
      throw e;
    });
  }
  return _schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/* ============================ المهام ============================ */

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string; // image | video | merge
  prompt: string;
  params_json: string;
  status: string; // pending | processing | completed | failed
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Attempt {
  provider: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

const TASK_COLS = `id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, error_message, attempts_json, created_at, updated_at, completed_at`;

function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: r.id as string,
    provider: (r.provider as string) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: r.model as string,
    type: r.type as string,
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: String(r.status),
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    completed_at: (r.completed_at as string) ?? null,
  };
}

export function parseTaskUrls(task: Pick<TaskRow, "result_urls_json">): string[] {
  if (!task.result_urls_json) return [];
  try {
    const arr = JSON.parse(task.result_urls_json);
    return Array.isArray(arr) ? arr.filter((u) => typeof u === "string" && u.length > 0) : [];
  } catch {
    return [];
  }
}

export function parseTaskAttempts(task: Pick<TaskRow, "attempts_json">): Attempt[] {
  try {
    const arr = JSON.parse(task.attempts_json || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export interface InsertTaskInput {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status?: string;
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
}

export async function insertTask(t: InsertTaskInput): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, error_message, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status ?? "pending",
      t.progress ?? 0,
      t.result_urls_json ?? null,
      t.error_message ?? null,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: `SELECT ${TASK_COLS} FROM tasks WHERE id = ?`,
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return mapTask(r.rows[0] as unknown as Record<string, unknown>);
}

/**
 * تحديث جزئي لمهمة. يضيف المحاولات إلى attempts_json دائمًا، ويسجّل completed_at
 * تلقائيًا عند الوصول لحالة completed، ويحدّث updated_at في كل كتابة (يُستخدم للتهدئة 45 ثانية).
 */
export async function updateTask(
  id: string,
  patch: Partial<Pick<InsertTaskInput, "provider" | "provider_task_id" | "key_id" | "status" | "progress" | "result_urls_json" | "error_message" | "params_json">>,
  newAttempts: Attempt[] = []
): Promise<TaskRow | null> {
  await ensureSchema();
  const current = await getTask(id);
  if (!current) return null;

  // سجل المحاولات: نحافظ على آخر 50 محاولة لتفادي نمو الصف بلا حدود
  const attempts = [...parseTaskAttempts(current), ...newAttempts].slice(-50);

  const sets: string[] = [];
  const args: InValue[] = [];
  const col: Record<string, string> = {
    provider: "provider",
    provider_task_id: "provider_task_id",
    key_id: "key_id",
    status: "status",
    progress: "progress",
    result_urls_json: "result_urls_json",
    error_message: "error_message",
    params_json: "params_json",
  };
  for (const [k, c] of Object.entries(col)) {
    if (k in patch) {
      sets.push(`${c} = ?`);
      args.push((patch as Record<string, unknown>)[k] as InValue ?? null);
    }
  }
  sets.push("attempts_json = ?");
  args.push(JSON.stringify(attempts));
  sets.push("updated_at = datetime('now')");
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
  }

  await getTurso().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args: [...args, id],
  });
  return getTask(id);
}

export async function listRecentTasks(
  limit: number,
  filter: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const sql = `SELECT ${TASK_COLS} FROM tasks
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(limit);
  const r = await getTurso().execute({ sql, args });
  return r.rows.map((row) => mapTask(row as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const r = await getTurso().execute(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'processing' OR status = 'pending' THEN 1 ELSE 0 END) AS processing
    FROM tasks`);
  const row = r.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

/* ============================ المفاتيح ============================ */

export interface KeyRow {
  id: string;
  provider: string; // kie | cometapi
  label: string;
  api_key: string; // لا يخرج من هذه الطبقة أبدًا دون تقنيع
  status: string; // active | exhausted | disabled
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

function mapKey(r: Record<string, unknown>): KeyRow {
  return {
    id: r.id as string,
    provider: r.provider as string,
    label: (r.label as string) ?? "",
    api_key: r.api_key as string,
    status: String(r.status),
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: r.created_at as string,
  };
}

/**
 * تجلب كل المفاتيح غير المعطّلة للمزودات المطلوبة بالترتيب التسلسلي الصارم:
 * أول مفتاح أُضيف يُجرَّب أولًا (created_at ASC, id ASC) — ليست round-robin وليست «الأقل استخدامًا».
 * المفتاح المستنزف (exhausted) يبقى في القائمة عمدًا: يُجرَّب في دوره وإن فشل يُعلَّم ثم ننتقل للتالي.
 * الاستثناء الوحيد هو disabled (تعطيل يدوي من الواجهة).
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows.map((row) => mapKey(row as unknown as Record<string, unknown>));
}

export async function getAllKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return r.rows.map((row) => mapKey(row as unknown as Record<string, unknown>));
}

export interface InsertKeyInput {
  id: string;
  provider: string;
  label?: string;
  api_key: string;
}

export async function insertKey(k: InsertKeyInput): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label ?? "", k.api_key],
  });
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<KeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [provider, apiKey],
  });
  return r.rows.length ? mapKey(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function getKey(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return r.rows.length ? mapKey(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export interface KeyPatch {
  status?: string;
  last_error?: string | null;
  last_used_at?: string;
  last_checked_at?: string;
}

export async function updateKey(id: string, patch: KeyPatch): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  const col: Record<string, string> = {
    status: "status",
    last_error: "last_error",
    last_used_at: "last_used_at",
    last_checked_at: "last_checked_at",
  };
  for (const [k, c] of Object.entries(col)) {
    if (k in patch) {
      sets.push(`${c} = ?`);
      args.push((patch as Record<string, unknown>)[k] as InValue ?? null);
    }
  }
  if (!sets.length) return;
  await getTurso().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args: [...args, id] });
}

/** تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — تُستدعى دائمًا من منسّق التوليد. */
export async function bumpKeyCounters(id: string, ok: boolean, error?: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_error = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, ok ? null : (error ?? null), id],
  });
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return r.rowsAffected > 0;
}

/** حذف كل المهام — يُستخدم في التنظيف بعد الاختبار فقط */
export async function deleteAllTasks(): Promise<number> {
  await ensureSchema();
  const r = await getTurso().execute("DELETE FROM tasks");
  return r.rowsAffected;
}
