/**
 * تقنيع المفاتيح وتنقية الأخطاء — إخفاء المفاتيح إلزامي في كل الاستجابات والسجلات (قاعدة ذهبية 9).
 * المفتاح الكامل لا يُعاد في أي استجابة API أو رسالة أداة أو سجل console.
 */

/** أول 7 أحرف + •••••••• + آخر 4 — وللمفاتيح القصيرة أول 3 + •••• */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length >= 16) {
    return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  }
  return `${key.slice(0, 3)}••••`;
}

/**
 * تُمرَّر على نصوص الأخطاء قبل تخزينها أو عرضها: تحذف أي مفتاح كامل قد يتسرب
 * من رسالة مزود (دفاعيًا) — نمرر قائمة المفاتيح المعروفة في السياق إن توفرت.
 */
export function scrubSecrets(text: string, knownKeys: string[] = []): string {
  let out = text ?? "";
  for (const k of knownKeys) {
    if (k && k.length >= 6) out = out.split(k).join("***");
  }
  return out;
}
