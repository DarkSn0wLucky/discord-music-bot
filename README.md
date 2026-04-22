# Discord Music Bot (Blue Minimal)

Музыкальный Discord-бот с slash-командами, голубым минималистичным интерфейсом и кнопками управления.

Поддержка:
- YouTube (ссылки + текстовый поиск)
- SoundCloud (ссылки)
- Playback control via panel buttons
- Интерактивная панель кнопок под плеером
- Оповещения в текстовом канале о ключевых действиях

## 1. Установка

```bash
npm install
```

## 2. Переменные окружения

Скопируй `.env.example` в `.env` и заполни:

```env
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
YOUTUBE_API_KEY=...
YOUTUBE_COOKIE=
YTDLP_COOKIES_PATH=cookies.txt
SOUNDCLOUD_CLIENT_ID=
EMBED_COLOR_HEX=#4da3ff
MAX_QUEUE_SIZE=150
MAX_PLAYLIST_ITEMS=50
AUTO_DISCONNECT_MS=180000
DEFAULT_VOLUME=0.75
```

Что важно:
- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` обязательны.
- `DISCORD_GUILD_ID` рекомендуется для быстрого обновления slash-команд (моментально в одном сервере).
- `YOUTUBE_API_KEY` не обязателен, но улучшает текстовый поиск.
- `YOUTUBE_COOKIE` опционален (может помочь при ограничениях YouTube).
- `YTDLP_COOKIES_PATH` путь к cookies-файлу для `yt-dlp` (по умолчанию `cookies.txt` в корне проекта).
- `SOUNDCLOUD_CLIENT_ID` опционален (если пусто, бот попробует взять free client id автоматически).
- Файл `cookies.txt` не хранится в git и должен лежать на сервере отдельно.

## 3. Права и Intents для бота

В Discord Developer Portal:
- Включи `SERVER MEMBERS INTENT` не обязательно для текущего набора, но можно оставить выключенным.
- Убедись, что у бота есть права:
  - `View Channels`
  - `Send Messages`
  - `Embed Links`
  - `Connect`
  - `Speak`
  - `Use Voice Activity`
  - `Read Message History`

## 4. Деплой slash-команд

```bash
npm run deploy:commands
```

Если указан `DISCORD_GUILD_ID`, команды появятся почти сразу.

## 5. Запуск

```bash
npm start
```

## Кнопки панели

- `Пауза/Продолжить`
- `Скип`
- `Стоп`
- `Шафл`
- `Цикл: Выкл/Трек/Очередь`

## Структура проекта

```text
src/
  commands/
  music/
  ui/
  utils/
scripts/
```
