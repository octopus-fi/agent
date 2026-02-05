/**
 * Octopus Finance AI Agent - Main Entry Point
 */

import { loadConfig } from "./config";
import { VaultMonitor } from "./services/vault-monitor";
import { logger } from "./utils/logger";
import "dotenv/config";

async function main(): Promise<void> {
  logger.info("=".repeat(50));
  logger.info("Octopus Finance AI Agent Starting...");
  logger.info("=".repeat(50));

  try {
    // Load configuration
    const config = loadConfig();
    logger.info(`Network: ${config.suiNetwork}`);
    logger.info(`Package ID: ${config.packageId}`);

    // Initialize vault monitor
    const monitor = new VaultMonitor(config);

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      logger.info("Received SIGINT, shutting down...");
      monitor.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      logger.info("Received SIGTERM, shutting down...");
      monitor.stop();
      process.exit(0);
    });

    // TEMP: manual vault injection for testing
    const sampleVaultId = process.env.SAMPLE_VAULT_ID;
    const sampleStakePositionId = process.env.SAMPLE_STAKE_POSITION_ID;
    if (sampleVaultId && sampleStakePositionId) {
      monitor.addVault(sampleVaultId, sampleStakePositionId);
    }

    // Start monitoring
    await monitor.start();

    logger.info("AI Agent is now running. Press Ctrl+C to stop.");
  } catch (error) {
    logger.error("Failed to start AI agent:", error);
    process.exit(1);
  }
}

main();
