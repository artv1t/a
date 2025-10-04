
const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logging');

class LPProtectionFilter {
  constructor() {
    this.name = '06_lpProtection';
    this.enabled = process.env.LP_PROTECTION_FILTER_ENABLED !== 'false';
    this.critical = process.env.LP_PROTECTION_CRITICAL === 'true';
    this.timeout = parseInt(process.env.LP_PROTECTION_TIMEOUT_MS) || 700;
    
    this.rpcUrl = process.env.HELIUS_RPC;
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    this.minBurnPercentage = parseFloat(process.env.LP_PROTECTION_MIN_BURN_PCT) || 80;
    this.maxDevHoldingsPercentage = parseFloat(process.env.LP_PROTECTION_MAX_DEV_HOLDINGS_PCT) || 5;
    this.penaltyNoBurn = parseFloat(process.env.LP_PROTECTION_PENALTY_NO_BURN) || -0.8;
    this.bonusHighBurn = parseFloat(process.env.LP_PROTECTION_BONUS_HIGH_BURN) || 0.3;
    this.bonusLocked = parseFloat(process.env.LP_PROTECTION_BONUS_LOCKED) || 0.2;
    
    this.whitelistedLockContracts = new Set([
      '11111111111111111111111111111111',
      'TeamTokenLockupContract11111111111111',
      'UnicryptLockContract1111111111111111',
      'PinkLockContract111111111111111111111'
    ]);
    
    this.burnAddress = '11111111111111111111111111111111';
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      hasLPTokens: 0,
      burnedLP: 0,
      lockedLP: 0,
      fakeBurn: 0,
      highBurn: 0,
      mediumBurn: 0,
      lowBurn: 0,
      noBurn: 0,
      rpcErrors: 0,
      timeouts: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    
    logger.info(`🛡️ ${this.name}: LP Protection Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      timeout: this.timeout,
      minBurnPercentage: this.minBurnPercentage,
      maxDevHoldingsPercentage: this.maxDevHoldingsPercentage,
      whitelistedContracts: this.whitelistedLockContracts.size,
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
        hasLPTokens: this.stats.hasLPTokens,
        burnedLP: this.stats.burnedLP,
        lockedLP: this.stats.lockedLP,
        fakeBurn: this.stats.fakeBurn,
        highBurn: this.stats.highBurn,
        mediumBurn: this.stats.mediumBurn,
        lowBurn: this.stats.lowBurn,
        noBurn: this.stats.noBurn,
        rpcErrors: this.stats.rpcErrors,
        timeouts: this.stats.timeouts,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%',
        lpTokenRate: this.stats.processed > 0 ? 
          Math.round((this.stats.hasLPTokens / this.stats.processed) * 1000) / 10 + '%' : '0%',
        burnRate: this.stats.hasLPTokens > 0 ? 
          Math.round((this.stats.burnedLP / this.stats.hasLPTokens) * 1000) / 10 + '%' : '0%'
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
      
      const lpAnalysis = await Promise.race([
        this.analyzeLPProtection(mintPubkey),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('LP analysis timeout')), this.timeout)
        )
      ]);
      
      if (!lpAnalysis) {
        this.stats.failed++;
        
        const result = {
          pass: !this.critical,
          critical: false,
          scoreDelta: 0,
          reason: 'lp_analysis_failed',
          action: this.critical ? 'failed' : 'passed_with_warning',
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`⚠️ ${this.name}: LP analysis failed`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      this.stats.hasLPTokens++;
      
      const { burnPercentage, isLocked, devHoldings, totalSupply, burnedAmount } = lpAnalysis;
      
      if (burnPercentage >= 90) {
        this.stats.highBurn++;
      } else if (burnPercentage >= 70) {
        this.stats.mediumBurn++;
      } else if (burnPercentage >= 30) {
        this.stats.lowBurn++;
      } else {
        this.stats.noBurn++;
      }
      
      if (burnPercentage >= this.minBurnPercentage) {
        this.stats.burnedLP++;
      }
      
      if (isLocked) {
        this.stats.lockedLP++;
      }
      
      if (devHoldings > this.maxDevHoldingsPercentage && burnPercentage < 50) {
        this.stats.fakeBurn++;
      }
      
      let passed = false;
      let scoreDelta = 0;
      let reason = '';
      
      if (isLocked) {
        passed = true;
        scoreDelta = this.bonusLocked;
        reason = 'lp_tokens_locked';
      } else if (burnPercentage >= this.minBurnPercentage) {
        passed = true;
        if (burnPercentage >= 95) {
          scoreDelta = this.bonusHighBurn;
        } else if (burnPercentage >= 85) {
          scoreDelta = this.bonusHighBurn * 0.7;
        } else {
          scoreDelta = this.bonusHighBurn * 0.4;
        }
        reason = 'high_lp_burn_rate';
      } else if (devHoldings > this.maxDevHoldingsPercentage) {
        passed = false;
        scoreDelta = this.penaltyNoBurn;
        reason = 'high_dev_lp_holdings';
      } else {
        passed = false;
        scoreDelta = this.penaltyNoBurn * 0.6;
        reason = 'insufficient_lp_burn';
      }
      
      if (passed) {
        this.stats.passed++;
      } else {
        this.stats.failed++;
      }
      
      const result = {
        pass: passed,
        critical: this.critical && !passed,
        scoreDelta: scoreDelta,
        reason: reason,
        action: passed ? 'passed' : 'failed',
        lpAnalysis: {
          totalSupply: totalSupply,
          burnedAmount: burnedAmount,
          burnPercentage: Math.round(burnPercentage * 100) / 100,
          isLocked: isLocked,
          devHoldings: Math.round(devHoldings * 100) / 100,
          riskLevel: this.getRiskLevel(burnPercentage, devHoldings, isLocked)
        },
        processingTimeMs: Date.now() - startTime
      };
      
      logger.info(`${passed ? '✅' : '❌'} ${this.name}: Token ${passed ? 'passed' : 'failed'} LP protection checks`, {
        mint,
        signature,
        ...result
      });
      
      return result;
      
    } catch (error) {
      if (error.message === 'LP analysis timeout') {
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
        reason: error.message === 'LP analysis timeout' ? 'lp_analysis_timeout' : 'rpc_error',
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
  
  async analyzeLPProtection(mintPubkey) {
    try {
      const lpMintAddress = await this.findLPMint(mintPubkey);
      
      if (!lpMintAddress) {
        return null;
      }
      
      const [supplyInfo, largestAccounts] = await Promise.all([
        this.connection.getTokenSupply(lpMintAddress),
        this.connection.getTokenLargestAccounts(lpMintAddress)
      ]);
      
      if (!supplyInfo?.value || !largestAccounts?.value) {
        return null;
      }
      
      const totalSupply = parseFloat(supplyInfo.value.amount);
      const accounts = largestAccounts.value;
      
      let burnedAmount = 0;
      let lockedAmount = 0;
      let devHoldings = 0;
      let isLocked = false;
      
      for (const account of accounts) {
        const amount = parseFloat(account.amount);
        const address = account.address;
        
        if (address === this.burnAddress) {
          burnedAmount += amount;
        } else if (this.whitelistedLockContracts.has(address)) {
          lockedAmount += amount;
          isLocked = true;
        } else {
          const accountInfo = await this.connection.getAccountInfo(new PublicKey(address));
          if (accountInfo && accountInfo.owner.toString() !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
            devHoldings += (amount / totalSupply) * 100;
          }
        }
      }
      
      const burnPercentage = (burnedAmount / totalSupply) * 100;
      const lockPercentage = (lockedAmount / totalSupply) * 100;
      
      return {
        totalSupply: totalSupply,
        burnedAmount: burnedAmount,
        lockedAmount: lockedAmount,
        burnPercentage: burnPercentage,
        lockPercentage: lockPercentage,
        devHoldings: devHoldings,
        isLocked: isLocked || lockPercentage > 50
      };
      
    } catch (error) {
      logger.error(`💥 ${this.name}: LP analysis error`, {
        mint: mintPubkey.toString(),
        error: error.message
      });
      return null;
    }
  }
  
  async findLPMint(tokenMint) {
    try {
      const RAYDIUM_AMM_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
      const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
      
      const [poolAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('amm_associated_seed'),
          SOL_MINT.toBuffer(),
          tokenMint.toBuffer()
        ],
        RAYDIUM_AMM_PROGRAM
      );
      
      const poolAccountInfo = await this.connection.getAccountInfo(poolAddress);
      
      if (!poolAccountInfo || !poolAccountInfo.data) {
        return null;
      }
      
      const data = poolAccountInfo.data;
      
      if (data.length < 752) {
        return null;
      }
      
      const lpMintBytes = data.slice(400, 432);
      const lpMintAddress = new PublicKey(lpMintBytes);
      
      return lpMintAddress;
      
    } catch (error) {
      return null;
    }
  }
  
  getRiskLevel(burnPercentage, devHoldings, isLocked) {
    if (isLocked || burnPercentage >= 95) {
      return 'LOW';
    } else if (burnPercentage >= 80 && devHoldings <= 5) {
      return 'MEDIUM';
    } else if (burnPercentage >= 50) {
      return 'HIGH';
    } else {
      return 'CRITICAL';
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0,
      lpTokenRate: this.stats.processed > 0 ? 
        (this.stats.hasLPTokens / this.stats.processed) * 100 : 0,
      burnRate: this.stats.hasLPTokens > 0 ? 
        (this.stats.burnedLP / this.stats.hasLPTokens) * 100 : 0
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
    if (config.minBurnPercentage !== undefined) this.minBurnPercentage = config.minBurnPercentage;
    if (config.maxDevHoldingsPercentage !== undefined) this.maxDevHoldingsPercentage = config.maxDevHoldingsPercentage;
    if (config.timeout !== undefined) this.timeout = config.timeout;
    if (config.critical !== undefined) this.critical = config.critical;
    
    logger.info(`🔧 ${this.name}: Configuration updated`, config);
  }
}

module.exports = LPProtectionFilter;
