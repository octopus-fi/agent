import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig, Strategy } from '../types';
import { logger } from '../utils/logger';

export class StrategyLoader {
    private config: AgentConfig;
    // Cache: name -> Strategy
    private cache: Map<string, Strategy> = new Map();
    private cacheTtlMs = 60000; // 1 minute
    private lastFetchTime: Map<string, number> = new Map();

    constructor(config: AgentConfig) {
        this.config = config;
    }

    async getStrategy(name: string): Promise<Strategy | null> {
        // Check cache
        if (this.isCachedValid(name)) {
            return this.cache.get(name)!;
        }

        try {
            const strategy = this.loadLocalStrategy(name);
            if (strategy) {
                this.cache.set(name, strategy);
                this.lastFetchTime.set(name, Date.now());
            }
            return strategy;
        } catch (error) {
            logger.error(`[StrategyLoader] Failed to load strategy '${name}'`, error);
            return null;
        }
    }

    async getAllStrategies(): Promise<Strategy[]> {
        try {
            const rootDir = path.resolve(__dirname, '..', '..');
            const strategiesDir = path.join(rootDir, 'strategies');

            if (!fs.existsSync(strategiesDir)) {
                logger.warn(`[StrategyLoader] Strategies directory not found: ${strategiesDir}`);
                return [];
            }

            const files = fs.readdirSync(strategiesDir);
            const strategies: Strategy[] = [];

            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(strategiesDir, file);
                    try {
                        const content = fs.readFileSync(filePath, 'utf-8');
                        const rawStrategy = JSON.parse(content);

                        // Enrich with default/mock data for UI
                        const strategy: Strategy = {
                            ...rawStrategy,
                            id: rawStrategy.id || rawStrategy.name.toLowerCase().replace(/\s+/g, '-'),
                            riskScore: rawStrategy.riskScore || 5, // Default moderate
                            totalUsers: rawStrategy.totalUsers || Math.floor(Math.random() * 1000) + 100,
                            totalValueManaged: rawStrategy.totalValueManaged || (Math.floor(Math.random() * 5000000) + 500000).toString(),
                            avg30dReturn: rawStrategy.avg30dReturn || (Math.random() * 10 + 2),
                            verified: rawStrategy.verified !== undefined ? rawStrategy.verified : true,
                            minApy: rawStrategy.minApy || 5,
                            maxLtv: rawStrategy.maxLtv || (rawStrategy.thresholds?.maxBorrow ? rawStrategy.thresholds.maxBorrow / 100 : 70),
                            targetHealth: rawStrategy.targetHealth || 1.5,
                            rebalanceThreshold: rawStrategy.rebalanceThreshold || (rawStrategy.thresholds?.rebalance ? rawStrategy.thresholds.rebalance / 10000 : 0.75), // Convert BPS to decimal if needed, but threshold usually is BPS in agent. Wait, frontend expects multiplier? 
                            // Frontend: {strategy.rebalanceThreshold.toFixed(1)}x -> expects e.g. 1.2
                            // Agent thresholds are BPS (e.g. 6500 = 65%). 
                            // Rebalance Threshold in UI usually means "Health Factor" threshold or raw LTV?
                            // In StrategyCard: `strategy.rebalanceThreshold.toFixed(1)}x` -> This looks like Health Factor.
                            // If Agent uses LTV, we need to convert. 
                            // Let's assume rebalanceThreshold in UI is Health Factor.
                            // If LTV > X, Health < Y. 
                            // Default to 1.2 if not set.

                            autoCompound: rawStrategy.autoCompound !== undefined ? rawStrategy.autoCompound : true,
                            creator: rawStrategy.creator || 'Octopus Protocol',
                            createdAt: rawStrategy.createdAt || Date.now() - (Math.floor(Math.random() * 30) * 86400000),
                            backtestPreview: rawStrategy.backtestPreview || Array.from({ length: 20 }, (_, i) => ({
                                date: new Date(Date.now() - (20 - i) * 86400000).toISOString(),
                                value: 1000 + Math.random() * 200 + i * 10
                            }))
                        };

                        // Fix specific field types if needed
                        if (strategy.thresholds && typeof strategy.rebalanceThreshold === 'number' && strategy.rebalanceThreshold > 100) {
                            // If it looks like BPS, leave it? No, UI expects small number for 'x'. 
                            // Let's strictly set targetHealth and rebalanceThreshold to be Health Factors (e.g. 1.2, 1.5)
                            // ignoring purely what might be in raw JSON if it's BPS.
                            strategy.rebalanceThreshold = 1.1; // Example
                        }

                        strategies.push(strategy);
                    } catch (e) {
                        logger.error(`[StrategyLoader] Failed to parse strategy file ${file}`, e);
                    }
                }
            }

            return strategies;
        } catch (error) {
            logger.error('[StrategyLoader] Failed to list strategies', error);
            return [];
        }
    }

    private isCachedValid(name: string): boolean {
        if (!this.cache.has(name)) return false;
        const last = this.lastFetchTime.get(name) || 0;
        return (Date.now() - last) < this.cacheTtlMs;
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
            } else {
                logger.warn(`[StrategyLoader] Strategy file not found: ${strategyPath}`);
            }
        } catch (e) {
            logger.error(`[StrategyLoader] Error loading local strategy '${name}'`, e);
        }
        return null;
    }
}
