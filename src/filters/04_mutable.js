
const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logging');

class MutableFilter {
  constructor() {
    this.name = '04_mutable';
    this.enabled = process.env.MUTABLE_FILTER_ENABLED !== 'false';
    this.critical = process.env.MUTABLE_CRITICAL === 'true';
    this.timeout = parseInt(process.env.MUTABLE_TIMEOUT_MS) || 1000;
    
    this.rpcUrl = process.env.HELIUS_RPC;
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    this.penaltyMutable = parseFloat(process.env.MUTABLE_PENALTY_MUTABLE) || -0.3;
    this.bonusImmutable = parseFloat(process.env.MUTABLE_BONUS_IMMUTABLE) || 0.2;
    this.penaltyBlacklistedAuthority = parseFloat(process.env.MUTABLE_PENALTY_BLACKLISTED_AUTHORITY) || -1.0;
    this.bonusSocialLinks = parseFloat(process.env.MUTABLE_BONUS_SOCIAL_LINKS) || 0.1;
    
    this.blacklistedAuthorities = new Set([
    ]);
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      mutable: 0,
      immutable: 0,
      hasMetadata: 0,
      noMetadata: 0,
      hasSocialLinks: 0,
      blacklistedAuthority: 0,
      rpcErrors: 0,
      timeouts: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    
    logger.info(`🔧 ${this.name}: Mutable Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      timeout: this.timeout,
      penaltyMutable: this.penaltyMutable,
      bonusImmutable: this.bonusImmutable,
      penaltyBlacklistedAuthority: this.penaltyBlacklistedAuthority,
      bonusSocialLinks: this.bonusSocialLinks,
      blacklistedAuthorities: this.blacklistedAuthorities.size,
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
        mutable: this.stats.mutable,
        immutable: this.stats.immutable,
        hasMetadata: this.stats.hasMetadata,
        noMetadata: this.stats.noMetadata,
        hasSocialLinks: this.stats.hasSocialLinks,
        blacklistedAuthority: this.stats.blacklistedAuthority,
        rpcErrors: this.stats.rpcErrors,
        timeouts: this.stats.timeouts,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%',
        rpcSuccessRate: this.stats.processed > 0 ? 
          Math.round(((this.stats.processed - this.stats.rpcErrors) / this.stats.processed) * 1000) / 10 + '%' : '0%',
        mutableRate: this.stats.processed > 0 ? 
          Math.round((this.stats.mutable / this.stats.processed) * 1000) / 10 + '%' : '0%',
        metadataRate: this.stats.processed > 0 ? 
          Math.round((this.stats.hasMetadata / this.stats.processed) * 1000) / 10 + '%' : '0%'
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
      
      const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METADATA_PROGRAM_ID.toBuffer(),
          mintPubkey.toBuffer()
        ],
        METADATA_PROGRAM_ID
      );
      
      const accountInfo = await Promise.race([
        this.connection.getAccountInfo(metadataPDA),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('RPC timeout')), this.timeout)
        )
      ]);
      
      let metadataInfo = null;
      let mutabilityChecks = [];
      let totalScoreDelta = 0;
      let criticalFailures = [];
      
      if (!accountInfo || !accountInfo.data) {
        this.stats.noMetadata++;
        
        mutabilityChecks.push({
          check: 'metadata_existence',
          result: 'no_metadata',
          reason: 'metadata_account_not_found',
          scoreDelta: -0.1
        });
        totalScoreDelta += -0.1;
        
      } else {
        this.stats.hasMetadata++;
        
        try {
          const data = accountInfo.data;
          
          let offset = 1; // Skip key byte
          
          const updateAuthority = new PublicKey(data.slice(offset, offset + 32)).toString();
          offset += 32;
          
          offset += 32;
          
          const nameLength = data.readUInt32LE(offset);
          offset += 4;
          const name = data.slice(offset, offset + nameLength).toString('utf8').replace(/\0/g, '');
          offset += nameLength;
          
          const symbolLength = data.readUInt32LE(offset);
          offset += 4;
          const symbol = data.slice(offset, offset + symbolLength).toString('utf8').replace(/\0/g, '');
          offset += symbolLength;
          
          const uriLength = data.readUInt32LE(offset);
          offset += 4;
          const uri = data.slice(offset, offset + uriLength).toString('utf8').replace(/\0/g, '');
          offset += uriLength;
          
          const sellerFeeBasisPoints = data.readUInt16LE(offset);
          offset += 2;
          
          const hasCreators = data.readUInt8(offset);
          offset += 1;
          
          if (hasCreators) {
            const creatorsLength = data.readUInt32LE(offset);
            offset += 4 + (creatorsLength * 34); // Each creator is 34 bytes
          }
          
          const primarySaleHappened = data.readUInt8(offset);
          offset += 1;
          
          const isMutable = data.readUInt8(offset) === 1;
          
          metadataInfo = {
            updateAuthority,
            name: name.trim(),
            symbol: symbol.trim(),
            uri: uri.trim(),
            sellerFeeBasisPoints,
            primarySaleHappened: primarySaleHappened === 1,
            isMutable
          };
          
          if (isMutable) {
            this.stats.mutable++;
            mutabilityChecks.push({
              check: 'mutability',
              result: 'mutable',
              reason: 'metadata_is_mutable',
              scoreDelta: this.penaltyMutable
            });
            totalScoreDelta += this.penaltyMutable;
          } else {
            this.stats.immutable++;
            mutabilityChecks.push({
              check: 'mutability',
              result: 'immutable',
              reason: 'metadata_is_immutable',
              scoreDelta: this.bonusImmutable
            });
            totalScoreDelta += this.bonusImmutable;
          }
          
          if (this.blacklistedAuthorities.has(updateAuthority)) {
            this.stats.blacklistedAuthority++;
            mutabilityChecks.push({
              check: 'update_authority',
              result: 'blacklisted',
              reason: 'update_authority_blacklisted',
              scoreDelta: this.penaltyBlacklistedAuthority
            });
            totalScoreDelta += this.penaltyBlacklistedAuthority;
            criticalFailures.push('blacklisted_update_authority');
          } else {
            mutabilityChecks.push({
              check: 'update_authority',
              result: 'clean',
              reason: 'update_authority_not_blacklisted',
              scoreDelta: 0
            });
          }
          
          const hasSocialLinks = uri && (
            uri.includes('twitter.com') || 
            uri.includes('telegram.org') || 
            uri.includes('discord.gg') ||
            uri.includes('github.com')
          );
          
          if (hasSocialLinks) {
            this.stats.hasSocialLinks++;
            mutabilityChecks.push({
              check: 'social_links',
              result: 'has_social_links',
              reason: 'uri_contains_social_links',
              scoreDelta: this.bonusSocialLinks
            });
            totalScoreDelta += this.bonusSocialLinks;
          } else {
            mutabilityChecks.push({
              check: 'social_links',
              result: 'no_social_links',
              reason: 'uri_no_social_links',
              scoreDelta: 0
            });
          }
          
        } catch (parseError) {
          this.stats.noMetadata++;
          
          mutabilityChecks.push({
            check: 'metadata_parsing',
            result: 'parse_error',
            reason: 'failed_to_parse_metadata',
            scoreDelta: -0.2,
            error: parseError.message
          });
          totalScoreDelta += -0.2;
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
        reason: passed ? 'mutable_checks_passed' : 'mutable_checks_failed',
        action: passed ? 'passed' : 'failed',
        metadataInfo: metadataInfo,
        mutabilityChecks: mutabilityChecks,
        criticalFailures: criticalFailures,
        processingTimeMs: Date.now() - startTime
      };
      
      logger.info(`${passed ? '✅' : '❌'} ${this.name}: Token ${passed ? 'passed' : 'failed'} mutable checks`, {
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
      mutableRate: this.stats.processed > 0 ? 
        (this.stats.mutable / this.stats.processed) * 100 : 0,
      metadataRate: this.stats.processed > 0 ? 
        (this.stats.hasMetadata / this.stats.processed) * 100 : 0
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
    if (config.penaltyMutable !== undefined) this.penaltyMutable = config.penaltyMutable;
    if (config.bonusImmutable !== undefined) this.bonusImmutable = config.bonusImmutable;
    if (config.penaltyBlacklistedAuthority !== undefined) this.penaltyBlacklistedAuthority = config.penaltyBlacklistedAuthority;
    if (config.bonusSocialLinks !== undefined) this.bonusSocialLinks = config.bonusSocialLinks;
    if (config.timeout !== undefined) this.timeout = config.timeout;
    if (config.critical !== undefined) this.critical = config.critical;
    
    logger.info(`🔧 ${this.name}: Configuration updated`, config);
  }
  
  addBlacklistedAuthority(authority) {
    this.blacklistedAuthorities.add(authority);
    logger.info(`🚫 ${this.name}: Added blacklisted authority`, { authority });
  }
  
  removeBlacklistedAuthority(authority) {
    this.blacklistedAuthorities.delete(authority);
    logger.info(`✅ ${this.name}: Removed blacklisted authority`, { authority });
  }
}

module.exports = MutableFilter;
