
const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logging');

class RenouncedFilter {
  constructor() {
    this.name = '03_renounced';
    this.enabled = process.env.RENOUNCED_FILTER_ENABLED !== 'false';
    this.critical = process.env.RENOUNCED_CRITICAL === 'true';
    this.timeout = parseInt(process.env.RENOUNCED_TIMEOUT_MS) || 1000;
    
    this.rpcUrl = process.env.HELIUS_RPC;
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    this.requireMintRenounced = process.env.RENOUNCED_REQUIRE_MINT_RENOUNCED !== 'false';
    this.requireFreezeRenounced = process.env.RENOUNCED_REQUIRE_FREEZE_RENOUNCED === 'true';
    this.penaltyNotRenounced = parseFloat(process.env.RENOUNCED_PENALTY_NOT_RENOUNCED) || -0.5;
    this.bonusRenounced = parseFloat(process.env.RENOUNCED_BONUS_RENOUNCED) || 0.3;
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      mintRenounced: 0,
      mintNotRenounced: 0,
      freezeRenounced: 0,
      freezeNotRenounced: 0,
      rpcErrors: 0,
      timeouts: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    
    logger.info(`🔒 ${this.name}: Renounced Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      timeout: this.timeout,
      requireMintRenounced: this.requireMintRenounced,
      requireFreezeRenounced: this.requireFreezeRenounced,
      penaltyNotRenounced: this.penaltyNotRenounced,
      bonusRenounced: this.bonusRenounced,
      rpcUrl: this.rpcUrl ? 'configured' : 'missing'
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
        mintRenounced: this.stats.mintRenounced,
        mintNotRenounced: this.stats.mintNotRenounced,
        freezeRenounced: this.stats.freezeRenounced,
        freezeNotRenounced: this.stats.freezeNotRenounced,
        rpcErrors: this.stats.rpcErrors,
        timeouts: this.stats.timeouts,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%',
        rpcSuccessRate: this.stats.processed > 0 ? 
          Math.round(((this.stats.processed - this.stats.rpcErrors) / this.stats.processed) * 1000) / 10 + '%' : '0%',
        mintRenouncedRate: this.stats.processed > 0 ? 
          Math.round((this.stats.mintRenounced / this.stats.processed) * 1000) / 10 + '%' : '0%'
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
          scoreDelta: -0.8,
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
        
        const mintAuthorityOption = data.readUInt32LE(0);
        const mintAuthority = mintAuthorityOption === 1 ? 
          new PublicKey(data.slice(4, 36)).toString() : null;
        
        const freezeAuthorityOption = data.readUInt32LE(45);
        let freezeAuthority = null;
        
        if (freezeAuthorityOption === 1) {
          const freezeAuthorityBytes = data.slice(46, 78);
          const isAllZeros = freezeAuthorityBytes.every(byte => byte === 0);
          
          if (!isAllZeros) {
            freezeAuthority = new PublicKey(freezeAuthorityBytes).toString();
          }
        }
        
        const supply = data.readBigUInt64LE(36);
        const decimals = data.readUInt8(44);
        
        mintInfo = {
          supply: supply.toString(),
          decimals,
          mintAuthority,
          freezeAuthority,
          mintRenounced: mintAuthority === null,
          freezeRenounced: freezeAuthority === null
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
      
      const renouncedChecks = [];
      let totalScoreDelta = 0;
      let criticalFailures = [];
      
      if (mintInfo.mintRenounced) {
        this.stats.mintRenounced++;
        renouncedChecks.push({
          check: 'mint_authority',
          result: 'renounced',
          reason: 'mint_authority_null',
          scoreDelta: this.bonusRenounced
        });
        totalScoreDelta += this.bonusRenounced;
      } else {
        this.stats.mintNotRenounced++;
        renouncedChecks.push({
          check: 'mint_authority',
          result: 'not_renounced',
          reason: 'mint_authority_present',
          scoreDelta: this.penaltyNotRenounced
        });
        totalScoreDelta += this.penaltyNotRenounced;
        
        if (this.requireMintRenounced) {
          criticalFailures.push('mint_authority_not_renounced');
        }
      }
      
      if (mintInfo.freezeRenounced) {
        this.stats.freezeRenounced++;
        renouncedChecks.push({
          check: 'freeze_authority',
          result: 'renounced',
          reason: 'freeze_authority_null',
          scoreDelta: this.bonusRenounced * 0.5
        });
        totalScoreDelta += this.bonusRenounced * 0.5;
      } else {
        this.stats.freezeNotRenounced++;
        renouncedChecks.push({
          check: 'freeze_authority',
          result: 'not_renounced',
          reason: 'freeze_authority_present',
          scoreDelta: this.penaltyNotRenounced * 0.3
        });
        totalScoreDelta += this.penaltyNotRenounced * 0.3;
        
        if (this.requireFreezeRenounced) {
          criticalFailures.push('freeze_authority_not_renounced');
        }
      }
      
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
        reason: passed ? 'renounced_checks_passed' : 'renounced_checks_failed',
        action: passed ? 'passed' : 'failed',
        mintInfo: mintInfo,
        renouncedChecks: renouncedChecks,
        criticalFailures: criticalFailures,
        processingTimeMs: Date.now() - startTime
      };
      
      logger.info(`${passed ? '✅' : '❌'} ${this.name}: Token ${passed ? 'passed' : 'failed'} renounced checks`, {
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
        critical: false,
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
        ((this.stats.processed - this.stats.rpcErrors) / this.stats.processed) * 100 : 0,
      mintRenouncedRate: this.stats.processed > 0 ? 
        (this.stats.mintRenounced / this.stats.processed) * 100 : 0
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
    if (config.requireMintRenounced !== undefined) this.requireMintRenounced = config.requireMintRenounced;
    if (config.requireFreezeRenounced !== undefined) this.requireFreezeRenounced = config.requireFreezeRenounced;
    if (config.timeout !== undefined) this.timeout = config.timeout;
    if (config.critical !== undefined) this.critical = config.critical;
    if (config.penaltyNotRenounced !== undefined) this.penaltyNotRenounced = config.penaltyNotRenounced;
    if (config.bonusRenounced !== undefined) this.bonusRenounced = config.bonusRenounced;
    
    logger.info(`🔧 ${this.name}: Configuration updated`, config);
  }
}

module.exports = RenouncedFilter;
