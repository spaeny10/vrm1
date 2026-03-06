import { useState, useEffect, useRef, useCallback } from 'react';

// Module-level deduplication: cacheKey -> { promise, timestamp }
const activeRequests = new Map();

export function useApiPolling(fetchFn, intervalMs = 30000, deps = [], cacheKey = null) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(null);
    const mountedRef = useRef(true);
    const errorCountRef = useRef(0);

    const doFetch = useCallback(async () => {
        try {
            let result;
            if (cacheKey && activeRequests.has(cacheKey)) {
                // Reuse in-flight request
                result = await activeRequests.get(cacheKey).promise;
            } else {
                const promise = fetchFn();
                if (cacheKey) {
                    activeRequests.set(cacheKey, { promise, timestamp: Date.now() });
                    promise.finally(() => activeRequests.delete(cacheKey));
                }
                result = await promise;
            }
            if (mountedRef.current) {
                setData(result);
                setError(null);
                setLoading(false);
                setLastUpdated(Date.now());
                errorCountRef.current = 0;
            }
        } catch (err) {
            if (mountedRef.current) {
                setError(err.message);
                setLoading(false);
                errorCountRef.current = Math.min(errorCountRef.current + 1, 5);
            }
        }
    }, [fetchFn, cacheKey]);

    // Stabilize deps with JSON.stringify to avoid spread issues
    const depsKey = JSON.stringify(deps);

    useEffect(() => {
        mountedRef.current = true;
        doFetch();

        // Exponential backoff: double interval on consecutive errors (max 5min)
        const getInterval = () => {
            if (errorCountRef.current === 0) return intervalMs;
            return Math.min(intervalMs * Math.pow(2, errorCountRef.current), 300000);
        };

        let timer;
        const scheduleNext = () => {
            timer = setTimeout(() => {
                doFetch().then(() => {
                    if (mountedRef.current) scheduleNext();
                });
            }, getInterval());
        };
        scheduleNext();

        return () => {
            mountedRef.current = false;
            clearTimeout(timer);
        };
    }, [doFetch, intervalMs, depsKey]);

    return { data, loading, error, refetch: doFetch, lastUpdated };
}
