
const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logging');

class LocalRouteGateFilter {
  constructor() {
    this.name = '05_localRouteGate';
    this.enabled = process.env.ROUTE_GATE_FILTER_ENABLED !== 'false';
    this.critical = process.env.ROUTE_GATE_CRITICAL === 'true';
    this.timeout = parseInt(process.env.ROUTE_GATE_TIMEOUT_MS) || 300;
    
    this.rpcUrl = process.env.HELIUS_RPC;
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    this.testAmountSOL = parseFloat(process.env.ROUTE_GATE_TEST_AMOUNT_SOL) || 0.02;
    this.cacheTTL = parseInt(process.env.ROUTE_GATE_CACHE_TTL_MS) || 300000;
    this.piThresholdHighLiq = parseFloat(process.env.ROUTE_GATE_PI_THRESHOLD_HIGH_LIQ) || 0.03;
    this.piThresholdMedLiq = parseFloat(process.env.ROUTE_GATE_PI_THRESHOLD_MED_LIQ) || 0.06;
    this.piThresholdLowLiq = parseFloat(process.env.ROUTE_GATE_PI_THRESHOLD_LOW_LIQ) || 0.10;
    this.highLiqThreshold = parseFloat(process.env.ROUTE_GATE_HIGH_LIQ_THRESHOLD) || 300;
    this.medLiqThreshold = parseFloat(process.env.ROUTE_GATE_MED_LIQ_THRESHOLD) || 100;
    
    this.knownPoolsCache = new Map();
    
    this.SOL_MINT = 'So11111111111111111111111111111111111111112';
    this.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      hasDirectPool: 0,
      solPools: 0,
      usdcPools: 0,
      lowPriceImpact: 0,
      mediumPriceImpact: 0,
      highPriceImpact: 0,
      noPoolFound: 0,
      cacheHits: 0,
      cacheMisses: 0,
      rpcErrors: 0,
      timeouts: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    
    logger.info(`🔄 ${this.name}: LocalRouteGate Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      timeout: this.timeout,
      testAmountSOL: this.testAmountSOL,
      cacheTTL: this.cacheTTL,
      piThresholds: {
        high: this.piThresholdHighLiq,
        medium: this.piThresholdMedLiq,
        low: this.piThresholdLowLiq
      },
      liquidityThresholds: {
        high: this.highLiqThreshold,
        medium: this.medLiqThreshold
      },
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
        hasDirectPool: this.stats.hasDirectPool,
        solPools: this.stats.solPools,
        usdcPools: this.stats.usdcPools,
        lowPriceImpact: this.stats.lowPriceImpact,
        mediumPriceImpact: this.stats.mediumPriceImpact,
        highPriceImpact: this.stats.highPriceImpact,
        noPoolFound: this.stats.noPoolFound,
        cacheHits: this.stats.cacheHits,
        cacheMisses: this.stats.cacheMisses,
        rpcErrors: this.stats.rpcErrors,
        timeouts: this.stats.timeouts,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%',
        poolDiscoveryRate: this.stats.processed > 0 ? 
          Math.round((this.stats.hasDirectPool / this.stats.processed) * 1000) / 10 + '%' : '0%',
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
      
      const cacheKey = mint;
      const cachedPool = this.knownPoolsCache.get(cacheKey);
      
      let poolData = null;
      
      if (cachedPool && (Date.now() - cachedPool.timestamp) < this.cacheTTL) {
        this.stats.cacheHits++;
        poolData = cachedPool.data;
        
        logger.debug(`🎯 ${this.name}: Cache hit for pool discovery`, {
          mint,
          poolAddress: poolData?.poolAddress,
          dex: poolData?.dex
        });
      } else {
        this.stats.cacheMisses++;
        
        poolData = await Promise.race([
          this.discoverPools(mintPubkey),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Pool discovery timeout')), this.timeout)
          )
        ]);
        
        if (poolData) {
          this.knownPoolsCache.set(cacheKey, {
            data: poolData,
            timestamp: Date.now()
          });
        }
      }
      
      if (!poolData) {
        this.stats.noPoolFound++;
        this.stats.failed++;
        
        const result = {
          pass: false,
          critical: this.critical,
          scoreDelta: -0.8,
          reason: 'no_direct_pool_found',
          action: 'failed',
          poolData: null,
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`❌ ${this.name}: No direct pool found`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      this.stats.hasDirectPool++;
      
      if (poolData.baseToken === 'SOL') {
        this.stats.solPools++;
      } else if (poolData.baseToken === 'USDC') {
        this.stats.usdcPools++;
      }
      
      const priceImpactData = this.calculatePriceImpact(poolData);
      const liquidityTier = this.getLiquidityTier(poolData.liquiditySOL);
      const threshold = this.getPriceImpactThreshold(liquidityTier);
      
      const buyPI = priceImpactData.buy;
      const sellPI = priceImpactData.sell;
      const maxPI = Math.max(buyPI, sellPI);
      
      if (maxPI <= 0.03) {
        this.stats.lowPriceImpact++;
      } else if (maxPI <= 0.06) {
        this.stats.mediumPriceImpact++;
      } else {
        this.stats.highPriceImpact++;
      }
      
      const passed = maxPI <= threshold;
      let scoreDelta = 0;
      
      if (passed) {
        this.stats.passed++;
        if (maxPI <= 0.02) {
          scoreDelta = 0.3;
        } else if (maxPI <= 0.05) {
          scoreDelta = 0.1;
        } else {
          scoreDelta = 0.0;
        }
      } else {
        this.stats.failed++;
        scoreDelta = -0.5;
      }
      
      const result = {
        pass: passed,
        critical: this.critical && !passed,
        scoreDelta: scoreDelta,
        reason: passed ? 'low_price_impact' : 'high_price_impact',
        action: passed ? 'passed' : 'failed',
        poolData: {
          poolAddress: poolData.poolAddress,
          dex: poolData.dex,
          baseToken: poolData.baseToken,
          reserveBase: poolData.reserveBase,
          reserveToken: poolData.reserveToken,
          liquiditySOL: poolData.liquiditySOL
        },
        priceImpact: {
          buy: Math.round(buyPI * 10000) / 100,
          sell: Math.round(sellPI * 10000) / 100,
          max: Math.round(maxPI * 10000) / 100,
          testAmount: this.testAmountSOL
        },
        liquidityTier: liquidityTier,
        threshold: Math.round(threshold * 10000) / 100,
        processingTimeMs: Date.now() - startTime
      };
      
      logger.info(`${passed ? '✅' : '❌'} ${this.name}: Token ${passed ? 'passed' : 'failed'} route gate checks`, {
        mint,
        signature,
        ...result
      });
      
      return result;
      
    } catch (error) {
      if (error.message === 'Pool discovery timeout') {
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
        reason: error.message === 'Pool discovery timeout' ? 'pool_discovery_timeout' : 'rpc_error',
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
  
  async discoverPools(mintPubkey) {
    try {
      const solPoolAddress = await this.findRaydiumPool(mintPubkey, this.SOL_MINT);
      if (solPoolAddress) {
        const poolData = await this.getPoolReserves(solPoolAddress, mintPubkey, this.SOL_MINT);
        if (poolData) {
          return {
            poolAddress: solPoolAddress.toString(),
            dex: 'raydium',
            baseToken: 'SOL',
            ...poolData
          };
        }
      }
      
      const usdcPoolAddress = await this.findRaydiumPool(mintPubkey, this.USDC_MINT);
      if (usdcPoolAddress) {
        const poolData = await this.getPoolReserves(usdcPoolAddress, mintPubkey, this.USDC_MINT);
        if (poolData) {
          return {
            poolAddress: usdcPoolAddress.toString(),
            dex: 'raydium',
            baseToken: 'USDC',
            ...poolData
          };
        }
      }
      
      return null;
      
    } catch (error) {
      logger.error(`💥 ${this.name}: Pool discovery error`, {
        mint: mintPubkey.toString(),
        error: error.message
      });
      return null;
    }
  }
  
  async findRaydiumPool(tokenMint, baseMint) {
    try {
      const RAYDIUM_AMM_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
      
      const [poolAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('amm_associated_seed'),
          new PublicKey(baseMint).toBuffer(),
          tokenMint.toBuffer()
        ],
        RAYDIUM_AMM_PROGRAM
      );
      
      const accountInfo = await this.connection.getAccountInfo(poolAddress);
      
      if (accountInfo && accountInfo.data) {
        return poolAddress;
      }
      
      return null;
      
    } catch (error) {
      return null;
    }
  }
  
  async getPoolReserves(poolAddress, tokenMint, baseMint) {
    try {
      const poolAccountInfo = await this.connection.getAccountInfo(poolAddress);
      
      if (!poolAccountInfo || !poolAccountInfo.data) {
        return null;
      }
      
      const data = poolAccountInfo.data;
      
      if (data.length < 752) {
        return null;
      }
      
      const baseReserve = data.readBigUInt64LE(504);
      const tokenReserve = data.readBigUInt64LE(512);
      
      const reserveBase = Number(baseReserve) / 1e9;
      const reserveToken = Number(tokenReserve) / 1e9;
      
      const liquiditySOL = baseMint === this.SOL_MINT ? reserveBase : reserveBase * 0.001;
      
      return {
        reserveBase: reserveBase,
        reserveToken: reserveToken,
        liquiditySOL: liquiditySOL
      };
      
    } catch (error) {
      logger.error(`💥 ${this.name}: Pool reserves error`, {
        poolAddress: poolAddress.toString(),
        error: error.message
      });
      return null;
    }
  }
  
  calculatePriceImpact(poolData) {
    const { reserveBase, reserveToken } = poolData;
    const dx = this.testAmountSOL;
    
    const buyPI = (dx * reserveToken) / ((reserveBase + dx) * reserveToken);
    const sellPI = (dx * reserveBase) / ((reserveToken + dx) * reserveBase);
    
    return {
      buy: Math.max(0, Math.min(1, buyPI)),
      sell: Math.max(0, Math.min(1, sellPI))
    };
  }
  
  getLiquidityTier(liquiditySOL) {
    if (liquiditySOL >= this.highLiqThreshold) {
      return 'high';
    } else if (liquiditySOL >= this.medLiqThreshold) {
      return 'medium';
    } else {
      return 'low';
    }
  }
  
  getPriceImpactThreshold(liquidityTier) {
    switch (liquidityTier) {
      case 'high':
        return this.piThresholdHighLiq;
      case 'medium':
        return this.piThresholdMedLiq;
      case 'low':
        return this.piThresholdLowLiq;
      default:
        return this.piThresholdLowLiq;
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0,
      poolDiscoveryRate: this.stats.processed > 0 ? 
        (this.stats.hasDirectPool / this.stats.processed) * 100 : 0,
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
    if (config.testAmountSOL !== undefined) this.testAmountSOL = config.testAmountSOL;
    if (config.cacheTTL !== undefined) this.cacheTTL = config.cacheTTL;
    if (config.piThresholdHighLiq !== undefined) this.piThresholdHighLiq = config.piThresholdHighLiq;
    if (config.piThresholdMedLiq !== undefined) this.piThresholdMedLiq = config.piThresholdMedLiq;
    if (config.piThresholdLowLiq !== undefined) this.piThresholdLowLiq = config.piThresholdLowLiq;
    if (config.timeout !== undefined) this.timeout = config.timeout;
    if (config.critical !== undefined) this.critical = config.critical;
    
    logger.info(`🔧 ${this.name}: Configuration updated`, config);
  }
}

module.exports = LocalRouteGateFilter;
