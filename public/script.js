const socket = io();
const output = document.getElementById('output');
const inputBox = document.getElementById('input-box');
const displayPrompt = document.getElementById('display-prompt');
const filePicker = document.getElementById('file-picker');
const uploadTrigger = document.getElementById('upload-trigger');
const leaveTrigger = document.getElementById('leave-trigger');

const hudLocation = document.getElementById('hud-location');
const hudTime = document.getElementById('hud-time');
const hudBuddy = document.getElementById('hud-buddy');

const voiceTray = document.getElementById('voice-tray');
const voiceUsersList = document.getElementById('voice-users-list');

let step = 'username';
let myUsername = '';
let myPassword = '';
let myRoom = '';
let myAvatar = '';
let isAdmin = false;
let audioMuted = false;

let adminActionTarget = ''; 

let localAudioStream = null;
let loopbackAudioNode = null; 
let peerConnections = {}; 
let voiceActive = false;
let micMuted = false;

const AVATARS = {
    '1': encrypt(` /\\_/\\\n( o.o )\n > ^ < `),
    '2': encrypt(`  ___ \n [o_o]\n /|_|\\`),
    '3': encrypt(` @@@@@\n( *_* )\n  \\-/ `),
    '4': encrypt(`  /\\  \n /  \\ \n/____\\`)
};

// --- RANDOMIZED NATURAL BLINKING ANIMATION LOOP ---
function runBlinkCycle() {
    // Normal state eyes
    hudBuddy.textContent = " <(o_o)> ";
    
    // Calculate a completely randomized delay timer for the next blink frame (between 1.5 to 5 seconds)
    let nextWaitTime = Math.random() * (5000 - 1500) + 1500;
    
    setTimeout(() => {
        // Closed/blinking eyes frame
        hudBuddy.textContent = " <(-_-)> ";
        
        // Hold the blink shut for a natural fraction of a second (150ms)
        setTimeout(() => {
            runBlinkCycle();
        }, 150);
    }, nextWaitTime);
}
// Start the natural blinking cycle
runBlinkCycle();

function encrypt(text) { return btoa(unescape(encodeURIComponent(text))); }
function decrypt(cipher) { return decodeURIComponent(escape(atob(cipher))); }

function updateSystemClock() {
    const now = new Date();
    const hrs = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    const secs = String(now.getSeconds()).padStart(2, '0');
    hudTime.textContent = `${hrs}:${mins}:${secs}`;
}
setInterval(updateSystemClock, 1000);
updateSystemClock();

function playBeepNotification() {
    if (audioMuted) return;
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(587.33, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
        oscillator.start();
        gainNode.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + 0.15);
        oscillator.stop(audioCtx.currentTime + 0.15);
    } catch(e) {}
}

function matchYoutubeId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function printMessage(pfp, user, text, isSystem = false) {
    const div = document.createElement('div');
    div.className = 'msg-line';
    if (isSystem) {
        div.innerHTML = `<div class="system">${text.replace(/\n/g, '<br>')}</div>`;
    } else {
        const cleanText = text.trim();
        const isImg = (/\.(jpeg|jpg|gif|png)$/i).test(cleanText) || cleanText.startsWith('data:image/');
        const ytId = matchYoutubeId(cleanText);

        const portraitBox = document.createElement('pre');
        portraitBox.className = 'portrait-container';
        portraitBox.textContent = pfp ? decrypt(pfp) : ` [?] \n [?] \n [?] `;

        const contentBox = document.createElement('div');
        contentBox.className = 'content-box';
        const userSpan = document.createElement('span');
        userSpan.className = 'user-tag'; userSpan.textContent = user + ' -> ';
        contentBox.appendChild(userSpan);
        
        if (isImg) {
            const img = document.createElement('img'); img.src = cleanText; img.className = 'shared-img';
            contentBox.appendChild(img);
        } else if (ytId) {
            const container = document.createElement('div');
            container.appendChild(document.createTextNode(cleanText));
            const iframe = document.createElement('iframe');
            iframe.src = `https://www.youtube.com/embed/${ytId}`;
            iframe.className = 'yt-frame';
            iframe.setAttribute('frameborder', '0'); iframe.setAttribute('allowfullscreen', 'true');
            container.appendChild(iframe);
            contentBox.appendChild(container);
        } else {
            contentBox.appendChild(document.createTextNode(text));
        }
        div.appendChild(portraitBox);
        div.appendChild(contentBox);
    }
    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
}

