# SalonSniper - Solana Token Sniper Bot

Автоматический снайпер-бот для торговли новыми токенами на Solana с использованием Helius API.

## Архитектура

Проект состоит из 5 основных шагов разработки:

### Шаг 1 ✅ - Репозиторий и структура
- [x] Создание файловой структуры
- [x] Настройка конфигурации
- [x] Базовая документация

### Шаг 2 🔄 - Helius Listener
- [ ] WebSocket подключение к Helius
- [ ] Подписка на SPL Token Program
- [ ] Дедупликация и батчинг
- [ ] REST fallback
- [ ] Логирование событий

### Шаг 3 🔄 - Pipeline фильтров
- [ ] 3.1 Dedup + allow/deny
- [ ] 3.2 Fast on-chain sanity
- [ ] 3.3 Renounced check
- [ ] 3.4 Mutable metadata
- [ ] 3.5 LocalRouteGate (Pool existence + PI)
- [ ] 3.6 LP Protection
- [ ] 3.7 Pool Size
- [ ] 3.8 On-chain heavy (holders)
- [ ] 3.9 Quality (DexScreener)

### Шаг 4 🔄 - Trade Executor
- [ ] Internal wallet support
- [ ] Phantom wallet support
- [ ] Position sizing
- [ ] Risk controls
- [ ] Exit strategies

### Шаг 5 🔄 - Контроль и мониторинг
- [ ] Сессии и логирование
- [ ] Метрики и алерты
- [ ] Persistence & recovery
- [ ] Тесты и CI

## Структура проекта

```
/SalonSniper
  /src
    /listeners
      heliusListener.js     # WebSocket подключение к Helius
    /pipeline
      orchestrator.js       # Координация фильтров
    /filters
      01_dedup.js          # Дедупликация
      02_sanity.js         # Базовые проверки
      03_renounced.js      # Проверка renounced
      04_mutable.js        # Проверка metadata
      05_localRouteGate.js # Локальный расчет PI
      06_lpProtection.js   # Защита LP
      07_poolSize.js       # Размер пула
      08_onchainHeavy.js   # Тяжелые on-chain проверки
      09_quality.js        # Качество через DexScreener
    /executor
      tradeExecutor.js     # Исполнение сделок
    /utils
      logging.js           # Логирование
    /storage
      checkpoint.js        # Сохранение состояния
  /config
    example.env           # Пример конфигурации
  /logs                   # Логи сессий
  /docs
    ARCHITECTURE.md       # Архитектура
    RUNBOOK.md           # Руководство по запуску
  /tests                  # Тесты
```

## Установка и запуск

1. Скопируйте `config/example.env` в `.env` и заполните ваши API ключи
2. Установите зависимости: `npm install`
3. Запустите бота: `npm start`

## Acceptance критерии

### Шаг 1
- [x] Repo содержит структуру и markdown-описания модулей
- [x] README описывает шаги 1..5
- [x] PR открыт и ждёт одобрения

### Шаг 2
- [ ] WS подключение стабильно 10+ минут
- [ ] Логи events.log растут
- [ ] Median latency WS→batch ≤ 300ms
- [ ] REST fallback ≤ 5% от общего входа
- [ ] Дедуп отфильтровывает повторные mints (30s)

### Шаг 3
- [ ] ≥ 95% отсеиваются до heavy checks
- [ ] Heavy checks на ≤ 5-10% кандидатов
- [ ] Median latency per mint ≤ 900ms
- [ ] Логи filters_summary.csv

### Шаг 4
- [ ] 10 тестовых сделок → 95% успешных симуляций
- [ ] Максимум 3 одновременных позиции
- [ ] Логи trades.csv и PnL

### Шаг 5
- [ ] Симуляция crash & restart
- [ ] Потеря ≤ 1 мин событий
- [ ] Процесс восстанавливается

## Безопасность

- Никогда не коммитить API ключи
- Использовать переменные окружения
- Мониторинг rate limits
- IP whitelisting для Helius

## Поддержка

Создано для пользователя @artv1t
Link to Devin run: https://app.devin.ai/sessions/ec8fa1b9347749169e62ab1cda030179
