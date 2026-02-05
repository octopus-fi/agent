/**
 * Octopus Finance - Rate Limiter
 * Prevents exceeding Gemini API free tier limits
 */

import { RateLimiterState } from '../types';
import { logger } from './logger';

export class RateLimiter {
  private state: RateLimiterState;
  private name: string;

  constructor(name: string, maxCallsPerMinute: number) {
    this.name = name;
    this.state = {
      lastCalls: [],
      maxCallsPerMinute,
    };
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove calls older than 1 minute
    this.state.lastCalls = this.state.lastCalls.filter(t => t > oneMinuteAgo);

    // If at limit, wait until oldest call expires
    if (this.state.lastCalls.length >= this.state.maxCallsPerMinute) {
      const oldestCall = this.state.lastCalls[0];
      const waitTime = oldestCall + 60000 - now + 100; // +100ms buffer
      
      logger.warn(`${this.name}: Rate limit reached, waiting ${waitTime}ms`);
      await this.sleep(waitTime);
      
      // Recurse to recheck
      return this.waitForSlot();
    }

    // Record this call
    this.state.lastCalls.push(now);
  }

  canCall(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const recentCalls = this.state.lastCalls.filter(t => t > oneMinuteAgo);
    return recentCalls.length < this.state.maxCallsPerMinute;
  }

  getRemainingCalls(): number {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const recentCalls = this.state.lastCalls.filter(t => t > oneMinuteAgo);
    return Math.max(0, this.state.maxCallsPerMinute - recentCalls.length);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Cooldown tracker for vault rebalancing
 * Prevents spamming rebalance on the same vault
 */
export class VaultCooldown {
  private lastActions: Map<string, number> = new Map();
  private cooldownSeconds: number;

  constructor(cooldownSeconds: number) {
    this.cooldownSeconds = cooldownSeconds;
  }

  canAct(vaultId: string): boolean {
    const lastAction = this.lastActions.get(vaultId);
    if (!lastAction) return true;
    
    const elapsed = (Date.now() - lastAction) / 1000;
    return elapsed >= this.cooldownSeconds;
  }

  recordAction(vaultId: string): void {
    this.lastActions.set(vaultId, Date.now());
  }

  getTimeUntilReady(vaultId: string): number {
    const lastAction = this.lastActions.get(vaultId);
    if (!lastAction) return 0;
    
    const elapsed = (Date.now() - lastAction) / 1000;
    return Math.max(0, this.cooldownSeconds - elapsed);
  }

  // Clean up old entries periodically
  cleanup(): void {
    const now = Date.now();
    const threshold = this.cooldownSeconds * 2 * 1000;
    
    for (const [vaultId, lastAction] of this.lastActions.entries()) {
      if (now - lastAction > threshold) {
        this.lastActions.delete(vaultId);
      }
    }
  }
}
