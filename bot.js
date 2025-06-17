// Load environment variables
require('dotenv').config();

// Import required modules
const tmi = require('tmi.js');
const express = require('express');
const app = express();

// Set up the web server port
const PORT = process.env.PORT || 3000;

// Configuration from environment variables
const BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN;
const CHANNEL_NAME = process.env.TWITCH_CHANNEL;

// Permission configuration - you can customize this!
// Option 1: List specific usernames who can use the bot (leave empty to disable)
const ALLOWED_USERS = process.env.ALLOWED_USERS ? 
    process.env.ALLOWED_USERS.split(',').map(u => u.trim().toLowerCase()) : [];

// Option 2: Allow mods and broadcaster (set to true to enable)
const ALLOW_MODS_AND_BROADCASTER = process.env.ALLOW_MODS_AND_BROADCASTER !== 'false'; // Default to true

// Store active timers with enhanced structure
const activeTimers = new Map();

// Track connection state
let isConnected = false;
let connectionAttempts = 0;
let botStartTime = new Date();

// Permission checking function - this is like a bouncer at a club
function hasPermission(tags) {
    const username = tags.username.toLowerCase();
    
    // First, check if they're the broadcaster (channel owner)
    if (tags.badges && tags.badges.broadcaster) {
        console.log(`✅ ${username} is the broadcaster - permission granted`);
        return true;
    }
    
    // If we're allowing mods and broadcaster, check for mod badge
    if (ALLOW_MODS_AND_BROADCASTER && tags.badges && tags.badges.moderator) {
        console.log(`✅ ${username} is a moderator - permission granted`);
        return true;
    }
    
    // If we have a specific allowed users list, check that
    if (ALLOWED_USERS.length > 0 && ALLOWED_USERS.includes(username)) {
        console.log(`✅ ${username} is in the allowed users list - permission granted`);
        return true;
    }
    
    // If no allowed users list is specified and we're not using mod checking,
    // then allow everyone (backwards compatibility)
    if (ALLOWED_USERS.length === 0 && !ALLOW_MODS_AND_BROADCASTER) {
        return true;
    }
    
    console.log(`❌ ${username} does not have permission to use timer commands`);
    return false;
}

// Enhanced timer structure to support pause/resume
class Timer {
    constructor(username, minutes, intervalMinutes, channel) {
        this.id = `${username}_${Date.now()}`;
        this.username = username;
        this.totalMinutes = minutes;
        this.intervalMinutes = intervalMinutes;
        this.channel = channel;
        
        // Time tracking
        this.startTime = Date.now();
        this.endTime = this.startTime + (minutes * 60 * 1000);
        this.lastUpdate = this.startTime;
        
        // Pause functionality
        this.isPaused = false;
        this.pausedAt = null;
        this.totalPausedTime = 0;
        
        // The actual interval that runs
        this.interval = null;
        
        // Start the timer
        this.start();
    }
    
    start() {
        // Clear any existing interval
        if (this.interval) {
            clearInterval(this.interval);
        }
        
        // Create the main timer loop
        this.interval = setInterval(() => this.tick(), 1000); // Check every second
    }
    
