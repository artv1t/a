
const logger = require('../utils/logging');

class DedupFilter {
  constructor() {
    this.name = '01_dedup';
    this.seenMints = new Map(); // TTL cache for seen mints
    this.allowList = new Set(); // White list of approved mints
    this.denyList = new Set();  // Black list of banned mints
    
    this.ttlMs = parseInt(process.env.DEDUP_TTL_MS) || 30000; // 30 seconds
    this.cleanupIntervalMs = 10000; // Clean expired entries every 10 seconds
    
    this.stats = {
      processed: 0,
      duplicates: 0,
      allowed: 0,
      denied: 0,
      passed: 0,
      startTime: Date.now()
    };
    
    this.loadLists();
    
    this.startCleanupTimer();
    
    this.startStatsTimer();
    
    logger.info(`🔍 ${this.name}: Dedup Filter initialized`, {
      ttlMs: this.ttlMs,
      allowListSize: this.allowList.size,
      denyListSize: this.denyList.size
    });
  }
  
  loadLists() {
    this.allowList = new Set([
    ]);
    
    this.denyList = new Set([
    ]);
    
    logger.info(`📋 ${this.name}: Lists loaded`, {
      allowList: this.allowList.size,
      denyList: this.denyList.size
    });
  }
  
  startCleanupTimer() {
    setInterval(() => {
      this.cleanupExpiredEntries();
    }, this.cleanupIntervalMs);
  }
  
  startStatsTimer() {
    setInterval(() => {
      this.logStats();
    }, 10000); // Every 10 seconds
  }
  
  cleanupExpiredEntries() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [mint, timestamp] of this.seenMints.entries()) {
      if (now - timestamp > this.ttlMs) {
        this.seenMints.delete(mint);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`🧹 ${this.name}: Cleaned ${cleaned} expired entries`, {
        cacheSize: this.seenMints.size
      });
    }
  }
  
  logStats() {
    const runtime = Date.now() - this.stats.startTime;
    const runtimeMinutes = runtime / 60000;
    
    const statsData = {
      filter: this.name,
      runtime: {
        ms: runtime,
        minutes: Math.round(runtimeMinutes * 10) / 10
      },
      stats: {
        processed: this.stats.processed,
        duplicates: this.stats.duplicates,
        denied: this.stats.denied,
        allowed: this.stats.allowed,
        passed: this.stats.passed,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%',
        duplicateRate: this.stats.processed > 0 ? 
          Math.round((this.stats.duplicates / this.stats.processed) * 1000) / 10 + '%' : '0%'
      },
      cache: {
        size: this.seenMints.size,
        ttlMs: this.ttlMs
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
    
    try {
      if (this.denyList.has(mint)) {
        this.stats.denied++;
        
        const result = {
          pass: false,
          critical: true,
          scoreDelta: 0,
          reason: 'deny_list_match',
          action: 'denied',
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`❌ ${this.name}: Token denied (blacklisted)`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      const now = Date.now();
      if (this.seenMints.has(mint)) {
        const lastSeen = this.seenMints.get(mint);
        if (now - lastSeen < this.ttlMs) {
          this.stats.duplicates++;
          
          const result = {
            pass: false,
            critical: false,
            scoreDelta: 0,
            reason: 'TTL_duplicate',
            action: 'duplicate',
            lastSeenMs: now - lastSeen,
            processingTimeMs: Date.now() - startTime
          };
          
          logger.debug(`🔄 ${this.name}: Duplicate token filtered`, {
            mint,
            signature,
            ...result
          });
          
          return result;
        }
      }
      
      this.seenMints.set(mint, now);
      
      let scoreDelta = 0;
      let action = 'passed';
      let reason = 'new_token';
      
      if (this.allowList.has(mint)) {
        this.stats.allowed++;
        scoreDelta = 0.2; // Bonus for whitelisted tokens
        action = 'allowed';
        reason = 'allow_list_bonus';
        
        logger.info(`✅ ${this.name}: Token allowed (whitelisted)`, {
          mint,
          signature,
          scoreDelta,
          reason
        });
      }
      
      this.stats.passed++;
      
      const result = {
        pass: true,
        critical: false,
        scoreDelta,
        reason,
        action,
        processingTimeMs: Date.now() - startTime
      };
      
      logger.debug(`✅ ${this.name}: Token passed`, {
        mint,
        signature,
        ...result,
        cacheSize: this.seenMints.size
      });
      
      return result;
      
    } catch (error) {
      logger.error(`💥 ${this.name}: Processing error`, {
        mint,
        signature,
        error: error.message,
        stack: error.stack
      });
      
      return {
        pass: true,
        critical: false,
        scoreDelta: 0,
        reason: 'processing_error',
        action: 'error_pass',
        processingTimeMs: Date.now() - startTime
      };
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.seenMints.size,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0
    };
  }
  
  addToAllowList(mint) {
    this.allowList.add(mint);
    logger.info(`➕ ${this.name}: Added to allow list`, { mint });
  }
  
  addToDenyList(mint) {
    this.denyList.add(mint);
    logger.info(`🚫 ${this.name}: Added to deny list`, { mint });
  }
  
  clearCache() {
    this.seenMints.clear();
    logger.info(`🧹 ${this.name}: Cache cleared`);
  }
}

module.exports = DedupFilter;
