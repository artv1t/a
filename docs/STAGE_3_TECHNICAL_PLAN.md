# 🎯 STAGE 3: PIPELINE FILTERS - ДЕТАЛЬНЫЙ ТЕХНИЧЕСКИЙ ПЛАН

## 📋 **ОБЩАЯ КОНЦЕПЦИЯ STAGE 3**

### **Архитектура системы:**
- **БОТ #1 (Stage 2):** Token Detector - ЗАКОНСЕРВИРОВАН ✅
  - Находит токены через Helius WebSocket
  - Выдает поток токенов (13 токенов/минуту)
  - Больше НЕ ТРОГАЕМ!

- **БОТ #2 (Stage 3):** Filter Pipeline - РАЗРАБАТЫВАЕМ
  - Получает токены от Бота #1
  - Пропускает через 9 фильтров (3.1-3.9)
  - Каждый фильтр с логированием и счетчиками
  - Выдает отфильтрованные качественные токены

- **БОТ #3 (Stage 4):** Trade Executor - БУДУЩЕЕ
  - Получает токены от Бота #2
  - Выполняет торговые операции

---

## 🔧 **ПРИНЦИПЫ STAGE 3:**

### **Логика фильтрации:**
1. **Последовательность:** От легких к тяжелым фильтрам
2. **Эффективность:** 95% токенов отсеиваются на легких фильтрах
3. **Производительность:** Тяжелые фильтры только для 5-10% кандидатов
4. **Логирование:** Каждый фильтр ведет детальную статистику
5. **Счетчики:** Входящие/исходящие токены на каждом этапе

### **Структура каждого фильтра:**
```javascript
// Вход: {mint, signature, parsedTx?, metadata}
// Выход: {pass: true|false, scoreDelta: float, reason: string, critical: boolean}
```

### **Глобальные параметры:**
- **Дедлайн фильтрации:** 900ms на токен
- **Критический фейл:** Немедленный дроп
- **Скоринг:** Суммирование scoreDelta
- **Порог прохождения:** SCORE_THRESHOLD (конфигурируемый)

---

## 📊 **ДЕТАЛЬНЫЙ ПЛАН ПО ШАГАМ:**

---

## 🔍 **ШАГ 3.1: DEDUP + ALLOW/DENY FILTER**

### **Цель:**
Быстрая фильтрация дубликатов и применение черных/белых списков

### **Техническая реализация:**

#### **Файл:** `src/filters/01_dedup.js`
```javascript
class DedupFilter {
  constructor() {
    this.seenMints = new Map(); // TTL cache
    this.allowList = new Set(); // Белый список
    this.denyList = new Set();  // Черный список
    this.ttlMs = 30000; // 30 секунд TTL
    this.stats = {
      processed: 0,
      duplicates: 0,
      allowed: 0,
      denied: 0,
      passed: 0
    };
  }
}
```

#### **Логика фильтра:**
1. **Проверка TTL дедупликации:**
   - Если mint в seenMints и не истек TTL → DUPLICATE (drop)
   - Если новый mint → добавить в seenMints с timestamp

2. **Проверка deny-list:**
   - Если mint в denyList → CRITICAL FAIL (drop)
   - Логировать причину блокировки

3. **Проверка allow-list:**
   - Если mint в allowList → PASS с bonus score
   - Если не в списках → PASS (нейтрально)

#### **Конфигурация (.env):**
```bash
DEDUP_TTL_MS=30000
ALLOW_LIST_FILE=config/allow_list.txt
DENY_LIST_FILE=config/deny_list.txt
```

#### **Логирование:**
- **Файл:** `logs/session_X/filter_01_dedup.log`
- **Формат:** JSON с полями:
  ```json
  {
    "timestamp": "2025-10-03T12:00:00.000Z",
    "mint": "ABC123...",
    "action": "duplicate|denied|allowed|passed",
    "reason": "TTL_duplicate|deny_list_match|allow_list_bonus",
    "scoreDelta": 0.0,
    "processingTimeMs": 1.2
  }
  ```

#### **Счетчики (каждые 10 секунд):**
```json
{
  "filter": "01_dedup",
  "stats": {
    "processed": 1250,
    "duplicates": 45,
    "denied": 12,
    "allowed": 8,
    "passed": 1185,
    "passRate": "94.8%",
    "avgProcessingTimeMs": 1.1
  }
}
```

#### **Тестирование шага 3.1:**
1. **Подготовка тестовых данных:**
   - Создать allow_list.txt с 5 известными mint адресами
   - Создать deny_list.txt с 3 скам токенами
   - Подготовить 100 тестовых mint адресов

2. **Тест дедупликации:**
   - Отправить один mint дважды с интервалом 10 секунд
   - Проверить: первый проходит, второй отсеивается как duplicate

3. **Тест allow/deny списков:**
   - Отправить mint из allow_list → должен пройти с bonus score
   - Отправить mint из deny_list → должен быть заблокирован

4. **Проверка производительности:**
   - Обработать 1000 mint адресов
   - Время обработки: ≤ 2ms на mint
   - Память: ≤ 10MB для кеша

#### **Критерии приемки 3.1:**
- ✅ Дедупликация работает с TTL 30 секунд
- ✅ Allow/deny списки применяются корректно
- ✅ Логирование в JSON формате
- ✅ Счетчики обновляются каждые 10 секунд
- ✅ Производительность ≤ 2ms на mint
- ✅ Память ≤ 10MB для кеша

---

## ⚡ **ШАГ 3.2: FAST ON-CHAIN SANITY CHECK**

### **Цель:**
Быстрая проверка базовой информации о токене через getMultipleAccounts

### **Техническая реализация:**

