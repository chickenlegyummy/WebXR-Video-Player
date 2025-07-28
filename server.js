const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Serve static files
app.use(express.static(__dirname));

// Video playlist configuration
const PLAYLIST = [
    { id: 'intro', name: 'Introduction', file: 'intro.mp4', duration: 60 },
    { id: 'dailylife', name: 'Daily Life', file: 'dailylife.mp4', duration: 300 },
    { id: 'law', name: 'Law Content', file: 'law.mp4', duration: 240 }
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

// WebSocket server
const wss = new WebSocket.Server({ port: 8080 });

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
            console.log('VR client disconnected');
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
                playVideo(data.index);
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
        
        console.log(`Playing video: ${serverState.currentVideo.name}`);
        
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
        
        console.log(`Navigated to: ${serverState.currentVideo.name} (not playing)`);
        
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

app.listen(PORT, () => {
    console.log(`HTTP Server running on http://192.168.0.128:${PORT}`);
    console.log(`WebSocket server running on ws://192.168.0.128:8080`);
    console.log(`VR Client: http://192.168.0.128:${PORT}`);
    console.log(`Controller: http://192.168.0.128:${PORT}/controller`);
});
