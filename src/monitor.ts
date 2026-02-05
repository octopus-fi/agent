/**
 * Octopus Finance - Standalone Monitor Script
 * Run with: npm run monitor
 */

import { loadConfig } from './config';
import { VaultMonitor } from './services/vault-monitor';
import { logger } from './utils/logger';

async function runMonitor(): Promise<void> {
  logger.info('Starting Octopus Finance Vault Monitor (Single Run Mode)');

  try {
    const config = loadConfig();
    const monitor = new VaultMonitor(config);
    
    // Run single monitoring cycle
    await monitor.runMonitoringCycle();
    
    logger.info('Monitoring cycle complete');
    process.exit(0);

  } catch (error) {
    logger.error('Monitor error:', error);
    process.exit(1);
  }
}

runMonitor();
