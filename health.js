#!/usr/bin/env node

const { QwenAuthManager } = require('./src/qwen/auth.js');
const path = require('path');
const { promises: fs } = require('fs');
const Table = require('cli-table3');

/**
 * Format date to local timezone format: MM.dd HH:mm
 * @param {Date} date - The date to format
 * @returns {string} Formatted date string
 */
function formatLocalDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}.${day} ${hours}:${minutes}`;
}

async function showHealthReport() {
  console.log('🏥 Qwen OpenAI Proxy - Account Health Report');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  
  try {
    const authManager = new QwenAuthManager();
    
    // Load health data from file
    let healthData = {};
    const healthFile = path.join(authManager.qwenDir, 'account_health.json');
    
    try {
      const data = await fs.readFile(healthFile, 'utf8');
      healthData = JSON.parse(data);
    } catch (error) {
      console.log('No health data found.');
      return;
    }
    
    const { strikes = {}, blockedUntil = {}, lastStrikeTime = {} } = healthData;
    
    // Get all unique account IDs
    const allAccountIds = new Set([
      ...Object.keys(strikes),
      ...Object.keys(blockedUntil),
      ...Object.keys(lastStrikeTime)
    ]);
    
    if (allAccountIds.size === 0) {
      console.log('No health data available.');
      return;
    }
    
    // Convert to array and sort by blockedUntil (blocked accounts first, then by timestamp)
    const sortedAccountIds = Array.from(allAccountIds).sort((a, b) => {
      const blockedA = blockedUntil[a];
      const blockedB = blockedUntil[b];
      const now = Date.now();
      
      // Both not blocked - sort by strikes (higher first)
      if (!blockedA && !blockedB) {
        const strikesA = strikes[a] || 0;
        const strikesB = strikes[b] || 0;
        return strikesB - strikesA;
      }
      
      // Only A is blocked
      if (blockedA && !blockedB) {
        return blockedA > now ? -1 : 1;
      }
      
      // Only B is blocked
      if (!blockedA && blockedB) {
        return blockedB > now ? 1 : -1;
      }
      
      // Both blocked - sort by remaining time (sooner expiration first)
      const remainingA = blockedA - now;
      const remainingB = blockedB - now;
      
      // Active blocks first, then expired
      if (remainingA > 0 && remainingB <= 0) return -1;
      if (remainingA <= 0 && remainingB > 0) return 1;
      
      // Both active or both expired - sort by timestamp
      return blockedA - blockedB;
    });
    
    // Create table
    const table = new Table({
      head: ['Account', 'Strikes', 'Blocked Until', 'Last Strike Time'],
      colWidths: [15, 10, 20, 25],
      style: {
        head: ['cyan'],
        border: ['gray']
      }
    });
    
    const now = Date.now();
    
    for (const accountId of sortedAccountIds) {
      const strikeCount = strikes[accountId] || 0;
      const blockedTimestamp = blockedUntil[accountId];
      const strikeTimestamp = lastStrikeTime[accountId];
      
      // Format blockedUntil
      let blockedUntilStr = '-';
      if (blockedTimestamp) {
        const blockedDate = new Date(blockedTimestamp);
        const remaining = blockedTimestamp - now;
        if (remaining > 0) {
          const minutes = Math.ceil(remaining / 60000);
          blockedUntilStr = `${formatLocalDate(blockedDate)} (${minutes}m)`;
        } else {
          blockedUntilStr = `${formatLocalDate(blockedDate)} (expired)`;
        }
      }
      
      // Format lastStrikeTime
      let lastStrikeStr = '-';
      if (strikeTimestamp) {
        const strikeDate = new Date(strikeTimestamp);
        const ago = now - strikeTimestamp;
        const minutesAgo = Math.floor(ago / 60000);
        const hoursAgo = Math.floor(ago / 3600000);
        const daysAgo = Math.floor(ago / 86400000);
        
        if (daysAgo > 0) {
          lastStrikeStr = `${formatLocalDate(strikeDate)} (${daysAgo}d ago)`;
        } else if (hoursAgo > 0) {
          lastStrikeStr = `${formatLocalDate(strikeDate)} (${hoursAgo}h ago)`;
        } else if (minutesAgo > 0) {
          lastStrikeStr = `${formatLocalDate(strikeDate)} (${minutesAgo}m ago)`;
        } else {
          lastStrikeStr = `${formatLocalDate(strikeDate)} (just now)`;
        }
      }
      
      table.push([
        accountId,
        strikeCount,
        blockedUntilStr,
        lastStrikeStr
      ]);
    }
    
    console.log(table.toString());
    console.log('');
    
    // Show summary
    const blockedCount = Object.values(blockedUntil).filter(ts => ts > now).length;
    const totalStrikes = Object.values(strikes).reduce((sum, count) => sum + count, 0);
    const accountsWithStrikes = Object.values(strikes).filter(count => count > 0).length;
    
    console.log('📈 Summary:');
    console.log(`• Total Accounts: ${allAccountIds.size}`);
    console.log(`• Blocked Accounts: ${blockedCount}`);
    console.log(`• Accounts with Strikes: ${accountsWithStrikes}`);
    console.log(`• Total Strikes: ${totalStrikes}`);
    
  } catch (error) {
    console.error('Failed to show health report:', error.message);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
  console.log('Usage: npm run health');
  console.log('Display account health status including strikes and blocks.');
  process.exit(0);
}

showHealthReport();