async function initVoiceChannel() {
    if (voiceActive) return;
    printMessage('', '', 'SYSTEM VOICE: Requesting hardware device microphone clearance access...', true);
    try {
        localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        voiceActive = true;
        micMuted = false;
        socket.emit('set-voice-state', { active: true, muted: false });
        printMessage('', '', 'SYSTEM VOICE: Microphone connected. Voice stream initialized.', true);
        
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(localAudioStream);
        loopbackAudioNode = audioContext.createGain();
        loopbackAudioNode.gain.setValueAtTime(1.0, audioContext.currentTime);
        source.connect(loopbackAudioNode);
        loopbackAudioNode.connect(audioContext.destination);
    } catch (err) {
        printMessage('', '', 'SYSTEM VOICE EXCEPTION: Local microphone hardware access denied or not found.', true);
        voiceActive = false;
        socket.emit('set-voice-state', { active: false, muted: false });
    }
}

function handleLeaveVoice() {
    if (!voiceActive) return;
    if (localAudioStream) { localAudioStream.getTracks().forEach(track => track.stop()); localAudioStream = null; }
    if (loopbackAudioNode) { loopbackAudioNode.disconnect(); loopbackAudioNode = null; }
    for (let id in peerConnections) { peerConnections[id].close(); }
    peerConnections = {};
    voiceActive = false;
    socket.emit('set-voice-state', { active: false, muted: false });
    printMessage('', '', 'SYSTEM VOICE: Disconnected from feed room.', true);
}

function createPeerConnection(peerSocketId) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerConnections[peerSocketId] = pc;
    if (localAudioStream) { localAudioStream.getTracks().forEach(track => pc.addTrack(track, localAudioStream)); }
    pc.onicecandidate = (event) => {
        if (event.candidate) { socket.emit('webrtc-signaling', { target: peerSocketId, signal: { candidate: event.candidate } }); }
    };
    pc.ontrack = (event) => {
        let audioEl = document.getElementById(`audio-${peerSocketId}`);
        if (!audioEl) {
            audioEl = document.createElement('audio'); audioEl.id = `audio-${peerSocketId}`;
            audioEl.autoplay = true; document.body.appendChild(audioEl);
        }
        audioEl.srcObject = event.streams[0];
    };
    return pc;
}

socket.on('voice-peer-joined', async ({ id, name }) => {
    if (!voiceActive) return;
    if (loopbackAudioNode) { loopbackAudioNode.disconnect(); loopbackAudioNode = null; }
    const pc = createPeerConnection(id);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-signaling', { target: id, signal: { sdp: pc.localDescription } });
});

socket.on('webrtc-signaling', async ({ sender, signal }) => {
    let pc = peerConnections[sender] || createPeerConnection(sender);
    if (signal.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('webrtc-signaling', { target: sender, signal: { sdp: pc.localDescription } });
        }
    } else if (signal.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch(e) {}
    }
});

socket.on('voice-state-update', (voiceUsers) => {
    if (voiceUsers.length === 0) { voiceTray.style.display = 'none'; return; }
    voiceTray.style.display = 'flex'; voiceUsersList.innerHTML = '';
    voiceUsers.forEach(u => {
        const span = document.createElement('span'); span.className = 'voice-user';
        span.innerHTML = `<span class="voice-dot ${u.muted ? 'muted' : ''}"></span>${u.name} ${u.muted ? '[MUTED]' : ''}`;
        voiceUsersList.appendChild(span);
    });
});

