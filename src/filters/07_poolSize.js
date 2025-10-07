
const logger = require('../utils/logging');

class PoolSizeFilter {
  constructor() {
    this.name = '07_poolSize';
    this.enabled = process.env.POOL_SIZE_ENABLED === 'true';
    this.critical = process.env.POOL_SIZE_CRITICAL === 'true';
    
    this.jupiterBaseUrl = process.env.JUP_BASE_URL || 'https://lite-api.jup.ag';
    this.jupiterQuotePath = process.env.JUP_QUOTE_PATH || '/swap/v1/quote';
    this.jupiterOutputMint = process.env.JUP_OUTPUT_MINT || 'So11111111111111111111111111111111111111112';
    this.jupiterSlippageBps = parseInt(process.env.JUP_SLIPPAGE_BPS) || 50;
    this.jupiterTargetPiBps = parseInt(process.env.JUP_TARGET_PI_BPS) || 600;
    this.jupiterTimeout = parseInt(process.env.JUP_TIMEOUT_MS) || 2500;
    this.jupiterRetry = parseInt(process.env.JUP_RETRY) || 1;
    
    this.elSmallSol = parseFloat(process.env.EL_SMALL_SOL) || 0.02;
    this.elBigSol = parseFloat(process.env.EL_BIG_SOL) || 0.5;
    this.elMaxSteps = parseInt(process.env.EL_MAX_STEPS) || 3;
    this.minElSol = parseFloat(process.env.MIN_EL_SOL) || 0.2;
    
    this.volumeCheckEnabled = process.env.V_CHECK_ENABLED === 'true';
    this.volumeWindowMin = parseInt(process.env.V_WINDOW_MIN) || 5;
    this.volumeMaxTx = parseInt(process.env.V_MAX_TX) || 80;
    this.volumeMinSwaps = parseInt(process.env.V_MIN_SWAPS) || 3;
    
    this.heliusRpc = process.env.HELIUS_RPC;
    this.heliusTxHistory = process.env.HELIUS_TX_HISTORY;
    this.heliusRpsMax = parseInt(process.env.HELIUS_RPS_MAX) || 3;
    this.heliusTimeout = parseInt(process.env.HELIUS_TIMEOUT_MS) || 1200;
    
    this.jupiterCache = new Map();
    this.jupiterCacheTtl = parseInt(process.env.JUP_CACHE_TTL_MS) || 60000;
    
    this.requestQueue = [];
    this.activeRequests = 0;
    this.maxConcurrency = parseInt(process.env.JUP_CONCURRENCY) || 2;
    this.qpsMax = parseInt(process.env.JUP_QPS_MAX) || 3;
    this.lastRequestTime = 0;
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      warn: 0,
      avg_latency_ms: 0,
      jup_calls: 0,
      cache_hits: 0,
      jup_429: 0,
      timeouts: 0,
      no_route: 0,
      el_low: 0,
      el_ok: 0,
      volume_low: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    
    logger.info(`💰 ${this.name}: Pool Size Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      jupiterBaseUrl: this.jupiterBaseUrl,
      elSmallSol: this.elSmallSol,
      elBigSol: this.elBigSol,
      minElSol: this.minElSol,
      volumeCheckEnabled: this.volumeCheckEnabled,
      qpsMax: this.qpsMax,
      maxConcurrency: this.maxConcurrency
    });
  }
  
  startStatsTimer() {
    setInterval(() => {
      this.logStats();
    }, 10000);
  }
  
  logStats() {
    const runtime = Date.now() - this.stats.startTime;
    const runtimeMinutes = runtime / 60000;
    
    if (this.stats.processed > 0) {
      this.stats.avg_latency_ms = Math.round(this.stats.avg_latency_ms);
    }
    
    const statsData = {
      filter: this.name,
      enabled: this.enabled,
      runtime: {
        ms: runtime,
        minutes: Math.round(runtimeMinutes * 10) / 10
      },
      stats: {
        processed: this.stats.processed,
        passed: this.stats.passed,
        failed: this.stats.failed,
        warn: this.stats.warn,
        avg_latency_ms: this.stats.avg_latency_ms,
        jup_calls: this.stats.jup_calls,
        cache_hits: this.stats.cache_hits,
        jup_429: this.stats.jup_429,
        timeouts: this.stats.timeouts,
        no_route: this.stats.no_route,
        el_low: this.stats.el_low,
        el_ok: this.stats.el_ok,
        volume_low: this.stats.volume_low,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%',
        cacheHitRate: (this.stats.cache_hits + this.stats.jup_calls) > 0 ? 
          Math.round((this.stats.cache_hits / (this.stats.cache_hits + this.stats.jup_calls)) * 1000) / 10 + '%' : '0%'
      },
      throughput: {
        tokensPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.processed / runtimeMinutes) * 10) / 10 : 0
      }
    };
    
    logger.info(`📊 ${this.name}: Statistics Update`, statsData);
  }
  
  async process(tokenData) {
    if (!this.enabled) {
      return {
        pass: true,
        critical: false,
        scoreDelta: 0,
        reason: 'filter_disabled',
        action: 'skipped',
        processingTimeMs: 0
      };
    }
    
    const startTime = Date.now();
    this.stats.processed++;
    
    const { mint, signature, from3_5 = {}, meta = {} } = tokenData;
    
    try {
      let marketLabel = from3_5.marketLabel;
      
      if (!marketLabel) {
        const smallQuote = await this.getJupiterQuote(mint, Math.floor(this.elSmallSol * 1e9));
        if (smallQuote && smallQuote.routePlan && smallQuote.routePlan.length > 0) {
          marketLabel = this.extractMarketLabel(smallQuote);
        }
      }
      
      if (!marketLabel) {
        this.stats.no_route++;
        const result = this.createResult(true, 0, 'no_route', 'pass_log_only', {
          usedCache: false,
          jupCalls: 1,
          tookMs: Date.now() - startTime
        });
        
        this.logTokenResult(mint, signature, result);
        return result;
      }
      
      const elResult = await this.calculateEffectiveLiquidity(mint, marketLabel);
      
      let volumeResult = null;
      if (this.volumeCheckEnabled) {
        volumeResult = await this.checkVolume(mint);
      }
      
      const decision = this.makeDecision(elResult, volumeResult);
      
      this.updateStats(decision);
      
      const processingTime = Date.now() - startTime;
      this.updateLatency(processingTime);
      
      const result = this.createResult(
        decision.pass,
        decision.scoreDelta,
        decision.reason,
        decision.action,
        {
          marketLabel,
          el_sol: elResult.elSol,
          pi_small_bps: elResult.piSmallBps,
          pi_big_bps: elResult.piBigBps,
          stepsUsed: elResult.stepsUsed,
          usedCache: elResult.usedCache,
          jupCalls: elResult.jupCalls,
          tookMs: processingTime,
          volume_window_min: volumeResult?.windowMin,
          swaps_count: volumeResult?.swapsCount,
          volume_est_sol: volumeResult?.volumeEstSol
        }
      );
      
      this.logTokenResult(mint, signature, result);
      return result;
      
    } catch (error) {
      this.stats.timeouts++;
      
      const result = this.createResult(true, 0, 'rate_limited', 'pass_log_only', {
        error: error.message,
        tookMs: Date.now() - startTime
      });
      
      logger.error(`💥 ${this.name}: Processing error`, {
        mint,
        signature,
        error: error.message
      });
      
      return result;
    }
  }
  
  async getJupiterQuote(mint, amountLamports) {
    const cacheKey = `${mint}|${amountLamports}|${this.jupiterOutputMint}`;
    
    const cached = this.jupiterCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.jupiterCacheTtl) {
      this.stats.cache_hits++;
      return cached.data;
    }
    
    await this.waitForRateLimit();
    
    try {
      this.stats.jup_calls++;
      
      const url = new URL(this.jupiterQuotePath, this.jupiterBaseUrl);
      url.searchParams.set('inputMint', mint);
      url.searchParams.set('outputMint', this.jupiterOutputMint);
      url.searchParams.set('amount', amountLamports.toString());
      url.searchParams.set('slippageBps', this.jupiterSlippageBps.toString());
      url.searchParams.set('restrictIntermediateTokens', 'true');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.jupiterTimeout);
      
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'SalonSniper/1.0'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.status === 429) {
        this.stats.jup_429++;
        throw new Error('Rate limited');
      }
      
      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      this.jupiterCache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });
      
      setTimeout(() => this.jupiterCache.delete(cacheKey), this.jupiterCacheTtl);
      
      return data;
      
    } catch (error) {
      if (error.name === 'AbortError') {
        this.stats.timeouts++;
        throw new Error('Jupiter timeout');
      }
      throw error;
    }
  }
  
  async waitForRateLimit() {
    const now = Date.now();
    const minInterval = 1000 / this.qpsMax; // ms between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < minInterval) {
      await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLastRequest));
    }
    
    this.lastRequestTime = Date.now();
  }
  
  extractMarketLabel(quote) {
    if (!quote.routePlan || quote.routePlan.length === 0) return null;
    
    for (const step of quote.routePlan) {
      if (step.swapInfo && step.swapInfo.label) {
        return step.swapInfo.label;
      }
    }
    
    return 'Unknown';
  }
  
  async calculateEffectiveLiquidity(mint, marketLabel) {
    const smallAmount = Math.floor(this.elSmallSol * 1e9);
    const bigAmount = Math.floor(this.elBigSol * 1e9);
    
    let jupCalls = 0;
    let usedCache = false;
    
    const smallQuote = await this.getJupiterQuote(mint, smallAmount);
    jupCalls++;
    
    if (!smallQuote || !smallQuote.routePlan || smallQuote.routePlan.length === 0) {
      return {
        elSol: 0,
        piSmallBps: 0,
        piBigBps: 0,
        stepsUsed: 0,
        usedCache,
        jupCalls
      };
    }
    
    const piSmallBps = smallQuote.priceImpactPct ? Math.round(smallQuote.priceImpactPct * 10000) : 0;
    
    const bigQuote = await this.getJupiterQuote(mint, bigAmount);
    jupCalls++;
    
    if (!bigQuote || !bigQuote.routePlan || bigQuote.routePlan.length === 0) {
      return {
        elSol: this.elSmallSol,
        piSmallBps,
        piBigBps: 0,
        stepsUsed: 0,
        usedCache,
        jupCalls
      };
    }
    
    const piBigBps = bigQuote.priceImpactPct ? Math.round(bigQuote.priceImpactPct * 10000) : 0;
    
    if (piBigBps <= this.jupiterTargetPiBps) {
      return {
        elSol: this.elBigSol,
        piSmallBps,
        piBigBps,
        stepsUsed: 0,
        usedCache,
        jupCalls
      };
    }
    
    let low = this.elSmallSol;
    let high = this.elBigSol;
    let bestEl = this.elSmallSol;
    let stepsUsed = 0;
    
    for (let step = 0; step < this.elMaxSteps; step++) {
      const mid = (low + high) / 2;
      const midAmount = Math.floor(mid * 1e9);
      
      const midQuote = await this.getJupiterQuote(mint, midAmount);
      jupCalls++;
      stepsUsed++;
      
      if (!midQuote || !midQuote.routePlan || midQuote.routePlan.length === 0) {
        high = mid;
        continue;
      }
      
      const midPiBps = midQuote.priceImpactPct ? Math.round(midQuote.priceImpactPct * 10000) : 0;
      
      if (midPiBps <= this.jupiterTargetPiBps) {
        bestEl = mid;
        low = mid;
      } else {
        high = mid;
      }
      
      if (high - low < 0.01) break;
    }
    
    return {
      elSol: bestEl,
      piSmallBps,
      piBigBps,
      stepsUsed,
      usedCache,
      jupCalls
    };
  }
  
  async checkVolume(mint) {
    if (!this.volumeCheckEnabled || !this.heliusTxHistory) {
      return null;
    }
    
    try {
      return {
        windowMin: this.volumeWindowMin,
        swapsCount: 0,
        volumeEstSol: 0
      };
    } catch (error) {
      logger.error(`💥 ${this.name}: Volume check error`, {
        mint,
        error: error.message
      });
      return null;
    }
  }
  
  makeDecision(elResult, volumeResult) {
    const { elSol } = elResult;
    
    if (elSol >= this.minElSol) {
      this.stats.el_ok++;
      return {
        pass: true,
        scoreDelta: 0.1,
        reason: 'el_ok',
        action: 'passed'
      };
    } else {
      this.stats.el_low++;
      return {
        pass: false,
        scoreDelta: -0.3,
        reason: 'el_low',
        action: 'failed'
      };
    }
  }
  
  updateStats(decision) {
    if (decision.pass) {
      this.stats.passed++;
    } else {
      this.stats.failed++;
    }
  }
  
  updateLatency(processingTime) {
    if (this.stats.processed === 1) {
      this.stats.avg_latency_ms = processingTime;
    } else {
      this.stats.avg_latency_ms = (this.stats.avg_latency_ms * (this.stats.processed - 1) + processingTime) / this.stats.processed;
    }
  }
  
  createResult(pass, scoreDelta, reason, action, meta) {
    return {
      pass,
      critical: false,
      scoreDelta,
      reason,
      action,
      meta,
      processingTimeMs: meta.tookMs || 0
    };
  }
  
  logTokenResult(mint, signature, result) {
    const logData = {
      ts: new Date().toISOString(),
      mint,
      marketLabel: result.meta.marketLabel || 'unknown',
      el_sol: result.meta.el_sol || 0,
      pi_small_bps: result.meta.pi_small_bps || 0,
      pi_big_bps: result.meta.pi_big_bps || 0,
      stepsUsed: result.meta.stepsUsed || 0,
      usedCache: result.meta.usedCache || false,
      jupCalls: result.meta.jupCalls || 0,
      reason: result.reason,
      action: result.action,
      tookMs: result.meta.tookMs || 0
    };
    
    const logPrefix = result.pass ? '✅' : '❌';
    logger.info(`${logPrefix} ${this.name}: ${result.action.toUpperCase()}`, {
      mint,
      signature,
      ...logData
    });
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0,
      cacheHitRate: (this.stats.cache_hits + this.stats.jup_calls) > 0 ? 
        (this.stats.cache_hits / (this.stats.cache_hits + this.stats.jup_calls)) * 100 : 0
    };
  }
  
  enable() {
    this.enabled = true;
    logger.info(`✅ ${this.name}: Filter enabled`);
  }
  
  disable() {
    this.enabled = false;
    logger.info(`❌ ${this.name}: Filter disabled`);
  }
  
  updateConfig(config) {
    if (config.minElSol !== undefined) this.minElSol = config.minElSol;
    if (config.jupiterTargetPiBps !== undefined) this.jupiterTargetPiBps = config.jupiterTargetPiBps;
    if (config.elMaxSteps !== undefined) this.elMaxSteps = config.elMaxSteps;
    if (config.qpsMax !== undefined) this.qpsMax = config.qpsMax;
    if (config.critical !== undefined) this.critical = config.critical;
    
    logger.info(`🔧 ${this.name}: Configuration updated`, config);
  }
}

module.exports = PoolSizeFilter;
