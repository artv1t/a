const logger = require('../utils/logging');
const { Connection, PublicKey } = require('@solana/web3.js');

class HoldersFilter {
  constructor() {
    this.name = 'HoldersFilter';
    this.enabled = process.env.HOLDERS_ENABLED === 'true';
    this.critical = process.env.HOLDERS_CRITICAL === 'true';
    this.mode = process.env.HOLDERS_MODE || 'LOG_ONLY';
    
    this.cacheTtlMs = parseInt(process.env.HOLDERS_CACHE_TTL_MS) || 60000;
    this.rpcTimeoutMs = parseInt(process.env.HOLDERS_RPC_TIMEOUT_MS) || 2500;
    this.concurrency = parseInt(process.env.HOLDERS_CONCURRENCY) || 4;
    this.rateLimitQps = parseInt(process.env.HOLDERS_RATE_LIMIT_QPS) || 10;
    this.topN = parseInt(process.env.HOLDERS_TOP_N) || 20;
    
    this.top1MaxPct = parseFloat(process.env.HOLDERS_TOP1_MAX_PCT) || 5;
    this.top5MaxPct = parseFloat(process.env.HOLDERS_TOP5_MAX_PCT) || 10;
    this.top10MaxPct = parseFloat(process.env.HOLDERS_TOP10_MAX_PCT) || 20;
    this.teamMaxPct = parseFloat(process.env.HOLDERS_TEAM_MAX_PCT) || 15;
    this.newWalletsWarnPct = parseFloat(process.env.HOLDERS_NEW_WALLETS_WARN_PCT) || 40;
    this.newWalletsFailPct = parseFloat(process.env.HOLDERS_NEW_WALLETS_FAIL_PCT) || 60;
    this.newWalletAgeDays = parseInt(process.env.HOLDERS_NEW_WALLET_AGE_DAYS) || 7;
    this.verifyTxHistory = process.env.HOLDERS_VERIFY_TX_HISTORY === 'true';
    
    this.connection = new Connection(process.env.HELIUS_RPC, {
      commitment: 'confirmed',
      httpHeaders: {
        'Content-Type': 'application/json'
      }
    });
    
    this.cache = new Map();
    this.requestQueue = [];
    this.activeRequests = 0;
    this.lastRequestTime = 0;
    
    this.stats = {
      totalProcessed: 0,
      totalPassed: 0,
      totalFailed: 0,
      totalWarned: 0,
      cacheHits: 0,
      cacheMisses: 0,
      rpcErrors: 0,
      timeouts: 0,
      avgProcessingTimeMs: 0,
      startTime: Date.now()
    };
    
    this.knownContracts = new Set([
      '11111111111111111111111111111111',
      '1nc1nerator11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    ]);
    
    this.startStatsTimer();
    
    logger.info(`🔧 ${this.name}: Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      mode: this.mode,
      topN: this.topN,
      thresholds: {
        top1MaxPct: this.top1MaxPct,
        top5MaxPct: this.top5MaxPct,
        top10MaxPct: this.top10MaxPct,
        teamMaxPct: this.teamMaxPct,
        newWalletsWarnPct: this.newWalletsWarnPct,
        newWalletsFailPct: this.newWalletsFailPct
      }
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
      mode: this.mode,
      runtime: {
        ms: runtime,
        minutes: Math.round(runtimeMinutes * 10) / 10
      },
      processing: {
        totalProcessed: this.stats.totalProcessed,
        totalPassed: this.stats.totalPassed,
        totalFailed: this.stats.totalFailed,
        totalWarned: this.stats.totalWarned,
        passRate: this.stats.totalProcessed > 0 ? 
          Math.round((this.stats.totalPassed / this.stats.totalProcessed) * 1000) / 10 + '%' : '0%',
        warnRate: this.stats.totalProcessed > 0 ? 
          Math.round((this.stats.totalWarned / this.stats.totalProcessed) * 1000) / 10 + '%' : '0%'
      },
      performance: {
        avgProcessingTimeMs: this.stats.avgProcessingTimeMs,
        cacheHitRate: (this.stats.cacheHits + this.stats.cacheMisses) > 0 ? 
          Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 1000) / 10 + '%' : '0%',
        rpcErrors: this.stats.rpcErrors,
        timeouts: this.stats.timeouts
      },
      queue: {
        activeRequests: this.activeRequests,
        queuedRequests: this.requestQueue.length
      }
    };
    
    logger.info(`📊 ${this.name}: Statistics`, statsData);
  }
  
  async process(tokenData) {
    if (!this.enabled) {
      return this.createResult(true, 0, 'filter_disabled', 'passed');
    }
    
    const startTime = Date.now();
    this.stats.totalProcessed++;
    
    try {
      const mint = tokenData.mint;
      
      if (!this.isValidMint(mint)) {
        this.stats.totalFailed++;
        return this.createResult(false, -0.5, 'invalid_mint', 'failed', {}, startTime);
      }
      
      const cacheKey = `holders:${mint}|${this.topN}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        this.stats.cacheHits++;
        const result = { ...cached, usedCache: true };
        this.updateStats(result, startTime);
        return result;
      }
      
      this.stats.cacheMisses++;
      
      const analysis = await this.analyzeHolders(mint, tokenData);
      const result = this.makeDecision(analysis, startTime);
      
      this.setCache(cacheKey, result);
      this.updateStats(result, startTime);
      
      logger.info(`${result.pass ? '✅' : '❌'} ${this.name}: Token ${result.action}`, {
        mint: mint,
        signature: tokenData.signature,
        ...result
      });
      
      return result;
      
    } catch (error) {
      this.stats.totalFailed++;
      this.stats.rpcErrors++;
      
      logger.error(`💥 ${this.name}: Processing error`, {
        mint: tokenData.mint,
        signature: tokenData.signature,
        error: error.message,
        stack: error.stack
      });
      
      return this.createResult(false, -0.2, 'processing_error', 'failed', {
        error: error.message
      }, startTime);
    }
  }
  
  isValidMint(mint) {
    try {
      new PublicKey(mint);
      return true;
    } catch {
      return false;
    }
  }
  
  async analyzeHolders(mint, tokenData) {
    const analysis = {
      mint: mint,
      circulatingSupply: 0,
      topHolders: [],
      metrics: {
        top1Pct: 0,
        top5Pct: 0,
        top10Pct: 0,
        teamPct: 0,
        newWalletsPct: 0,
        numUniqueOwners: 0
      },
      evidence: []
    };
    
    try {
      const supplyInfo = await this.getTokenSupply(mint);
      if (!supplyInfo || supplyInfo.value.uiAmount === 0) {
        throw new Error('Invalid or zero supply');
      }
      
      analysis.circulatingSupply = supplyInfo.value.uiAmount;
      
      const largestAccounts = await this.getTokenLargestAccounts(mint);
      if (!largestAccounts || largestAccounts.value.length === 0) {
        throw new Error('No token accounts found');
      }
      
      const holders = [];
      const ownerSet = new Set();
      
      for (const account of largestAccounts.value.slice(0, this.topN)) {
        try {
          const accountInfo = await this.getAccountInfo(account.address);
          if (!accountInfo || !accountInfo.value) continue;
          
          const parsed = accountInfo.value.data.parsed;
          if (!parsed || !parsed.info) continue;
          
          const owner = parsed.info.owner;
          const amount = parsed.info.tokenAmount.uiAmount;
          
          if (this.shouldExcludeOwner(owner)) continue;
          
          const pct = (amount / analysis.circulatingSupply) * 100;
          
          const isTeam = await this.isTeamWallet(owner, tokenData);
          const isNew = await this.isNewWallet(owner);
          
          holders.push({
            owner: owner,
            amount: amount,
            pct: pct,
            isTeam: isTeam,
            isNew: isNew
          });
          
          ownerSet.add(owner);
          
        } catch (error) {
          logger.warn(`${this.name}: Error processing account ${account.address}`, {
            error: error.message
          });
        }
      }
      
      holders.sort((a, b) => b.amount - a.amount);
      analysis.topHolders = holders;
      analysis.metrics.numUniqueOwners = ownerSet.size;
      
      analysis.metrics.top1Pct = holders.length > 0 ? holders[0].pct : 0;
      analysis.metrics.top5Pct = holders.slice(0, 5).reduce((sum, h) => sum + h.pct, 0);
      analysis.metrics.top10Pct = holders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);
      analysis.metrics.teamPct = holders.filter(h => h.isTeam).reduce((sum, h) => sum + h.pct, 0);
      analysis.metrics.newWalletsPct = holders.filter(h => h.isNew).reduce((sum, h) => sum + h.pct, 0);
      
      if (holders.length > 0) {
        analysis.evidence = holders.slice(0, 3).map(h => ({
          owner: h.owner,
          amount: h.amount,
          pct: Math.round(h.pct * 100) / 100,
          isTeam: h.isTeam,
          isNew: h.isNew
        }));
      }
      
    } catch (error) {
      logger.error(`${this.name}: Analysis error for ${mint}`, {
        error: error.message
      });
      throw error;
    }
    
    return analysis;
  }
  
