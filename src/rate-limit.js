/**
 * Token bucket per key (client address or endpoint), kept in memory. A restart forgets
 * everything, which is fine for limits of a few minutes.
 */
export class RateLimiter {
    /**
     * @param {Object} options
     * @param {number} options.capacity requests allowed in a burst
     * @param {number} options.perSecond requests added back per second
     * @param {() => number} [options.now] milliseconds
     * @param {number} [options.maxKeys] the map is emptied when it grows beyond this
     */
    constructor({ capacity, perSecond, now = Date.now, maxKeys = 100000 }) {
        this.capacity = capacity;
        this.perSecond = perSecond;
        this.now = now;
        this.maxKeys = maxKeys;
        this.buckets = new Map();
    }

    /**
     * @param {string} key
     * @returns {number} 0 when allowed, else the seconds until the next request is allowed
     */
    take(key) {
        const time = this.now();
        let bucket = this.buckets.get(key);
        if (bucket) {
            bucket.tokens = Math.min(this.capacity, bucket.tokens + ((time - bucket.at) / 1000) * this.perSecond);
            bucket.at = time;
        } else {
            if (this.buckets.size >= this.maxKeys) {
                this.buckets.clear();
            }
            bucket = { tokens: this.capacity, at: time };
            this.buckets.set(key, bucket);
        }
        if (bucket.tokens < 1) {
            return Math.ceil((1 - bucket.tokens) / this.perSecond);
        }
        bucket.tokens -= 1;
        return 0;
    }

    /** Drops buckets that are full again, called now and then. */
    prune() {
        const time = this.now();
        for (const [key, bucket] of this.buckets) {
            if (bucket.tokens + ((time - bucket.at) / 1000) * this.perSecond >= this.capacity) {
                this.buckets.delete(key);
            }
        }
    }
}
