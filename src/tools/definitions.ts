// octopus-ai-agent/src/tools/definitions.ts
/**
 * Octopus Finance - Gemini Tool Definitions
 * These tools are used by the Executor Agent to perform on-chain actions
 */

import { FunctionDeclaration, Type } from '@google/genai';

/**
 * Tool: Claim Staking Rewards and Rebalance Vault
 * This is the main tool for protecting vaults from liquidation
 */
export const claimAndRebalanceTool: FunctionDeclaration = {
  name: 'claim_and_rebalance',
  description: `Claims pending staking rewards from a user's stake position and uses them to add collateral to their vault, reducing the LTV ratio. Use this when a vault's LTV is above 60% (warning threshold) and the stake position has pending rewards available.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      vault_id: {
        type: Type.STRING,
        description: 'The object ID of the vault to rebalance',
      },
      stake_position_id: {
        type: Type.STRING,
        description: 'The object ID of the stake position linked to this vault',
      },
      reasoning: {
        type: Type.STRING,
        description: 'Brief explanation of why this rebalance is needed',
      },
    },
    required: ['vault_id', 'stake_position_id', 'reasoning'],
  },
};

/**
 * Tool: Rebalance from Existing Reserve
 * Uses already-deposited reserve funds without claiming new rewards
 */
export const rebalanceFromReserveTool: FunctionDeclaration = {
  name: 'rebalance_from_reserve',
  description: `Moves collateral from the vault's reward reserve to active collateral, reducing LTV. Use this when a vault already has funds in its reward_reserve and needs LTV reduction.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      vault_id: {
        type: Type.STRING,
        description: 'The object ID of the vault to rebalance',
      },
      reasoning: {
        type: Type.STRING,
        description: 'Brief explanation of why this rebalance is needed',
      },
    },
    required: ['vault_id', 'reasoning'],
  },
};

/**
 * Tool: Skip Action
 * Explicitly decline to take action (for transparency)
 */
export const skipActionTool: FunctionDeclaration = {
  name: 'skip_action',
  description: `Explicitly skip taking any action on a vault. Use this when the vault is healthy (LTV < 60%) or when there are no rewards available to claim.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      vault_id: {
        type: Type.STRING,
        description: 'The object ID of the vault being evaluated',
      },
      reason: {
        type: Type.STRING,
        description: 'Explanation of why no action is being taken',
      },
    },
    required: ['vault_id', 'reason'],
  },
};

/**
 * All tools available to the Executor Agent
 */
export const executorTools: FunctionDeclaration[] = [
  claimAndRebalanceTool,
  rebalanceFromReserveTool,
  skipActionTool,
];

/**
 * Tool execution types
 */
export interface ClaimAndRebalanceArgs {
  vault_id: string;
  stake_position_id: string;
  reasoning: string;
}

export interface RebalanceFromReserveArgs {
  vault_id: string;
  reasoning: string;
}

export interface SkipActionArgs {
  vault_id: string;
  reason: string;
}

export type ToolArgs = ClaimAndRebalanceArgs | RebalanceFromReserveArgs | SkipActionArgs;