#### **Файл:** `src/filters/02_sanity.js`
```javascript
class SanityFilter {
  constructor(rpcConnection) {
    this.rpc = rpcConnection;
    this.batchSize = 50; // Батчи для getMultipleAccounts
    this.stats = {
      processed: 0,
      invalidSupply: 0,
      invalidDecimals: 0,
      rpcErrors: 0,
      passed: 0
    };
  }
}
```

#### **Логика фильтра:**
1. **Батчевое получение данных:**
   - Группировать mint адреса в батчи по 50
   - Вызывать getMultipleAccounts для каждого батча
   - Timeout: 200ms на батч

2. **Проверки sanity:**
   - **Supply = 0:** CRITICAL FAIL (не выпущен)
   - **Decimals > 18:** SUSPICIOUS (score penalty -0.5)
   - **Decimals < 0:** CRITICAL FAIL (невалидный)
   - **mintAuthority существует:** Нейтрально (пока)

3. **Обработка ошибок:**
   - RPC timeout → DEFER (отложить на потом)
   - Account not found → CRITICAL FAIL
   - Network error → RETRY (до 3 раз)

#### **Конфигурация (.env):**
```bash
SANITY_BATCH_SIZE=50
SANITY_TIMEOUT_MS=200
SANITY_MAX_RETRIES=3
SANITY_MIN_DECIMALS=0
SANITY_MAX_DECIMALS=18
```

#### **Логирование:**
- **Файл:** `logs/session_X/filter_02_sanity.log`
- **Формат:**
  ```json
  {
    "timestamp": "2025-10-03T12:00:00.000Z",
    "mint": "ABC123...",
    "supply": "1000000000000",
    "decimals": 9,
    "mintAuthority": "DEF456...|null",
    "freezeAuthority": "GHI789...|null",
    "action": "passed|failed|deferred",
    "reason": "valid|zero_supply|invalid_decimals|rpc_timeout",
    "scoreDelta": 0.0,
    "processingTimeMs": 45.2,
    "batchId": "batch_001"
  }
  ```

#### **Счетчики:**
```json
{
  "filter": "02_sanity",
  "stats": {
    "processed": 1185,
    "passed": 1089,
    "failed": 96,
    "deferred": 0,
    "passRate": "91.9%",
    "avgBatchTimeMs": 156.3,
    "rpcSuccessRate": "98.2%"
  }
}
```

#### **Тестирование шага 3.2:**
1. **Тест валидных токенов:**
   - Взять 10 известных токенов (USDC, SOL, etc.)
   - Проверить: все проходят sanity check

2. **Тест невалидных токенов:**
   - Создать mock mint с supply=0
   - Создать mock mint с decimals=25
   - Проверить: оба отсеиваются

3. **Тест производительности:**
   - Обработать 500 mint адресов батчами
   - Время: ≤ 200ms на батч из 50 mint
   - RPC вызовы: 10 батчей = 10 RPC calls

4. **Тест обработки ошибок:**
   - Симулировать RPC timeout
   - Симулировать network error
   - Проверить retry логику

#### **Критерии приемки 3.2:**
- ✅ Батчевая обработка getMultipleAccounts
- ✅ Валидация supply, decimals, authorities
- ✅ Обработка RPC ошибок и timeouts
- ✅ Производительность ≤ 200ms на батч
- ✅ Детальное логирование всех проверок
- ✅ Счетчики с pass rate и RPC success rate

---

## 🔒 **ШАГ 3.3: RENOUNCED CHECK**

### **Цель:**
Проверка отказа от mintAuthority и freezeAuthority (renounced tokens)

### **Техническая реализация:**

#### **Файл:** `src/filters/03_renounced.js`
```javascript
class RenouncedFilter {
  constructor() {
    this.strictMode = false; // Конфигурируемо для early buys
    this.stats = {
      processed: 0,
      fullyRenounced: 0,
      partiallyRenounced: 0,
      notRenounced: 0,
      passed: 0
    };
  }
}
```

#### **Логика фильтра:**
1. **Проверка mintAuthority:**
   - `mintAuthority === null` → GOOD (+0.3 score)
   - `mintAuthority !== null` → RISKY (penalty или critical в strict mode)

2. **Проверка freezeAuthority:**
   - `freezeAuthority === null` → GOOD (+0.2 score)
   - `freezeAuthority !== null` → RISKY (penalty -0.2)

3. **Комбинированная оценка:**
   - **Fully renounced:** mint=null, freeze=null → PASS (+0.5 score)
   - **Partially renounced:** один из null → PASS (+0.1 score)
   - **Not renounced:** оба не null → PENALTY (-0.3) или CRITICAL FAIL

#### **Конфигурация (.env):**
```bash
RENOUNCED_STRICT_MODE=false
RENOUNCED_MINT_AUTHORITY_CRITICAL=false
RENOUNCED_FREEZE_AUTHORITY_CRITICAL=false
RENOUNCED_BONUS_FULLY=0.5
RENOUNCED_BONUS_PARTIAL=0.1
RENOUNCED_PENALTY_NOT=0.3
```

#### **Логирование:**
- **Файл:** `logs/session_X/filter_03_renounced.log`
- **Формат:**
  ```json
  {
    "timestamp": "2025-10-03T12:00:00.000Z",
    "mint": "ABC123...",
    "mintAuthority": "DEF456...|null",
    "freezeAuthority": "GHI789...|null",
    "renouncedStatus": "fully|partially|not_renounced",
    "action": "passed|failed",
    "scoreDelta": 0.5,
    "reason": "fully_renounced|mint_not_renounced|freeze_not_renounced",
    "strictMode": false,
    "processingTimeMs": 0.8
  }
  ```

