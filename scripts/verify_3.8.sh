#!/bin/bash


set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SESSION_ID="${1:-$(date +%Y-%m-%dT%H-%M-%S)}"
OUTPUT_FILE="${2:-per_mint_holders_${SESSION_ID}.csv}"

echo "🔍 Step 3.8 Holder Filter Verification"
echo "Session ID: $SESSION_ID"
echo "Output file: $OUTPUT_FILE"
echo "Project directory: $PROJECT_DIR"

cd "$PROJECT_DIR"

if [ ! -f ".env" ]; then
    echo "❌ Error: .env file not found"
    exit 1
fi

if [ ! -f "src/filters/08_holders.js" ]; then
    echo "❌ Error: Step 3.8 Holder Filter not found"
    exit 1
fi

echo "✅ Environment and filter files found"

echo "🧪 Running unit tests..."
if command -v npm &> /dev/null; then
    if [ -f "package.json" ] && grep -q "jest" package.json; then
        npm test -- tests/filters/08_holders.test.js
        echo "✅ Unit tests completed"
    else
        echo "⚠️  Jest not configured, skipping unit tests"
    fi
else
    echo "⚠️  npm not found, skipping unit tests"
fi

echo "📊 Creating CSV header..."
cat > "$OUTPUT_FILE" << EOF
mint,signature,pass,action,reason,top1_pct,top5_pct,top10_pct,team_pct,new_wallets_pct,num_unique_owners,circ_supply,processing_time_ms,used_cache,evidence
EOF

echo "🔧 Setting up test configuration..."
export HOLDERS_ENABLED=true
export HOLDERS_MODE=LOG_ONLY
export HOLDERS_CRITICAL=false

echo "📝 Test mints for verification:"
TEST_MINTS=(
    "So11111111111111111111111111111111111111112"
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
)

echo "🚀 Running Step 3.8 verification on test mints..."

for mint in "${TEST_MINTS[@]}"; do
    echo "Testing mint: $mint"
    
    node -e "
    const HoldersFilter = require('./src/filters/08_holders');
    const filter = new HoldersFilter();
    
    const testData = {
        mint: '$mint',
        signature: 'test-signature-$(date +%s)',
        metadata: {}
    };
    
    filter.process(testData)
        .then(result => {
            const evidence = result.metrics.evidence ? 
                JSON.stringify(result.metrics.evidence).replace(/,/g, ';') : '';
            
            const csvLine = [
                result.mint || '$mint',
                testData.signature,
                result.pass,
                result.action,
                result.reason,
                result.metrics.top1Pct || 0,
                result.metrics.top5Pct || 0,
                result.metrics.top10Pct || 0,
                result.metrics.teamPct || 0,
                result.metrics.newWalletsPct || 0,
                result.metrics.numUniqueOwners || 0,
                result.metrics.circulatingSupply || 0,
                result.processingTimeMs,
                result.usedCache,
                evidence
            ].join(',');
            
            console.log(csvLine);
        })
        .catch(error => {
            const csvLine = [
                '$mint',
                testData.signature,
                false,
                'error',
                error.message.replace(/,/g, ';'),
                0,0,0,0,0,0,0,0,false,
                ''
            ].join(',');
            
            console.log(csvLine);
        });
    " >> "$OUTPUT_FILE"
    
    sleep 1
done

echo "✅ Verification completed"
echo "📄 Results saved to: $OUTPUT_FILE"

if [ -f "$OUTPUT_FILE" ]; then
    echo "📊 Summary:"
    echo "Total entries: $(tail -n +2 "$OUTPUT_FILE" | wc -l)"
    echo "Passed: $(tail -n +2 "$OUTPUT_FILE" | grep -c ',true,')"
    echo "Failed: $(tail -n +2 "$OUTPUT_FILE" | grep -c ',false,')"
    echo ""
    echo "📋 Sample results:"
    head -n 6 "$OUTPUT_FILE"
fi

echo ""
echo "🎯 Manual verification checklist:"
echo "1. Check that top1/top5/top10 percentages are calculated correctly"
echo "2. Verify team wallet detection is working"
echo "3. Confirm new wallet identification is functioning"
echo "4. Validate cache hit rates are reasonable (>20%)"
echo "5. Check processing times are under 600ms median"
echo "6. Review evidence data for failed cases"
echo ""
echo "📁 Full results available in: $OUTPUT_FILE"
