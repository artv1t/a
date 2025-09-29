# SalonSniper Architecture

## Общий обзор

SalonSniper - это высокопроизводительный снайпер-бот для Solana, который использует Helius API для мониторинга новых токенов и автоматического выполнения сделок.

## Компоненты системы

### 1. Helius Listener (`src/listeners/heliusListener.js`)

**Назначение**: Получение потока новых mint адресов через WebSocket

**Ключевые функции**:
- WebSocket подключение к Helius с автоматическим переподключением
- Подписка на `logsSubscribe` с фильтром по SPL Token Program
- Извлечение mint адресов из `postTokenBalances`
- Дедупликация с TTL кешем (30 секунд)
- Батчинг событий (300ms окно)
- REST fallback для parsed транзакций

**Производительность**:
- Latency: WS→batch ≤ 300ms
- REST fallback: ≤ 5 req/s
- Дедуп эффективность: 30s TTL

### 2. Pipeline Orchestrator (`src/pipeline/orchestrator.js`)

**Назначение**: Координация выполнения фильтров

**Логика**:
- Получает пачки mint адресов от Listener
- Запускает фильтры параллельно с глобальным дедлайном 900ms
- Агрегирует результаты и принимает решения
- Отправляет кандидатов в Trade Executor

### 3. Фильтры (`src/filters/`)

Фильтры выполняются в порядке от лёгких к тяжёлым:

#### 3.1 Dedup (`01_dedup.js`)
- TTL дедупликация (30s)
- Allow/deny списки
- **Время**: ~1ms

#### 3.2 Fast Sanity (`02_sanity.js`)
- `getMultipleAccounts` для базовой информации
- Проверка decimals, supply, mintAuthority
- **Время**: ≤ 200ms

#### 3.3 Renounced (`03_renounced.js`)
- Проверка mintAuthority == null
- Проверка freezeAuthority == null
- **Время**: ≤ 50ms

#### 3.4 Mutable (`04_mutable.js`)
- Чтение Metaplex metadata
- Проверка isMutable и updateAuthority
- **Время**: ≤ 100ms

#### 3.5 LocalRouteGate (`05_localRouteGate.js`)
- Поиск direct pools (SOL/USDC)
- Локальный расчёт Price Impact через XYK
- Динамические пороги PI по ликвидности
- **Время**: ≤ 300ms

#### 3.6 LP Protection (`06_lpProtection.js`)
- Анализ LP mint supply
- Проверка burn vs fake burn
- Whitelist lock контрактов
- **Время**: ≤ 700ms

#### 3.7 Pool Size (`07_poolSize.js`)
- Динамические пороги по возрасту токена
- Подсчёт количества LP провайдеров
- **Время**: ≤ 200ms

#### 3.8 OnChain Heavy (`08_onchainHeavy.js`)
- `getTokenLargestAccounts` для анализа холдеров
- Проверка Token-2022 features
- **Время**: ≤ 500ms

#### 3.9 Quality (`09_quality.js`)
- DexScreener API для volume24h, liquidityUSD
- Non-blocking для новых токенов
- **Время**: async, не блокирует pipeline

### 4. Trade Executor (`src/executor/tradeExecutor.js`)

**Режимы работы**:
- **Internal Wallet**: Автоматическое подписание и отправка
- **Phantom Wallet**: Генерация транзакций для ручного подписания

**Risk Controls**:
- Максимум 3 одновременных позиции
- Position sizing с учётом ликвидности
- Timeout на исполнение (15 секунд)
- Retry policy (2 попытки)

**Exit Strategies**:
- Take Profit: +30% (configurable)
- Stop Loss: -20% (configurable)
- Time-based exit: 6 минут (configurable)

### 5. Utilities (`src/utils/`)

#### Logging (`logging.js`)
- Структурированное логирование (JSON + text)
- Сессионные папки: `logs/session_YYYYMMDD_HHMMSS/`
- Ротация логов

#### Storage (`src/storage/checkpoint.js`)
- Периодические чекпоинты (каждые 5 секунд)
- Сохранение состояния: lastProcessedSig, seenMints, candidateQueue
- Recovery при перезапуске

## Потоки данных

```
Helius WS → Listener → Orchestrator → Filters → Executor → Logs
     ↓         ↓           ↓           ↓         ↓
   Events   Batches   Candidates   Trades   Results
```

## Производительность

### Целевые метрики
- **Throughput**: 10k+ incoming events/min
- **Filter efficiency**: ≥95% отсеиваются до heavy checks
- **Latency**: Median per mint ≤ 900ms
- **Success rate**: ≥95% successful simulations

### Bottlenecks и оптимизации
- **Batching**: Снижает количество RPC вызовов
- **Caching**: LRU кеши для metadata и pool info
- **Parallel processing**: Worker pools для фильтров
- **Backpressure**: Drop events при перегрузке

## Мониторинг

### Метрики (каждые 60s)
- `total_incoming`: Общее количество событий
- `dedup_filtered`: Отфильтровано дедупом
- `passed_filters_count`: Прошло все фильтры
- `enqueued`: Добавлено в очередь
- `executed`: Исполнено сделок
- `failed_trades`: Неудачные сделки
- `ws_reconnects`: Переподключения WS
- `rest_fallback_rate`: Процент REST fallback

### Алерты
- WS disconnected > 10s
- REST fallback rate > 10%
- Trade failure rate spike
- High latency (>1.5s median)

## Безопасность

### Секреты
- Все API ключи в переменных окружения
- Никогда не коммитить приватные ключи
- Опциональная поддержка HashiVault

### Rate Limiting
- Helius: ≤ 5 REST req/s
- DexScreener: кеширование 60s
- Backpressure при превышении лимитов

### IP Security
- Whitelist IP адресов для Helius (если поддерживается)
- Мониторинг подозрительной активности
