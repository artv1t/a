
const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logging');

class PoolSizeFilter {
  constructor() {
    this.name = '07_poolSize';
    this.enabled = process.env.POOL_SIZE_FILTER_ENABLED !== 'false';
    this.critical = process.env.POOL_SIZE_CRITICAL === 'true';
    this.timeout = parseInt(process.env.POOL_SIZE_TIMEOUT_MS) || 700;
    
    this.rpcUrl = process.env.HELIUS_RPC;
    this.restApiUrl = process.env.HELIUS_TX_HISTORY;
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    this.minLiqQuote = parseFloat(process.env.POOL_MIN_LIQ_QUOTE) || 1000;
    this.minVolWindowQuote = parseFloat(process.env.POOL_MIN_VOL_WINDOW_QUOTE) || 200;
    this.minTurnover = parseFloat(process.env.POOL_MIN_TURNOVER) || 0.5;
    this.poolSizeMode = process.env.POOLSIZE_MODE || 'BLOCKING';
    this.lookbackMin = parseInt(process.env.LOOKBACK_MIN) || 5;
    this.lookbackTxCount = parseInt(process.env.POOL_LOOKBACK_TX_COUNT) || 150;
    
    this.quoteTokens = [
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  // USDT
    ];
    
    this.ammPrograms = [
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
      '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca
      'Dooar9JkhdZ7J3LHN3A7YCuoGRUggXhQaG4kijfLGU2j'  // Meteora
    ];
    
    this.poolCache = new Map();
    this.volumeCache = new Map();
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      poolsFound: 0,
      noPoolsFound: 0,
      lowLiquidity: 0,
      lowVolume: 0,
      lowTurnover: 0,
      rpcErrors: 0,
      timeouts: 0,
      cacheHits: 0,
      cacheMisses: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    
    logger.info(`💰 ${this.name}: Pool Size Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      timeout: this.timeout,
      minLiqQuote: this.minLiqQuote,
      minVolWindowQuote: this.minVolWindowQuote,
      minTurnover: this.minTurnover,
      poolSizeMode: this.poolSizeMode,
      lookbackMin: this.lookbackMin,
      lookbackTxCount: this.lookbackTxCount,
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
        poolsFound: this.stats.poolsFound,
        noPoolsFound: this.stats.noPoolsFound,
        lowLiquidity: this.stats.lowLiquidity,
        lowVolume: this.stats.lowVolume,
        lowTurnover: this.stats.lowTurnover,
        rpcErrors: this.stats.rpcErrors,
        timeouts: this.stats.timeouts,
        cacheHits: this.stats.cacheHits,
        cacheMisses: this.stats.cacheMisses,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%',
        poolFoundRate: this.stats.processed > 0 ? 
          Math.round((this.stats.poolsFound / this.stats.processed) * 1000) / 10 + '%' : '0%',
        cacheHitRate: (this.stats.cacheHits + this.stats.cacheMisses) > 0 ? 
          Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 1000) / 10 + '%' : '0%'
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
      
      const cacheKey = `pools_${mint}`;
      let poolData = this.poolCache.get(cacheKey);
      
      if (poolData) {
        this.stats.cacheHits++;
      } else {
        this.stats.cacheMisses++;
        poolData = await this.findTokenPools(mintPubkey);
        
        if (poolData.pools.length > 0) {
          this.poolCache.set(cacheKey, poolData);
          setTimeout(() => this.poolCache.delete(cacheKey), 300000); // 5 min cache
        }
      }
      
      if (poolData.pools.length === 0) {
        this.stats.noPoolsFound++;
        
        const result = {
          pass: true,
          critical: false,
          scoreDelta: 0,
          reason: 'no_pools_found',
          action: 'passed_no_pools',
          poolData: poolData,
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`⚠️ ${this.name}: No pools found`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      this.stats.poolsFound++;
      
      let bestPool = null;
      let maxLiquidity = 0;
      
      for (const pool of poolData.pools) {
        const poolAnalysis = await this.analyzePool(pool);
        
        if (poolAnalysis.liquidityQuote > maxLiquidity) {
          maxLiquidity = poolAnalysis.liquidityQuote;
          bestPool = {
            ...pool,
            analysis: poolAnalysis
          };
        }
      }
      
      if (!bestPool) {
        this.stats.failed++;
        
        const result = {
          pass: false,
          critical: this.critical && this.poolSizeMode === 'BLOCKING',
          scoreDelta: -0.5,
          reason: 'pool_analysis_failed',
          action: 'failed',
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`❌ ${this.name}: Pool analysis failed`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      const { liquidityQuote, volumeWindowQuote, turnover, quoteType } = bestPool.analysis;
      
      let failureReasons = [];
      let passed = true;
      
      if (liquidityQuote < this.minLiqQuote) {
        failureReasons.push('low_liquidity');
        this.stats.lowLiquidity++;
        passed = false;
      }
      
      if (volumeWindowQuote < this.minVolWindowQuote) {
        failureReasons.push('low_volume');
        this.stats.lowVolume++;
        passed = false;
      }
      
      if (turnover < this.minTurnover) {
        failureReasons.push('low_turnover');
        this.stats.lowTurnover++;
        passed = false;
      }
      
      if (this.poolSizeMode === 'LOG_ONLY') {
        passed = true;
      }
      
      if (passed) {
        this.stats.passed++;
      } else {
        this.stats.failed++;
      }
      
      const result = {
        pass: passed,
        critical: this.critical && !passed && this.poolSizeMode === 'BLOCKING',
        scoreDelta: 0,
        reason: passed ? 
          `liq=${Math.round(liquidityQuote)}, vol=${Math.round(volumeWindowQuote)}, turnover=${turnover.toFixed(2)}` :
          failureReasons.join(', '),
        action: passed ? 'passed' : 'failed',
        poolData: {
          poolAddress: bestPool.address,
          quoteType: quoteType,
          liquidityQuote: liquidityQuote,
          volumeWindowQuote: volumeWindowQuote,
          turnover: turnover,
          failureReasons: failureReasons
        },
        processingTimeMs: Date.now() - startTime
      };
      
      const logPrefix = passed ? '✅' : '❌';
      const logAction = passed ? 'PASS' : `FAIL_${failureReasons.join('_').toUpperCase()}`;
      
      logger.info(`${logPrefix} ${this.name}: ${logAction}`, {
        mint,
        signature,
        pool: bestPool.address,
        quote: quoteType,
        liq: Math.round(liquidityQuote),
        vol: Math.round(volumeWindowQuote),
        turnover: turnover.toFixed(2),
        ...result
      });
      
      return result;
      
    } catch (error) {
      if (error.message === 'RPC timeout') {
        this.stats.timeouts++;
      } else {
        this.stats.rpcErrors++;
      }
      
      const shouldPass = !this.critical || this.poolSizeMode === 'LOG_ONLY';
      
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
  
  async findTokenPools(mintPubkey) {
    const pools = [];
    
    try {
      for (const ammProgram of this.ammPrograms) {
        const programPubkey = new PublicKey(ammProgram);
        
        const accounts = await Promise.race([
          this.connection.getProgramAccounts(programPubkey, {
            filters: [
              {
                memcmp: {
                  offset: 400, // Approximate offset for token mints in pool data
                  bytes: mintPubkey.toBase58()
                }
              }
            ]
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('RPC timeout')), this.timeout)
          )
        ]);
        
        for (const account of accounts) {
          try {
            const poolInfo = this.parsePoolAccount(account, mintPubkey);
            if (poolInfo) {
              pools.push(poolInfo);
            }
          } catch (parseError) {
            continue;
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      logger.error(`💥 ${this.name}: Error finding pools`, {
        mint: mintPubkey.toString(),
        error: error.message
      });
    }
    
    return { pools };
  }
  
  parsePoolAccount(account, targetMint) {
    try {
      const data = account.account.data;
      
      if (data.length < 200) return null;
      
      const tokenAMint = new PublicKey(data.slice(8, 40)).toString();
      const tokenBMint = new PublicKey(data.slice(40, 72)).toString();
      const tokenAVault = new PublicKey(data.slice(72, 104)).toString();
      const tokenBVault = new PublicKey(data.slice(104, 136)).toString();
      
      const targetMintStr = targetMint.toString();
      
      if (tokenAMint !== targetMintStr && tokenBMint !== targetMintStr) {
        return null;
      }
      
      let quoteMint, quoteVault, baseMint, baseVault;
      
      if (this.quoteTokens.includes(tokenAMint)) {
        quoteMint = tokenAMint;
        quoteVault = tokenAVault;
        baseMint = tokenBMint;
        baseVault = tokenBVault;
      } else if (this.quoteTokens.includes(tokenBMint)) {
        quoteMint = tokenBMint;
        quoteVault = tokenBVault;
        baseMint = tokenAMint;
        baseVault = tokenAVault;
      } else {
        return null;
      }
      
      return {
        address: account.pubkey.toString(),
        tokenAMint,
        tokenBMint,
        tokenAVault,
        tokenBVault,
        quoteMint,
        quoteVault,
        baseMint,
        baseVault
      };
      
    } catch (error) {
      return null;
    }
  }
  
  async analyzePool(pool) {
    try {
      const vaultPubkey = new PublicKey(pool.quoteVault);
      
      const accountInfo = await Promise.race([
        this.connection.getAccountInfo(vaultPubkey),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('RPC timeout')), this.timeout)
        )
      ]);
      
      if (!accountInfo || !accountInfo.data) {
        throw new Error('Vault account not found');
      }
      
      const vaultBalance = this.parseTokenAccountBalance(accountInfo.data);
      const liquidityQuote = vaultBalance * 2; // Approximate TVL
      
      const volumeData = await this.calculateVolume(pool.quoteVault);
      const volumeWindowQuote = volumeData.volume;
      
      const turnover = liquidityQuote > 0 ? volumeWindowQuote / liquidityQuote : 0;
      
      const quoteType = this.getQuoteType(pool.quoteMint);
      
      return {
        liquidityQuote,
        volumeWindowQuote,
        turnover,
        quoteType
      };
      
    } catch (error) {
      throw new Error(`Pool analysis failed: ${error.message}`);
    }
  }
  
  parseTokenAccountBalance(data) {
    try {
      if (data.length < 72) return 0;
      
      const amount = data.readBigUInt64LE(64);
      return Number(amount) / 1e9; // Assume 9 decimals for SOL/USDC
      
    } catch (error) {
      return 0;
    }
  }
  
  async calculateVolume(vaultAddress) {
    const cacheKey = `volume_${vaultAddress}`;
    const cached = this.volumeCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < 60000) { // 1 min cache
      return cached.data;
    }
    
    try {
      const url = this.restApiUrl.replace('{address}', vaultAddress);
      const response = await fetch(`${url}&limit=${this.lookbackTxCount}`);
      
      if (!response.ok) {
        throw new Error(`REST API error: ${response.status}`);
      }
      
      const transactions = await response.json();
      
      let totalVolume = 0;
      const cutoffTime = Date.now() - (this.lookbackMin * 60 * 1000);
      
      for (const tx of transactions) {
        if (tx.timestamp * 1000 < cutoffTime) break;
        
        if (tx.tokenTransfers) {
          for (const transfer of tx.tokenTransfers) {
            if (transfer.toTokenAccount === vaultAddress || 
                transfer.fromTokenAccount === vaultAddress) {
              totalVolume += Math.abs(transfer.tokenAmount || 0);
            }
          }
        }
      }
      
      const volumeData = { volume: totalVolume / 1e9 }; // Convert to SOL/USDC units
      
      this.volumeCache.set(cacheKey, {
        data: volumeData,
        timestamp: Date.now()
      });
      
      setTimeout(() => this.volumeCache.delete(cacheKey), 300000); // 5 min cleanup
      
      return volumeData;
      
    } catch (error) {
      logger.error(`💥 ${this.name}: Volume calculation error`, {
        vault: vaultAddress,
        error: error.message
      });
      
      return { volume: 0 };
    }
  }
  
  getQuoteType(quoteMint) {
    if (quoteMint === 'So11111111111111111111111111111111111111112') return 'SOL';
    if (quoteMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 'USDC';
    if (quoteMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 'USDT';
    return 'UNKNOWN';
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0,
      poolFoundRate: this.stats.processed > 0 ? 
        (this.stats.poolsFound / this.stats.processed) * 100 : 0,
      cacheHitRate: (this.stats.cacheHits + this.stats.cacheMisses) > 0 ? 
        (this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100 : 0
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
    if (config.minLiqQuote !== undefined) this.minLiqQuote = config.minLiqQuote;
    if (config.minVolWindowQuote !== undefined) this.minVolWindowQuote = config.minVolWindowQuote;
    if (config.minTurnover !== undefined) this.minTurnover = config.minTurnover;
    if (config.poolSizeMode !== undefined) this.poolSizeMode = config.poolSizeMode;
    if (config.lookbackMin !== undefined) this.lookbackMin = config.lookbackMin;
    if (config.timeout !== undefined) this.timeout = config.timeout;
    if (config.critical !== undefined) this.critical = config.critical;
    
    logger.info(`🔧 ${this.name}: Configuration updated`, config);
  }
}

module.exports = PoolSizeFilter;
