// Load environment variables
require('dotenv').config();

// Import the Twitch messaging interface
const tmi = require('tmi.js');

// Configuration from environment variables
const BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN;
const CHANNEL_NAME = process.env.TWITCH_CHANNEL;

// Store active timers
const activeTimers = new Map();

// IMPORTANT: Track connection state to prevent duplicates
let isConnected = false;
let connectionAttempts = 0;

// Create the bot with its configuration
const client = new tmi.Client({
    options: { 
        debug: true,
        // IMPORTANT: Disable automatic reconnection to control it manually
        skipUpdatingEmotesets: true
    },
    connection: {
        secure: true,
        reconnect: false  // We'll handle reconnection manually
    },
    identity: {
        username: BOT_USERNAME,
        password: OAUTH_TOKEN
    },
    channels: [CHANNEL_NAME]
});

// Function to safely connect to Twitch
async function connectToTwitch() {
    // Don't connect if already connected
    if (isConnected) {
        console.log('⚠️ Already connected to Twitch, skipping connection attempt');
        return;
    }
    
    // Limit connection attempts
    if (connectionAttempts >= 3) {
        console.error('❌ Max connection attempts reached. Please check your configuration.');
        return;
    }
    
    connectionAttempts++;
    console.log(`Attempting to connect to Twitch (attempt ${connectionAttempts})...`);
    
    try {
        await client.connect();
    } catch (error) {
        console.error('Failed to connect:', error);
        isConnected = false;
        
        // Wait before retrying
        setTimeout(() => {
            connectToTwitch();
        }, 5000);
    }
}

// Start the connection
connectToTwitch();

// When successfully connected
client.on('connected', (addr, port) => {
    // Prevent multiple connection handlers
    if (isConnected) {
        console.log('⚠️ Duplicate connection event detected, ignoring');
        return;
    }
    
    isConnected = true;
    console.log(`✅ Connected to ${addr}:${port}`);
    console.log(`✅ Joined channel: ${CHANNEL_NAME}`);
    
    // Only send the welcome message once
    setTimeout(() => {
        if (isConnected) {
            client.say(CHANNEL_NAME, '🤖 Timer bot is online! Use commands like !10min or !15min2')
                .catch(err => console.error('Failed to send welcome message:', err));
        }
    }, 1000);
});

// Handle disconnections
client.on('disconnected', (reason) => {
    console.log(`❌ Disconnected from Twitch: ${reason}`);
    isConnected = false;
    
    // Wait 5 seconds before attempting to reconnect
    setTimeout(() => {
        connectionAttempts = 0;  // Reset attempts
        connectToTwitch();
    }, 5000);
});

// IMPORTANT: Use a message ID tracker to prevent duplicate processing
const processedMessages = new Set();

// Listen for messages in chat
client.on('message', (channel, tags, message, self) => {
    // Ignore messages from the bot itself
    if (self) return;
    
    // IMPORTANT: Check if we've already processed this message
    const messageId = tags.id;
    if (messageId && processedMessages.has(messageId)) {
        console.log('Duplicate message detected, skipping:', message);
        return;
    }
    
    // Add to processed messages (keep only last 100 to prevent memory issues)
    if (messageId) {
        processedMessages.add(messageId);
        if (processedMessages.size > 100) {
            const firstId = processedMessages.values().next().value;
            processedMessages.delete(firstId);
        }
    }
    
    // Get the username of who sent the message
    const username = tags.username;
    
    // Check if message is a timer command (e.g., !10min or !15min2)
    const timerMatch = message.match(/^!(\d+)min(\d+)?$/);
    
    if (timerMatch) {
        const minutes = parseInt(timerMatch[1]);
        const interval = parseInt(timerMatch[2]) || 1;
        
        // Only process if connected
        if (isConnected) {
            startTimer(channel, username, minutes, interval);
        }
        return;
    }
    
    // Check for stop timer command
    if (message.toLowerCase() === '!stoptimer') {
        if (isConnected) {
            stopTimers(channel, username);
        }
        return;
    }
    
    // Check for timer status command
    if (message.toLowerCase() === '!timers') {
        if (isConnected) {
            showTimerStatus(channel, username);
        }
        return;
    }
});