window.menuClick = function(action, parameter) {
    if (action === 'route_room') { socket.emit('join-room', { room: parameter, pfp: myAvatar }); } 
    else if (action === 'del_room') { socket.emit('admin-delete-room', parameter); } 
    else if (action === 'del_user') { socket.emit('admin-delete-user', parameter); } 
    else if (action === 'trigger_panel') { renderAdminPanel(); }
};

function renderAdminPanel() {
    step = 'admin_panel'; output.innerHTML = ''; displayPrompt.textContent = 'Select Option #: ';
    hudLocation.textContent = "LOCATION: ADMIN CONTROL PANEL";
    printMessage('', '', 
`==============================================
        ADMIN MAINFRAME CONTROL PANEL        
==============================================
[1] View and Manage Rooms
[2] View and Manage Users
[3] Open Chat Application
----------------------------------------------
Type "/logout" to drop session clearance
----------------------------------------------`, true);
}

function exitRoom() {
    handleLeaveVoice();
    socket.emit('leave-room'); output.innerHTML = ''; uploadTrigger.style.display = 'none'; leaveTrigger.style.display = 'none';
    if (isAdmin) { renderAdminPanel(); } 
    else { step = 'room'; displayPrompt.textContent = 'Enter Room Name: '; hudLocation.textContent = "LOCATION: ROOM MATRIX SELECTION"; socket.emit('get-rooms-list'); }
}

leaveTrigger.addEventListener('click', exitRoom);
displayPrompt.textContent = 'Enter Username: ';

inputBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const val = inputBox.value.trim();
        inputBox.value = '';
        if (!val) return;

        if (val === '/logout') { triggerLogout(); return; }

        if (step === 'username') { myUsername = val; step = 'password'; displayPrompt.textContent = 'Enter Password: '; }
        else if (step === 'password') { myPassword = val; socket.emit('auth-user', { name: myUsername, pass: myPassword }); }
        else if (step === 'avatar') {
            if (AVATARS[val]) {
                myAvatar = AVATARS[val];
                if (isAdmin) { renderAdminPanel(); } 
                else { step = 'room'; displayPrompt.textContent = 'Enter Room Name: '; hudLocation.textContent = "LOCATION: ROOM MATRIX SELECTION"; socket.emit('get-rooms-list'); }
            } else { printMessage('', '', 'SYSTEM: Invalid option.', true); }
        }
        else if (step === 'room') { socket.emit('join-room', { room: val, pfp: myAvatar }); }
        else if (step === 'admin_panel') {
            if (val === '1') { step = 'admin_rooms_view'; socket.emit('admin-get-state'); } 
            else if (val === '2') { step = 'admin_users_view'; socket.emit('admin-get-state'); } 
            else if (val === '3') { step = 'room'; displayPrompt.textContent = 'Enter Room Name: '; hudLocation.textContent = "LOCATION: ROOM MATRIX SELECTION"; socket.emit('get-rooms-list'); } 
            else { renderAdminPanel(); }
        }
        else if (step === 'admin_rooms_view' && val === 'back') { renderAdminPanel(); }
        else if (step === 'admin_rooms_view' && val === 'new') { step = 'admin_create_room_process'; displayPrompt.textContent = 'New Room Name: '; }
        else if (step === 'admin_create_room_process') { socket.emit('admin-create-room', val); }
        else if (step === 'admin_users_view' && val === 'back') { renderAdminPanel(); }
        else if (step === 'admin_users_view' && val === 'new') { step = 'admin_create_user_name'; displayPrompt.textContent = 'New User Name: '; }
        else if (step === 'admin_create_user_name') { adminActionTarget = val; step = 'admin_create_user_pass'; displayPrompt.textContent = `Password for ${val}: `; }
        else if (step === 'admin_create_user_pass') { socket.emit('admin-create-user', { newName: adminActionTarget, newPass: val }); }
        else if (step === 'chat') {
            if (val === '/clear') { output.innerHTML = ''; return; }
            if (val === '/leave') { exitRoom(); return; }
            if (val === '/vjoin') { initVoiceChannel(); return; }
            if (val === '/vleave') { handleLeaveVoice(); return; }
            
            // --- LIGHT AND DARK THEME SWITCH COMMANDS ---
            if (val === '/light') {
                document.body.classList.add('light-theme');
                printMessage('', '', 'SYSTEM: Swapped to Light Console Matrix layout.', true);
                return;
            }
            if (val === '/dark') {
                document.body.classList.remove('light-theme');
                printMessage('', '', 'SYSTEM: Swapped to Dark Console Matrix layout.', true);
                return;
            }

            if (val === '/vmute') {
                if (!voiceActive) return;
                micMuted = !micMuted; localAudioStream.getAudioTracks()[0].enabled = !micMuted;
                socket.emit('set-voice-state', { active: true, muted: micMuted });
                printMessage('', '', `SYSTEM VOICE: Microphone line ${micMuted ? 'MUTED' : 'UNMUTED'}.`, true);
                return;
            }
            if (val === '/help') {
                printMessage('', '', 
`--- TERMINAL INTERFACE CHEATSHEET ---
/help     - Displays layout features
/users    - Pulls usernames online in room
/light    - Swaps to bright monochrome contrast layout
/dark     - Swaps back to minimal night terminal look
/vjoin    - Connects to the room voice channel
/vmute    - Toggles microphone mute state
/vleave   - Disconnects your voice channel line
/clear    - Wipes local terminal chat log
/mute     - Silences terminal alert pings
/unmute   - Enables audio notification pings
/leave    - Returns to room layout hub
/logout   - Drops user pipeline credentials
-------------------------------------`, true);
                return;
            }
            if (val === '/users') { socket.emit('get-active-users'); return; }
            if (val === '/mute') { audioMuted = true; printMessage('', '', 'SYSTEM: Audio indicators muted.', true); return; }
            if (val === '/unmute') { audioMuted = false; printMessage('', '', 'SYSTEM: Audio indicators enabled.', true); playBeepNotification(); return; }

            socket.emit('chat-message', { pfp: myAvatar, msg: encrypt(val) });
        }
    }
});

