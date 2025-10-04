const logger = require('../utils/logging');
const DedupFilter = require('../filters/01_dedup');
const SanityFilter = require('../filters/02_sanity');
const RenouncedFilter = require('../filters/03_renounced');
const MutableFilter = require('../filters/04_mutable');
const LocalRouteGateFilter = require('../filters/05_localRouteGate');

class FilterPipeline {
  constructor() {
    this.name = 'FilterPipeline';
    this.enabled = process.env.FILTER_PIPELINE_ENABLED === 'true';
    this.scoreThreshold = parseFloat(process.env.FILTER_SCORE_THRESHOLD) || 0.0;
    
    this.filters = [
      new DedupFilter(),
      new SanityFilter(),
      new RenouncedFilter(),
      new MutableFilter(),
      new LocalRouteGateFilter()
    ];
    
    this.stats = {
      totalProcessed: 0,
      totalPassed: 0,
      totalFailed: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    
    logger.info(`🔧 ${this.name}: Pipeline initialized`, {
      enabled: this.enabled,
      scoreThreshold: this.scoreThreshold,
      filtersCount: this.filters.length,
      filters: this.filters.map(f => f.name)
    });
  }
  
  startStatsTimer() {
    setInterval(() => {
      this.logPipelineStats();
    }, 30000); // Every 30 seconds
  }
  
  logPipelineStats() {
    const runtime = Date.now() - this.stats.startTime;
    const runtimeMinutes = runtime / 60000;
    
    const pipelineStats = {
      pipeline: this.name,
      runtime: {
        ms: runtime,
        minutes: Math.round(runtimeMinutes * 10) / 10
      },
      stats: {
        totalProcessed: this.stats.totalProcessed,
        totalPassed: this.stats.totalPassed,
        totalFailed: this.stats.totalFailed,
        passRate: this.stats.totalProcessed > 0 ? 
          Math.round((this.stats.totalPassed / this.stats.totalProcessed) * 1000) / 10 + '%' : '0%'
      },
      throughput: {
        tokensPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.totalProcessed / runtimeMinutes) * 10) / 10 : 0,
        passedPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.totalPassed / runtimeMinutes) * 10) / 10 : 0
      },
      filterStats: this.filters.map(filter => ({
        name: filter.name,
        stats: filter.getStats()
      }))
    };
    
    logger.info(`📊 ${this.name}: Pipeline Statistics`, pipelineStats);
  }
  
  async processToken(tokenData) {
    if (!this.enabled) {
      return { pass: true, reason: 'pipeline_disabled', score: 0 };
    }
    
    const startTime = Date.now();
    this.stats.totalProcessed++;
    
    let totalScore = 0;
    const filterResults = [];
    
    try {
      for (const filter of this.filters) {
        const filterStart = Date.now();
        
        try {
          const result = await filter.process(tokenData);
          
          filterResults.push({
            filter: filter.name,
            result: result,
            timeMs: Date.now() - filterStart
          });
          
          if (result.critical && !result.pass) {
            this.stats.totalFailed++;
            
            const finalResult = {
              pass: false,
              reason: result.reason,
              score: totalScore,
              criticalFilter: filter.name,
              filterResults: filterResults,
              totalTimeMs: Date.now() - startTime
            };
            
            logger.info(`❌ ${this.name}: Token failed (critical)`, {
              mint: tokenData.mint,
              signature: tokenData.signature,
              ...finalResult
            });
            
            return finalResult;
          }
          
          totalScore += result.scoreDelta || 0;
          
        } catch (error) {
          logger.error(`💥 ${this.name}: Filter error`, {
            filter: filter.name,
            mint: tokenData.mint,
            error: error.message
          });
          
          filterResults.push({
            filter: filter.name,
            error: error.message,
            timeMs: Date.now() - filterStart
          });
        }
      }
      
      const passed = totalScore >= this.scoreThreshold;
      
      if (passed) {
        this.stats.totalPassed++;
      } else {
        this.stats.totalFailed++;
      }
      
      const finalResult = {
        pass: passed,
        score: totalScore,
        scoreThreshold: this.scoreThreshold,
        filterResults: filterResults,
        totalTimeMs: Date.now() - startTime
      };
      
      logger.info(`${passed ? '✅' : '❌'} ${this.name}: Token ${passed ? 'passed' : 'failed'}`, {
        mint: tokenData.mint,
        signature: tokenData.signature,
        ...finalResult
      });
      
      return finalResult;
      
    } catch (error) {
      this.stats.totalFailed++;
      
      logger.error(`💥 ${this.name}: Pipeline error`, {
        mint: tokenData.mint,
        signature: tokenData.signature,
        error: error.message,
        stack: error.stack
      });
      
      return {
        pass: false,
        reason: 'pipeline_error',
        score: totalScore,
        error: error.message,
        totalTimeMs: Date.now() - startTime
      };
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      filters: this.filters.map(filter => ({
        name: filter.name,
        stats: filter.getStats()
      }))
    };
  }
}

module.exports = FilterPipeline;
