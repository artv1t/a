# SalonSniper Runbook

## Быстрый старт

### 1. Установка

```bash
# Клонирование репозитория
git clone https://github.com/artv1t/a.git
cd a

# Установка зависимостей
npm install

# Настройка конфигурации
cp config/example.env .env
# Отредактируйте .env файл с вашими API ключами
```

### 2. Конфигурация

Обязательные переменные в `.env`:

```bash
# Helius API ключ
HELIUS_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
HELIUS_WS=wss://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Приватный ключ кошелька (для internal mode)
PRIVATE_KEY=your_base58_private_key

# Telegram для алертов (опционально)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 3. Запуск

```bash
# Продакшн
npm start

# Разработка с автоперезагрузкой
npm run dev

# Тесты
npm test
```

## Мониторинг

### Логи

Структура логов в `logs/session_YYYYMMDD_HHMMSS/`:

```
events.log          # Входящие события от Helius
filters.csv         # Результаты фильтрации
trades.csv          # Исполненные сделки
metrics.json        # Метрики производительности
errors.log          # Ошибки системы
health.log          # Состояние подключений
```

### Ключевые метрики

```bash
# Просмотр последних событий
tail -f logs/session_*/events.log

# Анализ фильтрации
tail -f logs/session_*/filters.csv

# Мониторинг сделок
tail -f logs/session_*/trades.csv

# Проверка ошибок
tail -f logs/session_*/errors.log
```

### Дашборд метрик

Метрики сохраняются в `metrics.json` каждые 60 секунд:

```json
{
  "timestamp": "2024-01-01T12:00:00Z",
  "total_incoming": 15420,
  "dedup_filtered": 3240,
  "passed_filters": 156,
  "enqueued": 89,
  "executed": 12,
  "failed_trades": 2,
  "ws_reconnects": 1,
  "rest_fallback_rate": 0.03,
  "latency_p50": 245,
  "latency_p95": 780
}
```

## Операционные процедуры

### Запуск в продакшне

```bash
# Создание screen сессии
screen -S salonsniper

# Запуск бота
npm start

# Отключение от screen (Ctrl+A, D)
# Подключение обратно: screen -r salonsniper
```

### Graceful shutdown

```bash
# Отправка SIGTERM для корректного завершения
kill -TERM $(pgrep -f "node src/index.js")

# Бот сохранит checkpoint и завершится
```

### Восстановление после сбоя

Бот автоматически восстанавливается из последнего checkpoint:

```bash
# Проверка последнего checkpoint
ls -la logs/session_*/checkpoint.json

# Запуск - автоматически загрузит последнее состояние
npm start
```

## Troubleshooting

### Проблемы с подключением

**WebSocket отключается часто**:
```bash
# Проверить логи подключения
grep "reconnect" logs/session_*/health.log

# Увеличить таймауты в .env
WS_RECONNECT_MAX_DELAY_S=120
```

**Высокий REST fallback rate**:
```bash
# Проверить rate limiting
grep "rate limit" logs/session_*/errors.log

# Снизить лимит в .env
REST_FALLBACK_LIMIT_PER_SEC=3
```

### Проблемы с производительностью

**Высокая latency фильтров**:
```bash
# Анализ времени выполнения фильтров
grep "filter_timing" logs/session_*/filters.csv

# Увеличить дедлайн в .env
GLOBAL_FILTER_DEADLINE_MS=1200
```

**Переполнение backlog**:
```bash
# Проверить размер очереди
grep "backlog" logs/session_*/health.log

# Увеличить лимит или снизить нагрузку
MAX_BACKLOG_EVENTS=15000
```

### Проблемы с торговлей

**Неудачные симуляции**:
```bash
# Анализ причин неудач
grep "simulation_failed" logs/session_*/trades.csv

# Возможные причины:
# - Высокий slippage
# - Недостаточная ликвидность
# - Изменение цены
```

**Timeout исполнения**:
```bash
# Увеличить таймаут в .env
EXECUTION_TIMEOUT_MS=20000

# Проверить состояние RPC
curl -X POST $HELIUS_RPC -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

## Алерты и уведомления

### Настройка Telegram

1. Создайте бота через @BotFather
2. Получите токен и chat_id
3. Добавьте в `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789
```

### Типы алертов

- **Critical**: WS disconnected > 10s
- **Warning**: High REST fallback rate
- **Info**: Trade execution results

## Безопасность

### Защита приватных ключей

```bash
# Никогда не коммитить .env
echo ".env" >> .gitignore

# Использовать права доступа 600
chmod 600 .env

# Регулярно ротировать ключи
```

### Мониторинг безопасности

```bash
# Проверка подозрительных транзакций
grep "suspicious" logs/session_*/trades.csv

# Мониторинг баланса кошелька
# (добавить в cron)
```

## Обновления и деплой

### Обновление кода

```bash
# Остановка бота
kill -TERM $(pgrep -f "node src/index.js")

# Обновление
git pull origin main
npm install

# Запуск
npm start
```

### Откат версии

```bash
# Просмотр коммитов
git log --oneline -10

# Откат к предыдущей версии
git checkout <commit_hash>
npm install
npm start
```

## Производительность

### Оптимизация

**Для высокой нагрузки**:
```bash
# Увеличить worker pool
WORKER_POOL_SIZE=16

# Увеличить batch window
BATCH_WINDOW_MS=500

# Снизить TTL дедупа
DEDUP_TTL_S=20
```

**Для низкой latency**:
```bash
# Уменьшить batch window
BATCH_WINDOW_MS=100

# Увеличить worker pool
WORKER_POOL_SIZE=12

# Снизить дедлайн фильтров
GLOBAL_FILTER_DEADLINE_MS=600
```

## Контакты

- Разработчик: @artv1t
- Devin Session: https://app.devin.ai/sessions/ec8fa1b9347749169e62ab1cda030179