#### **Счетчики:**
```json
{
  "filter": "03_renounced",
  "stats": {
    "processed": 1089,
    "fullyRenounced": 234,
    "partiallyRenounced": 456,
    "notRenounced": 399,
    "passed": 1089,
    "passRate": "100%",
    "fullyRenouncedRate": "21.5%",
    "avgScoreDelta": 0.12
  }
}
```

#### **Тестирование шага 3.3:**
1. **Тест fully renounced токенов:**
   - Найти токены с mint=null, freeze=null
   - Проверить: получают максимальный bonus score

2. **Тест not renounced токенов:**
   - Найти токены с активными authorities
   - Проверить: получают penalty или fail в strict mode

3. **Тест strict mode:**
   - Включить RENOUNCED_STRICT_MODE=true
   - Проверить: not renounced токены отсеиваются

4. **Тест производительности:**
   - Обработать 1000 токенов
   - Время: ≤ 1ms на токен (данные уже есть из step 3.2)

#### **Критерии приемки 3.3:**
- ✅ Проверка mintAuthority и freezeAuthority
- ✅ Конфигурируемый strict mode
- ✅ Правильное начисление score bonus/penalty
- ✅ Детальная статистика по типам renounced
- ✅ Производительность ≤ 1ms на токен
- ✅ Логирование всех проверок

---

## 📝 **ШАГ 3.4: MUTABLE METADATA CHECK**

### **Цель:**
Проверка Metaplex metadata на изменяемость и качество

### **Техническая реализация:**

#### **Файл:** `src/filters/04_mutable.js`
```javascript
class MutableFilter {
  constructor(rpcConnection) {
    this.rpc = rpcConnection;
    this.metaplexProgramId = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
    this.blacklistedUpdateAuthorities = new Set();
    this.stats = {
      processed: 0,
      hasMetadata: 0,
      isMutable: 0,
      hasUpdateAuthority: 0,
      hasSocialLinks: 0,
      passed: 0
    };
  }
}
```

#### **Логика фильтра:**
1. **Получение metadata account:**
   - Вычислить PDA для metadata account
   - getParsedAccountInfo для metadata
   - Timeout: 300ms

2. **Проверка isMutable:**
   - `isMutable === true` → PENALTY (-0.2 score)
   - `isMutable === false` → BONUS (+0.1 score)

3. **Проверка updateAuthority:**
   - updateAuthority в blacklist → CRITICAL FAIL
   - updateAuthority = mint authority → NEUTRAL
   - updateAuthority = null → BONUS (+0.1)

4. **Проверка social links:**
   - Наличие website/twitter/discord → BONUS (+0.1)
   - Качественные social links → BONUS (+0.2)

#### **Конфигурация (.env):**
```bash
MUTABLE_TIMEOUT_MS=300
MUTABLE_PENALTY=-0.2
MUTABLE_BONUS=0.1
SOCIAL_LINKS_BONUS=0.1
BLACKLISTED_UPDATE_AUTHORITIES=config/blacklisted_authorities.txt
```

#### **Логирование:**
- **Файл:** `logs/session_X/filter_04_mutable.log`
- **Формат:**
  ```json
  {
    "timestamp": "2025-10-03T12:00:00.000Z",
    "mint": "ABC123...",
    "metadataAccount": "META123...|null",
    "isMutable": true,
    "updateAuthority": "AUTH456...|null",
    "socialLinks": {
      "website": "https://example.com",
      "twitter": "@example",
      "discord": "discord.gg/example"
    },
    "action": "passed|failed",
    "scoreDelta": -0.1,
    "reason": "mutable_penalty|blacklisted_authority|social_bonus",
    "processingTimeMs": 245.6
  }
  ```

#### **Счетчики:**
```json
{
  "filter": "04_mutable",
  "stats": {
    "processed": 1089,
    "hasMetadata": 892,
    "isMutable": 567,
    "hasUpdateAuthority": 445,
    "hasSocialLinks": 123,
    "blacklistedAuthorities": 12,
    "passed": 1077,
    "passRate": "98.9%",
    "metadataFoundRate": "81.9%"
  }
}
```

#### **Тестирование шага 3.4:**
1. **Тест metadata parsing:**
   - Взять 10 токенов с известной metadata
   - Проверить: корректное извлечение isMutable, updateAuthority

2. **Тест blacklisted authorities:**
   - Добавить известный скам updateAuthority в blacklist
   - Проверить: токены с этим authority отсеиваются

3. **Тест social links detection:**
   - Найти токены с website/twitter в metadata
   - Проверить: получают social bonus

4. **Тест производительности:**
   - Обработать 100 токенов с metadata
   - Время: ≤ 300ms на токен
   - RPC calls: 1 на токен

#### **Критерии приемки 3.4:**
- ✅ Парсинг Metaplex metadata
- ✅ Проверка isMutable и updateAuthority
- ✅ Blacklist для updateAuthority
- ✅ Детекция social links с bonus
- ✅ Производительность ≤ 300ms на токен
- ✅ Обработка отсутствующей metadata

---

## 🔄 **ШАГ 3.5: LOCAL ROUTE GATE (POOL EXISTENCE + PRICE IMPACT)**

### **Цель:**
Ключевой фильтр: поиск direct pools и расчет price impact локально

### **Техническая реализация:**

#### **Файл:** `src/filters/05_localRouteGate.js`
```javascript
class LocalRouteGateFilter {
  constructor(rpcConnection) {
    this.rpc = rpcConnection;
    this.knownPoolsCache = new Map(); // Кеш известных пулов
    this.testTradeAmount = 0.02; // SOL для тестового трейда
    this.stats = {
      processed: 0,
      hasDirectPool: 0,
      solPools: 0,
      usdcPools: 0,
      lowPriceImpact: 0,
      highPriceImpact: 0,
      passed: 0
    };
  }
}
```

