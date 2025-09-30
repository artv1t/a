
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
      
      if (!signature) {
        logger.warn('⚠️ No signature found in log notification');
        return;
      }
      
      this.queueSignatureForBatch(signature);
      
    } catch (error) {
      logger.error('Failed to handle log notification', { 
        error: error.message
      });
    }
  }

  extractMintsFromTokenBalances(postTokenBalances) {
    const mints = new Set();
    
    logger.debug('🔍 Processing postTokenBalances', {
      count: postTokenBalances.length,
      sample: postTokenBalances.slice(0, 2) // Log first 2 for debugging
    });
    
    for (const balance of postTokenBalances) {
      if (balance.mint) {
        try {
          new PublicKey(balance.mint);
          mints.add(balance.mint);
          logger.debug('✅ Valid mint found', { mint: balance.mint });
        } catch (error) {
          logger.debug('❌ Invalid mint address', { mint: balance.mint, error: error.message });
        }
      } else {
        logger.debug('⚠️ Balance entry missing mint field', { balance });
      }
    }
    
    logger.debug('🎯 Final extracted mints', {
      count: mints.size,
      mints: Array.from(mints).slice(0, 5) // Log first 5 mints
    });
    
    return Array.from(mints);
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
    
    try {
      this.metrics.restFallbacks++;
      this.recordRestCall();
      
      const url = `https://api.helius.xyz/v0/transactions?api-key=7c8922d6-1031-42c1-b4ee-bf5daa29abd4`;
      const requestBody = {
        transactions: [signature]
      };
      
      logger.debug('🔗 REST fallback request', { 
        signature, 
        url: url.replace(/api-key=[^&]+/, 'api-key=***'),
        method: 'POST'
      });
      
      const response = await axios.post(url, requestBody, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });
      
      logger.debug('📥 REST fallback response', {
        signature,
        status: response.status,
        hasData: !!response.data,
        isArray: Array.isArray(response.data),
        dataLength: response.data?.length || 0
      });
      
      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        const transaction = response.data[0];
        
        let mints = [];
        
        if (transaction.tokenTransfers && Array.isArray(transaction.tokenTransfers)) {
          mints = transaction.tokenTransfers.map(transfer => transfer.mint).filter(mint => mint);
          
          logger.debug('✅ REST fallback success - tokenTransfers', {
            signature,
            mintCount: mints.length,
            mints: mints.slice(0, 3),
            tokenTransfersCount: transaction.tokenTransfers.length
          });
        } else {
          logger.debug('⚠️ REST fallback: no tokenTransfers found', {
            signature,
            transactionKeys: transaction ? Object.keys(transaction) : [],
            hasTokenTransfers: !!(transaction && transaction.tokenTransfers)
          });
        }
        
        if (mints.length > 0) {
          this.queueEvent({
            signature,
            mints,
            timestamp: Date.now(),
            source: 'rest_fallback'
          });
        }
      } else {
        logger.debug('⚠️ REST fallback: invalid response format', {
          signature,
          hasData: !!response.data,
          isArray: Array.isArray(response.data),
          dataType: typeof response.data
        });
      }
      
    } catch (error) {
      logger.error('REST fallback failed', { 
        signature, 
        error: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        responseData: error.response?.data,
        url: error.config?.url?.replace(/api-key=[^&]+/, 'api-key=***')
      });
    }
  }

  canMakeRestCall() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    this.restCallTimes = this.restCallTimes.filter(time => time > oneSecondAgo);
    
    return this.restCallTimes.length < this.config.restFallbackLimit;
  }

  recordRestCall() {
    this.restCallTimes.push(Date.now());
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
      return;
    }
    
    this.isProcessingBatch = true;
    this.batchTimer = null;
    
    const startTime = Date.now();
    const batch = [...this.eventQueue];
    this.eventQueue = [];
    
    try {
      const allMints = new Set();
      const signatures = new Set();
      
      for (const event of batch) {
        signatures.add(event.signature);
        for (const mint of event.mints) {
          allMints.add(mint);
        }
      }
      
      const batchData = {
        mints: Array.from(allMints),
        signatures: Array.from(signatures),
        eventCount: batch.length,
        timestamp: Date.now()
      };
      
      const processingTime = Date.now() - startTime;
      logger.logBatch(batch.length, processingTime, {
        mintCount: allMints.size,
        signatureCount: signatures.size
      });
      
      for (const handler of this.eventHandlers) {
        try {
          await handler(batchData);
        } catch (error) {
          logger.error('Batch handler failed', { error: error.message });
        }
      }
      
      this.metrics.batchesProcessed++;
      
    } catch (error) {
      logger.error('Batch processing failed', { error: error.message });
    } finally {
      this.isProcessingBatch = false;
      
      if (this.eventQueue.length > 0) {
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
    const restFallbackRate = this.metrics.totalEvents > 0 
      ? this.metrics.restFallbacks / this.metrics.totalEvents 
      : 0;
    
    logger.info('📊 Helius Listener Metrics', {
      totalEvents: this.metrics.totalEvents,
      dedupFiltered: this.metrics.dedupFiltered,
      batchesProcessed: this.metrics.batchesProcessed,
      restFallbacks: this.metrics.restFallbacks,
      restFallbackRate: Math.round(restFallbackRate * 100) / 100,
      reconnects: this.metrics.reconnects,
      queueSize: this.eventQueue.length,
      cacheSize: this.seenMints.getStats().keys
    });
  }

  logHealth(event, data = {}) {
    logger.logHealth(event, data);
  }

  getMetrics() {
    return { ...this.metrics };
  }
}

module.exports = HeliusListener;
