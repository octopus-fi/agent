import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { AnalyzerAgent } from './src/agents/analyzer';
import { AgentConfig, HealthStatus, RecommendedAction, VaultHealthMetrics } from './src/types';

dotenv.config();

// Configuration
const CONFIG = {
    network: 'testnet',
    registryId: process.env.STRATEGY_REGISTRY_ID,
    packageId: process.env.PACKAGE_ID,
    walrusAggregator: process.env.WALRUS_AGGREGATOR_URL || 'https://aggregator.walrus-testnet.walrus.space',
    geminiKey: process.env.GEMINI_ANALYZER_API_KEY,
};

// Mock Strategy Interface
interface Strategy {
    name: string;
    description: string;
    thresholds: {
        warning: number;
        rebalance: number;
        maxBorrow: number;
        liquidation: number;
    };
    actionRules: string;
}

async function main() {
    const args = process.argv.slice(2);
    const strategyName = args[0] || 'Conservative';
    const mockLtvPercent = parseFloat(args[1] || '60'); // Default to 60% LTV 

    console.log('🤖 Walrus Strategy Simulation');
    console.log('============================');
    console.log(`Target Strategy: ${strategyName}`);
    console.log(`Mock LTV: ${mockLtvPercent}%`);

    if (!CONFIG.registryId || !CONFIG.packageId) {
        throw new Error('❌ Missing env vars (STRATEGY_REGISTRY_ID or PACKAGE_ID)');
    }

    const client = new SuiClient({ url: getFullnodeUrl('testnet') });

    // 1. Get Blob ID from Registry (using devInspect for view function)
    console.log('\n🔗 Step 1: Querying Strategy Registry...');
    console.log(`   Registry ID: ${CONFIG.registryId}`);

    const txb = new Transaction();
    txb.moveCall({
        target: `${CONFIG.packageId}::strategy_registry::get_strategy_blob_id`,
        arguments: [
            txb.object(CONFIG.registryId),
            txb.pure.string(strategyName)
        ]
    });

    // Note: devInspectTransactionBlock might be deprecated or expect different params if using Transaction
    // But usually it accepts 'transactionBlock' property which can take a Transaction instance.
    // ... (tx setup)

    let blobId = '';
    try {
        const inspectResult = await client.devInspectTransactionBlock({
            sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
            transactionBlock: txb,
        });

        if (inspectResult.effects.status.status === 'failure') {
            console.warn('⚠️ On-chain strategy lookup failed (Move error).');
            throw new Error(inspectResult.effects.status.error);
        }

        if (inspectResult.results && inspectResult.results[0] && inspectResult.results[0].returnValues) {
            const valueBytes = Uint8Array.from(inspectResult.results[0].returnValues[0][0]);
            if (valueBytes[0] < 128) {
                blobId = new TextDecoder().decode(valueBytes.slice(1));
            } else {
                blobId = new TextDecoder().decode(valueBytes.slice(2));
            }
            console.log(`✅ Found Blob ID on-chain: ${blobId}`);
        } else {
            throw new Error('No return values from on-chain call');
        }
    } catch (e) {
        console.warn(`⚠️ Failed to fetch from registry: ${e instanceof Error ? e.message : String(e)}`);
        console.log('   Falling back to local strategy_blobs.json...');

        // Fallback
        const blobsPath = path.join(__dirname, 'strategy_blobs.json');
        if (fs.existsSync(blobsPath)) {
            const blobs = JSON.parse(fs.readFileSync(blobsPath, 'utf-8'));
            blobId = blobs[strategyName];
            if (blobId) {
                console.log(`✅ Found Blob ID locally: ${blobId}`);
            } else {
                console.error(`❌ Strategy "${strategyName}" not found in local file.`);
                return;
            }
        } else {
            console.error('❌ Local strategy_blobs.json not found.');
            return;
        }
    }


    // 2. Fetch from Walrus
    console.log('\nWalrus Fetching Strategy JSON...');
    const url = `${CONFIG.walrusAggregator}/v1/blobs/${blobId}`;
    console.log(`   URL: ${url}`);

    let strategy: Strategy;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch blob: ${response.statusText}`);
        }
        const text = await response.text();
        // Try parsing
        try {
            strategy = JSON.parse(text) as unknown as Strategy;
            console.log('✅ Strategy Loaded from Walrus');
        } catch (parseError) {
            console.warn(`⚠️ Failed to parse Walrus content: ${text.substring(0, 50)}...`);
            throw parseError;
        }
    } catch (e) {
        console.warn(`⚠️ Walrus fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        console.log('   Falling back to local strategies/*.json ...');

        try {
            const localPath = path.join(__dirname, 'strategies', `${strategyName.toLowerCase()}.json`);
            if (fs.existsSync(localPath)) {
                strategy = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
                console.log(`✅ Strategy Loaded locally from ${localPath}`);
            } else {
                throw new Error(`Local strategy file not found: ${localPath}`);
            }
        } catch (localError) {
            console.error('❌ Failed to load strategy locally.');
            throw localError;
        }
    }

    console.log(JSON.stringify(strategy, null, 2));


    // 3. Simulate Agent Analysis
    console.log('\n🤖 Step 3: Running AI Analysis...');

    const mockConfig: AgentConfig = {
        analyzerApiKey: CONFIG.geminiKey || '',
        executorApiKey: '',
        suiNetwork: 'testnet',
        aiPrivateKey: '',
        packageId: CONFIG.packageId,
        stakingPoolId: '',
        oracleId: '',
        aiCapabilityId: '',
        monitorIntervalSeconds: 60,
        ltvThresholds: strategy.thresholds,
        rateLimits: { analyzerMaxRpm: 60, executorMaxRpm: 10, minRebalanceIntervalSeconds: 0 }
    };

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