#### **Логика фильтра:**
1. **Поиск direct pools:**
   - Искать SOL/TOKEN пулы (Raydium, Orca)
   - Искать USDC/TOKEN пулы
   - Кешировать найденные пулы на 5 минут

2. **Получение reserve balances:**
   - getMultipleAccounts для pool accounts
   - Извлечь reserve0, reserve1 из pool data
   - Определить какой reserve = SOL/USDC

3. **Расчет Price Impact:**
   - XYK формула: `PI = (dx * reserve_out) / ((reserve_in + dx) * reserve_out)`
   - Для dx = 0.02 SOL
   - Расчет buy PI и sell PI

4. **Dynamic PI thresholds:**
   - **Liquidity ≥ 300 SOL:** PI ≤ 3% → PASS
   - **Liquidity 100-300 SOL:** PI ≤ 6% → PASS
   - **Liquidity < 100 SOL:** PI ≤ 10% + age < 10 min → PASS

#### **Конфигурация (.env):**
```bash
ROUTE_GATE_TEST_AMOUNT_SOL=0.02
ROUTE_GATE_CACHE_TTL_MS=300000
ROUTE_GATE_PI_THRESHOLD_HIGH_LIQ=0.03
ROUTE_GATE_PI_THRESHOLD_MED_LIQ=0.06
ROUTE_GATE_PI_THRESHOLD_LOW_LIQ=0.10
ROUTE_GATE_HIGH_LIQ_THRESHOLD=300
ROUTE_GATE_MED_LIQ_THRESHOLD=100
```

#### **Логирование:**
- **Файл:** `logs/session_X/filter_05_route_gate.log`
- **Формат:**
  ```json
  {
    "timestamp": "2025-10-03T12:00:00.000Z",
    "mint": "ABC123...",
    "pools": [
      {
        "poolAddress": "POOL123...",
        "dex": "raydium|orca",
        "baseToken": "SOL|USDC",
        "reserveBase": "1500.5",
        "reserveToken": "1000000.0",
        "liquiditySOL": 1500.5
      }
    ],
    "priceImpact": {
      "buy": 0.025,
      "sell": 0.027,
      "testAmount": 0.02
    },
    "liquidityTier": "high|medium|low",
    "threshold": 0.03,
    "action": "passed|failed",
    "scoreDelta": 0.2,
    "reason": "low_pi|high_pi|no_pool",
    "processingTimeMs": 156.8
  }
  ```

#### **Счетчики:**
```json
{
  "filter": "05_route_gate",
  "stats": {
    "processed": 1077,
    "hasDirectPool": 834,
    "solPools": 612,
    "usdcPools": 222,
    "lowPriceImpact": 445,
    "mediumPriceImpact": 234,
    "highPriceImpact": 155,
    "passed": 679,
    "passRate": "63.0%",
    "avgLiquiditySOL": 245.6,
    "avgPriceImpact": 0.047
  }
}
```

#### **Тестирование шага 3.5:**
1. **Тест pool discovery:**
   - Взять 5 известных токенов с SOL пулами
   - Проверить: находит правильные pool addresses

2. **Тест price impact calculation:**
   - Взять пул с известной ликвидностью
   - Рассчитать PI вручную и сравнить с результатом

3. **Тест dynamic thresholds:**
   - Токен с 500 SOL ликвидности, PI 4% → должен fail
   - Токен с 50 SOL ликвидности, PI 8% → должен pass

4. **Тест производительности:**
   - Обработать 100 токенов
   - Время: ≤ 300ms на токен
   - Кеширование: повторные запросы ≤ 50ms

#### **Критерии приемки 3.5:**
- ✅ Поиск direct SOL/USDC пулов
- ✅ Корректный расчет price impact по XYK
- ✅ Dynamic thresholds по ликвидности
- ✅ Кеширование pool data
- ✅ Производительность ≤ 300ms на токен
- ✅ Детальная статистика по пулам и PI

---

## 🛡️ **ШАГ 3.6: LP PROTECTION CHECK**

### **Цель:**
Проверка защиты ликвидности: burn LP tokens vs fake burn

### **Техническая реализация:**

#### **Файл:** `src/filters/06_lpProtection.js`
```javascript
class LPProtectionFilter {
  constructor(rpcConnection) {
    this.rpc = rpcConnection;
    this.whitelistedLockContracts = new Set([
      'LOCK1...', // Team Finance
      'LOCK2...', // Unicrypt
      // Другие известные lock контракты
    ]);
    this.minBurnPercentage = 80; // Минимум 80% burn
    this.stats = {
      processed: 0,
      hasLPTokens: 0,
      burnedLP: 0,
      lockedLP: 0,
      fakeBurn: 0,
      passed: 0
    };
  }
}
```

#### **Логика фильтра:**
1. **Поиск LP mint address:**
   - Из pool data получить LP mint
   - getTokenSupply для LP mint
   - getTokenLargestAccounts для LP holders

2. **Анализ LP distribution:**
   - Проверить top LP holders
   - Найти burn address (11111...1111)
   - Найти lock contracts из whitelist

3. **Расчет burn percentage:**
   - `burnPercentage = burnedAmount / totalSupply * 100`
   - Если burn ≥ minBurnPercentage → PASS
   - Если lock contract в whitelist → PASS

4. **Детекция fake burn:**
   - LP tokens в wallet разработчика → SUSPICIOUS
   - LP tokens в неизвестном контракте → RISKY
   - Множественные мелкие holders → FAKE BURN

