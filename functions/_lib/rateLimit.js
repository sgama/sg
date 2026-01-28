import { CONFIG, AppError } from './config.js';

export class RateLimiter {
    /**
     * Simple sliding window rate limiter using KV
     * @param {KVNamespace} kv 
     * @param {string} ip 
     * @returns {Promise<void>} Throws AppError if limit exceeded
     */
    static async check(kv, ip) {
        if (!kv) return; // Skip if no KV bound (dev mode safe)

        const key = `rl:${ip}`;
        const currentWindow = Math.floor(Date.now() / 1000 / CONFIG.RATE_LIMIT.WINDOW_SECONDS);
        const uniqueKey = `${key}:${currentWindow}`;

        const count = await kv.get(uniqueKey);
        const requestCount = count ? parseInt(count) : 0;

        if (requestCount >= CONFIG.RATE_LIMIT.MAX_REQUESTS) {
            throw new AppError('Too many requests. Please try again later.', 429);
        }

        // Increment count (TTL = Window + 10s buffer)
        await kv.put(uniqueKey, (requestCount + 1).toString(), {
            expirationTtl: CONFIG.RATE_LIMIT.WINDOW_SECONDS + 10
        });
    }
}
