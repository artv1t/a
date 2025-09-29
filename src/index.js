
const dotenv = require('dotenv');
dotenv.config();

const logger = require('./utils/logging');
const HeliusListener = require('./listeners/heliusListener');

class SalonSniper {
  constructor() {
    this.heliusListener = null;
    this.isRunning = false;
  }

  async start() {
    try {
      logger.info('🎯 SalonSniper Starting...');
      logger.info('📁 Project structure loaded');
      logger.info('⚙️  Configuration loaded');
      
      this.validateConfig();
      
      logger.info('🚀 Step 2: Initializing Helius Listener');
      this.heliusListener = new HeliusListener();
      
      this.heliusListener.onBatch(async (batchData) => {
        logger.info('📦 Received batch', {
          mintCount: batchData.mints.length,
          eventCount: batchData.eventCount,
          signatureCount: batchData.signatures.length
        });
        
        if (batchData.mints.length > 0) {
          logger.info('🪙 Sample mints', {
            mints: batchData.mints.slice(0, 3),
            totalCount: batchData.mints.length
          });
        }
      });
      
      await this.heliusListener.start();
      this.isRunning = true;
      
      logger.info('✅ SalonSniper Step 2 running successfully');
      logger.info('📋 Next: Step 3 - Pipeline and Filters (awaiting approval)');
      
    } catch (error) {
      logger.error('Failed to start SalonSniper', { error: error.message });
      process.exit(1);
    }
  }

  validateConfig() {
    const required = ['HELIUS_WS', 'HELIUS_RPC'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    
    logger.info('✅ Configuration validated');
  }

  async stop() {
    logger.info('🛑 Graceful shutdown initiated');
    this.isRunning = false;
    
    if (this.heliusListener) {
      await this.heliusListener.stop();
    }
    
    logger.info('✅ SalonSniper stopped');
  }
}

const bot = new SalonSniper();

process.on('SIGTERM', async () => {
  await bot.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await bot.stop();
  process.exit(0);
});

bot.start().catch(error => {
  console.error('Failed to start SalonSniper:', error.message);
  process.exit(1);
});
