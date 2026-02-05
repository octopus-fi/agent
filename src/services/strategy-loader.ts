
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig, Strategy } from '../types';
import { logger } from '../utils/logger';

export class StrategyLoader {
    private client: SuiClient;
    private config: AgentConfig;
    private registryId: string;
    private walrusAggregator: string;
    // Cache: name -> Strategy
    private cache: Map<string, Strategy> = new Map();
    private cacheTtlMs = 60000; // 1 minute
    private lastFetchTime: Map<string, number> = new Map();

    constructor(config: AgentConfig) {
        this.config = config;
        this.client = new SuiClient({ url: getFullnodeUrl(config.suiNetwork) });
        this.registryId = config.strategyRegistryId;
        this.walrusAggregator = process.env.WALRUS_AGGREGATOR_URL || 'https://aggregator.walrus-testnet.walrus.space';
    }

    async getStrategy(name: string): Promise<Strategy | null> {
        // Check cache
        if (this.isCachedValid(name)) {
            return this.cache.get(name)!;
        }

        try {
            // 1. Get Blob ID from Registry
            const blobId = await this.fetchBlobIdFromRegistry(name);

            // 2. Fetch JSON from Walrus
            const strategy = await this.fetchStrategyFromWalrus(blobId, name);

            // Update cache
            this.cache.set(name, strategy);
            this.lastFetchTime.set(name, Date.now());

            return strategy;
        } catch (error) {
            logger.warn(`[StrategyLoader] Failed to load strategy '${name}', attempting local fallback`, error);
            // Fallback
            return this.loadLocalStrategy(name);
        }
    }

    private isCachedValid(name: string): boolean {
        if (!this.cache.has(name)) return false;
        const last = this.lastFetchTime.get(name) || 0;
        return (Date.now() - last) < this.cacheTtlMs;
    }

    private async fetchBlobIdFromRegistry(name: string): Promise<string> {
        if (!this.registryId) {
            throw new Error('STRATEGY_REGISTRY_ID not configured');
        }

        const txb = new Transaction();
        txb.moveCall({
            target: `${this.config.packageId}::strategy_registry::get_strategy_blob_id`,
            arguments: [
                txb.object(this.registryId),
                txb.pure.string(name)
            ]
        });

        const inspectResult = await this.client.devInspectTransactionBlock({
            sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
            transactionBlock: txb,
        });

        if (inspectResult.effects.status.status === 'failure') {
            throw new Error(`Registry lookup failed: ${inspectResult.effects.status.error}`);
        }

        if (inspectResult.results && inspectResult.results[0]?.returnValues) {
            const valueBytes = Uint8Array.from(inspectResult.results[0].returnValues[0][0]);
            // Extract String (BCS encoded)
            // Check first byte for length encoding (vector<u8>)
            // Simple heuristic for ULEB128 length prefix standard in BCS for vectors
            let contentBytes;
            if (valueBytes[0] < 128) {
                contentBytes = valueBytes.slice(1);
            } else {
                contentBytes = valueBytes.slice(2);
            }
            return new TextDecoder().decode(contentBytes);
        }

        throw new Error('No return value from registry lookup');
    }

    private async fetchStrategyFromWalrus(blobId: string, strategyName: string): Promise<Strategy> {
        const url = `${this.walrusAggregator}/v1/blobs/${blobId}`;
        logger.debug(`[StrategyLoader] Fetching from Walrus: ${url}`);

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Walrus fetch failed: ${response.statusText}`);
        }

        const text = await response.text();
        try {
            return JSON.parse(text) as Strategy;
        } catch (e) {
            logger.warn(`[StrategyLoader] Invalid JSON from Walrus: ${text.substring(0, 50)}...`);
            throw new Error('Invalid JSON content');
        }
    }

    private loadLocalStrategy(name: string): Strategy | null {
        try {
            // Traverse up from src/services to root
            const rootDir = path.resolve(__dirname, '..', '..');
            const strategyPath = path.join(rootDir, 'strategies', `${name.toLowerCase()}.json`);

            if (fs.existsSync(strategyPath)) {
                logger.info(`[StrategyLoader] Loaded local strategy: ${strategyPath}`);
                const data = fs.readFileSync(strategyPath, 'utf-8');
                return JSON.parse(data) as Strategy;
            }
        } catch (e) {
            logger.error(`[StrategyLoader] Local fallback failed for '${name}'`, e);
        }
        return null;
    }
}
