/**
 * واجهة المزودين الموحدة — كل خطأ يُرمى كـ ProviderError ليُصنَّف في classify.ts.
 * المزودان: kie.ai (أساسي) و CometAPI (ثانوي).
 */
import type { KeyRow } from "@/lib/turso";

export interface ProviderKey {
  id: string;
  provider: string;
  api_key: string;
  label: string;
}

export function toProviderKey(row: KeyRow): ProviderKey {
  return { id: row.id, provider: row.provider, api_key: row.api_key, label: row.label };
}

/** خطأ مزود بحالة (قد تكون undefined لأخطاء الشبكة/الانقطاع) ورسالة للتصنيف */
export class ProviderError extends Error {
  constructor(public status: number | undefined, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد معرّف المهمة لدى المزود */
  createTask(key: ProviderKey, model: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(key: ProviderKey, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: ProviderKey, providerTaskId: string): Promise<ProviderCheckResult>;
}

/** استخراج رسالة خطأ مقروءة من جسم استجابة المزود مهما كان شكله (msg/error/message/code) */
export function extractErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    return (
      j.msg ??
      j.error?.message ??
      j.error?.code ??
      (typeof j.error === "string" ? j.error : undefined) ??
      j.message ??
      j.detail ??
      text.slice(0, 300)
    );
  } catch {
    return text.slice(0, 300);
  }
}

/** تغليف fetch بأخطاء موحدة: الشبكة/الانقطاع/المهلة تصبح ProviderError بلا حالة (مؤقتة) */
export async function providerFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ProviderError(undefined, `network: ${msg}`);
  }
}