  shouldExcludeOwner(owner) {
    return this.knownContracts.has(owner) || 
           owner === '11111111111111111111111111111111' ||
           owner === '1nc1nerator11111111111111111111111111111111';
  }
  
  async isTeamWallet(owner, tokenData) {
    try {
      if (tokenData.metadata) {
        if (tokenData.metadata.updateAuthority === owner) return true;
        if (tokenData.metadata.creators && 
            tokenData.metadata.creators.some(c => c.address === owner)) return true;
      }
      
      if (this.verifyTxHistory) {
        const signatures = await this.getSignaturesForAddress(owner, { limit: 10 });
        if (signatures && signatures.length > 0) {
          const oldestSig = signatures[signatures.length - 1];
          const now = Date.now() / 1000;
          const sigTime = oldestSig.blockTime || now;
          
          if (now - sigTime < 3600) {
            return true;
          }
        }
      }
      
      return false;
    } catch (error) {
      logger.warn(`${this.name}: Error checking team wallet ${owner}`, {
        error: error.message
      });
      return false;
    }
  }
  
  async isNewWallet(owner) {
    try {
      const signatures = await this.getSignaturesForAddress(owner, { limit: 1 });
      if (!signatures || signatures.length === 0) return true;
      
      const firstSig = signatures[0];
      const now = Date.now() / 1000;
      const sigTime = firstSig.blockTime || now;
      const ageDays = (now - sigTime) / 86400;
      
      return ageDays < this.newWalletAgeDays;
    } catch (error) {
      logger.warn(`${this.name}: Error checking wallet age ${owner}`, {
        error: error.message
      });
      return false;
    }
  }
  