    tick() {
        // Don't do anything if paused
        if (this.isPaused) {
            return;
        }
        
        const now = Date.now();
        const elapsed = now - this.startTime - this.totalPausedTime;
        const remaining = (this.totalMinutes * 60 * 1000) - elapsed;
        
        // Check if timer is complete
        if (remaining <= 0) {
            sendMessage(this.channel, `⏰ @${this.username} your ${this.totalMinutes}-minute timer is complete! You can now resume your requests and can expect an answer to your questions. 🎉`);
            this.cleanup();
            return;
        }
        
        // Check if it's time for an update
        const timeSinceLastUpdate = now - this.lastUpdate;
        const updateInterval = this.intervalMinutes * 60 * 1000;
        
        if (timeSinceLastUpdate >= updateInterval - 500) { // 500ms buffer for accuracy
            const remainingMinutes = Math.ceil(remaining / 60000);
            const remainingSeconds = Math.ceil((remaining % 60000) / 1000);
            
            let timeString;
            if (remainingMinutes >= 1) {
                timeString = `${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
            } else {
                timeString = `${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
            }
            
            sendMessage(this.channel, `⏱️ @${this.username}: ${timeString} remaining! Please enjoy the trigger and wait with an answer to your questions or with new requests.`);
            this.lastUpdate = now;
        }
    }
    
    pause() {
        if (this.isPaused) {
            return false; // Already paused
        }
        
        this.isPaused = true;
        this.pausedAt = Date.now();
        clearInterval(this.interval);
        return true;
    }
    
    resume() {
        if (!this.isPaused) {
            return false; // Not paused
        }
        
        // Calculate how long we were paused
        const pauseDuration = Date.now() - this.pausedAt;
        this.totalPausedTime += pauseDuration;
        
        // Reset pause state
        this.isPaused = false;
        this.pausedAt = null;
        
        // Restart the interval
        this.start();
        return true;
    }
    
    getStatus() {
        const now = Date.now();
        const elapsed = now - this.startTime - this.totalPausedTime - (this.isPaused ? (now - this.pausedAt) : 0);
        const remaining = (this.totalMinutes * 60 * 1000) - elapsed;
        const remainingMinutes = Math.ceil(remaining / 60000);
        
        return {
            remaining: remainingMinutes,
            isPaused: this.isPaused,
            total: this.totalMinutes
        };
    }
    
    cleanup() {
        if (this.interval) {
            clearInterval(this.interval);
        }
        activeTimers.delete(this.id);
    }
}

// Create status page
app.get('/', (req, res) => {
    const uptime = Math.floor((new Date() - botStartTime) / 1000 / 60);
    const timerCount = activeTimers.size;
    
    // Build permission info string
    let permissionInfo = '';
    if (ALLOWED_USERS.length > 0) {
        permissionInfo = `Allowed users: ${ALLOWED_USERS.join(', ')}`;
    } else if (ALLOW_MODS_AND_BROADCASTER) {
        permissionInfo = 'Allowed: Channel owner and moderators';
    } else {
        permissionInfo = 'Allowed: Everyone';
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Twitch Timer Bot Status</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    max-width: 800px;
                    margin: 50px auto;
                    padding: 20px;
                    background-color: #f0f0f0;
                }
                .status-box {
                    background-color: white;
                    padding: 30px;
                    border-radius: 10px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }
                .online { color: #4CAF50; font-weight: bold; }
                .offline { color: #f44336; font-weight: bold; }
                h1 { color: #9146FF; }
                .command { 
                    background-color: #f5f5f5; 
                    padding: 2px 6px; 
                    border-radius: 3px; 
                    font-family: monospace;
                }
                .permission-info {
                    background-color: #e3f2fd;
                    padding: 15px;
                    border-radius: 5px;
                    margin: 20px 0;
                }
            </style>
        </head>
        <body>
            <div class="status-box">
                <h1>🤖 Twitch Timer Bot</h1>
                <p>Status: <span class="${isConnected ? 'online' : 'offline'}">${isConnected ? '✅ Online' : '❌ Offline'}</span></p>
                <p>Bot Username: ${BOT_USERNAME || 'Not configured'}</p>
                <p>Channel: ${CHANNEL_NAME || 'Not configured'}</p>
                <p>Uptime: ${uptime} minutes</p>
                <p>Active Timers: ${timerCount}</p>
                
                <div class="permission-info">
                    <strong>🔒 Permission Settings:</strong><br>
                    ${permissionInfo}
                </div>
                
                <hr>
                <h3>Available Commands:</h3>
                <ul>
                    <li><span class="command">!10min</span> - Start a 10-minute timer</li>
                    <li><span class="command">!15min2</span> - Start a 15-minute timer with 2-minute updates</li>
                    <li><span class="command">!pause</span> - Pause your active timer</li>
                    <li><span class="command">!resume</span> - Resume your paused timer</li>
                    <li><span class="command">!stoptimer</span> - Stop your active timers</li>
                    <li><span class="command">!timers</span> - Check your active timers</li>
                </ul>
                
                <h3>Permission System:</h3>
                <p>Commands can be restricted to specific users or roles. This prevents random viewers from starting timers.</p>
            </div>
        </body>
        </html>
    `);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connected: isConnected,
        uptime: Math.floor((new Date() - botStartTime) / 1000),
        timers: activeTimers.size
    });
});

// Start web server
app.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`);
});

// Create Twitch client
const client = new tmi.Client({
    options: { 
        debug: true,
        skipUpdatingEmotesets: true
    },
    connection: {
        secure: true,
        reconnect: false
    },
    identity: {
        username: BOT_USERNAME,
        password: OAUTH_TOKEN
    },
    channels: [CHANNEL_NAME]
});

// Connection management
async function connectToTwitch() {
    if (isConnected) {
        console.log('⚠️ Already connected to Twitch');
        return;
    }
    
    if (connectionAttempts >= 3) {
        console.error('❌ Max connection attempts reached');
        return;
    }
    
    connectionAttempts++;
    console.log(`Connecting to Twitch (attempt ${connectionAttempts})...`);
    
    try {
        await client.connect();
    } catch (error) {
        console.error('Failed to connect:', error);
        isConnected = false;
        setTimeout(() => connectToTwitch(), 5000);
    }
}

// Start connection after delay
setTimeout(() => connectToTwitch(), 2000);

// Connected event
client.on('connected', (addr, port) => {
    if (isConnected) return;
    
    isConnected = true;
    console.log(`✅ Connected to ${addr}:${port}`);
    console.log(`✅ Joined channel: ${CHANNEL_NAME}`);
    
    // Log permission configuration
    console.log('📋 Permission Configuration:');
    if (ALLOWED_USERS.length > 0) {
        console.log(`   Allowed users: ${ALLOWED_USERS.join(', ')}`);
    }
    if (ALLOW_MODS_AND_BROADCASTER) {
        console.log('   Mods and broadcaster: Allowed');
    }
    
    setTimeout(() => {
        if (isConnected) {
            client.say(CHANNEL_NAME, '🤖 Timer bot is online! Authorized users can use !10min, !pause, !resume, etc.')
                .catch(err => console.error('Failed to send welcome message:', err));
        }
    }, 1000);
});

// Disconnected event
client.on('disconnected', (reason) => {
    console.log(`❌ Disconnected: ${reason}`);
    isConnected = false;
    setTimeout(() => {
        connectionAttempts = 0;
        connectToTwitch();
    }, 5000);
});

// Message tracking for duplicates
const processedMessages = new Set();

// Main message handler - this is where the magic happens!
client.on('message', (channel, tags, message, self) => {
    // Ignore bot's own messages
    if (self) return;
    
    // Duplicate check
    const messageId = tags.id;
    if (messageId && processedMessages.has(messageId)) {
        return;
    }
    
    if (messageId) {
        processedMessages.add(messageId);
        if (processedMessages.size > 100) {
            const firstId = processedMessages.values().next().value;
            processedMessages.delete(firstId);
        }
    }
    
    const username = tags.username;
    const lowerMessage = message.toLowerCase();
    
    // Timer command regex
    const timerMatch = message.match(/^!(\d+)min(\d+)?$/);
    
    // Check permissions for timer commands
    const needsPermission = timerMatch || 
                          lowerMessage === '!stoptimer' || 
                          lowerMessage === '!pause' || 
                          lowerMessage === '!resume';
    
    if (needsPermission && !hasPermission(tags)) {
        // Silently ignore or send a polite message
        if (timerMatch || lowerMessage === '!pause' || lowerMessage === '!resume') {
            sendMessage(channel, `${username}, sorry! Only authorized users can use timer commands.`);
        }
        return;
    }
    
    // Process timer start command
    if (timerMatch) {
        const minutes = parseInt(timerMatch[1]);
        const interval = parseInt(timerMatch[2]) || 1;
        
        if (isConnected) {
            startTimer(channel, username, minutes, interval);
        }
        return;
    }
    
    // Pause command
    if (lowerMessage === '!pause') {
        if (isConnected) {
            pauseTimer(channel, username);
        }
        return;
    }
    
    // Resume command
    if (lowerMessage === '!resume') {
        if (isConnected) {
            resumeTimer(channel, username);
        }
        return;
    }
    
    // Stop timer command
    if (lowerMessage === '!stoptimer') {
        if (isConnected) {
            stopTimers(channel, username);
        }
        return;
    }
    
    // Timer status command (anyone can use this)
    if (lowerMessage === '!timers') {
        if (isConnected) {
            showTimerStatus(channel, username);
        }
        return;
    }
});

// Start a new timer
function startTimer(channel, username, minutes, intervalMinutes) {
    // Stop existing timers for this user
    for (const [id, timer] of activeTimers.entries()) {
        if (timer.username === username) {
            timer.cleanup();
        }
    }
    
    // Create new timer
    const timer = new Timer(username, minutes, intervalMinutes, channel);
    activeTimers.set(timer.id, timer);
    
    sendMessage(channel, `💋⏱️ ${username} started a ${minutes}-minute Trigger timer! Updates every ${intervalMinutes} minute(s). Please enjoy and lean back, and wait with your new requests. 🌜✨`);
}

// Pause a timer
function pauseTimer(channel, username) {
    let found = false;
    
    for (const [id, timer] of activeTimers.entries()) {
        if (timer.username === username && !timer.isPaused) {
            if (timer.pause()) {
                const status = timer.getStatus();
                sendMessage(channel, `⏸️ ${username} paused timer with ${status.remaining} minutes remaining.`);
                found = true;
            }
            break; // Only pause the first active timer
        }
    }
    
    if (!found) {
        sendMessage(channel, `${username}, you don't have an active timer to pause.`);
    }
}

// Resume a timer
function resumeTimer(channel, username) {
    let found = false;
    
    for (const [id, timer] of activeTimers.entries()) {
        if (timer.username === username && timer.isPaused) {
            if (timer.resume()) {
                const status = timer.getStatus();
                sendMessage(channel, `▶️ ${username} resumed timer with ${status.remaining} minutes remaining. Please wait with new requests or answers to your questions, and enjoy.`);
                found = true;
            }
            break; // Only resume the first paused timer
        }
    }
    
    if (!found) {
        sendMessage(channel, `${username}, you don't have a paused timer to resume.`);
    }
}

// Stop timers
function stopTimers(channel, username) {
    let stoppedCount = 0;
    
    for (const [id, timer] of activeTimers.entries()) {
        if (timer.username === username) {
            timer.cleanup();
            stoppedCount++;
        }
    }
    
    if (stoppedCount > 0) {
        sendMessage(channel, `⏹️ Stopped ${stoppedCount} timer(s) for ${username}`);
    } else {
        sendMessage(channel, `${username}, you don't have any active timers.`);
    }
}

// Show timer status
function showTimerStatus(channel, username) {
    const userTimers = [];
    
    for (const [id, timer] of activeTimers.entries()) {
        if (timer.username === username) {
            const status = timer.getStatus();
            const pauseIndicator = status.isPaused ? ' (PAUSED)' : '';
            userTimers.push(`${status.remaining}min${pauseIndicator}`);
        }
    }
    
    if (userTimers.length > 0) {
        sendMessage(channel, `${username}, your timers: ${userTimers.join(', ')}`);
    } else {
        sendMessage(channel, `${username}, you have no active timers. Start one with !10min`);
    }
}

// Safe message sending
function sendMessage(channel, message) {
    if (isConnected) {
        client.say(channel, message)
            .catch(err => console.error('Failed to send message:', err));
    }
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    
    for (const [id, timer] of activeTimers.entries()) {
        timer.cleanup();
    }
    
    if (isConnected) {
        client.disconnect();
    }
    
    process.exit(0);
});

// Log startup
console.log('🚀 Bot starting up...');
console.log(`📺 Channel: ${CHANNEL_NAME}`);
console.log(`🤖 Bot user: ${BOT_USERNAME}`);