socket.on('active-users-data', (users) => { printMessage('', '', `--- USERS CURRENTLY IN NODE ---\n• ${users.join('\n• ')}\n--------------------------------`, true); });
socket.on('rooms-list-data', (rooms) => { printMessage('', '', '--- AVAILABLE ROOM CHANNELS ---\n' + rooms.join(', ') + '\n--------------------------------\nCommands: /logout\n--------------------------------', true); });

socket.on('room-join-result', (data) => {
    if (data.success) {
        myRoom = data.room; step = 'chat'; displayPrompt.textContent = 'msg: ';
        uploadTrigger.style.display = 'inline'; leaveTrigger.style.display = 'inline';
        hudLocation.textContent = `LOCATION: ACTIVE ROOM [${myRoom.toUpperCase()}]`;
        printMessage('', '', `SYSTEM: Safe handshake absolute. Entered room [${myRoom}].\nType "/vjoin" to test voice calling, or "/help" for details.`, true);
    } else {
        printMessage('', '', `SYSTEM ERROR: ${data.msg}`, true);
        if (!isAdmin) socket.emit('get-rooms-list');
    }
});

socket.on('admin-state-data', (data) => {
    output.innerHTML = '';
    if (step === 'admin_rooms_view') {
        hudLocation.textContent = "LOCATION: ADMIN CONTROL -> ROOMS MATRIX";
        printMessage('', '', '--- ACTIVE ROOM CHANNELS ---\nType "new" to create, "back" to return.\nClick a name to instantly join.\n', true);
        data.rooms.forEach(r => { printMessage('', '', `* <span class="menu-btn" onclick="menuClick('route_room','${r}')">${r}</span> [<span class="danger-btn" onclick="menuClick('del_room','${r}')">DELETE WIPE</span>]`, true); });
    } else if (step === 'admin_users_view') {
        hudLocation.textContent = "LOCATION: ADMIN CONTROL -> USER ACCOUNTS";
        printMessage('', '', '--- PROVISIONED PROFILE ENCLAVES ---\nType "new" to create, "back" to return.\n', true);
        data.users.forEach(u => {
            let deleteAction = u !== 'admin' ? ` [<span class="danger-btn" onclick="menuClick('del_user','${u}')">REVOKE DISCONNECT</span>]` : ' [PROTECTED]';
            printMessage('', '', `* User: <b>${u}</b>${deleteAction}`, true);
        });
    }
});