  makeDecision(analysis, startTime) {
    const { metrics } = analysis;
    let pass = true;
    let action = 'passed';
    let reason = 'holder_distribution_ok';
    let scoreDelta = 0.2;
    
    if (metrics.top1Pct > this.top1MaxPct) {
      pass = false;
      action = 'failed';
      reason = 'top1_concentration';
      scoreDelta = -0.4;
    } else if (metrics.top5Pct > this.top5MaxPct) {
      pass = false;
      action = 'failed';
      reason = 'top5_concentration';
      scoreDelta = -0.4;
    } else if (metrics.top10Pct > this.top10MaxPct) {
      if (this.mode === 'STRICT') {
        pass = false;
        action = 'failed';
        reason = 'top10_concentration';
        scoreDelta = -0.3;
      } else {
        action = 'warn';
        reason = 'top10_high';
        scoreDelta = -0.1;
      }
    } else if (metrics.teamPct > this.teamMaxPct) {
      pass = false;
      action = 'failed';
      reason = 'team_centralization';
      scoreDelta = -0.4;
    } else if (metrics.newWalletsPct > this.newWalletsFailPct) {
      pass = false;
      action = 'failed';
      reason = 'new_wallets_mass';
      scoreDelta = -0.4;
    } else if (metrics.newWalletsPct > this.newWalletsWarnPct) {
      action = 'warn';
      reason = 'new_wallets_suspicious';
      scoreDelta = -0.2;
    } else if (metrics.numUniqueOwners < 3) {
      action = 'warn';
      reason = 'too_few_owners';
      scoreDelta = -0.1;
    }
    
    if (this.mode === 'LOG_ONLY' && !pass) {
      pass = true;
      action = 'passed_log_only';
      scoreDelta = 0;
    }
    
    return this.createResult(pass, scoreDelta, reason, action, {
      circulatingSupply: analysis.circulatingSupply,
      ...metrics,
      topHolders: analysis.topHolders.slice(0, 5),
      evidence: analysis.evidence
    }, startTime);
  }
  
