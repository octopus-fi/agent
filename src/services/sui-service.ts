/**
 * Octopus Finance - Sui Blockchain Service
 * Handles all on-chain interactions
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import {
  AgentConfig,
  VaultData,
  StakePositionData,
  StakingPoolData,
  VaultHealthMetrics,
  HealthStatus,
  RecommendedAction,
  ExecutionResult,
} from "../types";
import { MODULES, SCALE_FACTOR, BPS_SCALE } from "../config";
import { logger } from "../utils/logger";

export class SuiService {
  private client: SuiClient;
  private keypair: Ed25519Keypair;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new SuiClient({ url: getFullnodeUrl(config.suiNetwork) });

    // Initialize keypair from private key (suiprivkey1... format)
    const { secretKey } = decodeSuiPrivateKey(config.aiPrivateKey);
    this.keypair = Ed25519Keypair.fromSecretKey(secretKey);

    logger.info(`AI Agent initialized with address: ${this.getAgentAddress()}`);
  }

  getAgentAddress(): string {
    return this.keypair.getPublicKey().toSuiAddress();
  }

  // ===========================================
  // READ OPERATIONS (No gas cost)
  // ===========================================

  async getVault(vaultId: string): Promise<VaultData | null> {
    try {
      const obj = await this.client.getObject({
        id: vaultId,
        options: { showContent: true, showOwner: true },
      });

      if (!obj.data?.content || obj.data.content.dataType !== "moveObject") {
        return null;
      }

      const fields = obj.data.content.fields as Record<string, unknown>;

      // Vault is now a shared object, owner is stored in the struct
      return {
        id: vaultId,
        owner: (fields["owner"] as string) || "",
        collateralAmount: BigInt((fields["collateral"] as string) || "0"),
        debtAmount: BigInt((fields["debt"] as string) || "0"),
        rewardReserve: BigInt((fields["reward_reserve"] as string) || "0"),
        createdAt: 0, // Not tracked in contract
      };
    } catch (error) {
      logger.error(`Failed to get vault ${vaultId}:`, error);
      return null;
    }
  }

  async getStakePosition(
    positionId: string,
  ): Promise<StakePositionData | null> {
    try {
      const obj = await this.client.getObject({
        id: positionId,
        options: { showContent: true },
      });

      if (!obj.data?.content || obj.data.content.dataType !== "moveObject") {
        return null;
      }

      const fields = obj.data.content.fields as Record<string, unknown>;

      return {
        id: positionId,
        owner: (fields["owner"] as string) || "",
        shares: BigInt((fields["shares"] as string) || "0"),
        pendingRewards: BigInt((fields["pending_rewards"] as string) || "0"),
        linkedVaultId: fields["linked_vault_id"] as string | null,
        autoRebalanceEnabled:
          (fields["auto_rebalance_enabled"] as boolean) || false,
      };
    } catch (error) {
      logger.error(`Failed to get stake position ${positionId}:`, error);
      return null;
    }
  }

  async getStakingPool(): Promise<StakingPoolData | null> {
    try {
      const obj = await this.client.getObject({
        id: this.config.stakingPoolId,
        options: { showContent: true },
      });

      if (!obj.data?.content || obj.data.content.dataType !== "moveObject") {
        return null;
      }

      const fields = obj.data.content.fields as Record<string, unknown>;

      return {
        id: this.config.stakingPoolId,
        totalStaked: BigInt((fields["asset_balance"] as string) || "0"),
        totalShares: BigInt((fields["total_shares"] as string) || "0"),
        totalRewards: BigInt((fields["total_rewards"] as string) || "0"),
        rewardRateBps: Number(fields["reward_rate_bps"] || 7),
        lastRewardEpoch: Number(fields["last_reward_epoch"] || 0),
      };
    } catch (error) {
      logger.error("Failed to get staking pool:", error);
      return null;
    }
  }

  // async getPrice(tokenType: string): Promise<bigint> {
  //   try {
  //     const obj = await this.client.getObject({
  //       id: this.config.oracleId,
  //       options: { showContent: true }
  //     });

  //     if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
  //       return 0n;
  //     }

  //     const fields = obj.data.content.fields as Record<string, unknown>;
  //     const prices = fields['prices'] as Record<string, string>;

  //     return BigInt(prices[tokenType] || '0');
  //   } catch (error) {
  //     logger.error(`Failed to get price for ${tokenType}:`, error);
  //     return 0n;
  //   }
  // }

  async getPrice(tokenType: string): Promise<bigint> {
    if (tokenType === "OCTSUI") {
      // price in USD scaled to 1e9
      const price = process.env.OCTSUI_PRICE_USD || "3.5";
      return BigInt(Math.floor(parseFloat(price) * 1e9));
    }

    return 0n;
  }

  async calculateVaultHealth(
    vault: VaultData,
    stakePosition: StakePositionData | null,
    collateralPrice: bigint,
  ): Promise<VaultHealthMetrics> {
    // Calculate LTV: (debt * 1e9) / (collateral * price) * 10000
    const collateralValue =
      (vault.collateralAmount * collateralPrice) / SCALE_FACTOR;
    const debtValue = vault.debtAmount; // octUSD is 1:1 with USD

    let ltvBps = 0;
    if (collateralValue > 0n) {
      ltvBps = Number((debtValue * BigInt(BPS_SCALE)) / collateralValue);
    }

    // Determine health status
    let healthStatus: HealthStatus;
    let recommendedAction: RecommendedAction;

    if (ltvBps >= this.config.ltvThresholds.liquidation) {
      healthStatus = HealthStatus.LIQUIDATABLE;
      recommendedAction = RecommendedAction.URGENT_REBALANCE;
    } else if (ltvBps >= this.config.ltvThresholds.maxBorrow) {
      healthStatus = HealthStatus.CRITICAL;
      recommendedAction = RecommendedAction.URGENT_REBALANCE;
    } else if (ltvBps >= this.config.ltvThresholds.rebalance) {
      healthStatus = HealthStatus.AT_RISK;
      recommendedAction = RecommendedAction.REBALANCE;
    } else if (ltvBps >= this.config.ltvThresholds.warning) {
      healthStatus = HealthStatus.WARNING;
      recommendedAction = RecommendedAction.CLAIM_REWARDS;
    } else {
      healthStatus = HealthStatus.HEALTHY;
      recommendedAction = RecommendedAction.NONE;
    }

    const pendingRewards = stakePosition?.pendingRewards || 0n;

    return {
      vaultId: vault.id,
      owner: vault.owner,
      collateralValue,
      debtValue,
      ltvBps,
      healthStatus,
      rewardReserve: vault.rewardReserve,
      pendingRewards,
      recommendedAction,
    };
  }

  // ===========================================
  // WRITE OPERATIONS (Requires gas)
  // ===========================================

  async executeClaimAndRebalance(
    stakePositionId: string,
    vaultId: string,
  ): Promise<ExecutionResult> {
    try {
      logger.info(
        `[sui-service] rebalance args: vault=${vaultId} oracle=${this.config.oracleId} cap=${this.config.aiCapabilityId}`,
      );

      const tx = new Transaction();

      // Call ai_claim_and_rebalance
      // T = underlying asset type (MOCKSUI), NOT OCTSUI
      // Clock shared object ID on Sui (0x6)
      const CLOCK_OBJECT_ID = '0x6';

      tx.moveCall({
        target: `${this.config.packageId}::${MODULES.AI_ADAPTER}::ai_claim_and_rebalance`,
        typeArguments: [`${this.config.packageId}::mocksui::MOCKSUI`],
        arguments: [
          tx.object(this.config.aiCapabilityId), // cap
          tx.object(this.config.stakingPoolId), // pool: StakingPool<T>
          tx.object(stakePositionId), // position: StakePosition
          tx.object(vaultId), // vault: Vault<OCTSUI>
          tx.object(this.config.oracleId as string), // oracle
          tx.object(CLOCK_OBJECT_ID), // clock: &Clock (required for timestamp)
        ],
      });

      const result = await this.client.signAndExecuteTransaction({
        signer: this.keypair,
        transaction: tx,
        options: {
          showEffects: true,
          showEvents: true,
        },
      });

      logger.info(`Claim and rebalance executed: ${result.digest}`);

      // Parse events to get details
      let rewardsClaimed = 0n;
      let collateralAdded = 0n;

      if (result.events) {
        for (const event of result.events) {
          if (event.type.includes("AIActionEvent")) {
            const eventData = event.parsedJson as Record<string, string>;
            rewardsClaimed = BigInt(eventData["rewards_claimed"] || "0");
            collateralAdded = BigInt(eventData["collateral_added"] || "0");
          }
        }
      }

      return {
        success: true,
        txDigest: result.digest,
        action: "claim_and_rebalance",
        vaultId,
        rewardsClaimed,
        collateralAdded,
      };
    } catch (error) {
      logger.error("Failed to execute claim and rebalance:", error);
      return {
        success: false,
        action: "claim_and_rebalance",
        vaultId,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async executeRebalanceFromReserve(vaultId: string): Promise<ExecutionResult> {
    try {
      const tx = new Transaction();

      tx.moveCall({
        target: `${this.config.packageId}::${MODULES.AI_ADAPTER}::ai_rebalance`,
        typeArguments: [`${this.config.packageId}::octsui::OCTSUI`],
        arguments: [
          tx.object(this.config.aiCapabilityId),
          tx.object(vaultId),
          tx.object(this.config.oracleId),
        ],
      });

      const result = await this.client.signAndExecuteTransaction({
        signer: this.keypair,
        transaction: tx,
        options: {
          showEffects: true,
          showEvents: true,
        },
      });

      logger.info(`Rebalance from reserve executed: ${result.digest}`);

      return {
        success: true,
        txDigest: result.digest,
        action: "rebalance_from_reserve",
        vaultId,
      };
    } catch (error) {
      logger.error("Failed to execute rebalance:", error);
      return {
        success: false,
        action: "rebalance_from_reserve",
        vaultId,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Get all vaults that this AI is authorized to manage
  async getAuthorizedVaults(): Promise<string[]> {
    try {
      // Query events to find vaults where AI was authorized
      const events = await this.client.queryEvents({
        query: {
          MoveEventType: `${this.config.packageId}::${MODULES.AI_ADAPTER}::AIAuthorizedEvent`,
        },
        limit: 100,
      });

      const vaultIds: string[] = [];
      for (const event of events.data) {
        const eventData = event.parsedJson as Record<string, string>;
        if (eventData["ai_address"] === this.getAgentAddress()) {
          vaultIds.push(eventData["vault_id"]);
        }
      }

      return vaultIds;
    } catch (error) {
      logger.error("Failed to get authorized vaults:", error);
      return [];
    }
  }

  // Get stake positions linked to vaults with auto-rebalance enabled
  async getAutoRebalancePositions(): Promise<Map<string, string>> {
    // Returns Map<vaultId, stakePositionId>
    try {
      const events = await this.client.queryEvents({
        query: {
          MoveEventType: `${this.config.packageId}::${MODULES.LIQUID_STAKING}::AutoRebalanceEnabledEvent`,
        },
        limit: 100,
      });

      const positions = new Map<string, string>();
      for (const event of events.data) {
        const eventData = event.parsedJson as Record<string, string>;
        positions.set(eventData["vault_id"], eventData["position_id"]);
      }

      return positions;
    } catch (error) {
      logger.error("Failed to get auto-rebalance positions:", error);
      return new Map();
    }
  }
}
