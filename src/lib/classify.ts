/**
 * تصنيف أخطاء المزودين — القلب الذي يقود سياسة التبديل التسلسلي (قسم 4.2 من المواصفة).
 *
 * الفئات:
 *  disabled  → مفتاح مرفوض (401/403 أو رسالة توثيق) → علّم المفتاح disabled → انتقل للتالي
 *  exhausted → نفاد رصيد (402 أو رسائل الرصيد) → علّم exhausted (يبقى في القاعدة) → انتقل للتالي
 *  provider  → الموديل غير مدعوم لدى هذا المزود → انتقل للتالي
 *  params    → معطيات الطلب خاطئة → توقف فورًا (تبديل المفاتيح لن يحلها)
 *  temporary → 429/5xx/شبكة/انقطاع → انتقل للتالي الآن والمفتاح يبقى سليمًا
 *
 * ملاحظة مقاسة فعليًا: بعض المزودين (ومنهم kie.ai) يرسلون نفاد الرصيد بحالة HTTP 200/400
 * مع كود/رسالة داخلية — لذلك نفحص أنماط الرصيد «قبل» فحص 400.
 */

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// أنماط رسائل نفاد الرصيد (بما فيها الأنماط الصينية الشائعة لدى المزودين)
const EXHAUSTED_RE =
  /insufficient|quota|balance|credit|out of credits|exhausted|充值|余额不足|\b402\b/i;
// أنماط رسائل رفض المفتاح
const DISABLED_RE =
  /invalid api key|unauthorized|forbidden|authentication|invalid key|api key|apikey|\b401\b|\b403\b/i;
// أنماط موديل غير مدعوم
const PROVIDER_RE = /model not found|unsupported model|unknown model|not a valid model/i;

export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const m = (message || "").toLowerCase();

  // 1) نفاد الرصيد أولًا — قبل فحص 400 لأن بعض المزودين يرسلونه بحالة 400 أو داخل جسم بحالة 200
  if (status === 402 || EXHAUSTED_RE.test(m)) return "exhausted";

  // 2) مفتاح مرفوض
  if (status === 401 || status === 403 || DISABLED_RE.test(m)) return "disabled";

  // 3) موديل غير مدعوم لدى المزود (بأكواد الطلب الخاطئ)
  if (PROVIDER_RE.test(m) && (status === 400 || status === 404 || status === 422 || status === undefined)) {
    return "provider";
  }

  // 4) معطيات خاطئة — توقف فوري
  if (status === 400 || status === 422) return "params";

  // 5) مؤقت: 429، 5xx، أو خطأ شبكة بلا حالة
  if (status === 429 || (status !== undefined && status >= 500) || status === undefined) {
    return "temporary";
  }

  // أي شيء آخر غريب نعامله كمؤقت (نتابع ولا نكسر المهمة)
  return "temporary";
}