socket.on('admin-action-complete', (msg) => {
    printMessage('', '', `SYSTEM: ${msg}`, true);
    if (step === 'admin_create_room_process') { step = 'admin_rooms_view'; displayPrompt.textContent = 'Select Option #: '; } 
    else if (step === 'admin_create_user_pass') { step = 'admin_users_view'; displayPrompt.textContent = 'Select Option #: '; }
    setTimeout(() => { socket.emit('admin-get-state'); }, 800);
});

socket.on('auth-result', (data) => {
    if (data.success) {
        isAdmin = data.isAdmin; step = 'avatar';
        printMessage('', '', `Select Avatar Profile Grid Portrait:\n1: Kitty Art\n2: Robot Art\n3: Punk Art\n4: Geometric Sigil Art\nChoose number (1-4):`, true);
        displayPrompt.textContent = 'Select Portrait #: ';
    } else {
        printMessage('', '', 'SYSTEM: ' + data.msg, true);
        step = 'username'; displayPrompt.textContent = 'Enter Username: ';
    }
});

function triggerLogout() {
    handleLeaveVoice(); socket.emit('leave-room'); socket.disconnect();
    step = 'username'; myUsername = ''; myPassword = ''; myRoom = ''; myAvatar = ''; isAdmin = false; adminActionTarget = '';
    hudLocation.textContent = "LOCATION: UNINITIALIZED GATEWAY";
    output.innerHTML = '*** SECURE MULTI-ROOM TERMINAL v12.0 ***<br>SYSTEM: Session terminated successfully. Handshake dropped.<br><br>';
    uploadTrigger.style.display = 'none'; leaveTrigger.style.display = 'none';
    displayPrompt.textContent = 'Enter Username: '; socket.connect();
}

uploadTrigger.addEventListener('click', () => { filePicker.click(); });
filePicker.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file || step !== 'chat') return;
    if (file.type === 'image/gif' || file.size < 200000) {
        const reader = new FileReader();
        reader.onload = function(event) { socket.emit('chat-message', { pfp: myAvatar, msg: encrypt(event.target.result) }); };
        reader.readAsDataURL(file); filePicker.value = ''; return;
    }
    const reader = new FileReader();
    reader.onload = function(event) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            let width = img.width; let height = img.height; const maxDimension = 800;
            if (width > height) { if (width > maxDimension) { height *= maxDimension / width; width = maxDimension; } } 
            else { if (height > maxDimension) { width *= maxDimension / height; height = maxDimension; } }
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
            socket.emit('chat-message', { pfp: myAvatar, msg: encrypt(canvas.toDataURL('image/jpeg', 0.7)) });
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file); filePicker.value = '';
});

socket.on('load-history', (historyData) => {
    printMessage('', '', '--- LOADING PERSISTENT LOGS ---', true);
    historyData.forEach(item => { printMessage(item.pfp, decrypt(item.user), decrypt(item.msg)); });
    printMessage('', '', '--------------------------------', true);
});

socket.on('message', ({ user, pfp, msg }) => { 
    printMessage(pfp, decrypt(user), decrypt(msg)); 
    if (decrypt(user) !== myUsername) { playBeepNotification(); }
});

socket.on('system-message', (msg) => { printMessage('', '', msg, true); });