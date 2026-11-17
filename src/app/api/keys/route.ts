/**
 * /api/keys — إدارة المفاتيح للواجهة.
 * GET: القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey) — لا يُعاد المفتاح الكامل في أي استجابة.
 * POST: {provider, api_key, label?} مع رفض التكرار لنفس المزود.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getAllKeys, insertKey, findDuplicateKey, ensureSchema } from "@/lib/turso";
import { maskKey } from "@/lib/mask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = ["kie", "cometapi"];

/** شكل المفتاح المُقنَّع المعروض للواجهة — المفتاح الكامل لا يخرج من قاعدة البيانات أبدًا */
function toPublicKey(row: {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    maskedKey: maskKey(row.api_key),
    status: row.status,
    usageCount: row.usage_count,
    successCount: row.success_count,
    failCount: row.fail_count,
    lastUsedAt: row.last_used_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export async function GET() {
  await ensureSchema();
  const keys = await getAllKeys();
  return NextResponse.json({ keys: keys.map(toPublicKey) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  await ensureSchema();
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح: JSON مطلوب" }, { status: 400 });
  }

  const provider = (body.provider ?? "").trim();
  const apiKey = (body.api_key ?? "").trim();
  const label = (body.label ?? "").trim().slice(0, 80);

  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "المزود غير صالح: القيم المسموحة هي kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 8) {
    return NextResponse.json({ error: "المفتاح قصير أو فارغ: أدخل مفتاح API صحيحًا" }, { status: 400 });
  }

  // رفض التكرار لنفس المزود — والمفتاح الكامل لا يظهر في رسالة الخطأ أبدًا
  const dup = await findDuplicateKey(provider, apiKey);
  if (dup) {
    return NextResponse.json(
      { error: `هذا المفتاح مسجّل مسبقًا لنفس المزود (${maskKey(apiKey)})` },
      { status: 409 }
    );
  }

  const id = randomUUID();
  await insertKey({ id, provider, label, api_key: apiKey });
  const keys = await getAllKeys();
  const added = keys.find((k) => k.id === id);
  return NextResponse.json({ ok: true, key: added ? toPublicKey(added) : null }, { status: 201 });
}
