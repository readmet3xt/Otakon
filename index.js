// index.js - Final version with partner connection status

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from 'redis';

const PORT = process.env.PORT || 8080;

const redisClient = createClient({
    url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

const rooms = new Map();

const startServer = async () => {
    await redisClient.connect();
    console.log('Connected to Redis database.');

    const httpServer = createServer();
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('request', (req, res) => {
        if (req.url === '/' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Relay server is healthy and running.');
        } else {
            res.writeHead(404).end();
        }
    });

    httpServer.on('upgrade', (request, socket, head) => {
        const roomCode = request.url.slice(1);
        if (!roomCode) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    wss.on('connection', async (ws, req) => {
        const roomCode = req.url.slice(1);
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        if (!rooms.has(roomCode)) {
            rooms.set(roomCode, new Set());
        }
        const room = rooms.get(roomCode);
        room.add(ws);

        console.log(`Client connected to room: ${roomCode}. Total clients: ${room.size}`);
        
        // --- NEW: Logic to notify clients when a partner connects ---
        if (room.size === 2) {
            const connectedMessage = JSON.stringify({ type: 'partner_connected' });
            room.forEach(client => client.send(connectedMessage));
            console.log(`Room ${roomCode} is full. Notified clients.`);
        }
        // --- END NEW LOGIC ---

        const historyJSON = await redisClient.get(roomCode);
        if (historyJSON) {
            ws.send(JSON.stringify({ type: 'history_restore', payload: JSON.parse(historyJSON) }));
        }

        ws.on('message', async (messageBuffer) => {
            const message = messageBuffer.toString();
            // Relay the message to every *other* client in the same room.
            room.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });

            // Save history (your existing logic)
            const parsedMessage = JSON.parse(message);
            if (parsedMessage.type === 'ai_response' || parsedMessage.type === 'user_message') {
                const currentHistory = JSON.parse(await redisClient.get(roomCode) || '[]');
                currentHistory.push(parsedMessage);
                await redisClient.set(roomCode, JSON.stringify(currentHistory));
            }
        });

        ws.on('close', () => {
            room.delete(ws);
            console.log(`Client disconnected from room: ${roomCode}. Remaining clients: ${room.size}`);
            
            // --- NEW: Logic to notify the remaining client that their partner has left ---
            const disconnectedMessage = JSON.stringify({ type: 'partner_disconnected' });
            room.forEach(client => client.send(disconnectedMessage));
            // --- END NEW LOGIC ---
        });
    });

    setInterval(() => {
        wss.clients.forEach(ws => {
            if (!ws.isAlive) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`Server is listening on port ${PORT}`);
    });
};

startServer();