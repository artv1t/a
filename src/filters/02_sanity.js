
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
    
    const { mint, signature, metadata = {} } = tokenData;
    
    try {
      let mintPubkey;
      try {
        mintPubkey = new PublicKey(mint);
      } catch (error) {
        this.stats.failed++;
        
        const result = {
          pass: false,
          critical: this.critical,
          scoreDelta: -1.0,
          reason: 'invalid_mint_address',
          action: 'failed',
          error: error.message,
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`❌ ${this.name}: Invalid mint address`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      const accountInfo = await Promise.race([
        this.connection.getAccountInfo(mintPubkey),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('RPC timeout')), this.timeout)
        )
      ]);
      
      if (!accountInfo) {
        this.stats.failed++;
        
        const result = {
          pass: false,
          critical: this.critical,
          scoreDelta: -0.5,
          reason: 'account_not_found',
          action: 'failed',
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`❌ ${this.name}: Account not found`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      let mintInfo;
      try {
        if (!accountInfo.data || accountInfo.data.length < 82) {
          throw new Error('Invalid mint account data length');
        }
        
        const data = accountInfo.data;
        const supply = data.readBigUInt64LE(36); // Supply at offset 36
        const decimals = data.readUInt8(44); // Decimals at offset 44
        
        const mintAuthorityOption = data.readUInt32LE(0);
        const mintAuthority = mintAuthorityOption === 1 ? 
          new PublicKey(data.slice(4, 36)).toString() : null;
        
        const freezeAuthorityOption = data.readUInt32LE(45);
        const freezeAuthority = freezeAuthorityOption === 1 ? 
          new PublicKey(data.slice(46, 78)).toString() : null;
        
        mintInfo = {
          supply: supply.toString(),
          decimals,
          mintAuthority,
          freezeAuthority
        };
        
      } catch (parseError) {
        this.stats.failed++;
        
        const result = {
          pass: false,
          critical: this.critical,
          scoreDelta: -0.8,
          reason: 'parse_error',
          action: 'failed',
          error: parseError.message,
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`❌ ${this.name}: Failed to parse mint data`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      const validationResults = [];
      let totalScoreDelta = 0;
      
      if (mintInfo.supply === '0') {
        validationResults.push({
          check: 'supply',
          result: 'failed',
          reason: 'zero_supply',
          scoreDelta: -0.8
        });
        totalScoreDelta -= 0.8;
      } else {
        validationResults.push({
          check: 'supply',
          result: 'passed',
          reason: 'valid_supply',
          scoreDelta: 0.1
        });
        totalScoreDelta += 0.1;
      }
      
      if (mintInfo.decimals < this.minDecimals || mintInfo.decimals > this.maxDecimals) {
        validationResults.push({
          check: 'decimals',
          result: 'failed',
          reason: 'invalid_decimals',
          scoreDelta: -0.5
        });
        totalScoreDelta -= 0.5;
      } else {
        validationResults.push({
          check: 'decimals',
          result: 'passed',
          reason: 'valid_decimals',
          scoreDelta: 0.1
        });
        totalScoreDelta += 0.1;
      }
      
      if (mintInfo.mintAuthority) {
        validationResults.push({
          check: 'mint_authority',
          result: 'info',
          reason: 'has_mint_authority',
          scoreDelta: -0.1 // Slight penalty for not being renounced
        });
        totalScoreDelta -= 0.1;
      } else {
        validationResults.push({
          check: 'mint_authority',
          result: 'info',
          reason: 'renounced_mint_authority',
          scoreDelta: 0.1 // Slight bonus for being renounced
        });
        totalScoreDelta += 0.1;
      }
      
      const criticalFailures = validationResults.filter(r => 
        r.result === 'failed' && (r.check === 'supply' || r.check === 'decimals')
      );
      
      const passed = criticalFailures.length === 0;
      
      if (passed) {
        this.stats.passed++;
      } else {
        this.stats.failed++;
      }
      
      const result = {
        pass: passed,
        critical: this.critical && !passed,
        scoreDelta: totalScoreDelta,
        reason: passed ? 'sanity_checks_passed' : 'sanity_checks_failed',
        action: passed ? 'passed' : 'failed',
        mintInfo: mintInfo,
        validationResults: validationResults,
        processingTimeMs: Date.now() - startTime
      };
      
      logger.info(`${passed ? '✅' : '❌'} ${this.name}: Token ${passed ? 'passed' : 'failed'} sanity checks`, {
        mint,
        signature,
        ...result
      });
      
      return result;
      
    } catch (error) {
      if (error.message === 'RPC timeout') {
        this.stats.timeouts++;
      } else {
        this.stats.rpcErrors++;
      }
      
      const shouldPass = !this.critical;
      
      if (shouldPass) {
        this.stats.passed++;
      } else {
        this.stats.failed++;
      }
      
      const result = {
        pass: shouldPass,
        critical: false, // Don't make RPC errors critical
        scoreDelta: 0,
        reason: error.message === 'RPC timeout' ? 'rpc_timeout' : 'rpc_error',
        action: shouldPass ? 'error_pass' : 'error_fail',
        error: error.message,
        processingTimeMs: Date.now() - startTime
      };
      
      logger.error(`💥 ${this.name}: Processing error`, {
        mint,
        signature,
        ...result
      });
      
      return result;
    }
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
