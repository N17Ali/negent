<div dir="rtl">

# Negent

>  [English version](./README.md)

یه بات تلگرام که اخبار تکنولوژی رو از فیدهای RSS جمع می‌کنه، با **Google Gemini** مهم‌ترین خبرها رو انتخاب می‌کنه، اون‌ها رو خلاصه و به **فارسی** ترجمه می‌کنه، و به همراه یه **نسخهٔ صوتی فارسی** (اختیاری) طبق زمان‌بندی برای مشترک‌ها می‌فرسته.

کل پروژه یه **Cloudflare Worker** با TypeScript‌ه که روی **D1** (همون SQLite) کار می‌کنه. **بدون هیچ dependency در زمان اجرا.**

## چطور کار می‌کنه

```
منابع RSS ──► کرون fetch ──► خبرهای خام (D1)
                                  │
                                  ▼
                        کرون select (ساعتی)
                                  │
          ┌───────────────────────┼────────────────────────┐
          ▼                       ▼                         ▼
     انتخاب با Gemini      خلاصه/ترجمه با Gemini        ارسال در تلگرام
     (بهترین خبرها،          به فارسی                   (+ نسخهٔ صوتی
      حذف تکراری‌ها)                                     فارسی، اختیاری)
```

دو تا کرون همه‌چیز رو می‌گردونن:

- **`fetch`** (هر ۱۰ دقیقه) — هر بار **یک** منبع RSS رو می‌کشه (به‌صورت چرخشی)، با کلمات کلیدی فیلتر می‌کنه، بر اساس hash آدرس تکراری‌ها رو حذف می‌کنه و خبرهای جدید رو به‌عنوان `raw` ذخیره می‌کنه.
- **`select`** (ساعتی، محدود به ساعات روز تهران) — جدیدترین عنوان‌های خام رو به Gemini می‌فرسته تا بهترین خبرها رو انتخاب کنه و تکراری‌های بین منابع رو حذف کنه. انتخاب‌ها خلاصه و به فارسی محاوره‌ای ترجمه می‌شن، برای مشترک‌های فعال ارسال می‌شن و در صورت فعال بودن، به‌صورت پیام صوتی فارسی هم خونده می‌شن.

### نسخهٔ صوتی

صدا با مدل صوتی **Live API** جمینای روی WebSocket تولید می‌شه که PCM خام برمی‌گردونه؛ این PCM بدون هیچ کتابخانه‌ای توی یه فایل WAV بسته‌بندی می‌شه و با `sendAudio` تلگرام فرستاده می‌شه. این قابلیت با `SEND_AUDIO` کنترل می‌شه و کاملاً best-effort‌ه — هر خطایی نادیده گرفته می‌شه تا جلوی ارسال متن گرفته نشه.

## ابزارها

- **محیط اجرا:** Cloudflare Workers (TypeScript)
- **ذخیره‌سازی:** Cloudflare D1 (SQLite) — تنها جای ذخیره‌سازی
- **هوش مصنوعی:** Google Gemini (انتخاب + خلاصه/ترجمه + صدا)
- **ارسال:** Telegram Bot API (مبتنی بر webhook)
- **Dependency:** هیچی در زمان اجرا (پارس RSS با regex بدون کتابخونه‌ست؛ ساخت WAV هم دستیه)

## شروع کار

### پیش‌نیازها

