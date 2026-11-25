const generic = 'عملیات انجام نشد. اتصال، نشست یا مسیر خروجی را بررسی کنید.';
export function message(error) {
  if (error.code === 'MK_AUTH_PASSWORD_REJECTED') return 'مکتب‌خونه ورود خودکار با رمز ذخیره‌شده در ‎.env‎ را نپذیرفت.';
  if (error.code === 'MK_AUTH_INTERACTIVE_REQUIRED') return 'مکتب‌خونه ورود بدون تأیید را برای این درخواست ارائه نکرد.';
  if (error.status === 401 || /session|MK_EMAIL|MK_PASSWORD/i.test(error.message)) return 'نشست معتبر نیست. تنظیمات ورود را بررسی کنید.';
  if (error.status === 429) return 'مکتب‌خونه تعداد درخواست‌ها را محدود کرده است. کمی بعد دوباره تلاش کنید.';
  if (/in use/i.test(error.message)) return 'این دوره در حال دانلود است یا قفل یک اجرای قبلی باقی مانده است.';
  if (error.code === 'ENOSPC') return 'فضای کافی برای ذخیرهٔ فایل وجود ندارد (ENOSPC).';
  if (['EACCES','EPERM','EBUSY'].includes(error.code)) return `دسترسی به فایل یا پوشه ممکن نیست یا فایل در حال استفاده است (${error.code}). دسترسی و برنامه‌های دیگر را بررسی کنید.`;
  return generic;
}
