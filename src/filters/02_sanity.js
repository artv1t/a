
const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logging');

class SanityFilter {
  constructor() {
    this.name = '02_sanity';
    this.enabled = process.env.SANITY_FILTER_ENABLED !== 'false'; // Enabled by default
    this.critical = process.env.SANITY_CRITICAL === 'true'; // Non-critical by default
    this.timeout = parseInt(process.env.SANITY_TIMEOUT_MS) || 300; // 300ms timeout
    
    this.rpcUrl = process.env.HELIUS_RPC;
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    this.minDecimals = parseInt(process.env.SANITY_MIN_DECIMALS) || 0;
    this.maxDecimals = parseInt(process.env.SANITY_MAX_DECIMALS) || 18;
    this.maxRetries = parseInt(process.env.SANITY_MAX_RETRIES) || 3;
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      deferred: 0,
      rpcErrors: 0,
      timeouts: 0,
      startTime: Date.now()
    };
    
    this.batchQueue = [];
    this.batchSize = parseInt(process.env.SANITY_BATCH_SIZE) || 100;
    this.batchTimeoutMs = parseInt(process.env.SANITY_BATCH_TIMEOUT_MS) || 500;
    
    this.startStatsTimer();
    
    logger.info(`🔍 ${this.name}: Sanity Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      timeout: this.timeout,
      minDecimals: this.minDecimals,
      maxDecimals: this.maxDecimals,
      batchSize: this.batchSize,
      rpcUrl: this.rpcUrl ? 'configured' : 'missing'
    });
  }
  
  startStatsTimer() {
    setInterval(() => {
      this.logStats();
    }, 10000); // Every 10 seconds
  }
  
  logStats() {
    const runtime = Date.now() - this.stats.startTime;
    const runtimeMinutes = runtime / 60000;
    
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
        deferred: this.stats.deferred,
        rpcErrors: this.stats.rpcErrors,
        timeouts: this.stats.timeouts,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%',
        rpcSuccessRate: this.stats.processed > 0 ? 
          Math.round(((this.stats.processed - this.stats.rpcErrors) / this.stats.processed) * 1000) / 10 + '%' : '0%'
      },
      throughput: {
        tokensPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.processed / runtimeMinutes) * 10) / 10 : 0
      }
    };
    
    logger.info(`📊 ${this.name}: Statistics Update`, statsData);
  }
  
  async process(tokenData) {
    const startTime = Date.now();
    this.stats.processed++;
    
    const { mint, signature, metadata = {} } = tokenData;
    
    this.stats.passed++;
    
    const result = {
      pass: true,
      critical: false,
      scoreDelta: 0,
      reason: 'filter_disabled_passthrough',
      action: 'passed_through',
      processingTimeMs: Date.now() - startTime
    };
    
    logger.debug(`➡️ ${this.name}: Token passed through (DISABLED)`, {
      mint,
      signature,
      enabled: this.enabled,
      ...result
    });
    
    return result;
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0,
      rpcSuccessRate: this.stats.processed > 0 ? 
        ((this.stats.processed - this.stats.rpcErrors) / this.stats.processed) * 100 : 0
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
    if (config.minDecimals !== undefined) this.minDecimals = config.minDecimals;
    if (config.maxDecimals !== undefined) this.maxDecimals = config.maxDecimals;
    if (config.timeout !== undefined) this.timeout = config.timeout;
    if (config.critical !== undefined) this.critical = config.critical;
    
    logger.info(`🔧 ${this.name}: Configuration updated`, config);
  }
}

module.exports = SanityFilter;
