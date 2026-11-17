/**
 * /api/keys/{id} — تعطيل/تنشيط يدوي (PATCH) وحذف (DELETE).
 * المفتاح الكامل لا يُعاد أبدًا؛ الرد يعرض المفتاح مُقنَّعًا فقط.
 */
import { NextResponse } from "next/server";
import { deleteKey, getKey, updateKey } from "@/lib/turso";
import { maskKey } from "@/lib/mask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicKey(row: Awaited<ReturnType<typeof getKey>>) {
  if (!row) return null;
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

/** PATCH {status: "active" | "disabled"} — تنشيط يدوي يعيد المفتاح للخدمة حتى لو كان مستنزفًا (بعد الشحن) */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { status?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }
  const status = (body.status ?? "").trim();
  if (status !== "active" && status !== "disabled") {
    return NextResponse.json({ error: "الحالة المسموحة يدويًا هي active أو disabled فقط" }, { status: 400 });
  }
  const existing = await getKey(id);
  if (!existing) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await updateKey(id, { status, last_error: status === "active" ? null : existing.last_error });
  return NextResponse.json({ ok: true, key: publicKey(await getKey(id)) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const removed = await deleteKey(id);
  if (!removed) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
