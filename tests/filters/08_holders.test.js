const HoldersFilter = require('../../src/filters/08_holders');

describe('HoldersFilter', () => {
  let filter;
  
  beforeEach(() => {
    process.env.HOLDERS_ENABLED = 'true';
    process.env.HOLDERS_CRITICAL = 'true';
    process.env.HOLDERS_MODE = 'LOG_ONLY';
    process.env.HOLDERS_TOP1_MAX_PCT = '5';
    process.env.HOLDERS_TOP5_MAX_PCT = '10';
    process.env.HOLDERS_TOP10_MAX_PCT = '20';
    process.env.HOLDERS_TEAM_MAX_PCT = '15';
    process.env.HOLDERS_NEW_WALLETS_WARN_PCT = '40';
    process.env.HOLDERS_NEW_WALLETS_FAIL_PCT = '60';
    process.env.HELIUS_RPC = 'https://test-rpc.com';
    
    filter = new HoldersFilter();
    
    filter.getTokenSupply = jest.fn();
    filter.getTokenLargestAccounts = jest.fn();
    filter.getAccountInfo = jest.fn();
    filter.isTeamWallet = jest.fn();
    filter.isNewWallet = jest.fn();
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('initialization', () => {
    test('should initialize with correct configuration', () => {
      expect(filter.enabled).toBe(true);
      expect(filter.critical).toBe(true);
      expect(filter.mode).toBe('LOG_ONLY');
      expect(filter.top1MaxPct).toBe(5);
      expect(filter.top5MaxPct).toBe(10);
      expect(filter.top10MaxPct).toBe(20);
    });
  });
  
  describe('process', () => {
    test('should return filter_disabled when disabled', async () => {
      filter.enabled = false;
      
      const result = await filter.process({ mint: 'test-mint' });
      
      expect(result.pass).toBe(true);
      expect(result.reason).toBe('filter_disabled');
    });
    
    test('should fail on invalid mint', async () => {
      const result = await filter.process({ mint: 'invalid-mint' });
      
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('invalid_mint');
      expect(result.scoreDelta).toBe(-0.5);
    });
    
    test('should pass with good distribution', async () => {
      const mockTokenData = {
        mint: 'So11111111111111111111111111111111111111112',
        metadata: {}
      };
      
      filter.getTokenSupply.mockResolvedValue({
        value: { uiAmount: 1000000 }
      });
      
      filter.getTokenLargestAccounts.mockResolvedValue({
        value: [
          { address: 'account1' },
          { address: 'account2' },
          { address: 'account3' }
        ]
      });
      
      filter.getAccountInfo.mockImplementation((address) => {
        const amounts = { account1: 30000, account2: 25000, account3: 20000 };
        return Promise.resolve({
          value: {
            data: {
              parsed: {
                info: {
                  owner: `owner-${address}`,
                  tokenAmount: { uiAmount: amounts[address] || 10000 }
                }
              }
            }
          }
        });
      });
      
      filter.isTeamWallet.mockResolvedValue(false);
      filter.isNewWallet.mockResolvedValue(false);
      
      const result = await filter.process(mockTokenData);
      
      expect(result.pass).toBe(true);
      expect(result.action).toBe('passed_log_only');
      expect(result.metrics.top1Pct).toBe(3);
      expect(result.metrics.top5Pct).toBeLessThan(10);
    });
    
    test('should fail on top1 concentration in STRICT mode', async () => {
      filter.mode = 'STRICT';
      
      const mockTokenData = {
        mint: 'So11111111111111111111111111111111111111112',
        metadata: {}
      };
      
      filter.getTokenSupply.mockResolvedValue({
        value: { uiAmount: 1000000 }
      });
      
      filter.getTokenLargestAccounts.mockResolvedValue({
        value: [
          { address: 'account1' },
          { address: 'account2' }
        ]
      });
      
      filter.getAccountInfo.mockImplementation((address) => {
        const amounts = { account1: 80000, account2: 20000 };
        return Promise.resolve({
          value: {
            data: {
              parsed: {
                info: {
                  owner: `owner-${address}`,
                  tokenAmount: { uiAmount: amounts[address] }
                }
              }
            }
          }
        });
      });
      
      filter.isTeamWallet.mockResolvedValue(false);
      filter.isNewWallet.mockResolvedValue(false);
      
      const result = await filter.process(mockTokenData);
      
      expect(result.pass).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.reason).toBe('top1_concentration');
      expect(result.metrics.top1Pct).toBe(8);
    });
    
    test('should pass_log_only on top1 concentration in LOG_ONLY mode', async () => {
      const mockTokenData = {
        mint: 'So11111111111111111111111111111111111111112',
        metadata: {}
      };
      
      filter.getTokenSupply.mockResolvedValue({
        value: { uiAmount: 1000000 }
      });
      
      filter.getTokenLargestAccounts.mockResolvedValue({
        value: [
          { address: 'account1' }
        ]
      });
      
      filter.getAccountInfo.mockResolvedValue({
        value: {
          data: {
            parsed: {
              info: {
                owner: 'owner-account1',
                tokenAmount: { uiAmount: 80000 }
              }
            }
          }
        }
      });
      
      filter.isTeamWallet.mockResolvedValue(false);
      filter.isNewWallet.mockResolvedValue(false);
      
      const result = await filter.process(mockTokenData);
      
      expect(result.pass).toBe(true);
      expect(result.action).toBe('passed_log_only');
      expect(result.reason).toBe('top1_concentration');
      expect(result.scoreDelta).toBe(0);
    });
    
    test('should fail on team centralization', async () => {
      filter.mode = 'STRICT';
      
      const mockTokenData = {
        mint: 'So11111111111111111111111111111111111111112',
        metadata: { updateAuthority: 'team-wallet' }
      };
      
      filter.getTokenSupply.mockResolvedValue({
        value: { uiAmount: 1000000 }
      });
      
      filter.getTokenLargestAccounts.mockResolvedValue({
        value: [
          { address: 'account1' },
          { address: 'account2' }
        ]
      });
      
      filter.getAccountInfo.mockImplementation((address) => {
        return Promise.resolve({
          value: {
            data: {
              parsed: {
                info: {
                  owner: address === 'account1' ? 'team-wallet' : 'regular-wallet',
                  tokenAmount: { uiAmount: 200000 }
                }
              }
            }
          }
        });
      });
      
      filter.isTeamWallet.mockImplementation((owner) => owner === 'team-wallet');
      filter.isNewWallet.mockResolvedValue(false);
      
      const result = await filter.process(mockTokenData);
      
      expect(result.pass).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.reason).toBe('team_centralization');
      expect(result.metrics.teamPct).toBe(20);
    });
    
    test('should fail on new wallets mass', async () => {
      filter.mode = 'STRICT';
      
      const mockTokenData = {
        mint: 'So11111111111111111111111111111111111111112',
        metadata: {}
      };
      
      filter.getTokenSupply.mockResolvedValue({
        value: { uiAmount: 1000000 }
      });
      
      filter.getTokenLargestAccounts.mockResolvedValue({
        value: [
          { address: 'account1' },
          { address: 'account2' },
          { address: 'account3' }
        ]
      });
      
      filter.getAccountInfo.mockImplementation((address) => {
        return Promise.resolve({
          value: {
            data: {
              parsed: {
                info: {
                  owner: `owner-${address}`,
                  tokenAmount: { uiAmount: 250000 }
                }
              }
            }
          }
        });
      });
      
      filter.isTeamWallet.mockResolvedValue(false);
      filter.isNewWallet.mockResolvedValue(true);
      
      const result = await filter.process(mockTokenData);
      
      expect(result.pass).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.reason).toBe('new_wallets_mass');
      expect(result.metrics.newWalletsPct).toBe(75);
    });
    
    test('should warn on new wallets suspicious', async () => {
      const mockTokenData = {
        mint: 'So11111111111111111111111111111111111111112',
        metadata: {}
      };
      
      filter.getTokenSupply.mockResolvedValue({
        value: { uiAmount: 1000000 }
      });
      
      filter.getTokenLargestAccounts.mockResolvedValue({
        value: [
          { address: 'account1' },
          { address: 'account2' }
        ]
      });
      
      filter.getAccountInfo.mockImplementation((address) => {
        return Promise.resolve({
          value: {
            data: {
              parsed: {
                info: {
                  owner: `owner-${address}`,
                  tokenAmount: { uiAmount: 250000 }
                }
              }
            }
          }
        });
      });
      
      filter.isTeamWallet.mockResolvedValue(false);
      filter.isNewWallet.mockResolvedValue(true);
      
      const result = await filter.process(mockTokenData);
      
      expect(result.pass).toBe(true);
      expect(result.action).toBe('passed_log_only');
      expect(result.reason).toBe('new_wallets_suspicious');
      expect(result.metrics.newWalletsPct).toBe(50);
    });
    
    test('should exclude known contracts', () => {
      expect(filter.shouldExcludeOwner('11111111111111111111111111111111')).toBe(true);
      expect(filter.shouldExcludeOwner('1nc1nerator11111111111111111111111111111111')).toBe(true);
      expect(filter.shouldExcludeOwner('regular-wallet')).toBe(false);
    });
  });
  
  describe('caching', () => {
    test('should use cache when available', async () => {
      const cacheKey = 'holders:test-mint|20';
      const cachedResult = {
        pass: true,
        reason: 'cached_result',
        scoreDelta: 0.2
      };
      
      filter.setCache(cacheKey, cachedResult);
      
      const result = await filter.process({ mint: 'test-mint' });
      
      expect(result.usedCache).toBe(true);
      expect(result.reason).toBe('cached_result');
      expect(filter.getTokenSupply).not.toHaveBeenCalled();
    });
    
    test('should not use expired cache', async () => {
      const cacheKey = 'holders:test-mint|20';
      const cachedResult = {
        pass: true,
        reason: 'cached_result'
      };
      
      filter.cache.set(cacheKey, {
        data: cachedResult,
        timestamp: Date.now() - 70000
      });
      
      const result = await filter.process({ mint: 'invalid-mint' });
      
      expect(result.usedCache).toBe(false);
      expect(result.reason).toBe('invalid_mint');
    });
  });
  
  describe('configuration updates', () => {
    test('should update configuration', () => {
      filter.updateConfig({
        HOLDERS_ENABLED: 'false',
        HOLDERS_MODE: 'STRICT',
        HOLDERS_TOP1_MAX_PCT: '8'
      });
      
      expect(filter.enabled).toBe(false);
      expect(filter.mode).toBe('STRICT');
      expect(filter.top1MaxPct).toBe(8);
    });
  });
});
