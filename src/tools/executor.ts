/**
 * Octopus Finance - Tool Executor
 * Handles execution of Gemini tool calls
 */

import { SuiService } from '../services/sui-service';
import { ExecutionResult } from '../types';
import { logger } from '../utils/logger';
import { 
  ClaimAndRebalanceArgs, 
  RebalanceFromReserveArgs, 
  SkipActionArgs,
  ToolArgs 
} from './definitions';

export class ToolExecutor {
  private suiService: SuiService;

  constructor(suiService: SuiService) {
    this.suiService = suiService;
  }

  async execute(toolName: string, args: ToolArgs): Promise<ExecutionResult> {
    logger.info(`Executing tool: ${toolName}`, { args });

    switch (toolName) {
      case 'claim_and_rebalance':
        return this.executeClaimAndRebalance(args as ClaimAndRebalanceArgs);

      case 'rebalance_from_reserve':
        return this.executeRebalanceFromReserve(args as RebalanceFromReserveArgs);

      case 'skip_action':
        return this.executeSkipAction(args as SkipActionArgs);

      default:
        logger.error(`Unknown tool: ${toolName}`);
        return {
          success: false,
          action: toolName,
          vaultId: 'unknown',
          error: `Unknown tool: ${toolName}`,
        };
    }
  }

  private async executeClaimAndRebalance(args: ClaimAndRebalanceArgs): Promise<ExecutionResult> {
    logger.info(`Claim and rebalance: ${args.vault_id}`, { reason: args.reasoning });
    
    return this.suiService.executeClaimAndRebalance(
      args.stake_position_id,
      args.vault_id
    );
  }

  private async executeRebalanceFromReserve(args: RebalanceFromReserveArgs): Promise<ExecutionResult> {
    logger.info(`Rebalance from reserve: ${args.vault_id}`, { reason: args.reasoning });
    
    return this.suiService.executeRebalanceFromReserve(args.vault_id);
  }

  private async executeSkipAction(args: SkipActionArgs): Promise<ExecutionResult> {
    logger.info(`Skipping action on vault ${args.vault_id}: ${args.reason}`);
    
    return {
      success: true,
      action: 'skip',
      vaultId: args.vault_id,
    };
  }
}
