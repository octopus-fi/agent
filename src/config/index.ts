//  octopus-ai-agent/src/config/index.ts
/**
 * Octopus Finance AI Agent - Configuration
 */

import dotenv from 'dotenv';
import { AgentConfig, LtvThresholds, RateLimits } from '../types';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function optionalEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

export function loadConfig(): AgentConfig {
  const ltvThresholds: LtvThresholds = {
    warning: optionalEnvNumber('LTV_WARNING_THRESHOLD', 6000),
    rebalance: optionalEnvNumber('LTV_REBALANCE_THRESHOLD', 6500),
    maxBorrow: optionalEnvNumber('LTV_MAX_BORROW', 7000),
    liquidation: optionalEnvNumber('LTV_LIQUIDATION', 8000),
  };

  const rateLimits: RateLimits = {
    analyzerMaxRpm: optionalEnvNumber('ANALYZER_MAX_RPM', 10),
    executorMaxRpm: optionalEnvNumber('EXECUTOR_MAX_RPM', 5),
    minRebalanceIntervalSeconds: optionalEnvNumber('MIN_REBALANCE_INTERVAL_SECONDS', 0),
  };

  return {
    analyzerApiKey: requireEnv('GEMINI_ANALYZER_API_KEY'),
    executorApiKey: requireEnv('GEMINI_EXECUTOR_API_KEY'),
    suiNetwork: optionalEnv('SUI_NETWORK', 'testnet') as AgentConfig['suiNetwork'],
    aiPrivateKey: requireEnv('AI_PRIVATE_KEY'),
    packageId: requireEnv('PACKAGE_ID'),
    stakingPoolId: requireEnv('STAKING_POOL_ID'),
    oracleId: requireEnv('ORACLE_ID'),
    strategyRegistryId: requireEnv('STRATEGY_REGISTRY_ID'), // Matches .env
    aiCapabilityId: requireEnv('AI_CAPABILITY_ID'),
    monitorIntervalSeconds: optionalEnvNumber('MONITOR_INTERVAL_SECONDS', 10),
    ltvThresholds,
    rateLimits,
    sampleVaultId: optionalEnv('SAMPLE_VAULT_ID', '0x52d3644111f0cce9f27cfda9ec70bd55b1cbeb4d81a4f53a9bf145f41b183c68'),
    sampleStakePositionId: optionalEnv('SAMPLE_STAKE_POSITION_ID', '0xf01c6a994c87fccf3e1670aa85a58782ff2b5fe7f1f1df32071bcc878eeafc4e'),
    demoUserAddress: optionalEnv('DEMO_USER_ADDRESS', '0x0e9e0287bf733d0771e1c3a16055eb947874e2c855f881f7f218ded75cb0e85a'), // Default to testnet deployer
  };
}

// Contract module names
export const MODULES = {
  VAULT_MANAGER: 'vault_manager',
  LIQUID_STAKING: 'liquid_staking',
  AI_ADAPTER: 'ai_adapter',
  ORACLE_ADAPTER: 'oracle_adapter',
  LIQUIDATION: 'liquidation',
  OCTSUI: 'octsui',
  OCTUSD: 'octusd',
} as const;

// Token decimals (1e9 = 9 decimals)
export const TOKEN_DECIMALS = 9;
export const SCALE_FACTOR = 1_000_000_000n;

// Basis points scale
export const BPS_SCALE = 10000;

// User-specific strategy preferences (Demo/MVP)
// User-specific strategy preferences (Demo/MVP)
export const getUserStrategyPreferences = (userAddress?: string): Record<string, string> => {
  const prefs: Record<string, string> = {
    "default": "Conservative"
  };

  if (userAddress) {
    prefs[userAddress] = "Degen";
  }

  // Keep the original hardcoded one as fallback/legacy if needed, or remove if we want full clean up.
  // For now, let's keep the explicitly defined one if it differs from the passed userAddress, 
  // but since we want to remove hardcoded values, we'll rely on the passed argument.

  return prefs;
};

