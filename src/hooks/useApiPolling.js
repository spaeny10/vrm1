import { useState, useEffect, useRef, useCallback } from 'react';

// Module-level deduplication: cacheKey -> { promise, timestamp }
const activeRequests = new Map();

export function useApiPolling(fetchFn, intervalMs = 30000, deps = [], cacheKey = null) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(null);
    const mountedRef = useRef(true);

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
            }
        } catch (err) {
            if (mountedRef.current) {
                setError(err.message);
                setLoading(false);
            }
        }
    }, [fetchFn, cacheKey]);

    useEffect(() => {
        mountedRef.current = true;
        doFetch();
        const interval = setInterval(doFetch, intervalMs);
        return () => {
            mountedRef.current = false;
            clearInterval(interval);
        };
    }, [doFetch, intervalMs, ...deps]);

    return { data, loading, error, refetch: doFetch, lastUpdated };
}
