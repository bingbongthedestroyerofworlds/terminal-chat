const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error(err.message);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, username TEXT, pfp TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS rooms (room_name TEXT PRIMARY KEY)`);
    
    db.run(`INSERT OR IGNORE INTO users (username, password) VALUES ('admin', 'orangesandlemons')`);
    db.run(`INSERT OR IGNORE INTO rooms (room_name) VALUES ('lounge'), ('lobby')`);
});

io.on('connection', (socket) => {
    let currentRoom = null;
    let authUser = null;

    // Synchronize voice channel layout maps across peers
    function updateVoiceState() {
        if (!currentRoom) return;
        const socketsInRoom = io.sockets.adapter.rooms.get(currentRoom);
        const voiceUsers = [];
        if (socketsInRoom) {
            for (const id of socketsInRoom) {
                const s = io.sockets.sockets.get(id);
                if (s && s.customUsername && s.inVoiceChannel) {
                    voiceUsers.push({ name: s.customUsername, muted: s.voiceMuted, id: s.id });
                }
            }
        }
        io.to(currentRoom).emit('voice-state-update', voiceUsers);
    }

    socket.on('auth-user', ({ name, pass }) => {
        db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [name, pass], (err, row) => {
            if (row) {
                authUser = name;
                socket.emit('auth-result', { success: true, isAdmin: (name === 'admin') });
            } else {
                socket.emit('auth-result', { success: false, msg: 'Authentication failure.' });
            }
        });
    });

    socket.on('admin-get-state', () => {
        if (authUser !== 'admin') return;
        db.all(`SELECT username FROM users`, [], (err, userRows) => {
            db.all(`SELECT room_name FROM rooms`, [], (err, roomRows) => {
                socket.emit('admin-state-data', { users: userRows.map(r => r.username), rooms: roomRows.map(r => r.room_name) });
            });
        });
    });

    socket.on('get-rooms-list', () => {
        db.all(`SELECT room_name FROM rooms`, [], (err, rows) => {
            socket.emit('rooms-list-data', rows.map(r => r.room_name));
        });
    });

    socket.on('get-active-users', () => {
        if (!currentRoom) return;
        const socketsInRoom = io.sockets.adapter.rooms.get(currentRoom);
        const userList = [];
        if (socketsInRoom) {
            for (const socketId of socketsInRoom) {
                const clientSocket = io.sockets.sockets.get(socketId);
                if (clientSocket && clientSocket.customUsername) userList.push(clientSocket.customUsername);
            }
        }
        socket.emit('active-users-data', userList);
    });

    socket.on('admin-create-user', ({ newName, newPass }) => {
        if (authUser !== 'admin') return;
        db.run(`INSERT OR IGNORE INTO users (username, password) VALUES (?, ?)`, [newName, newPass], () => {
            socket.emit('admin-action-complete', 'User created.');
        });
    });

    socket.on('admin-delete-user', (targetUser) => {
        if (authUser !== 'admin' || targetUser === 'admin') return;
        db.run(`DELETE FROM users WHERE username = ?`, [targetUser], () => {
            socket.emit('admin-action-complete', 'User deleted.');
        });
    });

    socket.on('admin-create-room', (roomName) => {
        if (authUser !== 'admin') return;
        db.run(`INSERT OR IGNORE INTO rooms (room_name) VALUES (?)`, [roomName.toLowerCase()], () => {
            socket.emit('admin-action-complete', 'Room created.');
        });
    });

    socket.on('admin-delete-room', (roomName) => {
        if (authUser !== 'admin') return;
        db.run(`DELETE FROM rooms WHERE room_name = ?`, [roomName], () => {
            db.run(`DELETE FROM messages WHERE room = ?`, [roomName], () => {
                socket.emit('admin-action-complete', 'Room wiped.');
            });
        });
    });

    socket.on('join-room', ({ room, pfp }) => {
        if (!authUser) return;
        const targetRoom = room.toLowerCase();

        db.get(`SELECT room_name FROM rooms WHERE room_name = ?`, [targetRoom], (err, row) => {
            if (!row) {
                socket.emit('room-join-result', { success: false, msg: `Room [${targetRoom}] does not exist.` });
                return;
            }

            currentRoom = targetRoom;
            socket.customUsername = authUser;
            socket.inVoiceChannel = false;
            socket.voiceMuted = false;
            socket.join(currentRoom);
            socket.emit('room-join-result', { success: true, room: currentRoom });
            socket.to(currentRoom).emit('system-message', `SYSTEM: User "${authUser}" routed into the node.`);
            updateVoiceState();

            db.all(`SELECT username, pfp, message FROM messages WHERE room = ? ORDER BY timestamp ASC`, [currentRoom], (err, rows) => {
                if (rows) {
                    socket.emit('load-history', rows.map(r => ({ user: btoa(r.username), pfp: r.pfp, msg: r.message })));
                }
            });
        });
    });

    // WebRTC Signaling Event Relay Pipeline
    socket.on('webrtc-signaling', (payload) => {
        if (payload.target) {
            io.to(payload.target).emit('webrtc-signaling', { sender: socket.id, signal: payload.signal });
        }
    });

    socket.on('set-voice-state', ({ active, muted }) => {
        socket.inVoiceChannel = active;
        socket.voiceMuted = muted;
        updateVoiceState();
        if (active) {
            // Signal to other users in the room to start an active call connection handshake
            socket.to(currentRoom).emit('voice-peer-joined', { id: socket.id, name: socket.customUsername });
        }
    });

    socket.on('leave-room', () => {
        if (currentRoom && authUser) {
            socket.to(currentRoom).emit('system-message', `SYSTEM: User "${authUser}" detached from node.`);
            socket.leave(currentRoom);
            currentRoom = null;
            updateVoiceState();
        }
    });

    socket.on('chat-message', (data) => {
        if (!authUser || !currentRoom) return;
        db.run(`INSERT INTO messages (room, username, pfp, message) VALUES (?, ?, ?, ?)`, [currentRoom, authUser, data.pfp, data.msg]);
        io.to(currentRoom).emit('message', { user: btoa(authUser), pfp: data.pfp, msg: data.msg });
    });

    socket.on('disconnect', () => {
        if (currentRoom && authUser) {
            io.to(currentRoom).emit('system-message', `SYSTEM: Node path lost for "${authUser}".`);
            updateVoiceState();
        }
    });
});

// Change your old server.listen line to this:
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
    console.log(`Server running on port ${PORT}`); 
});
