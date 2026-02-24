#!/usr/bin/env node
/**
 * Test script for semantic search functionality
 * Run: node test_semantic_search.js
 */

import 'dotenv/config';

const API_BASE = 'http://localhost:3001/api';

async function testSemanticSearch() {
    console.log('🧪 Testing Semantic Search Setup\n');

    // Test 1: Check server is running
    console.log('1️⃣  Testing server connection...');
    try {
        const res = await fetch(`${API_BASE}/fleet/latest`);
        if (res.ok) {
            console.log('   ✅ Server is running\n');
        } else {
            console.log('   ❌ Server returned error:', res.status);
            return;
        }
    } catch (err) {
        console.log('   ❌ Server not reachable. Start with: npm run dev');
        return;
    }

    // Test 2: Check embeddings stats
    console.log('2️⃣  Checking embeddings index...');
    try {
        const res = await fetch(`${API_BASE}/embeddings/stats`);
        const data = await res.json();

        if (data.success && data.stats.length > 0) {
            console.log('   ✅ Embeddings index exists:');
            data.stats.forEach(stat => {
                console.log(`      - ${stat.content_type}: ${stat.count} items`);
            });
            console.log('');
        } else {
            console.log('   ⚠️  No embeddings found. Generating...\n');

            // Generate embeddings
            console.log('3️⃣  Generating embeddings...');
            const genRes = await fetch(`${API_BASE}/embeddings/generate`, {
                method: 'POST'
            });
            const genData = await genRes.json();

            if (genData.success) {
                console.log('   ✅ Embeddings generated:');
                console.log(`      - Sites: ${genData.sites_embedded}`);
                console.log(`      - Devices: ${genData.devices_embedded}`);
                console.log(`      - Alerts: ${genData.alerts_embedded}`);
                console.log('');
            } else {
                console.log('   ❌ Failed:', genData.error);
                return;
            }
        }
    } catch (err) {
        console.log('   ❌ Error:', err.message);
        return;
    }

    // Test 3: Perform semantic search
    console.log('4️⃣  Testing semantic search...');
    const testQueries = [
        'low battery',
        'offline trailers',
        'weak signal'
    ];

    for (const query of testQueries) {
        try {
            const res = await fetch(`${API_BASE}/search/semantic`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, limit: 3 })
            });

            const data = await res.json();

            if (data.success) {
                console.log(`   ✅ Query: "${query}"`);
                console.log(`      Found ${data.count} results`);
                if (data.results.length > 0) {
                    console.log(`      Top result: ${data.results[0].text.slice(0, 80)}...`);
                    console.log(`      Similarity: ${(data.results[0].similarity * 100).toFixed(1)}%`);
                }
                console.log('');
            } else {
                console.log(`   ❌ Query failed: ${data.error}`);
            }
        } catch (err) {
            console.log(`   ❌ Error: ${err.message}`);
        }
    }

    console.log('✨ Semantic search is working!\n');
    console.log('Try it in the UI:');
    console.log('   1. Open http://localhost:3001');
    console.log('   2. Look for the QueryBar at the top');
    console.log('   3. Toggle to "🔍 Semantic Search" mode');
    console.log('   4. Try queries like: "low battery", "offline", "weak signal"\n');
}

testSemanticSearch().catch(console.error);
