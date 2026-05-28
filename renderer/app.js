// ===========================
// Variables globales
// ===========================
let localStream = null;
let peerConnection = null;
let signalingSocket = null;
let isReceiverActive = false;

const configuration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// Elementos UI
const tabs = document.querySelectorAll('.tab');
const senderPanel = document.getElementById('senderPanel');
const receiverPanel = document.getElementById('receiverPanel');

// Emisor
const cameraSelect = document.getElementById('cameraSelect');
const micSelect = document.getElementById('micSelect');
const connectSenderBtn = document.getElementById('connectSender');
const disconnectSenderBtn = document.getElementById('disconnectSender');
const receiverIP = document.getElementById('receiverIP');
const receiverPort = document.getElementById('receiverPort');
const senderLog = document.getElementById('senderLog');

// Receptor
const remoteVideo = document.getElementById('remoteVideo');
const startServerBtn = document.getElementById('startServer');
const stopServerBtn = document.getElementById('stopServer');
const serverPort = document.getElementById('serverPort');
const receiverLog = document.getElementById('receiverLog');
const localIPSpan = document.getElementById('localIP');

// ===========================
// Funciones de log
// ===========================
function logEmitter(msg) { senderLog.innerHTML += msg + '<br>'; senderLog.scrollTop = senderLog.scrollHeight; }
function logReceiver(msg) { receiverLog.innerHTML += msg + '<br>'; receiverLog.scrollTop = receiverLog.scrollHeight; }

// ===========================
// Cambio de pestañas
// ===========================
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    senderPanel.classList.toggle('active', target === 'sender');
    receiverPanel.classList.toggle('active', target === 'receiver');
  });
});

// ===========================
// Obtener IP local
// ===========================
async function getLocalIP() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.createDataChannel('');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return new Promise(resolve => {
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const ip = e.candidate.address;
      if (ip && ip !== '127.0.0.1' && ip.includes('.')) {
        resolve(ip);
        pc.close();
      }
    };
  });
}
getLocalIP().then(ip => { localIPSpan.textContent = ip; });

// ===========================
// Listado de dispositivos
// ===========================
async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const mics = devices.filter(d => d.kind === 'audioinput');
    cameraSelect.innerHTML = '';
    cameras.forEach(cam => cameraSelect.add(new Option(cam.label || `Cámara ${cam.deviceId.slice(0,8)}`, cam.deviceId)));
    micSelect.innerHTML = '';
    mics.forEach(mic => micSelect.add(new Option(mic.label || `Micrófono ${mic.deviceId.slice(0,8)}`, mic.deviceId)));
  } catch (err) { logEmitter('Error al listar dispositivos: ' + err.message); }
}
document.getElementById('refreshCameras').addEventListener('click', refreshDevices);
document.getElementById('refreshMics').addEventListener('click', refreshDevices);
refreshDevices();

// ===========================
// EMISOR
// ===========================
connectSenderBtn.addEventListener('click', async () => {
  const videoId = cameraSelect.value;
  const audioId = micSelect.value;
  const includeAudio = document.getElementById('includeAudio').checked;
  const noiseReduction = document.getElementById('noiseReduction').checked;
  const fps = parseInt(document.getElementById('fps').value) || 30;

  if (!videoId) return logEmitter('❌ Selecciona una cámara.');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: videoId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: fps } },
      audio: includeAudio ? { deviceId: { exact: audioId }, echoCancellation: false, noiseSuppression: noiseReduction, autoGainControl: false, sampleRate: 48000, channelCount: 1 } : false
    });
    logEmitter('✔ Captura local iniciada');
  } catch (err) {
    logEmitter('❌ Error al capturar: ' + err.message);
    return;
  }

  peerConnection = new RTCPeerConnection(configuration);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onsignalingstatechange = () => {
    logEmitter('ℹ Estado señalización: ' + peerConnection.signalingState);
  };

  let pendingCandidates = [];
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      const msg = { type: 'candidate', candidate: event.candidate.toJSON() };
      if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
        signalingSocket.send(JSON.stringify(msg));
      } else {
        pendingCandidates.push(msg);
      }
    }
  };

  peerConnection.onconnectionstatechange = () => {
    logEmitter('Estado conexión: ' + peerConnection.connectionState);
  };

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    logEmitter('✔ Oferta creada');

    const ip = receiverIP.value;
    const port = receiverPort.value;
    signalingSocket = new WebSocket(`ws://${ip}:${port}`);

    signalingSocket.onopen = () => {
      logEmitter('✔ Conectado al servidor de señalización');
      signalingSocket.send(JSON.stringify({ type: 'offer', sdp: peerConnection.localDescription.toJSON() }));
      pendingCandidates.forEach(c => signalingSocket.send(JSON.stringify(c)));
      pendingCandidates = [];
    };

    signalingSocket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'answer') {
          logEmitter('ℹ Recibida respuesta – estado actual: ' + peerConnection.signalingState);
          peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp))
            .then(() => logEmitter('✔ Respuesta establecida, conexión P2P exitosa'))
            .catch(e => logEmitter('❌ Error al establecer remote: ' + e.message));
        } else if (msg.type === 'candidate') {
          peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate))
            .catch(e => logEmitter('❌ Error ICE: ' + e.message));
        }
      } catch (e) {
        logEmitter('Mensaje no válido del servidor');
      }
    };

    signalingSocket.onerror = (err) => logEmitter('❌ Error de conexión: ' + err.message);
    signalingSocket.onclose = () => logEmitter('⚠ Conexión con el servidor cerrada');

    connectSenderBtn.disabled = true;
    disconnectSenderBtn.disabled = false;
  } catch (err) {
    logEmitter('❌ Error al conectar: ' + err.message);
  }
});

