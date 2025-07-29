const WebSocket = require('ws');
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const WS_PORT = 8080;

// HTTPS configuration
const httpsOptions = {
    key: fs.readFileSync(path.join(__dirname, 'keys', 'server.key')),
    cert: fs.readFileSync(path.join(__dirname, 'keys', 'server.crt'))
};

// Serve static files
app.use(express.static(__dirname));

// Video playlist configuration
const PLAYLIST = [
    { id: 'intro', name: 'Introduction', file: './public/intro.mp4', duration:  24},
    { id: '4_4_2_1', name: '4_4_2_1', file: './public/4_4_2_1.mp4', duration: 17},
    { id: '9_5', name: '9_5', file: './public/9_5.mp4', duration: 4},
    { id: '10', name: '10', file: './public/10.mp4', duration: 2},
];

// Server state
let serverState = {
    currentVideo: null,
    currentIndex: -1,
    isPlaying: false,
    currentTime: 0,
    playlist: PLAYLIST,
    vrClientReady: false,
    gestureEnabled: false
};

// Create HTTPS server
const server = https.createServer(httpsOptions, app);

// WebSocket server attached to HTTPS server
const wss = new WebSocket.Server({ server });

// Connected clients
const clients = {
    vr: null,
    controller: null
};

wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (error) {
            console.error('Invalid message:', error);
        }
    });

    ws.on('close', () => {
        // Remove client from registry
        if (clients.vr === ws) {
            clients.vr = null;
            serverState.vrClientReady = false;
            serverState.gestureEnabled = false;
            // Reset video state when VR client disconnects
            serverState.currentVideo = null;
            serverState.currentIndex = -1;
            serverState.isPlaying = false;
            serverState.currentTime = 0;
            console.log('VR client disconnected - resetting video state');
        }
        if (clients.controller === ws) {
            clients.controller = null;
            console.log('Controller client disconnected');
        }
        broadcastState();
    });
});

function handleMessage(ws, data) {
    console.log('Received message:', data);

    switch (data.type) {
        case 'register':
            if (data.clientType === 'vr') {
                clients.vr = ws;
                serverState.vrClientReady = true;
                console.log('VR client registered');
            } else if (data.clientType === 'controller') {
                clients.controller = ws;
                console.log('Controller client registered');
            }
            sendToClient(ws, { type: 'state', data: serverState });
            broadcastState();
            break;

        case 'gesture_captured':
            if (ws === clients.vr) {
                serverState.gestureEnabled = true;
                console.log('User gesture captured - autoplay now enabled');
                broadcastState();
            }
            break;

        case 'video_ready':
            if (ws === clients.vr) {
                console.log('VR client video ready');
            }
            break;

        case 'video_ended':
            if (ws === clients.vr) {
                console.log('Video ended');
                serverState.isPlaying = false;
                serverState.currentTime = 0;
                broadcastState();
            }
            break;

        case 'time_update':
            if (ws === clients.vr) {
                serverState.currentTime = data.currentTime;
                // Only broadcast time updates to controller (not back to VR)
                if (clients.controller) {
                    sendToClient(clients.controller, { 
                        type: 'time_update', 
                        currentTime: data.currentTime 
                    });
                }
            }
            break;

        case 'play':
            if (ws === clients.controller && serverState.gestureEnabled) {
                if (serverState.currentVideo === null) {
                    // Start with intro video (index 0)
                    playVideo(0);
                } else {
                    resumeVideo();
                }
            }
            break;

        case 'pause':
            if (ws === clients.controller && serverState.gestureEnabled) {
                pauseVideo();
            }
            break;

        case 'next':
            if (ws === clients.controller && serverState.gestureEnabled) {
                goToNextVideo();
            }
            break;

        case 'select_video':
            if (ws === clients.controller && serverState.gestureEnabled) {
                loadVideo(data.index);
            }
            break;

        case 'vr_reset_detected':
            if (ws === clients.vr) {
                console.log('VR perspective reset detected:', data.position, data.rotation);
                // Notify controller about VR reset
                if (clients.controller) {
                    sendToClient(clients.controller, {
                        type: 'vr_reset_notification',
                        position: data.position,
                        rotation: data.rotation,
                        timestamp: new Date().toISOString()
                    });
                }
            }
            break;

        case 'vr_entered':
            if (ws === clients.vr) {
                console.log('VR mode entered');
                if (clients.controller) {
                    sendToClient(clients.controller, {
                        type: 'vr_status_change',
                        status: 'entered'
                    });
                }
            }
            break;

        case 'vr_exited':
            if (ws === clients.vr) {
                console.log('VR mode exited');
                if (clients.controller) {
                    sendToClient(clients.controller, {
                        type: 'vr_status_change',
                        status: 'exited'
                    });
                }
            }
            break;
    }
}

