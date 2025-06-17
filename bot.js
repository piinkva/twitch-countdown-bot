// Load environment variables (your secrets)
require('dotenv').config();

// Import the Twitch messaging interface
const tmi = require('tmi.js');

// Configuration from environment variables
const BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN;
const CHANNEL_NAME = process.env.TWITCH_CHANNEL;

// Store active timers
// This is like a notebook where the bot keeps track of all running timers
const activeTimers = new Map();

// Create the bot with its configuration
const client = new tmi.Client({
    options: { debug: true }, // Shows detailed logs
    connection: {
        secure: true,
        reconnect: true // Automatically reconnect if disconnected
    },
    identity: {
        username: BOT_USERNAME,
        password: OAUTH_TOKEN
    },
    channels: [CHANNEL_NAME]
});

// Connect to Twitch
console.log('Attempting to connect to Twitch...');
client.connect().catch(console.error);

// When successfully connected
client.on('connected', (addr, port) => {
    console.log(`✅ Connected to ${addr}:${port}`);
    console.log(`✅ Joined channel: ${CHANNEL_NAME}`);
    // Announce that the bot is online
    client.say(CHANNEL_NAME, '🤖 Timer bot is online! Use commands like !10min or !15min2');
});

// Listen for messages in chat
client.on('message', (channel, tags, message, self) => {
    // Ignore messages from the bot itself
    if (self) return;
    
    // Get the username of who sent the message
    const username = tags.username;
    
    // Check if message is a timer command (e.g., !10min or !15min2)
    const timerMatch = message.match(/^!(\d+)min(\d+)?$/);
    
    if (timerMatch) {
        // Extract the minutes and interval from the command
        const minutes = parseInt(timerMatch[1]);
        const interval = parseInt(timerMatch[2]) || 1; // Default to 1 minute intervals
        
        // Start the timer
        startTimer(channel, username, minutes, interval);
        return;
    }
    
    // Check for stop timer command
    if (message.toLowerCase() === '!stoptimer') {
        stopTimers(channel, username);
        return;
    }
    
    // Check for timer status command
    if (message.toLowerCase() === '!timers') {
        showTimerStatus(channel, username);
        return;
    }
});

// Function to start a new timer
function startTimer(channel, username, minutes, intervalMinutes) {
    // Create a unique ID for this timer
    const timerId = `${username}_${Date.now()}`;
    
    // Calculate when the timer should end
    const endTime = Date.now() + (minutes * 60 * 1000);
    
    // Send confirmation message
    client.say(channel, `⏱️ @${username} started a ${minutes}-minute timer! I'll update every ${intervalMinutes} minute(s).`);
    
    // Create the timer object
    const timer = {
        username: username,
        startMinutes: minutes,
        endTime: endTime,
        intervalMinutes: intervalMinutes,
        lastUpdate: Date.now(),
        // The interval function that runs periodically
        interval: setInterval(() => {
            const now = Date.now();
            const remaining = endTime - now;
            
            // Check if timer is complete
            if (remaining <= 0) {
                client.say(channel, `⏰ @${username} your ${minutes}-minute timer is complete! 🎉`);
                clearInterval(timer.interval);
                activeTimers.delete(timerId);
                return;
            }
            
            // Check if it's time for an update
            const timeSinceLastUpdate = now - timer.lastUpdate;
            const shouldUpdate = timeSinceLastUpdate >= (intervalMinutes * 60 * 1000);
            
            if (shouldUpdate) {
                const remainingMinutes = Math.ceil(remaining / 60000);
                const remainingSeconds = Math.ceil((remaining % 60000) / 1000);
                
                // Format the time nicely
                let timeString;
                if (remainingMinutes >= 1) {
                    timeString = `${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
                } else {
                    timeString = `${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
                }
                
                client.say(channel, `⏱️ @${username}: ${timeString} remaining!`);
                timer.lastUpdate = now;
            }
        }, 5000) // Check every 5 seconds for accuracy
    };
    
    // Store the timer
    activeTimers.set(timerId, timer);
}

// Function to stop all timers for a user
function stopTimers(channel, username) {
    let stoppedCount = 0;
    
    // Go through all timers and stop ones belonging to this user
    for (const [timerId, timer] of activeTimers.entries()) {
        if (timer.username === username) {
            clearInterval(timer.interval);
            activeTimers.delete(timerId);
            stoppedCount++;
        }
    }
    
    // Send appropriate message
    if (stoppedCount > 0) {
        client.say(channel, `⏹️ Stopped ${stoppedCount} timer(s) for @${username}`);
    } else {
        client.say(channel, `@${username}, you don't have any active timers.`);
    }
}

// Function to show timer status
function showTimerStatus(channel, username) {
    const userTimers = [];
    
    // Find all timers for this user
    for (const [timerId, timer] of activeTimers.entries()) {
        if (timer.username === username) {
            const remaining = timer.endTime - Date.now();
            const remainingMinutes = Math.ceil(remaining / 60000);
            userTimers.push(`${remainingMinutes}min`);
        }
    }
    
    // Send status message
    if (userTimers.length > 0) {
        client.say(channel, `@${username}, your active timers: ${userTimers.join(', ')}`);
    } else {
        client.say(channel, `@${username}, you have no active timers. Start one with !10min`);
    }
}

// Handle errors gracefully
client.on('disconnected', (reason) => {
    console.log(`❌ Disconnected from Twitch: ${reason}`);
});

// Keep the bot running
console.log('Bot is starting up...');