#### **Конфигурация (.env):**
```bash
LP_PROTECTION_MIN_BURN_PCT=80
LP_PROTECTION_WHITELIST_FILE=config/lock_contracts.txt
LP_PROTECTION_MAX_DEV_HOLDINGS_PCT=5
LP_PROTECTION_TIMEOUT_MS=700
```

#### **Логирование:**
- **Файл:** `logs/session_X/filter_06_lp_protection.log`
- **Формат:**
  ```json
  {
    "timestamp": "2025-10-03T12:00:00.000Z",
    "mint": "ABC123...",
    "poolAddress": "POOL123...",
    "lpMint": "LP456...",
    "lpSupply": "1000000.0",
    "lpHolders": [
      {
        "address": "111111...1111",
        "amount": "850000.0",
        "percentage": 85.0,
        "type": "burn"
      },
      {
        "address": "LOCK123...",
        "amount": "100000.0",
        "percentage": 10.0,
        "type": "lock_contract"
      }
    ],
    "burnPercentage": 85.0,
    "lockPercentage": 10.0,
    "protection": "burned|locked|fake|none",
    "action": "passed|failed",
    "scoreDelta": 0.3,
    "reason": "sufficient_burn|whitelisted_lock|fake_burn|no_protection",
    "processingTimeMs": 456.2
  }
  ```

#### **Счетчики:**
```json
{
  "filter": "06_lp_protection",
  "stats": {
    "processed": 679,
    "hasLPTokens": 634,
    "burnedLP": 445,
    "lockedLP": 89,
    "fakeBurn": 67,
    "noProtection": 33,
    "passed": 534,
    "passRate": "78.6%",
    "avgBurnPercentage": 76.4,
    "avgLockPercentage": 12.1
  }
}
```

#### **Тестирование шага 3.6:**
1. **Тест burned LP:**
   - Найти токен с 90% burned LP
   - Проверить: проходит с high score

2. **Тест locked LP:**
   - Найти токен с LP в Team Finance
   - Проверить: проходит с bonus

3. **Тест fake burn detection:**
   - Найти токен с LP в dev wallet
   - Проверить: отсеивается как fake burn

4. **Тест производительности:**
   - Обработать 50 токенов с LP
   - Время: ≤ 700ms на токен
   - RPC calls: 3-4 на токен

#### **Критерии приемки 3.6:**
- ✅ Поиск и анализ LP mint
- ✅ Расчет burn percentage
- ✅ Whitelist для lock contracts
- ✅ Детекция fake burn
- ✅ Производительность ≤ 700ms на токен
- ✅ Детальная статистика по LP protection

---

## 📏 **ШАГ 3.7: POOL SIZE CHECK**

### **Цель:**
Dynamic проверка размера пула в зависимости от возраста токена

### **Техническая реализация:**

#### **Файл:** `src/filters/07_poolSize.js`
```javascript
class PoolSizeFilter {
  constructor() {
    this.ageThresholds = {
      veryNew: 10 * 60 * 1000,    // 10 минут
      new: 60 * 60 * 1000,       // 1 час
      mature: 24 * 60 * 60 * 1000 // 24 часа
    };
    this.sizeThresholds = {
      veryNew: { min: 40, preferred: 60 },
      new: { min: 120, preferred: 200 },
      mature: { min: 300, preferred: 500 }
    };
    this.stats = {
      processed: 0,
      veryNewTokens: 0,
      newTokens: 0,
      matureTokens: 0,
      sufficientSize: 0,
      passed: 0
    };
  }
}
```

#### **Логика фильтра:**
1. **Определение возраста токена:**
   - Получить timestamp создания из metadata или первой транзакции
   - Рассчитать age = now - creationTime

2. **Dynamic size requirements:**
   - **Age < 10 min:** min 40-60 SOL
   - **Age 10-60 min:** min 120-200 SOL
   - **Age > 60 min:** min 300+ SOL

3. **Проверка количества LP providers:**
   - Получить список LP holders
   - Исключить burn address и lock contracts
   - Желательно > 1 LP provider

4. **Scoring по размеру:**
   - Size ≥ preferred → BONUS (+0.2)
   - Size ≥ min → PASS (0.0)
   - Size < min → FAIL

#### **Конфигурация (.env):**
```bash
POOL_SIZE_VERY_NEW_MIN=40
POOL_SIZE_VERY_NEW_PREFERRED=60
POOL_SIZE_NEW_MIN=120
POOL_SIZE_NEW_PREFERRED=200
POOL_SIZE_MATURE_MIN=300
POOL_SIZE_MATURE_PREFERRED=500
POOL_SIZE_MIN_LP_PROVIDERS=1
```

#### **Логирование:**
- **Файл:** `logs/session_X/filter_07_pool_size.log`
- **Формат:**
  ```json
  {
    "timestamp": "2025-10-03T12:00:00.000Z",
    "mint": "ABC123...",
    "tokenAge": {
      "createdAt": "2025-10-03T11:45:00.000Z",
      "ageMinutes": 15.5,
      "category": "very_new|new|mature"
    },
    "poolSize": {
      "liquiditySOL": 156.7,
      "liquidityUSD": 23450.5,
      "lpProviders": 3
    },
    "thresholds": {
      "min": 40,
      "preferred": 60
    },
    "action": "passed|failed",
    "scoreDelta": 0.2,
    "reason": "preferred_size|sufficient_size|insufficient_size",
    "processingTimeMs": 89.4
  }
  ```