// Function to start a new timer
function startTimer(channel, username, minutes, intervalMinutes) {
    // Stop any existing timers for this user first
    stopTimersQuietly(username);
    
    // Create a unique ID for this timer
    const timerId = `${username}_${Date.now()}`;
    
    // Calculate when the timer should end
    const endTime = Date.now() + (minutes * 60 * 1000);
    
    // Send confirmation message ONCE
    sendMessage(channel, `⏱️ @${username} started a ${minutes}-minute timer! I'll update every ${intervalMinutes} minute(s).`);
    
    // Create the timer object
    const timer = {
        username: username,
        startMinutes: minutes,
        endTime: endTime,
        intervalMinutes: intervalMinutes,
        lastUpdate: Date.now(),
        announced: false,  // Track if we've announced this timer
        interval: setInterval(() => {
            const now = Date.now();
            const remaining = endTime - now;
            
            // Check if timer is complete
            if (remaining <= 0) {
                sendMessage(channel, `⏰ @${username} your ${minutes}-minute timer is complete! 🎉`);
                clearInterval(timer.interval);
                activeTimers.delete(timerId);
                return;
            }
            
            // Check if it's time for an update
            const timeSinceLastUpdate = now - timer.lastUpdate;
            const shouldUpdate = timeSinceLastUpdate >= (intervalMinutes * 60 * 1000 - 1000); // Small buffer
            
            if (shouldUpdate) {
                const remainingMinutes = Math.ceil(remaining / 60000);
                const remainingSeconds = Math.ceil((remaining % 60000) / 1000);
                
                let timeString;
                if (remainingMinutes >= 1) {
                    timeString = `${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
                } else {
                    timeString = `${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
                }
                
                sendMessage(channel, `⏱️ @${username}: ${timeString} remaining!`);
                timer.lastUpdate = now;
            }
        }, 5000)
    };
    
    // Store the timer
    activeTimers.set(timerId, timer);
}

// Helper function to send messages safely
function sendMessage(channel, message) {
    if (isConnected) {
        client.say(channel, message)
            .catch(err => console.error('Failed to send message:', err));
    }
}

// Function to stop timers without announcement
function stopTimersQuietly(username) {
    for (const [timerId, timer] of activeTimers.entries()) {
        if (timer.username === username) {
            clearInterval(timer.interval);
            activeTimers.delete(timerId);
        }
    }
}

// Function to stop all timers for a user
function stopTimers(channel, username) {
    let stoppedCount = 0;
    
    for (const [timerId, timer] of activeTimers.entries()) {
        if (timer.username === username) {
            clearInterval(timer.interval);
            activeTimers.delete(timerId);
            stoppedCount++;
        }
    }
    
    if (stoppedCount > 0) {
        sendMessage(channel, `⏹️ Stopped ${stoppedCount} timer(s) for @${username}`);
    } else {
        sendMessage(channel, `@${username}, you don't have any active timers.`);
    }
}

// Function to show timer status
function showTimerStatus(channel, username) {
    const userTimers = [];
    
    for (const [timerId, timer] of activeTimers.entries()) {
        if (timer.username === username) {
            const remaining = timer.endTime - Date.now();
            const remainingMinutes = Math.ceil(remaining / 60000);
            userTimers.push(`${remainingMinutes}min`);
        }
    }
    
    if (userTimers.length > 0) {
        sendMessage(channel, `@${username}, your active timers: ${userTimers.join(', ')}`);
    } else {
        sendMessage(channel, `@${username}, you have no active timers. Start one with !10min`);
    }
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, cleaning up...');
    
    // Clear all timers
    for (const [timerId, timer] of activeTimers.entries()) {
        clearInterval(timer.interval);
    }
    activeTimers.clear();
    
    // Disconnect from Twitch
    if (isConnected) {
        client.disconnect();
    }
    
    process.exit(0);
});

// Keep the bot running
console.log('Bot is starting up...');
console.log(`Bot username: ${BOT_USERNAME}`);
console.log(`Target channel: ${CHANNEL_NAME}`);