  createResult(pass, scoreDelta, reason, action, metrics = {}, startTime = Date.now()) {
    return {
      pass: pass,
      critical: this.critical,
      scoreDelta: scoreDelta,
      reason: reason,
      action: action,
      metrics: metrics,
      processingTimeMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      usedCache: false
    };
  }
  
  updateStats(result, startTime) {
    const processingTime = Date.now() - startTime;
    this.stats.avgProcessingTimeMs = 
      (this.stats.avgProcessingTimeMs * (this.stats.totalProcessed - 1) + processingTime) / 
      this.stats.totalProcessed;
    
    if (result.pass) {
      this.stats.totalPassed++;
    } else {
      this.stats.totalFailed++;
    }
    
    if (result.action === 'warn') {
      this.stats.totalWarned++;
    }
  }
  
  getFromCache(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }
    this.cache.delete(key);
    return null;
  }
  
  setCache(key, data) {
    this.cache.set(key, {
      data: data,
      timestamp: Date.now()
    });
  }
  
  async getTokenSupply(mint) {
    const mintPubkey = new PublicKey(mint);
    return await this.makeRpcCall('getTokenSupply', [mintPubkey]);
  }
  
  async getTokenLargestAccounts(mint) {
    const mintPubkey = new PublicKey(mint);
    return await this.makeRpcCall('getTokenLargestAccounts', [mintPubkey]);
  }
  
  async getAccountInfo(address) {
    const addressPubkey = new PublicKey(address);
    return await this.makeRpcCall('getParsedAccountInfo', [addressPubkey]);
  }
  
  async getSignaturesForAddress(address, options = {}) {
    const addressPubkey = new PublicKey(address);
    return await this.makeRpcCall('getSignaturesForAddress', [addressPubkey, options]);
  }
  
  async makeRpcCall(method, params) {
    return new Promise((resolve, reject) => {
      const request = { method, params, resolve, reject };
      this.requestQueue.push(request);
      this.processQueue();
    });
  }
  
  async processQueue() {
    if (this.activeRequests >= this.concurrency || this.requestQueue.length === 0) {
      return;
    }
    
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minInterval = 1000 / this.rateLimitQps;
    
    if (timeSinceLastRequest < minInterval) {
      setTimeout(() => this.processQueue(), minInterval - timeSinceLastRequest);
      return;
    }
    
    const request = this.requestQueue.shift();
    this.activeRequests++;
    this.lastRequestTime = now;
    
    try {
      const result = await Promise.race([
        this.connection[request.method](...request.params),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('RPC timeout')), this.rpcTimeoutMs)
        )
      ]);
      
      request.resolve(result);
    } catch (error) {
      if (error.message === 'RPC timeout') {
        this.stats.timeouts++;
      } else {
        this.stats.rpcErrors++;
      }
      request.reject(error);
    } finally {
      this.activeRequests--;
      setTimeout(() => this.processQueue(), 50);
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      mode: this.mode,
      cacheSize: this.cache.size,
      queueLength: this.requestQueue.length,
      activeRequests: this.activeRequests
    };
  }
  
  updateConfig(newConfig) {
    if (newConfig.HOLDERS_ENABLED !== undefined) {
      this.enabled = newConfig.HOLDERS_ENABLED === 'true';
    }
    if (newConfig.HOLDERS_MODE !== undefined) {
      this.mode = newConfig.HOLDERS_MODE;
    }
    if (newConfig.HOLDERS_TOP1_MAX_PCT !== undefined) {
      this.top1MaxPct = parseFloat(newConfig.HOLDERS_TOP1_MAX_PCT);
    }
    if (newConfig.HOLDERS_TOP5_MAX_PCT !== undefined) {
      this.top5MaxPct = parseFloat(newConfig.HOLDERS_TOP5_MAX_PCT);
    }
    if (newConfig.HOLDERS_TOP10_MAX_PCT !== undefined) {
      this.top10MaxPct = parseFloat(newConfig.HOLDERS_TOP10_MAX_PCT);
    }
    
    logger.info(`🔧 ${this.name}: Configuration updated`, {
      enabled: this.enabled,
      mode: this.mode,
      thresholds: {
        top1MaxPct: this.top1MaxPct,
        top5MaxPct: this.top5MaxPct,
        top10MaxPct: this.top10MaxPct
      }
    });
  }
}

module.exports = HoldersFilter;