- Node.js و npm
- یه اکانت Cloudflare با Wrangler تنظیم‌شده
- توکن بات تلگرام (از [@BotFather](https://t.me/BotFather))
- کلید API جمینای

### راه‌اندازی

<div dir="ltr">

```bash
# نصب dependency های توسعه
npm install

# ساخت دیتابیس D1 و آپدیت database_id توی wrangler.toml
wrangler d1 create negent-db

# اعمال schema و seed کردن منابع RSS پیش‌فرض
npm run db:remote
npm run seed:remote

# ست کردن secret ها (توی ریپو ذخیره نمی‌شن)
wrangler secret put BOT_TOKEN
wrangler secret put GEMINI_API_KEY

# دیپلوی
npm run deploy
```

</div>

برای توسعهٔ محلی یه فایل `.dev.vars` بساز:

<div dir="ltr">

```
BOT_TOKEN=your-telegram-bot-token
GEMINI_API_KEY=your-gemini-api-key
```

</div>

بعدش webhook تلگرام رو طوری ثبت کن که به آدرس `/webhook/<BOT_TOKEN>` روی Worker دیپلوی‌شده‌ات اشاره کنه.

## دستورها

<div dir="ltr">

| Command | توضیح |
| --- | --- |
| `npm run dev` | اجرای محلی Worker روی `http://localhost:8787` |
| `npm test` | اجرای یک‌بارهٔ تست‌ها (Vitest) |
| `npm run test:watch` | اجرای تست‌ها در حالت watch |
| `npm run deploy` | دیپلوی Worker |
| `npm run tail` | لاگ زندهٔ Worker دیپلوی‌شده |
| `npm run db:local` / `db:remote` | اعمال `schema.sql` روی D1 |
| `npm run seed:local` / `seed:remote` | seed کردن منابع RSS پیش‌فرض |
| `npx tsc --noEmit` | تایپ‌چک (اسکریپت lint نداریم؛ TypeScript روی `strict`) |

</div>

### تست محلی کرون

`wrangler dev` هندلر زمان‌بندی‌شده رو روی HTTP در دسترس می‌ذاره (فاصله‌ها رو با `+` انکد کن):

<div dir="ltr">

```bash
curl 'http://localhost:8787/__scheduled?cron=*/10+*+*+*+*'
```

</div>

## دستورهای بات

<div dir="ltr">

| Command | چه کسی | توضیح |
| --- | --- | --- |
| `/start` | همه | عضویت (اولین کاربر تاریخ، ادمین می‌شه) |
| `/stop` | همه | لغو عضویت |
| `/sources` | همه | لیست فیدهای RSS |
| `/status` | ادمین | آمار خط لوله |

</div>

منابع فقط از طریق `seed.sql` مدیریت می‌شن — دستوری برای اضافه/حذف کردن توی بات نیست.

## ساختار پروژه

<div dir="ltr">

```
src/
├── index.ts            # ورودی Worker: fetch (webhook/health) + scheduled (cron dispatch)
├── cron/
│   ├── fetch.ts        # کشیدن یک منبع RSS، فیلتر، حذف تکراری، ذخیرهٔ خام
│   ├── select.ts       # انتخاب → خلاصه → تولید مقاله‌های `done`
│   └── deliver.ts      # ارسال یک مقاله `done` (متن + پاسخ صوتی)
├── services/
│   ├── rss.ts          # پارسر RSS/Atom بدون dependency
│   ├── selector.ts     # انتخاب خبر با Gemini
│   ├── summarize.ts    # خلاصه/ترجمه به فارسی با Gemini
│   ├── tts.ts          # صدای Gemini Live API (WebSocket)
│   ├── telegram.ts     # کلاینت Telegram Bot API + فرمت پیام
│   └── geminiClient.ts # ابزارهای مشترک Gemini HTTP/retry/fallback/JSON
├── bot/commands.ts     # هندلر دستورهای بات
├── utils/
│   ├── constants.ts    # همهٔ تنظیمات (اندازهٔ batch، ساعت‌ها، کلمات کلیدی، مدل‌ها)
│   ├── filter.ts       # فیلتر کلمات کلیدی
│   ├── audio.ts        # تبدیل PCM به WAV
│   ├── time.ts         # گیت تحویل ساعات تهران
│   └── cronRegistry.ts # رجیستری عبارت کرون → هندلر
├── db.ts               # کوئری‌های D1
└── types.ts            # bindings محیط + تایپ‌های دامنه
```

</div>

## نکته‌ها

- همهٔ متن‌های کاربرپسند به **فارسی محاوره‌ای** هستن ("تو" نه "شما")، با نگه‌داشتن اصطلاحات فنی به انگلیسی.
- ارسال، آگاه از منطقهٔ زمانیه: کرون‌ها با UTC اجرا می‌شن ولی ارسال محدود به ساعات روز تهران (UTC+3:30) است.
- تنظیمات توی `src/utils/constants.ts` قرار دارن.
- برای راهنمای معماری عمیق‌تر و نکته‌های ریز، `AGENTS.md` رو ببین.

## لایسنس

پروژهٔ خصوصی.

</div>