disconnectSenderBtn.addEventListener('click', () => {
  if (signalingSocket) signalingSocket.close();
  if (peerConnection) peerConnection.close();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  peerConnection = null;
  signalingSocket = null;
  connectSenderBtn.disabled = false;
  disconnectSenderBtn.disabled = true;
  logEmitter('⏹ Desconectado');
});

// ===========================
// RECEPTOR
// ===========================
startServerBtn.addEventListener('click', () => {
  const port = parseInt(serverPort.value) || 3000;
  window.electronAPI.registerReceiver();
  window.electronAPI.onReceiverSignal((msg) => {
    if (msg.type === 'offer') {
      handleOffer(msg.sdp);
    } else if (msg.type === 'candidate') {
      if (peerConnection) {
        peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate))
          .catch(e => logReceiver('Error ICE: ' + e.message));
      }
    }
  });
  isReceiverActive = true;
  window.electronAPI.startServer(port);
});

stopServerBtn.addEventListener('click', () => {
  window.electronAPI.stopServer();
  window.electronAPI.unregisterReceiver();
  window.electronAPI.removeReceiverSignalListener();
  isReceiverActive = false;
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
  startServerBtn.disabled = false;
  stopServerBtn.disabled = true;
  logReceiver('⏹ Servidor detenido');
});

window.electronAPI.onServerStarted((port) => {
  logReceiver(`✔ Servidor de señalización iniciado en puerto ${port}`);
  startServerBtn.disabled = true;
  stopServerBtn.disabled = false;
});

window.electronAPI.onServerStopped(() => {
  logReceiver('⏹ Servidor detenido');
  startServerBtn.disabled = false;
  stopServerBtn.disabled = true;
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
});

window.electronAPI.onWsDisconnected(() => {
  logReceiver('⚠ Cliente desconectado');
});

async function handleOffer(sdp) {
  if (peerConnection) peerConnection.close();
  peerConnection = new RTCPeerConnection(configuration);

  peerConnection.ontrack = (event) => {
    logReceiver('✔ Pista remota recibida');
    remoteVideo.srcObject = event.streams[0];
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      window.electronAPI.wsSend({ type: 'candidate', candidate: event.candidate.toJSON() });
    }
  };

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    window.electronAPI.wsSend({ type: 'answer', sdp: { type: answer.type, sdp: answer.sdp } });
    logReceiver('✔ Oferta procesada, respuesta enviada');
  } catch (err) {
    logReceiver('❌ Error procesando oferta: ' + err.message);
  }
}

// ===========================
// Pantalla completa
// ===========================
document.getElementById('fullscreenBtn').addEventListener('click', () => {
  if (remoteVideo.requestFullscreen) remoteVideo.requestFullscreen();
});

// ===========================
// Prueba de micrófono
// ===========================
document.getElementById('testMic').addEventListener('click', async () => {
  const audioId = micSelect.value;
  if (!audioId) return logEmitter('❌ No hay micrófono seleccionado.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: audioId } } });
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(audioCtx.destination);
    logEmitter('🎤 Escuchando micrófono (5s)');
    setTimeout(() => {
      stream.getTracks().forEach(t => t.stop());
      audioCtx.close();
      logEmitter('🔇 Prueba finalizada');
    }, 5000);
  } catch (err) {
    logEmitter('❌ Error: ' + err.message);
  }
});
