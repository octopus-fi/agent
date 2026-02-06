import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { AnalyzerAgent } from './src/agents/analyzer';
import { AgentConfig, HealthStatus, RecommendedAction, VaultHealthMetrics, Strategy } from './src/types';
import { StrategyLoader } from './src/services/strategy-loader';

dotenv.config();

// Configuration
const CONFIG = {
    network: 'testnet',
    registryId: process.env.STRATEGY_REGISTRY_ID,
    packageId: process.env.PACKAGE_ID,
    walrusAggregator: process.env.WALRUS_AGGREGATOR_URL || 'https://aggregator.walrus-testnet.walrus.space',
    geminiKey: process.env.GEMINI_ANALYZER_API_KEY,
};

async function main() {
    const args = process.argv.slice(2);
    const strategyName = args[0] || 'Conservative';
    const mockLtvPercent = parseFloat(args[1] || '60'); // Default to 60% LTV 

    console.log('🤖 Strategy Simulation (Local Mode)');
    console.log('=================================');
    console.log(`Target Strategy: ${strategyName}`);
    console.log(`Mock LTV: ${mockLtvPercent}%`);

    // Mock Config for Loader
    const mockConfig: AgentConfig = {
        analyzerApiKey: CONFIG.geminiKey || '',
        executorApiKey: '',
        suiNetwork: 'testnet',
        aiPrivateKey: '',
        packageId: CONFIG.packageId || '',
        stakingPoolId: '',
        oracleId: '',
        aiCapabilityId: '',
        monitorIntervalSeconds: 60,
        ltvThresholds: { warning: 6000, rebalance: 6500, maxBorrow: 7000, liquidation: 8000 },
        rateLimits: { analyzerMaxRpm: 60, executorMaxRpm: 10, minRebalanceIntervalSeconds: 0 }
    };

    const strategyLoader = new StrategyLoader(mockConfig);

    console.log('\nLoading Strategy...');
    const strategy = await strategyLoader.getStrategy(strategyName);

    if (!strategy) {
        console.error(`❌ Failed to load strategy '${strategyName}' from local files.`);
        return;
    }

    console.log('✅ Strategy Loaded:', strategy.name);
    console.log(JSON.stringify(strategy, null, 2));


    // 3. Simulate Agent Analysis
    console.log('\n🤖 Step 3: Running AI Analysis...');

    const analyzer = new AnalyzerAgent(mockConfig);

    // Mock Vault Metrics
    const collateral = 1000_000_000_000n; // $1000
    const debt = BigInt(Math.floor(1000 * mockLtvPercent * 100)); // approximate
    const mockDebt = (BigInt(Math.floor(mockLtvPercent * 100)) * collateral) / 10000n;

    const metrics: VaultHealthMetrics = {
        vaultId: '0xMOCK_VAULT',
        owner: '0xUSER',
        collateralValue: collateral,
        debtValue: mockDebt,
        ltvBps: Math.floor(mockLtvPercent * 100),
        healthStatus: HealthStatus.WARNING,
        rewardReserve: 0n,
        pendingRewards: 0n,
        recommendedAction: RecommendedAction.NONE
    };

    console.log(`   Vault State: LTV ${metrics.ltvBps} bps (${mockLtvPercent}%)`);
    console.log(`   Strategy Rebalance Threshold: ${strategy.thresholds.rebalance} bps`);

    // Run Analysis
    const analysisResult = await analyzer.analyzeVault(metrics);

    console.log('\n📝 AI Analysis Result:');
    console.log(`   Should Act: ${analysisResult.shouldAct}`);
    console.log(`   Action: ${analysisResult.action}`);
    console.log(`   Reasoning: ${analysisResult.reasoning}`);

    if (analysisResult.action === 'REBALANCE' || analysisResult.action === 'URGENT_REBALANCE') {
        if (metrics.ltvBps >= strategy.thresholds.rebalance) {
            console.log('\n✅ SUCCESS: Agent recommended rebalancing as expected by strategy.');
        } else {
            console.log('\n⚠️ UNEXPECTED: Agent recommended rebalancing below threshold?');
        }
    } else {
        if (metrics.ltvBps < strategy.thresholds.rebalance) {
            console.log('\n✅ SUCCESS: Agent correctly held off rebalancing.');
        } else {
            console.log('\n⚠️ UNEXPECTED: Agent missed rebalance opportunity?');
        }
    }
}

main().catch(console.error);
