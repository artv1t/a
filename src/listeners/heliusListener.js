
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
      batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS) || 2000,
      dedupTtlS: parseInt(process.env.DEDUP_TTL_S) || 60,
      restFallbackLimit: parseInt(process.env.REST_FALLBACK_LIMIT_PER_SEC) || 1,
      maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE) || 25,
      maxBacklog: parseInt(process.env.MAX_BACKLOG_EVENTS) || 5000,
      maxReconnectDelay: parseInt(process.env.WS_RECONNECT_MAX_DELAY_S) || 60,
      maxTokenAgeHours: parseFloat(process.env.MAX_TOKEN_AGE_HOURS) || 1.5,
      processingDelayMs: parseInt(process.env.PROCESSING_DELAY_MS) || 1000,
      interBatchDelayMs: parseInt(process.env.INTER_BATCH_DELAY_MS) || 3000,
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
      lastEventTime: null,
      ageFiltered: 0,
      ageCheckErrors: 0
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

  async extractMintsFromTokenBalances(postTokenBalances) {
    const mints = new Set();
    
    // Step 2.4: Enhanced input validation and logging
    if (!postTokenBalances || !Array.isArray(postTokenBalances)) {
      logger.debug('⚠️ Step 2.4: No postTokenBalances provided', {
        hasPostTokenBalances: !!postTokenBalances,
        isArray: Array.isArray(postTokenBalances),
        type: typeof postTokenBalances
      });
      return [];
    }
    
    logger.debug('🔍 Processing postTokenBalances', {
      count: postTokenBalances.length,
      sample: postTokenBalances.slice(0, 2)
    });
    
    // Step 2.4: Enhanced balance processing with detailed tracking
    const validBalances = [];
    const invalidBalances = [];
    
    for (const balance of postTokenBalances) {
      if (balance.mint) {
        try {
          new PublicKey(balance.mint);
          mints.add(balance.mint);
          validBalances.push(balance);
          logger.debug('✅ Valid mint found from postTokenBalances', { mint: balance.mint });
        } catch (error) {
          invalidBalances.push({ mint: balance.mint, error: error.message });
          logger.debug('❌ Invalid mint address in postTokenBalances', { mint: balance.mint, error: error.message });
        }
      } else {
        invalidBalances.push({ balance, reason: 'missing_mint_field' });
        logger.debug('⚠️ Balance entry missing mint field', { balance });
      }
    }
    
    const rawMints = Array.from(mints);
    const interestingMints = this.filterInterestingMints(rawMints);
    const youngMints = await this.filterByAge(interestingMints);
    
    // Step 2.4: Comprehensive token balance analysis logging
    logger.info('🪙 Step 2.4: Token Balance Mint Extraction Analysis', {
      extraction: {
        totalBalances: postTokenBalances.length,
        validBalances: validBalances.length,
        invalidBalances: invalidBalances.length,
        rawMints: rawMints.length,
        interestingMints: interestingMints.length,
        youngMints: youngMints.length
      },
      balanceDetails: validBalances.slice(0, 5).map(balance => ({
        mint: balance.mint,
        owner: balance.owner,
        uiTokenAmount: balance.uiTokenAmount?.uiAmount || 'unknown',
        decimals: balance.uiTokenAmount?.decimals || 'unknown'
      })),
      mintAddresses: {
        allFound: rawMints,
        interesting: interestingMints,
        young: youngMints,
        filtered: rawMints.filter(mint => !interestingMints.includes(mint))
      },
      filteringEfficiency: {
        interestingFilterRate: rawMints.length > 0 ? 
          ((rawMints.length - interestingMints.length) / rawMints.length * 100).toFixed(1) + '%' : '0%',
        ageFilterRate: interestingMints.length > 0 ? 
          ((interestingMints.length - youngMints.length) / interestingMints.length * 100).toFixed(1) + '%' : '0%'
      },
      timestamp: new Date().toISOString()
    });
    
    logger.debug('🎯 Final extracted mints from postTokenBalances', {
      rawCount: rawMints.length,
      interestingCount: interestingMints.length,
      youngCount: youngMints.length,
      mints: youngMints.slice(0, 5)
    });
    
    return youngMints;
  }

  async extractMintsFromTokenTransfers(tokenTransfers) {
    const mints = new Set();
    
    // Step 2.4: Enhanced input validation and logging
    if (!tokenTransfers || !Array.isArray(tokenTransfers)) {
      logger.debug('⚠️ Step 2.4: No tokenTransfers provided', {
        hasTokenTransfers: !!tokenTransfers,
        isArray: Array.isArray(tokenTransfers),
        type: typeof tokenTransfers
      });
      return [];
    }
    
    logger.info('🔍 Processing tokenTransfers', {
      count: tokenTransfers.length,
      sample: tokenTransfers.slice(0, 2)
    });
    
    // Step 2.4: Enhanced transfer processing with detailed tracking
    const validTransfers = [];
    const invalidTransfers = [];
    
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
            validTransfers.push(transfer);
            logger.info('✅ Valid mint found from tokenTransfers', { 
              mint: transfer.mint,
              fromTokenAccount: transfer.fromTokenAccount,
              toTokenAccount: transfer.toTokenAccount,
              tokenAmount: transfer.tokenAmount
            });
          } else {
            invalidTransfers.push({
              mint: transfer.mint,
              reason: this.getTransferInvalidReason(transfer)
            });
            logger.info('⚠️ Token transfer filtered out by isValidTokenTransfer', { 
              mint: transfer.mint,
              reason: 'invalid_transfer_data',
              transfer: transfer
            });
          }
        } catch (error) {
          invalidTransfers.push({
            mint: transfer.mint,
            reason: 'invalid_mint_address',
            error: error.message
          });
          logger.info('❌ Invalid mint address in tokenTransfers', { 
            mint: transfer.mint, 
            error: error.message 
          });
        }
      } else {
        invalidTransfers.push({
          transfer,
          reason: 'missing_mint_field'
        });
        logger.info('⚠️ Transfer entry missing mint field', { transfer });
      }
    }
    
    const rawMints = Array.from(mints);
    const interestingMints = this.filterInterestingMints(rawMints);
    const youngMints = await this.filterByAge(interestingMints);
    
    // Step 2.4: Comprehensive token transfer analysis logging
    logger.info('🔄 Step 2.4: Token Transfer Mint Extraction Analysis', {
      transferAnalysis: {
        totalTransfers: tokenTransfers.length,
        validTransfers: validTransfers.length,
        invalidTransfers: invalidTransfers.length,
        rawMints: rawMints.length,
        interestingMints: interestingMints.length,
        youngMints: youngMints.length
      },
      validTransferDetails: validTransfers.slice(0, 3).map(transfer => ({
        mint: transfer.mint,
        tokenAmount: transfer.tokenAmount,
        fromAccount: transfer.fromTokenAccount?.substring(0, 8) + '...',
        toAccount: transfer.toTokenAccount?.substring(0, 8) + '...'
      })),
      invalidTransferReasons: invalidTransfers.slice(0, 3),
      mintAddresses: {
        allFound: rawMints,
        interesting: interestingMints,
        young: youngMints,
        filtered: rawMints.filter(mint => !interestingMints.includes(mint))
      },
      filteringEfficiency: {
        validationFilterRate: tokenTransfers.length > 0 ? 
          ((tokenTransfers.length - validTransfers.length) / tokenTransfers.length * 100).toFixed(1) + '%' : '0%',
        interestingFilterRate: rawMints.length > 0 ? 
          ((rawMints.length - interestingMints.length) / rawMints.length * 100).toFixed(1) + '%' : '0%',
        ageFilterRate: interestingMints.length > 0 ? 
          ((interestingMints.length - youngMints.length) / interestingMints.length * 100).toFixed(1) + '%' : '0%'
      },
      timestamp: new Date().toISOString()
    });
    
    logger.info('🎯 Final extracted mints from tokenTransfers', {
      rawCount: rawMints.length,
      interestingCount: interestingMints.length,
      youngCount: youngMints.length,
      mints: youngMints.slice(0, 5)
    });
    
    return youngMints;
  }
  
  // Step 2.4: Helper method to get detailed transfer invalid reasons
  getTransferInvalidReason(transfer) {
    if (!transfer.mint) return 'missing_mint';
    if (transfer.mint === 'So11111111111111111111111111111111111111112') return 'sol_transfer';
    if (transfer.tokenAmount === undefined || transfer.tokenAmount === null) return 'missing_token_amount';
    if (typeof transfer.tokenAmount === 'number' && transfer.tokenAmount <= 0) return 'zero_or_negative_amount';
    if (!transfer.fromTokenAccount) return 'missing_from_account';
    if (!transfer.toTokenAccount) return 'missing_to_account';
    return 'unknown_reason';
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
            const transferMints = await this.extractMintsFromTokenTransfers(transaction.tokenTransfers);
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
            const balanceMints = await this.extractMintsFromTokenBalances(transaction.tokenBalances);
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
            const postBalanceMints = await this.extractMintsFromTokenBalances(transaction.meta.postTokenBalances);
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

  async checkTokenAge(mint) {
    try {
      const response = await axios.post(this.config.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [
          mint,
          {
            encoding: 'base64',
            commitment: 'confirmed'
          }
        ]
      }, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.data.result || !response.data.result.value) {
        logger.debug('❌ Token account not found for age check', { mint });
        return false;
      }

      const accountInfo = response.data.result.value;
      if (!accountInfo.executable && accountInfo.lamports > 0) {
        const currentTime = Date.now();
        const maxAgeMs = this.config.maxTokenAgeHours * 60 * 60 * 1000;
        
        const response2 = await axios.post(this.config.rpcUrl, {
          jsonrpc: '2.0',
          id: 2,
          method: 'getSignaturesForAddress',
          params: [
            mint,
            {
              limit: 1,
              commitment: 'confirmed'
            }
          ]
        }, {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (response2.data.result && response2.data.result.length > 0) {
          const firstSignature = response2.data.result[response2.data.result.length - 1];
          if (firstSignature.blockTime) {
            const tokenCreationTime = firstSignature.blockTime * 1000;
            const tokenAge = currentTime - tokenCreationTime;
            const isYoung = tokenAge <= maxAgeMs;
            
            logger.debug('🕐 Token age check', {
              mint: mint.slice(0, 8) + '...',
              ageMinutes: Math.round(tokenAge / (1000 * 60)),
              maxAgeHours: this.config.maxTokenAgeHours,
              isYoung,
              creationTime: new Date(tokenCreationTime).toISOString()
            });
            
            return isYoung;
          }
        }
      }
      
      logger.debug('⚠️ Could not determine token age, allowing through', { mint: mint.slice(0, 8) + '...' });
      return true;
      
    } catch (error) {
      this.metrics.ageCheckErrors++;
      logger.debug('❌ Error checking token age, allowing through', { 
        mint: mint.slice(0, 8) + '...',
        error: error.message 
      });
      return true;
    }
  }

  async filterByAge(mints) {
    if (mints.length === 0) {
      return mints;
    }

    logger.debug('🕐 Starting age filtering', {
      inputCount: mints.length,
      maxAgeHours: this.config.maxTokenAgeHours
    });

    const ageCheckPromises = mints.map(async (mint) => {
      const isYoung = await this.checkTokenAge(mint);
      return { mint, isYoung };
    });

    try {
      const ageResults = await Promise.all(ageCheckPromises);
      const youngMints = ageResults
        .filter(result => result.isYoung)
        .map(result => result.mint);
      
      const filteredCount = mints.length - youngMints.length;
      this.metrics.ageFiltered += filteredCount;

      logger.info('🕐 Age filtering completed', {
        inputCount: mints.length,
        outputCount: youngMints.length,
        filteredOut: filteredCount,
        maxAgeHours: this.config.maxTokenAgeHours,
        sampleYoungMints: youngMints.slice(0, 3)
      });

      return youngMints;
      
    } catch (error) {
      logger.error('❌ Age filtering failed, returning original mints', {
        error: error.message,
        mintCount: mints.length
      });
      return mints;
    }
  }

  canMakeRestCall() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    this.restCallTimes = this.restCallTimes.filter(time => time > oneSecondAgo);
    
    const recentCalls = this.restCallTimes.length;
    const maxCallsPerSecond = this.config.restFallbackLimit;
    const withinRateLimit = recentCalls < maxCallsPerSecond;
    
    logger.debug('🚦 Stage 2 Optimized REST rate limit check', {
      recentCalls,
      maxCallsPerSecond,
      withinRateLimit,
      totalRecentCalls: this.restCallTimes.length
    });
    
    return withinRateLimit;
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
    
    if (this.signatureQueue.length >= this.config.maxBatchSize) {
      logger.debug('🚀 Batch size limit reached, processing immediately', {
        queueSize: this.signatureQueue.length,
        maxBatchSize: this.config.maxBatchSize
      });
      this.processSignatureBatch();
    } else {
      this.scheduleSignatureBatchProcessing();
    }
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
    
    const batchToProcess = this.signatureQueue.splice(0, this.config.maxBatchSize);
    
    logger.info('🔄 Processing signature batch (Stage 2 Optimized)', {
      batchSize: batchToProcess.length,
      remainingInQueue: this.signatureQueue.length,
      maxBatchSize: this.config.maxBatchSize,
      rateLimitAllows: this.config.restFallbackLimit,
      processingDelayMs: this.config.processingDelayMs
    });
    
    const signaturestoProcess = batchToProcess.slice(0, 1);
    
    for (const item of signaturestoProcess) {
      if (this.canMakeRestCall()) {
        await this.scheduleRestFallback(item.signature);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        logger.debug('⚠️ Skipping signature due to rate limit', { signature: item.signature });
        break;
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, this.config.processingDelayMs));
    
    this.isProcessingSignatureBatch = false;
    
    if (this.signatureQueue && this.signatureQueue.length > 0) {
      setTimeout(() => {
        this.scheduleSignatureBatchProcessing();
      }, this.config.interBatchDelayMs);
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
    
    await new Promise(resolve => setTimeout(resolve, this.config.processingDelayMs / 2));
    
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
      const mintDetails = [];
      
      // Step 2.4: Enhanced mint address tracking with detailed information
      for (const event of batch) {
        signatures.add(event.signature);
        for (const mint of event.mints) {
          allMints.add(mint);
          mintDetails.push({
            mint,
            signature: event.signature,
            source: event.source || 'unknown',
            timestamp: event.timestamp,
            ageFiltered: event.ageFiltered || false
          });
        }
        
        const source = event.source || 'unknown';
        eventSources[source] = (eventSources[source] || 0) + 1;
      }
      
      // Step 2.4: Detailed mint address logging with comprehensive statistics
      const uniqueMints = Array.from(allMints);
      const mintsBySource = {};
      mintDetails.forEach(detail => {
        if (!mintsBySource[detail.source]) {
          mintsBySource[detail.source] = [];
        }
        mintsBySource[detail.source].push(detail.mint);
      });
      
      logger.info('🪙 Step 2.4: Detailed Mint Address Analysis', {
        batchNumber: this.metrics.batchesProcessed + 1,
        totalUniqueMintsFound: uniqueMints.length,
        totalMintInstances: mintDetails.length,
        uniqueSignatures: signatures.size,
        mintsBySource: Object.keys(mintsBySource).map(source => ({
          source,
          mintCount: mintsBySource[source].length,
          uniqueMints: [...new Set(mintsBySource[source])].length
        })),
        sampleMintDetails: mintDetails.slice(0, 3).map(detail => ({
          mint: detail.mint,
          signature: detail.signature.substring(0, 8) + '...',
          source: detail.source,
          ageFiltered: detail.ageFiltered
        })),
        allFoundMints: uniqueMints.slice(0, 10),
        processingTimeMs: Date.now() - startTime
      });
      
      // Step 2.4: Enhanced batch statistics
      const batchStats = {
        batchId: this.metrics.batchesProcessed + 1,
        eventCount: batch.length,
        uniqueSignatures: signatures.size,
        totalMintInstances: mintDetails.length,
        uniqueMintsFound: uniqueMints.length,
        deduplicationEfficiency: mintDetails.length > 0 ? 
          ((mintDetails.length - uniqueMints.length) / mintDetails.length * 100).toFixed(1) + '%' : '0%',
        sourceDistribution: eventSources,
        avgMintsPerEvent: batch.length > 0 ? (mintDetails.length / batch.length).toFixed(2) : '0',
        processingLatency: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
      
      logger.info('📊 Step 2.4: Enhanced Batch Statistics', batchStats);
      
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
        timestamp: Date.now(),
        mintDetails: mintDetails,
        batchStats: batchStats
      };
      
      const processingTime = Date.now() - startTime;
      logger.logBatch(batch.length, processingTime, {
        mintCount: allMints.size,
        signatureCount: signatures.size,
        batchNumber: this.metrics.batchesProcessed + 1,
        eventSources,
        enhancedStats: batchStats
      });
      
      for (const handler of this.eventHandlers) {
        try {
          logger.debug('📤 Calling batch handler', {
            mintCount: allMints.size,
            eventCount: batch.length,
            handlerName: handler.name || 'anonymous'
          });
          await handler(batchData);
        } catch (error) {
          logger.error('Batch handler failed', { 
            error: error.message,
            stack: error.stack,
            handlerName: handler.name || 'anonymous'
          });
        }
      }
      
      this.metrics.batchesProcessed++;
      
      // Step 2.4: Enhanced completion logging with debug information
      logger.info('✅ Step 2.4: Batch Processing Completed Successfully', {
        batchNumber: this.metrics.batchesProcessed,
        totalProcessingTimeMs: Date.now() - startTime,
        mintCount: allMints.size,
        eventCount: batch.length,
        efficiency: {
          msPerEvent: batch.length > 0 ? ((Date.now() - startTime) / batch.length).toFixed(2) : '0',
          msPerMint: allMints.size > 0 ? ((Date.now() - startTime) / allMints.size).toFixed(2) : '0'
        },
        memoryUsage: {
          queueSize: this.eventQueue.length,
          cacheSize: this.seenMints.getStats().keys,
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
        }
      });
      
    } catch (error) {
      logger.error('Batch processing failed', { 
        error: error.message,
        stack: error.stack,
        batchSize: batch.length,
        batchNumber: this.metrics.batchesProcessed + 1
      });
    } finally {
      this.isProcessingBatch = false;
      
      if (this.eventQueue.length > 0) {
        logger.debug('🔄 Scheduling next batch processing (Stage 2 Optimized)', {
          remainingQueueSize: this.eventQueue.length,
          nextBatchNumber: this.metrics.batchesProcessed + 2,
          delayMs: this.config.interBatchDelayMs
        });
        setTimeout(() => {
          this.scheduleBatchProcessing();
        }, this.config.interBatchDelayMs);
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
    
    // Step 2.4 Enhancement: Comprehensive metrics with detailed debug information
    const uptimeSeconds = Math.floor((now - this.metrics.startTime) / 1000);
    const eventsPerSecond = uptimeSeconds > 0 ? (this.metrics.totalEvents / uptimeSeconds).toFixed(2) : '0.00';
    const batchesPerMinute = uptimeSeconds > 60 ? ((this.metrics.batchesProcessed / uptimeSeconds) * 60).toFixed(2) : '0.00';
    const avgEventsPerBatch = this.metrics.batchesProcessed > 0 ? (this.metrics.totalEvents / this.metrics.batchesProcessed).toFixed(2) : '0.00';
    
    // Step 2.4: Enhanced system health and performance metrics
    const memUsage = process.memoryUsage();
    const systemMetrics = {
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
        external: Math.round(memUsage.external / 1024 / 1024) + 'MB',
        rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB'
      },
      uptime: {
        seconds: uptimeSeconds,
        formatted: this.formatUptime(uptimeSeconds)
      },
      websocket: {
        isConnected: this.isConnected,
        reconnectAttempts: this.reconnectAttempts,
        lastMessageTime: this.lastMessageTime ? new Date(this.lastMessageTime).toISOString() : null,
        timeSinceLastMessage: this.lastMessageTime ? Math.round((now - this.lastMessageTime) / 1000) + 's' : null
      }
    };
    
    const baseMetrics = {
      totalEvents: this.metrics.totalEvents,
      dedupFiltered: this.metrics.dedupFiltered,
      ageFiltered: this.metrics.ageFiltered,
      ageCheckErrors: this.metrics.ageCheckErrors,
      batchesProcessed: this.metrics.batchesProcessed,
      restFallbacks: this.metrics.restFallbacks,
      restFallbackRate: Math.round(restFallbackRate * 100) / 100,
      reconnects: this.metrics.reconnects,
      queueSize: this.eventQueue.length,
      cacheSize: this.seenMints.getStats().keys,
      uptimeSeconds,
      maxTokenAgeHours: this.config.maxTokenAgeHours,
      performance: {
        eventsPerSecond: parseFloat(eventsPerSecond),
        batchesPerMinute: parseFloat(batchesPerMinute),
        avgEventsPerBatch: parseFloat(avgEventsPerBatch),
        efficiency: {
          dedupEfficiency: this.metrics.totalEvents > 0 ? 
            ((this.metrics.dedupFiltered / this.metrics.totalEvents) * 100).toFixed(1) + '%' : '0%',
          ageFilterEfficiency: this.metrics.totalEvents > 0 ? 
            ((this.metrics.ageFiltered / this.metrics.totalEvents) * 100).toFixed(1) + '%' : '0%'
        }
      },
      systemHealth: systemMetrics
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
        lastCallTime: this.metrics.restCallStats.lastCallTime,
        callsPerMinute: uptimeSeconds > 60 ? 
          ((this.metrics.restCallStats.totalCalls / uptimeSeconds) * 60).toFixed(2) : '0.00'
      };
    }
    
    // Step 2.4: Enhanced debug information logging
    logger.info('📊 Step 2.4: Comprehensive Helius Listener Metrics & Debug Info', baseMetrics);
    
    // Step 2.4: Additional debug logging for troubleshooting
    logger.debug('🔧 Step 2.4: Detailed Debug Information', {
      configSnapshot: {
        batchWindowMs: this.config.batchWindowMs,
        dedupTtlS: this.config.dedupTtlS,
        restFallbackLimit: this.config.restFallbackLimit,
        maxTokenAgeHours: this.config.maxTokenAgeHours,
        maxBacklog: this.config.maxBacklog
      },
      internalState: {
        isProcessingBatch: this.isProcessingBatch,
        eventQueueLength: this.eventQueue.length,
        batchTimerActive: !!this.batchTimer,
        subscriptionId: this.subscriptionId,
        wsReadyState: this.ws ? this.ws.readyState : null
      },
      cacheDetails: this.seenMints.getStats(),
      recentRestCalls: this.restCallTimes.slice(-5).map(time => new Date(time).toISOString())
    });
    
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
    
    // Step 2.4: Additional health checks and warnings
    if (this.eventQueue.length > this.config.maxBacklog * 0.8) {
      logger.warn('⚠️ Event queue approaching capacity', {
        currentSize: this.eventQueue.length,
        maxCapacity: this.config.maxBacklog,
        utilizationPercent: ((this.eventQueue.length / this.config.maxBacklog) * 100).toFixed(1) + '%'
      });
    }
    
    if (memUsage.heapUsed > 500 * 1024 * 1024) { // 500MB
      logger.warn('⚠️ High memory usage detected', {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        recommendation: 'Consider restarting if memory continues to grow'
      });
    }
  }
  
  // Step 2.4: Helper method for formatting uptime
  formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
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