function playVideo(index) {
    if (index >= 0 && index < PLAYLIST.length) {
        serverState.currentIndex = index;
        serverState.currentVideo = PLAYLIST[index];
        serverState.isPlaying = true;
        serverState.currentTime = 0;
        
        console.log("Playing video: " + serverState.currentVideo.name);
        
        // Send play command to VR client
        if (clients.vr) {
            sendToClient(clients.vr, {
                type: 'play_video',
                video: serverState.currentVideo
            });
        }
        
        broadcastState();
    }
}

function resumeVideo() {
    if (serverState.currentVideo && !serverState.isPlaying) {
        serverState.isPlaying = true;
        
        if (clients.vr) {
            sendToClient(clients.vr, { type: 'resume' });
        }
        
        broadcastState();
    }
}

function pauseVideo() {
    if (serverState.currentVideo && serverState.isPlaying) {
        serverState.isPlaying = false;
        
        if (clients.vr) {
            sendToClient(clients.vr, { type: 'pause' });
        }
        
        broadcastState();
    }
}

function goToNextVideo() {
    const nextIndex = serverState.currentIndex + 1;
    if (nextIndex < PLAYLIST.length) {
        // Navigate to next video but don't auto-start
        serverState.currentIndex = nextIndex;
        serverState.currentVideo = PLAYLIST[nextIndex];
        serverState.isPlaying = false; // Don't auto-start
        serverState.currentTime = 0;
        
        console.log("Navigated to: " + serverState.currentVideo.name + " (not playing)");
        
        // Send video info to VR client but don't play yet
        if (clients.vr) {
            sendToClient(clients.vr, {
                type: 'load_video',
                video: serverState.currentVideo
            });
        }
        
        broadcastState();
    } else {
        console.log('Reached end of playlist');
        serverState.isPlaying = false;
        broadcastState();
    }
}

function loadVideo(index) {
    if (index >= 0 && index < PLAYLIST.length) {
        // Navigate to selected video but don't auto-start
        serverState.currentIndex = index;
        serverState.currentVideo = PLAYLIST[index];
        serverState.isPlaying = false; // Don't auto-start
        serverState.currentTime = 0;
        
        console.log("Loaded: " + serverState.currentVideo.name + " (not playing)");
        
        // Send video info to VR client but don't play yet
        if (clients.vr) {
            sendToClient(clients.vr, {
                type: 'load_video',
                video: serverState.currentVideo
            });
        }
        
        broadcastState();
    }
}

function playNextVideo() {
    const nextIndex = serverState.currentIndex + 1;
    if (nextIndex < PLAYLIST.length) {
        playVideo(nextIndex);
    } else {
        console.log('Reached end of playlist');
        serverState.isPlaying = false;
        broadcastState();
    }
}

function sendToClient(client, message) {
    if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
    }
}

function broadcastState() {
    const stateMessage = { type: 'state', data: serverState };
    
    if (clients.vr) {
        sendToClient(clients.vr, stateMessage);
    }
    if (clients.controller) {
        sendToClient(clients.controller, stateMessage);
    }
}

// HTTP server
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'vr-client.html'));
});

app.get('/controller', (req, res) => {
    res.sendFile(path.join(__dirname, 'controller.html'));
});

app.get('/playlist', (req, res) => {
    res.json(PLAYLIST);
});

// Start HTTPS server
server.listen(PORT, () => {
    console.log("HTTPS Server running on https://192.168.0.102:" + PORT);
    console.log("WebSocket server running on wss://192.168.0.102:" + PORT);
    console.log("VR Client: https://192.168.0.102:" + PORT);
    console.log("Controller: https://192.168.0.102:" + PORT + "/controller");
});
