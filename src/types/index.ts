/**
 * Octopus Finance AI Agent - Type Definitions
 */

// ===========================================
// BLOCKCHAIN TYPES
// ===========================================

export interface VaultData {
  id: string;
  owner: string;
  collateralAmount: bigint;
  debtAmount: bigint;
  rewardReserve: bigint;
  createdAt: number;
}

export interface StakePositionData {
  id: string;
  owner: string;
  shares: bigint;
  pendingRewards: bigint;
  linkedVaultId: string | null;
  autoRebalanceEnabled: boolean;
}

export interface StakingPoolData {
  id: string;
  totalStaked: bigint;
  totalShares: bigint;
  totalRewards: bigint;
  rewardRateBps: number;
  lastRewardEpoch: number;
}

export interface OracleData {
  id: string;
  prices: Map<string, PriceData>;
}

export interface PriceData {
  price: bigint;
  decimals: number;
  lastUpdate: number;
}

// ===========================================
// HEALTH METRICS
// ===========================================

export interface VaultHealthMetrics {
  vaultId: string;
  owner: string;
  collateralValue: bigint;
  debtValue: bigint;
  ltvBps: number;           // Current LTV in basis points
  healthStatus: HealthStatus;
  rewardReserve: bigint;
  pendingRewards: bigint;
  recommendedAction: RecommendedAction;
}

export enum HealthStatus {
  HEALTHY = 'HEALTHY',           // LTV < 60%
  WARNING = 'WARNING',           // LTV 60-65%
  AT_RISK = 'AT_RISK',          // LTV 65-70%
  CRITICAL = 'CRITICAL',        // LTV 70-80%
  LIQUIDATABLE = 'LIQUIDATABLE' // LTV > 80%
}

export enum RecommendedAction {
  NONE = 'NONE',
  MONITOR = 'MONITOR',
  CLAIM_REWARDS = 'CLAIM_REWARDS',
  REBALANCE = 'REBALANCE',
  URGENT_REBALANCE = 'URGENT_REBALANCE'
}

// ===========================================
// AI AGENT TYPES
// ===========================================

export interface AgentConfig {
  analyzerApiKey: string;
  executorApiKey: string;
  suiNetwork: 'mainnet' | 'testnet' | 'devnet' | 'localnet';
  aiPrivateKey: string;
  packageId: string;
  stakingPoolId: string;
  oracleId: string;
  aiCapabilityId: string;
  monitorIntervalSeconds: number;
  ltvThresholds: LtvThresholds;
  rateLimits: RateLimits;
  // Demo/Test Config
  sampleVaultId?: string;
  sampleStakePositionId?: string;
  demoUserAddress?: string;
}

export interface LtvThresholds {
  warning: number;      // 6000 = 60%
  rebalance: number;    // 6500 = 65%
  maxBorrow: number;    // 7000 = 70%
  liquidation: number;  // 8000 = 80%
}

export interface Strategy {
  id?: string;
  name: string;
  description: string;
  thresholds: LtvThresholds;
  actionRules: string;
  // UI Display Fields
  riskScore?: number;
  totalUsers?: number;
  totalValueManaged?: string;
  avg30dReturn?: number;
  verified?: boolean;
  minApy?: number;
  maxLtv?: number;
  targetHealth?: number;
  rebalanceThreshold?: number;
  autoCompound?: boolean;
  creator?: string;
  createdAt?: number;
  backtestPreview?: any[];
}

export interface RateLimits {
  analyzerMaxRpm: number;
  executorMaxRpm: number;
  minRebalanceIntervalSeconds: number;
}

// ===========================================
// TOOL DEFINITIONS FOR GEMINI
// ===========================================

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  txDigest?: string;
}

export interface AnalysisResult {
  vaultId: string;
  shouldAct: boolean;
  action: RecommendedAction;
  reasoning: string;
  confidence: number;
  estimatedRewardsNeeded: bigint;
  availableRewards: bigint;
}

export interface ExecutionResult {
  success: boolean;
  txDigest?: string;
  action: string;
  vaultId: string;
  rewardsClaimed?: bigint;
  collateralAdded?: bigint;
  newLtv?: number;
  error?: string;
}

// ===========================================
// EVENT TYPES
// ===========================================

export interface AIActionEvent {
  vaultId: string;
  action: string;
  rewardsClaimed: bigint;
  collateralAdded: bigint;
  oldLtv: number;
  newLtv: number;
  timestamp: number;
}

export interface MonitoringEvent {
  type: 'health_check' | 'action_taken' | 'error' | 'rate_limited';
  vaultId?: string;
  details: Record<string, unknown>;
  timestamp: number;
}

// ===========================================
// RATE LIMITER
// ===========================================

export interface RateLimiterState {
  lastCalls: number[];
  maxCallsPerMinute: number;
}