#### **Счетчики:**
```json
{
  "filter": "07_pool_size",
  "stats": {
    "processed": 534,
    "veryNewTokens": 123,
    "newTokens": 234,
    "matureTokens": 177,
    "sufficientSize": 445,
    "preferredSize": 234,
    "passed": 445,
    "passRate": "83.3%",
    "avgPoolSizeSOL": 187.6,
    "avgLPProviders": 2.4
  }
}
```

#### **Тестирование шага 3.7:**
1. **Тест age categorization:**
   - Токен возрастом 5 минут → very_new category
   - Токен возрастом 30 минут → new category
   - Токен возрастом 2 часа → mature category

2. **Тест dynamic thresholds:**
   - Very new токен с 50 SOL → должен pass
   - New токен с 50 SOL → должен fail
   - Mature токен с 200 SOL → должен fail

3. **Тест LP providers count:**
   - Пул с 1 LP provider → pass
   - Пул с 5 LP providers → bonus score

4. **Тест производительности:**
   - Обработать 100 токенов
   - Время: ≤ 100ms на токен (данные уже есть)

#### **Критерии приемки 3.7:**
- ✅ Dynamic size thresholds по возрасту
- ✅ Подсчет LP providers
- ✅ Правильная категоризация по возрасту
- ✅ Scoring по размеру пула
- ✅ Производительность ≤ 100ms на токен
- ✅ Статистика по категориям возраста

---

## 🔍 **ШАГ 3.8: ON-CHAIN HEAVY CHECKS**

### **Цель:**
Тяжелые on-chain проверки: holders distribution, Token-2022 features

### **Техническая реализация:**

#### **Файл:** `src/filters/08_onchainHeavy.js`
```javascript
class OnChainHeavyFilter {
  constructor(rpcConnection) {
    this.rpc = rpcConnection;
    this.cache = new Map(); // Кеш на 1-5 минут
    this.cacheTTL = 5 * 60 * 1000; // 5 минут
    this.forbiddenToken2022Features = [
      'TransferFeeConfig',
      'MintCloseAuthority',
      'PermanentDelegate'
    ];
    this.stats = {
      processed: 0,
      token2022: 0,
      forbiddenFeatures: 0,
      healthyDistribution: 0,
      concentratedHoldings: 0,
      passed: 0
    };
  }
}
```

#### **Логика фильтра:**
1. **Token-2022 detection:**
   - Проверить program owner mint account
   - Если Token-2022 → проверить extensions
   - Forbidden features → CRITICAL FAIL

2. **Holders distribution analysis:**
   - getTokenLargestAccounts (top 20 holders)
   - Кешировать результат на 5 минут
   - Рассчитать концентрацию holdings

3. **Distribution thresholds:**
   - **Top 1 holder ≤ 35-40%** → PASS
   - **Top 5 holders ≤ 65-70%** → PASS
   - Превышение → FAIL (concentrated)

4. **Special accounts exclusion:**
   - Исключить burn address
   - Исключить известные DEX accounts
   - Исключить lock contracts

#### **Конфигурация (.env):**
```bash
HEAVY_CACHE_TTL_MS=300000
HEAVY_TOP1_THRESHOLD_PCT=40
HEAVY_TOP5_THRESHOLD_PCT=70
HEAVY_TIMEOUT_MS=1000
HEAVY_FORBIDDEN_FEATURES=TransferFeeConfig,MintCloseAuthority,PermanentDelegate
```

#### **Логирование:**
- **Файл:** `logs/session_X/filter_08_heavy.log`
- **Формат:**
  ```json
  {
    "timestamp": "2025-10-03T12:00:00.000Z",
    "mint": "ABC123...",
    "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "token2022Features": ["TransferFeeConfig"],
    "holdersDistribution": {
      "top1Percentage": 25.5,
      "top5Percentage": 58.3,
      "top10Percentage": 72.1,
      "totalHolders": 1247,
      "excludedAccounts": ["111111...1111", "DEX123..."]
    },
    "action": "passed|failed",
    "scoreDelta": 0.1,
    "reason": "healthy_distribution|concentrated_holdings|forbidden_features",
    "cached": true,
    "processingTimeMs": 234.7
  }
  ```

#### **Счетчики:**
```json
{
  "filter": "08_heavy",
  "stats": {
    "processed": 445,
    "token2022": 23,
    "forbiddenFeatures": 8,
    "healthyDistribution": 334,
    "concentratedHoldings": 103,
    "passed": 334,
    "passRate": "75.1%",
    "avgTop1Percentage": 28.7,
    "avgTop5Percentage": 61.4,
    "cacheHitRate": "67.2%"
  }
}
```

#### **Тестирование шага 3.8:**
1. **Тест Token-2022 detection:**
   - Найти Token-2022 токен с transfer fees
   - Проверить: отсеивается как forbidden

2. **Тест holders distribution:**
   - Токен с top1=25%, top5=55% → должен pass
   - Токен с top1=45%, top5=80% → должен fail

3. **Тест кеширования:**
   - Обработать один токен дважды
   - Второй раз должен использовать кеш (< 50ms)

4. **Тест производительности:**
   - Обработать 20 токенов (только 5-10% от общего потока)
   - Время: ≤ 1000ms на токен
   - RPC calls: 2-3 на токен

#### **Критерии приемки 3.8:**
- ✅ Детекция Token-2022 и forbidden features
- ✅ Анализ holders distribution
- ✅ Кеширование результатов на 5 минут
- ✅ Исключение special accounts
- ✅ Производительность ≤ 1000ms на токен
- ✅ Применяется только к 5-10% токенов

---

## 🌟 **ШАГ 3.9: QUALITY CHECK (DEXSCREENER)**

### **Цель:**
Внешняя проверка качества через DexScreener API (non-blocking)

