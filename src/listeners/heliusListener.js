
const WebSocket = require('ws');
const axios = require('axios');
const NodeCache = require('node-cache');
const { PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logging');

class HeliusListener {
  constructor(config = {}) {
    this.config = {
      wsUrl: process.env.HELIUS_WS || config.wsUrl,
      rpcUrl: process.env.HELIUS_RPC || config.rpcUrl,
      parseUrl: process.env.HELIUS_PARSE_TX || config.parseUrl,
      batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS) || 300,
      dedupTtlS: parseInt(process.env.DEDUP_TTL_S) || 30,
      restFallbackLimit: parseInt(process.env.REST_FALLBACK_LIMIT_PER_SEC) || 5,
      maxBacklog: parseInt(process.env.MAX_BACKLOG_EVENTS) || 10000,
      maxReconnectDelay: parseInt(process.env.WS_RECONNECT_MAX_DELAY_S) || 60,
      ...config
    };

    this.SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.lastMessageTime = null;
    this.subscriptionId = null;
    
    this.seenMints = new NodeCache({ 
      stdTTL: this.config.dedupTtlS,
      checkperiod: this.config.dedupTtlS / 2,
      useClones: false
    });
    
    this.eventQueue = [];
    this.batchTimer = null;
    this.isProcessingBatch = false;
    
    this.restCallTimes = [];
    
    this.metrics = {
      totalEvents: 0,
      dedupFiltered: 0,
      batchesProcessed: 0,
      restFallbacks: 0,
      reconnects: 0,
      lastEventTime: null
    };

    this.eventHandlers = [];
  }

  onBatch(handler) {
    this.eventHandlers.push(handler);
  }

  async start() {
    logger.info('🎯 Starting Helius Listener', {
      wsUrl: this.config.wsUrl?.replace(/api-key=[^&]+/, 'api-key=***'),
      batchWindow: this.config.batchWindowMs,
      dedupTtl: this.config.dedupTtlS
    });

    await this.connect();
    this.startHealthMonitoring();
  }

  async stop() {
    logger.info('🛑 Stopping Helius Listener');
    
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    
    if (this.ws) {
      this.ws.close();
    }
    
    if (this.eventQueue.length > 0) {
      await this.processBatch();
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      try {
        logger.info('🔌 Connecting to Helius WebSocket');
        
        this.ws = new WebSocket(this.config.wsUrl);
        
        this.ws.on('open', () => {
          logger.info('✅ WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.lastMessageTime = Date.now();
          
          this.subscribe();
          this.logHealth('ws_connected');
          resolve();
        });
        
        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });
        
        this.ws.on('close', (code, reason) => {
          logger.warn('❌ WebSocket closed', { code, reason: reason.toString() });
          this.isConnected = false;
          this.logHealth('ws_closed', { code, reason: reason.toString() });
          this.scheduleReconnect();
        });
        
        this.ws.on('error', (error) => {
          logger.error('💥 WebSocket error', { error: error.message });
          this.logHealth('ws_error', { error: error.message });
          reject(error);
        });
        
      } catch (error) {
        logger.error('Failed to create WebSocket connection', { error: error.message });
        reject(error);
      }
    });
  }

  subscribe() {
    const subscribeMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        {
          mentions: [this.SPL_TOKEN_PROGRAM_ID]
        },
        {
          commitment: 'confirmed'
        }
      ]
    };

    logger.info('📡 Subscribing to SPL Token Program logs (Developer plan) with REST Parse API fallback');
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      this.lastMessageTime = Date.now();
      
      if (message.id === 1 && message.result) {
        this.subscriptionId = message.result;
        logger.info('✅ Subscription confirmed', { subscriptionId: this.subscriptionId });
        return;
      }
      
      if (message.method === 'logsNotification' && message.params) {
        this.handleLogNotification(message.params);
      }
      
    } catch (error) {
      logger.error('Failed to parse WebSocket message', { 
        error: error.message,
        data: data.toString().slice(0, 200)
      });
    }
  }

  async handleLogNotification(params) {
    try {
      const { result } = params;
      const { value } = result;
      const { signature } = value;
      
      this.metrics.totalEvents++;
      this.metrics.lastEventTime = Date.now();
      
      logger.debug('📥 Received log notification', {
        signature,
        hasValue: !!value,
        hasLogs: !!(value && value.logs),
        logCount: value?.logs?.length || 0,
        eventNumber: this.metrics.totalEvents
      });
      
      if (!signature) {
        logger.warn('⚠️ No signature found in log notification', {
          resultStructure: Object.keys(result || {}),
          valueStructure: Object.keys(value || {})
        });
        return;
      }
      
      this.queueSignatureForBatch(signature);
      
    } catch (error) {
      logger.error('Failed to handle log notification', { 
        error: error.message,
        stack: error.stack
      });
    }
  }

  extractMintsFromTokenBalances(postTokenBalances) {
    const mints = new Set();
    
    logger.debug('🔍 Processing postTokenBalances', {
      count: postTokenBalances.length,
      sample: postTokenBalances.slice(0, 2)
    });
    
    for (const balance of postTokenBalances) {
      if (balance.mint) {
        try {
          new PublicKey(balance.mint);
          mints.add(balance.mint);
          logger.debug('✅ Valid mint found from postTokenBalances', { mint: balance.mint });
        } catch (error) {
          logger.debug('❌ Invalid mint address in postTokenBalances', { mint: balance.mint, error: error.message });
        }
      } else {
        logger.debug('⚠️ Balance entry missing mint field', { balance });
      }
    }
    
    const rawMints = Array.from(mints);
    const filteredMints = this.filterInterestingMints(rawMints);
    
    logger.debug('🎯 Final extracted mints from postTokenBalances', {
      rawCount: rawMints.length,
      filteredCount: filteredMints.length,
      mints: filteredMints.slice(0, 5)
    });
    
    return filteredMints;
  }

  extractMintsFromTokenTransfers(tokenTransfers) {
    const mints = new Set();
    
    logger.info('🔍 Processing tokenTransfers', {
      count: tokenTransfers.length,
      sample: tokenTransfers.slice(0, 2)
    });
    
    for (const transfer of tokenTransfers) {
      if (transfer.mint) {
        try {
          new PublicKey(transfer.mint);
          
          logger.info('🔍 Checking transfer validity', {
            mint: transfer.mint,
            hasTokenAmount: !!transfer.tokenAmount,
            tokenAmount: transfer.tokenAmount,
            hasFromAccount: !!transfer.fromTokenAccount,
            hasToAccount: !!transfer.toTokenAccount,
            fromTokenAccount: transfer.fromTokenAccount,
            toTokenAccount: transfer.toTokenAccount
          });
          
          if (this.isValidTokenTransfer(transfer)) {
            mints.add(transfer.mint);
            logger.info('✅ Valid mint found from tokenTransfers', { 
              mint: transfer.mint,
              fromTokenAccount: transfer.fromTokenAccount,
              toTokenAccount: transfer.toTokenAccount,
              tokenAmount: transfer.tokenAmount
            });
          } else {
            logger.info('⚠️ Token transfer filtered out by isValidTokenTransfer', { 
              mint: transfer.mint,
              reason: 'invalid_transfer_data',
              transfer: transfer
            });
          }
        } catch (error) {
          logger.info('❌ Invalid mint address in tokenTransfers', { 
            mint: transfer.mint, 
            error: error.message 
          });
        }
      } else {
        logger.info('⚠️ Transfer entry missing mint field', { transfer });
      }
    }
    
    const rawMints = Array.from(mints);
    const filteredMints = this.filterInterestingMints(rawMints);
    
    logger.info('🎯 Final extracted mints from tokenTransfers', {
      rawCount: rawMints.length,
      filteredCount: filteredMints.length,
      mints: filteredMints.slice(0, 5)
    });
    
    return filteredMints;
  }

  isValidTokenTransfer(transfer) {
    let amount = 0;
    if (typeof transfer.tokenAmount === 'number') {
      amount = transfer.tokenAmount;
    } else if (transfer.tokenAmount && typeof transfer.tokenAmount === 'object') {
      amount = parseFloat(transfer.tokenAmount.uiAmount || 0);
    } else {
      return false;
    }
    
    if (amount <= 0) {
      return false;
    }
    
    if (!transfer.fromTokenAccount && !transfer.toTokenAccount) {
      return false;
    }
    
    return true;
  }

  async scheduleRestFallback(signature) {
    if (!signature || typeof signature !== 'string') {
      logger.warn('⚠️ Invalid signature for REST fallback', { signature });
      return;
    }
    
    if (!this.canMakeRestCall()) {
      logger.warn('⚠️ REST fallback rate limit exceeded, skipping', { signature });
      return;
    }
    
    const maxRetries = 3;
    let attempt = 0;
    let lastError = null;
    
    while (attempt <= maxRetries) {
      try {
        this.metrics.restFallbacks++;
        this.recordRestCall();
        
        const url = `https://api.helius.xyz/v0/transactions?api-key=7c8922d6-1031-42c1-b4ee-bf5daa29abd4`;
        const requestBody = {
          transactions: [signature]
        };
        
        const backoffDelay = attempt > 0 ? Math.min(1000 * Math.pow(2, attempt - 1), 5000) : 0;
        if (backoffDelay > 0) {
          logger.debug('⏳ REST fallback backoff delay', { signature, attempt: attempt + 1, delay: backoffDelay });
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
        
        logger.debug('🔗 REST fallback request', { 
          signature, 
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          url: url.replace(/api-key=[^&]+/, 'api-key=***'),
          method: 'POST',
          backoffDelay
        });
        
        const response = await axios.post(url, requestBody, {
          timeout: 20000,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'SalonSniper/1.0',
            'X-Request-ID': `${signature.slice(0, 8)}-${Date.now()}`,
            'Cache-Control': 'no-cache'
          },
          validateStatus: (status) => status < 500
        });
        
        logger.debug('📥 REST fallback response', {
          signature,
          attempt: attempt + 1,
          status: response.status,
          hasData: !!response.data,
          isArray: Array.isArray(response.data),
          dataLength: response.data?.length || 0,
          responseTime: response.headers['x-response-time'] || 'unknown'
        });
        
        if (response.status >= 400 && response.status < 500) {
          logger.warn('⚠️ REST fallback client error, not retrying', {
            signature,
            status: response.status,
            statusText: response.statusText,
            attempt: attempt + 1
          });
          return;
        }
        
        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
          const transaction = response.data[0];
          
          logger.info('🔍 REST API response structure', {
            signature,
            attempt: attempt + 1,
            transactionKeys: transaction ? Object.keys(transaction) : [],
            hasTokenTransfers: !!(transaction && transaction.tokenTransfers),
            hasTokenBalances: !!(transaction && transaction.tokenBalances),
            hasPostTokenBalances: !!(transaction && transaction.meta && transaction.meta.postTokenBalances),
            hasAccountData: !!(transaction && transaction.accountData),
            hasInstructions: !!(transaction && transaction.instructions),
            hasEvents: !!(transaction && transaction.events),
            responseStructure: {
              type: typeof transaction,
              keys: transaction ? Object.keys(transaction).slice(0, 10) : []
            }
          });
          
          let allMints = new Set();
          let extractionSources = [];
          
          if (transaction.tokenTransfers && Array.isArray(transaction.tokenTransfers)) {
            const transferMints = this.extractMintsFromTokenTransfers(transaction.tokenTransfers);
            transferMints.forEach(mint => allMints.add(mint));
            extractionSources.push(`tokenTransfers(${transferMints.length})`);
            
            logger.info('✅ REST fallback - tokenTransfers extracted', {
              signature,
              attempt: attempt + 1,
              mintCount: transferMints.length,
              mints: transferMints.slice(0, 3),
              tokenTransfersCount: transaction.tokenTransfers.length
            });
          }
          
          if (transaction.tokenBalances && Array.isArray(transaction.tokenBalances)) {
            const balanceMints = this.extractMintsFromTokenBalances(transaction.tokenBalances);
            balanceMints.forEach(mint => allMints.add(mint));
            extractionSources.push(`tokenBalances(${balanceMints.length})`);
            
            logger.info('✅ REST fallback - tokenBalances extracted', {
              signature,
              attempt: attempt + 1,
              mintCount: balanceMints.length,
              mints: balanceMints.slice(0, 3),
              tokenBalancesCount: transaction.tokenBalances.length
            });
          }
          
          if (transaction.meta && transaction.meta.postTokenBalances && Array.isArray(transaction.meta.postTokenBalances)) {
            const postBalanceMints = this.extractMintsFromTokenBalances(transaction.meta.postTokenBalances);
            postBalanceMints.forEach(mint => allMints.add(mint));
            extractionSources.push(`postTokenBalances(${postBalanceMints.length})`);
            
            logger.info('✅ REST fallback - postTokenBalances extracted', {
              signature,
              attempt: attempt + 1,
              mintCount: postBalanceMints.length,
              mints: postBalanceMints.slice(0, 3),
              postTokenBalancesCount: transaction.meta.postTokenBalances.length
            });
          }
          
          const finalMints = Array.from(allMints);
          
          if (finalMints.length > 0) {
            logger.info('🎯 REST fallback combined success', {
              signature,
              attempt: attempt + 1,
              totalMintCount: finalMints.length,
              mints: finalMints.slice(0, 5),
              extractionSources: extractionSources.join(', '),
              combinedFromSources: extractionSources.length
            });
            
            this.queueEvent({
              signature,
              mints: finalMints,
              timestamp: Date.now(),
              source: 'rest_fallback_enhanced'
            });
            
            return;
          }
          else if (transaction.accountData && Array.isArray(transaction.accountData)) {
            for (const accountInfo of transaction.accountData) {
              if (accountInfo.account && accountInfo.account.includes('Token')) {
                logger.debug('🔍 Found Token account in accountData', {
                  signature,
                  account: accountInfo.account,
                  accountKeys: accountInfo ? Object.keys(accountInfo) : []
                });
              }
            }
            
            logger.debug('⚠️ REST fallback: found accountData but no mints extracted', {
              signature,
              attempt: attempt + 1,
              accountDataCount: transaction.accountData.length
            });
          }
          else {
            logger.debug('⚠️ REST fallback: no token data found', {
              signature,
              attempt: attempt + 1,
              transactionKeys: transaction ? Object.keys(transaction) : [],
              hasTokenTransfers: !!(transaction && transaction.tokenTransfers),
              hasTokenBalances: !!(transaction && transaction.tokenBalances),
              hasAccountData: !!(transaction && transaction.accountData),
              sampleTransaction: transaction ? JSON.stringify(transaction).slice(0, 500) : null
            });
          }
          
          
          return;
        } else {
          logger.debug('⚠️ REST fallback: invalid response format', {
            signature,
            attempt: attempt + 1,
            hasData: !!response.data,
            isArray: Array.isArray(response.data),
            dataType: typeof response.data
          });
        }
        
        return;
        
      } catch (error) {
        attempt++;
        
        const isRetryable = error.code === 'ECONNRESET' || 
                           error.code === 'ETIMEDOUT' ||
                           (error.response && error.response.status >= 500);
        
        if (attempt <= maxRetries && isRetryable) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          logger.warn('⚠️ REST fallback failed, retrying', { 
            signature, 
            attempt,
            maxRetries: maxRetries + 1,
            error: error.message,
            retryDelay: delay,
            isRetryable
          });
          
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        logger.error('REST fallback failed after retries', { 
          signature, 
          attempt,
          error: error.message,
          status: error.response?.status,
          statusText: error.response?.statusText,
          responseData: error.response?.data,
          url: error.config?.url?.replace(/api-key=[^&]+/, 'api-key=***')
        });
        
        return;
      }
    }
  }

  filterInterestingMints(mints) {
    const commonTokens = new Set([
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
      'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
      '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH
      '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E', // BTC
    ]);
    
    return mints.filter(mint => !commonTokens.has(mint));
  }

  canMakeRestCall() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    this.restCallTimes = this.restCallTimes.filter(time => time > oneSecondAgo);
    
    // Step 2.2 Enhancement: Burst capacity with sustained rate limiting
    const burstCapacity = Math.min(this.config.restFallbackLimit * 2, 15);
    const sustainedLimit = this.config.restFallbackLimit;
    
    // Allow burst for first few calls, then enforce sustained rate
    const recentCalls = this.restCallTimes.length;
    const canBurst = recentCalls < burstCapacity;
    const withinSustainedRate = recentCalls < sustainedLimit;
    
    // If we have made many calls recently, check longer window for sustained rate
    if (recentCalls >= sustainedLimit) {
      const longerWindowStart = now - 5000; // 5 second window
      const longerWindowCalls = this.restCallTimes.filter(time => time > longerWindowStart).length;
      const sustainedRateOk = longerWindowCalls < (sustainedLimit * 5);
      
      logger.debug('🚦 REST rate limit check - sustained rate', {
        recentCalls,
        longerWindowCalls,
        sustainedLimit,
        sustainedRateOk,
        burstCapacity
      });
      
      return sustainedRateOk;
    }
    
    logger.debug('🚦 REST rate limit check', {
      recentCalls,
      sustainedLimit,
      burstCapacity,
      canBurst,
      withinSustainedRate,
      allowed: canBurst || withinSustainedRate
    });
    
    return canBurst || withinSustainedRate;
  }

  recordRestCall() {
    const now = Date.now();
    this.restCallTimes.push(now);
    
    // Step 2.2 Enhancement: Track REST call performance metrics
    if (!this.metrics.restCallStats) {
      this.metrics.restCallStats = {
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        averageResponseTime: 0,
        lastCallTime: 0
      };
    }
    
    this.metrics.restCallStats.totalCalls++;
    this.metrics.restCallStats.lastCallTime = now;
  }

  queueSignatureForBatch(signature) {
    if (!this.signatureQueue) {
      this.signatureQueue = [];
    }
    
    this.signatureQueue.push({
      signature,
      timestamp: Date.now()
    });
    
    this.scheduleSignatureBatchProcessing();
  }

  scheduleSignatureBatchProcessing() {
    if (this.signatureBatchTimer || this.isProcessingSignatureBatch) {
      return;
    }
    
    this.signatureBatchTimer = setTimeout(() => {
      this.processSignatureBatch();
    }, this.config.batchWindowMs);
  }

  async processSignatureBatch() {
    if (this.isProcessingSignatureBatch || !this.signatureQueue || this.signatureQueue.length === 0) {
      return;
    }
    
    this.isProcessingSignatureBatch = true;
    this.signatureBatchTimer = null;
    
    const batch = [...this.signatureQueue];
    this.signatureQueue = [];
    
    logger.info('🔄 Processing signature batch', {
      batchSize: batch.length,
      rateLimitAllows: this.config.restFallbackLimit
    });
    
    const signaturestoProcess = batch.slice(0, this.config.restFallbackLimit);
    
    for (const item of signaturestoProcess) {
      if (this.canMakeRestCall()) {
        await this.scheduleRestFallback(item.signature);
        await new Promise(resolve => setTimeout(resolve, 200));
      } else {
        logger.debug('⚠️ Skipping signature due to rate limit', { signature: item.signature });
        break;
      }
    }
    
    this.isProcessingSignatureBatch = false;
    
    if (this.signatureQueue && this.signatureQueue.length > 0) {
      this.scheduleSignatureBatchProcessing();
    }
  }

  queueEvent(event) {
    const uniqueMints = this.deduplicateMints(event.mints);
    
    if (uniqueMints.length === 0) {
      this.metrics.dedupFiltered++;
      return;
    }
    
    this.eventQueue.push({
      ...event,
      mints: uniqueMints
    });
    
    if (this.eventQueue.length > this.config.maxBacklog) {
      logger.warn('⚠️ Event queue backlog exceeded, dropping oldest events', {
        queueSize: this.eventQueue.length,
        maxBacklog: this.config.maxBacklog
      });
      
      const dropCount = Math.floor(this.config.maxBacklog * 0.1);
      this.eventQueue.splice(0, dropCount);
    }
    
    this.scheduleBatchProcessing();
  }

  deduplicateMints(mints) {
    const uniqueMints = [];
    
    for (const mint of mints) {
      if (!this.seenMints.has(mint)) {
        this.seenMints.set(mint, true);
        uniqueMints.push(mint);
      }
    }
    
    return uniqueMints;
  }

  scheduleBatchProcessing() {
    if (this.batchTimer || this.isProcessingBatch) {
      return;
    }
    
    this.batchTimer = setTimeout(() => {
      this.processBatch();
    }, this.config.batchWindowMs);
  }

  async processBatch() {
    if (this.isProcessingBatch || this.eventQueue.length === 0) {
      logger.debug('⚠️ Batch processing skipped', {
        isProcessingBatch: this.isProcessingBatch,
        queueLength: this.eventQueue.length
      });
      return;
    }
    
    this.isProcessingBatch = true;
    this.batchTimer = null;
    
    const startTime = Date.now();
    const batch = [...this.eventQueue];
    this.eventQueue = [];
    
    logger.debug('🔄 Processing batch', {
      eventCount: batch.length,
      queueSizeBefore: batch.length,
      queueSizeAfter: this.eventQueue.length,
      batchNumber: this.metrics.batchesProcessed + 1
    });
    
    try {
      const allMints = new Set();
      const signatures = new Set();
      const eventSources = {};
      
      for (const event of batch) {
        signatures.add(event.signature);
        for (const mint of event.mints) {
          allMints.add(mint);
        }
        
        const source = event.source || 'unknown';
        eventSources[source] = (eventSources[source] || 0) + 1;
      }
      
      logger.debug('🎯 Batch mint extraction results', {
        totalMintsFromEvents: allMints.size,
        uniqueSignatures: signatures.size,
        sampleMints: Array.from(allMints).slice(0, 5),
        eventSources,
        batchProcessingTimeMs: Date.now() - startTime
      });
      
      const batchData = {
        mints: Array.from(allMints),
        signatures: Array.from(signatures),
        eventCount: batch.length,
        timestamp: Date.now()
      };
      
      const processingTime = Date.now() - startTime;
      logger.logBatch(batch.length, processingTime, {
        mintCount: allMints.size,
        signatureCount: signatures.size,
        batchNumber: this.metrics.batchesProcessed + 1,
        eventSources
      });
      
      for (const handler of this.eventHandlers) {
        try {
          logger.debug('📤 Calling batch handler', {
            mintCount: allMints.size,
            eventCount: batch.length
          });
          await handler(batchData);
        } catch (error) {
          logger.error('Batch handler failed', { 
            error: error.message,
            stack: error.stack
          });
        }
      }
      
      this.metrics.batchesProcessed++;
      
      logger.debug('✅ Batch processing completed', {
        batchNumber: this.metrics.batchesProcessed,
        totalProcessingTimeMs: Date.now() - startTime,
        mintCount: allMints.size,
        eventCount: batch.length
      });
      
    } catch (error) {
      logger.error('Batch processing failed', { 
        error: error.message,
        stack: error.stack,
        batchSize: batch.length
      });
    } finally {
      this.isProcessingBatch = false;
      
      if (this.eventQueue.length > 0) {
        logger.debug('🔄 Scheduling next batch processing', {
          remainingQueueSize: this.eventQueue.length
        });
        this.scheduleBatchProcessing();
      }
    }
  }

  scheduleReconnect() {
    if (this.isConnected) {
      return;
    }
    
    this.metrics.reconnects++;
    const delay = Math.min(
      Math.pow(2, this.reconnectAttempts) * 1000,
      this.config.maxReconnectDelay * 1000
    );
    
    logger.info(`🔄 Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
    
    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect().catch(error => {
        logger.error('Reconnection failed', { error: error.message });
        this.scheduleReconnect();
      });
    }, delay);
  }

  startHealthMonitoring() {
    setInterval(() => {
      this.checkHealth();
      this.logMetrics();
    }, 60000); // Every minute
  }

  checkHealth() {
    const now = Date.now();
    const timeSinceLastMessage = this.lastMessageTime ? now - this.lastMessageTime : null;
    
    if (timeSinceLastMessage && timeSinceLastMessage > 30000) {
      logger.warn('⚠️ Connection appears stale, no messages received', {
        timeSinceLastMessage: Math.round(timeSinceLastMessage / 1000)
      });
      
      this.logHealth('connection_stale', {
        timeSinceLastMessage
      });
    }
    
    const cacheStats = this.seenMints.getStats();
    logger.logDedup(
      this.metrics.totalEvents,
      this.metrics.dedupFiltered,
      cacheStats.keys
    );
  }

  logMetrics() {
    const now = Date.now();
    const restFallbackRate = this.metrics.totalEvents > 0 
      ? this.metrics.restFallbacks / this.metrics.totalEvents 
      : 0;
    
    // Step 2.2 Enhancement: Comprehensive metrics with performance indicators
    const uptimeSeconds = Math.floor((now - this.metrics.startTime) / 1000);
    const eventsPerSecond = uptimeSeconds > 0 ? (this.metrics.totalEvents / uptimeSeconds).toFixed(2) : '0.00';
    const batchesPerMinute = uptimeSeconds > 60 ? ((this.metrics.batchesProcessed / uptimeSeconds) * 60).toFixed(2) : '0.00';
    
    const baseMetrics = {
      totalEvents: this.metrics.totalEvents,
      dedupFiltered: this.metrics.dedupFiltered,
      batchesProcessed: this.metrics.batchesProcessed,
      restFallbacks: this.metrics.restFallbacks,
      restFallbackRate: Math.round(restFallbackRate * 100) / 100,
      reconnects: this.metrics.reconnects,
      queueSize: this.eventQueue.length,
      cacheSize: this.seenMints.getStats().keys,
      uptimeSeconds,
      performance: {
        eventsPerSecond: parseFloat(eventsPerSecond),
        batchesPerMinute: parseFloat(batchesPerMinute)
      }
    };

    // Add REST call stats if available
    if (this.metrics.restCallStats) {
      const successRate = this.metrics.restCallStats.totalCalls > 0 ? 
        ((this.metrics.restCallStats.successfulCalls / this.metrics.restCallStats.totalCalls) * 100).toFixed(1) : '0.0';
      
      baseMetrics.restCallStats = {
        totalCalls: this.metrics.restCallStats.totalCalls,
        successfulCalls: this.metrics.restCallStats.successfulCalls,
        failedCalls: this.metrics.restCallStats.failedCalls,
        successRate: successRate + '%',
        averageResponseTime: this.metrics.restCallStats.averageResponseTime,
        lastCallTime: this.metrics.restCallStats.lastCallTime
      };
    }
    
    logger.info('📊 Helius Listener Enhanced Metrics', baseMetrics);
    
    // Step 2.2 Enhancement: Health warnings based on metrics
    if (this.metrics.batchesProcessed > 10) {
      const emptyBatchRate = this.metrics.dedupFiltered > 0 ? 
        (this.metrics.dedupFiltered / this.metrics.totalEvents) * 100 : 0;
      if (emptyBatchRate > 50) {
        logger.warn('⚠️ High deduplication rate detected', {
          dedupRate: emptyBatchRate.toFixed(1) + '%',
          possibleCauses: ['high_duplicate_activity', 'cache_working_well']
        });
      }
    }
    
    if (restFallbackRate > 0.8) {
      logger.warn('⚠️ High REST fallback rate detected', {
        restFallbackRate: (restFallbackRate * 100).toFixed(1) + '%',
        possibleCauses: ['websocket_missing_data', 'api_limitations', 'network_issues']
      });
    }
  }

  logHealth(event, data = {}) {
    logger.logHealth(event, data);
  }

  getMetrics() {
    return { ...this.metrics };
  }
}

module.exports = HeliusListener;
