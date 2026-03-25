from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

# ── BURAYA YAZI ──
BOT_TOKEN  = "8751483749:AAEUWNdeXaBGg8aZJX2fnXzQcuZRkKOyl2Y"   # @BotFather'dan aldığın token
WEBAPP_URL = "https://spin.ikinciel.az/game_36.php"  # sitənin adresi

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    args = context.args  # /start ref_123 → args = ["ref_123"]
    ref  = args[0] if args else ""

    # Mini App URL-ə ref parametrini əlavə et
    url = WEBAPP_URL
    if ref:
        url += ("&" if "?" in url else "?") + "ref=" + ref

    keyboard = [[
        InlineKeyboardButton(
            "🍾 Oyunu Aç",
            web_app=WebAppInfo(url=url)
        )
    ]]

    await update.message.reply_text(
        "🍾 *Spin The Bottle*\n\nOyuna xoş gəldiniz! Aşağıdakı düyməyə basaraq oyunu açın.",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown"
    )

if __name__ == "__main__":
    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    print("Bot işləyir...")
    app.run_polling()