### **Техническая реализация:**

#### **Файл:** `src/filters/09_quality.js`
```javascript
class QualityFilter {
  constructor() {
    this.dexScreenerAPI = 'https://api.dexscreener.com/latest/dex/tokens/';
    this.cache = new Map(); // Кеш на 30-60 секунд
    this.cacheTTL = 60 * 1000; // 1 минута
    this.rateLimiter = new RateLimiter(10, 1000); // 10 req/sec
    this.stats = {
      processed: 0,
      apiSuccess: 0,
      apiErrors: 0,
      hasVolume: 0,
      hasLiquidity: 0,
      qualityBonus: 0,
      passed: 0
    };
  }
}
```

#### **Логика фильтра:**
1. **Non-blocking execution:**
   - Для токенов возрастом < 30 минут → не блокировать pipeline
   - Запрос к DexScreener в фоне
   - Результат влияет только на score/prioritization

2. **DexScreener API call:**
   - GET /latest/dex/tokens/{mint}
   - Timeout: 2000ms
   - Rate limit: 10 req/sec

3. **Quality metrics:**
   - **volume24h > $1000** → BONUS (+0.1)
   - **liquidityUSD > $10000** → BONUS (+0.1)
   - **pairAge > 1 hour** → BONUS (+0.05)
   - **Multiple DEXes** → BONUS (+0.05)

4. **Error handling:**
   - API timeout → NEUTRAL (не влияет на результат)
   - Rate limit → DEFER (попробовать позже)
   - 404 Not Found → NEUTRAL (новый токен)

#### **Конфигурация (.env):**
```bash
QUALITY_API_TIMEOUT_MS=2000
QUALITY_CACHE_TTL_MS=60000
QUALITY_RATE_LIMIT_PER_SEC=10
QUALITY_MIN_VOLUME_USD=1000
QUALITY_MIN_LIQUIDITY_USD=10000
QUALITY_NON_BLOCKING_AGE_MIN=30
```

#### **Логирование:**
- **Файл:** `logs/session_X/filter_09_quality.log`
- **Формат:**
  ```json
  {
    "timestamp": "2025-10-03T12:00:00.000Z",
    "mint": "ABC123...",
    "tokenAge": 25.5,
    "nonBlocking": true,
    "dexScreenerData": {
      "volume24h": 15420.5,
      "liquidityUSD": 45600.2,
      "pairAge": 3.2,
      "dexes": ["raydium", "orca"],
      "priceUSD": 0.000123
    },
    "qualityMetrics": {
      "volumeBonus": 0.1,
      "liquidityBonus": 0.1,
      "ageBonus": 0.05,
      "multiDexBonus": 0.05
    },
    "action": "passed|deferred|neutral",
    "scoreDelta": 0.3,
    "reason": "quality_bonus|api_timeout|not_found|rate_limited",
    "cached": false,
    "processingTimeMs": 1456.3
  }
  ```

#### **Счетчики:**
```json
{
  "filter": "09_quality",
  "stats": {
    "processed": 334,
    "apiSuccess": 267,
    "apiErrors": 45,
    "apiTimeouts": 22,
    "hasVolume": 156,
    "hasLiquidity": 189,
    "qualityBonus": 134,
    "nonBlockingTokens": 234,
    "passed": 334,
    "passRate": "100%",
    "apiSuccessRate": "85.6%",
    "avgQualityScore": 0.12
  }
  }
```

#### **Тестирование шага 3.9:**
1. **Тест DexScreener API:**
   - Запросить данные для известного токена
   - Проверить: корректный парсинг volume, liquidity

2. **Тест non-blocking mode:**
   - Токен возрастом 15 минут → не должен блокировать
   - Токен возрастом 45 минут → может блокировать

3. **Тест rate limiting:**
   - Отправить 20 запросов подряд
   - Проверить: соблюдается лимит 10 req/sec

4. **Тест error handling:**
   - Симулировать API timeout
   - Симулировать 404 response
   - Проверить: не ломает pipeline

#### **Критерии приемки 3.9:**
- ✅ Non-blocking для токенов < 30 минут
- ✅ Интеграция с DexScreener API
- ✅ Rate limiting 10 req/sec
- ✅ Кеширование на 1 минуту
- ✅ Graceful error handling
- ✅ Quality bonus scoring

---

## 🎯 **ОБЩАЯ АРХИТЕКТУРА PIPELINE:**

### **Файл:** `src/pipeline/orchestrator.js`

#### **Pipeline Orchestrator:**
```javascript
class FilterPipeline {
  constructor() {
    this.filters = [
      new DedupFilter(),
      new SanityFilter(rpc),
      new RenouncedFilter(),
      new MutableFilter(rpc),
      new LocalRouteGateFilter(rpc),
      new LPProtectionFilter(rpc),
      new PoolSizeFilter(),
      new OnChainHeavyFilter(rpc),
      new QualityFilter()
    ];
    this.globalTimeout = 900; // 900ms на токен
    this.scoreThreshold = 0.5; // Минимальный score для прохождения
  }

  async processToken(tokenData) {
    const startTime = Date.now();
    let totalScore = 0;
    const results = [];

    for (const filter of this.filters) {
      const filterStart = Date.now();
      
      try {
        const result = await Promise.race([
          filter.process(tokenData),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Filter timeout')), this.globalTimeout)
          )
        ]);

        if (result.critical && !result.pass) {
          // Критический фейл - немедленный дроп
          return { pass: false, reason: result.reason, score: totalScore };
        }

        totalScore += result.scoreDelta;
        results.push({
          filter: filter.constructor.name,
          result: result,
          timeMs: Date.now() - filterStart
        });

      } catch (error) {
        // Timeout или ошибка фильтра
        results.push({
          filter: filter.constructor.name,
          error: error.message,
          timeMs: Date.now() - filterStart
        });
      }
    }

    const passed = totalScore >= this.scoreThreshold;
    return {
      pass: passed,
      score: totalScore,
      results: results,
      totalTimeMs: Date.now() - startTime
    };
  }
}
```

