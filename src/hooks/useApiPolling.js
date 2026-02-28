import { useState, useEffect, useRef, useCallback } from 'react';

export function useApiPolling(fetchFn, intervalMs = 30000, deps = []) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(null);
    const mountedRef = useRef(true);

    const doFetch = useCallback(async () => {
        try {
            const result = await fetchFn();
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
    }, [fetchFn]);

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