---

## 📊 **ЛОГИРОВАНИЕ И МОНИТОРИНГ:**

### **Общие логи:**
- **`logs/session_X/pipeline_summary.log`** - Общая статистика pipeline
- **`logs/session_X/pipeline_performance.log`** - Производительность фильтров
- **`logs/session_X/pipeline_errors.log`** - Ошибки и таймауты

### **Счетчики каждые 30 секунд:**
```json
{
  "timestamp": "2025-10-03T12:00:00.000Z",
  "pipeline": {
    "totalProcessed": 1250,
    "totalPassed": 234,
    "passRate": "18.7%",
    "avgProcessingTimeMs": 456.7,
    "avgScore": 0.34
  },
  "filterStats": {
    "01_dedup": { "processed": 1250, "passed": 1185, "passRate": "94.8%" },
    "02_sanity": { "processed": 1185, "passed": 1089, "passRate": "91.9%" },
    "03_renounced": { "processed": 1089, "passed": 1089, "passRate": "100%" },
    "04_mutable": { "processed": 1089, "passed": 1077, "passRate": "98.9%" },
    "05_route_gate": { "processed": 1077, "passed": 679, "passRate": "63.0%" },
    "06_lp_protection": { "processed": 679, "passed": 534, "passRate": "78.6%" },
    "07_pool_size": { "processed": 534, "passed": 445, "passRate": "83.3%" },
    "08_heavy": { "processed": 445, "passed": 334, "passRate": "75.1%" },
    "09_quality": { "processed": 334, "passed": 334, "passRate": "100%" }
  }
}
```

---

## 🧪 **ТЕСТИРОВАНИЕ КАЖДОГО ШАГА:**

### **Процедура тестирования:**
1. **Реализация фильтра** (например, 3.1)
2. **Unit тесты** с mock данными
3. **Integration тест** с реальными токенами
4. **Performance тест** с нагрузкой
5. **Ручная проверка** через Cursor
6. **Одобрение** перед переходом к 3.2

### **Команды для тестирования:**
```bash
# Тест отдельного фильтра
npm run test:filter:01

# Тест производительности
npm run test:performance:01

# Интеграционный тест
npm run test:integration:01

# Полный pipeline тест (только после всех 9 шагов)
npm run test:pipeline:full
```

---

## 🎯 **КРИТЕРИИ ПРИЕМКИ STAGE 3:**

### **Общие требования:**
- ✅ Все 9 фильтров реализованы и протестированы
- ✅ 95% токенов отсеиваются на легких фильтрах (3.1-3.4)
- ✅ Тяжелые фильтры (3.8) применяются к ≤ 10% токенов
- ✅ Median latency ≤ 900ms на токен
- ✅ Детальное логирование каждого фильтра
- ✅ Счетчики и статистика в реальном времени

### **Производительность:**
- **Throughput:** 100+ токенов в минуту
- **Latency:** ≤ 900ms на токен
- **Memory:** ≤ 200MB для всего pipeline
- **RPC calls:** ≤ 10 на токен (с кешированием)

### **Качество фильтрации:**
- **Pass rate:** 15-25% от входящих токенов
- **False positives:** ≤ 5% (хорошие токены отсеяны)
- **False negatives:** ≤ 10% (плохие токены прошли)

---

## 🚀 **ПЛАН РЕАЛИЗАЦИИ:**

### **Неделя 1:**
- **День 1-2:** Шаги 3.1, 3.2 (легкие фильтры)
- **День 3-4:** Шаги 3.3, 3.4 (metadata фильтры)
- **День 5:** Тестирование и оптимизация 3.1-3.4

### **Неделя 2:**
- **День 1-2:** Шаг 3.5 (LocalRouteGate - ключевой)
- **День 3:** Шаги 3.6, 3.7 (LP и pool size)
- **День 4:** Шаг 3.8 (heavy checks)
- **День 5:** Шаг 3.9 (quality API)

### **Неделя 3:**
- **День 1-2:** Pipeline orchestrator
- **День 3-4:** Интеграционное тестирование
- **День 5:** Оптимизация и финальные тесты

---

## 📋 **ЧЕКЛИСТ ДЛЯ КАЖДОГО ШАГА:**

### **Перед началом шага:**
- [ ] Изучить техническое описание
- [ ] Подготовить тестовые данные
- [ ] Настроить конфигурацию
- [ ] Создать файл фильтра

### **Во время реализации:**
- [ ] Реализовать основную логику
- [ ] Добавить логирование
- [ ] Добавить счетчики
- [ ] Обработать ошибки
- [ ] Оптимизировать производительность

### **После реализации:**
- [ ] Unit тесты
- [ ] Integration тесты
- [ ] Performance тесты
- [ ] Ручная проверка
- [ ] Документация
- [ ] Commit и push

### **Перед переходом к следующему шагу:**
- [ ] Все тесты проходят
- [ ] Производительность в норме
- [ ] Логирование работает
- [ ] Ручная проверка пройдена
- [ ] Одобрение получено

---

**🎯 ЭТОТ ПЛАН ГОТОВ К РЕАЛИЗАЦИИ!**

**Каждый шаг детально расписан с техническими деталями, тестированием и критериями приемки. Готов начинать с шага 3.1 по твоему одобрению!**
