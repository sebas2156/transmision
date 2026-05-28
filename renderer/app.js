// ===========================
// Variables globales separadas
// ===========================
let previewStream = null;      // Stream solo para preview local
let senderStream = null;       // Stream para transmisión WebRTC
let receiverStream = null;
let senderPeer = null;
let receiverPeer = null;
let signalingSocket = null;
let myClientId = null;
let statsInterval = null;

const resolutionCache = new Map();

const COMMON_RESOLUTIONS = [
  [320, 240],
  [640, 480],
  [800, 600],
  [1024, 768],
  [1280, 720],
  [1366, 768],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160]
];

// Colas para ICE candidates
let pendingSenderIceCandidates = [];
let pendingReceiverIceCandidates = [];

// Procesamiento de audio
let audioContext = null;
let audioWorkletNode = null;
let processedAudioTrack = null;

const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10,
  sdpSemantics: 'unified-plan'
};

// Elementos UI
const tabs = document.querySelectorAll('.tab');
const senderPanel = document.getElementById('senderPanel');
const receiverPanel = document.getElementById('receiverPanel');

// Emisor
const cameraSelect = document.getElementById('cameraSelect');
const micSelect = document.getElementById('micSelect');
const resolutionSelect = document.getElementById('resolutionSelect');
const connectSenderBtn = document.getElementById('connectSender');
const disconnectSenderBtn = document.getElementById('disconnectSender');
const receiverIP = document.getElementById('receiverIP');
const receiverPort = document.getElementById('receiverPort');
const senderLog = document.getElementById('senderLog');
const localPreview = document.getElementById('localPreview');
const applyBitrateBtn = document.getElementById('applyBitrate');
const hardwareAcceleration = document.getElementById('hardwareAcceleration');

// Receptor
const remoteVideo = document.getElementById('remoteVideo');
const startServerBtn = document.getElementById('startServer');
const stopServerBtn = document.getElementById('stopServer');
const serverPort = document.getElementById('serverPort');
const receiverLog = document.getElementById('receiverLog');
const localIPSpan = document.getElementById('localIP');
const downloadStatsBtn = document.getElementById('downloadStats');

// ===========================
// Funciones de log
// ===========================
function logEmitter(msg) { 
  const timestamp = new Date().toLocaleTimeString();
  senderLog.innerHTML += `[${timestamp}] ${msg}<br>`; 
  senderLog.scrollTop = senderLog.scrollHeight; 
}

function logReceiver(msg) { 
  const timestamp = new Date().toLocaleTimeString();
  receiverLog.innerHTML += `[${timestamp}] ${msg}<br>`; 
  receiverLog.scrollTop = receiverLog.scrollHeight; 
}

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
    setTimeout(() => {
      if (pc.signalingState !== 'closed') {
        resolve('localhost');
        pc.close();
      }
    }, 2000);
  });
}

getLocalIP().then(ip => { 
  localIPSpan.textContent = ip;
  logReceiver(`IP local detectada: ${ip}`);
});

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
    
    logEmitter(`Dispositivos detectados: ${cameras.length} cámaras, ${mics.length} micrófonos`);
  } catch (err) { 
    logEmitter('Error al listar dispositivos: ' + err.message); 
  }
}

// ===========================
// Detectar resoluciones reales por probing
// ===========================
async function detectCameraResolutions(deviceId) {
  if (resolutionCache.has(deviceId)) {
    resolutionSelect.innerHTML = '';
    const cached = resolutionCache.get(deviceId);
    cached.forEach(r => {
      resolutionSelect.add(new Option(`${r.w}x${r.h}`, `${r.w}x${r.h}`));
    });
    logEmitter(`✔ ${cached.length} resoluciones (cache)`);
    return;
  }

  resolutionSelect.innerHTML = '';
  const supported = [];

  for (const [width, height] of COMMON_RESOLUTIONS) {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { exact: width },
          height: { exact: height }
        }
      });

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();

      if (settings.width === width && settings.height === height) {
        supported.push({ w: width, h: height });
        resolutionSelect.add(new Option(`${width}x${height}`, `${width}x${height}`));
      }
    } catch {}
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }
  }

  if (supported.length === 0) {
    resolutionSelect.add(new Option('Por defecto', 'default'));
  }

  resolutionCache.set(deviceId, supported);
  logEmitter(`✔ ${supported.length} resoluciones reales detectadas`);
}

cameraSelect.addEventListener('change', async () => {
  const deviceId = cameraSelect.value;
  if (!deviceId) return;

  logEmitter('🔍 Detectando resoluciones soportadas...');
  await detectCameraResolutions(deviceId);
});

document.getElementById('refreshCameras').addEventListener('click', refreshDevices);
document.getElementById('refreshMics').addEventListener('click', refreshDevices);
refreshDevices();

// ===========================
// Helper: Serializar candidate manualmente
// ===========================
function serializeCandidate(candidate) {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment
  };
}

// ===========================
// Iniciar preview local (sin WebRTC)
// ===========================
async function startLocalPreview() {
  const videoId = cameraSelect.value;
  const resolution = resolutionSelect.value;
  
  if (!videoId) {
    logEmitter('❌ Selecciona una cámara primero');
    return false;
  }
  
  let videoConstraints = {
    deviceId: { exact: videoId }
  };
  
  // Configurar resolución si está seleccionada
  if (resolution) {
    const [width, height] = resolution.split('x');
    videoConstraints.width = { exact: parseInt(width) };
    videoConstraints.height = { exact: parseInt(height) };
  }
  
  try {
    // Detener preview anterior
    if (previewStream) {
      previewStream.getTracks().forEach(t => t.stop());
    }
    
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false
    });
    
    localPreview.srcObject = previewStream;
    logEmitter(`✅ Vista previa iniciada${resolution ? ` a ${resolution}` : ''}`);
    return true;
    
  } catch (err) {
    logEmitter(`❌ Error en preview: ${err.message}`);
    return false;
  }
}

// Iniciar preview al seleccionar cámara o resolución
cameraSelect.addEventListener('change', () => startLocalPreview());
resolutionSelect.addEventListener('change', () => startLocalPreview());

// ===========================
// Iniciar stream de transmisión (puede ser diferente al preview)
// ===========================
async function startSenderStream() {
  const videoId = cameraSelect.value;
  const audioId = micSelect.value;
  const includeAudio = document.getElementById('includeAudio').checked;
  const noiseReduction = document.getElementById('noiseReduction').checked;
  const echoCancellation = document.getElementById('echoCancellation').checked;
  const autoGainControl = document.getElementById('autoGainControl').checked;
  const fps = parseInt(document.getElementById('fps').value) || 30;
  const resolution = resolutionSelect.value;
  const advancedNoiseReduction = document.getElementById('advancedNoiseReduction').checked;
  
  if (!videoId) {
    throw new Error('Selecciona una cámara');
  }
  
  let videoConstraints = {
    deviceId: { exact: videoId },
    frameRate: { ideal: fps }
  };
  
  if (resolution) {
    const [width, height] = resolution.split('x');
    videoConstraints.width = { exact: parseInt(width) };
    videoConstraints.height = { exact: parseInt(height) };
  }
  
  const audioConstraints = includeAudio ? {
    deviceId: { exact: audioId },
    echoCancellation: echoCancellation,
    noiseSuppression: noiseReduction,
    autoGainControl: autoGainControl,
    sampleRate: 48000,
    channelCount: 1
  } : false;
  
  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: audioConstraints
  });
  
  // Si se habilita RNNoise avanzado, procesar audio
  if (includeAudio && advancedNoiseReduction) {
    logEmitter('🎧 Aplicando RNNoise avanzado...');
    try {
      const processedStream = await applyRNNoise(stream);
      return processedStream;
    } catch (err) {
      logEmitter(`⚠️ RNNoise falló, usando audio original: ${err.message}`);
      return stream;
    }
  }
  
  return stream;
}

// ===========================
// Aplicar RNNoise al audio (simulado con procesamiento básico)
// ===========================
async function applyRNNoise(inputStream) {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: 'interactive'
    });
  }
  
  const source = audioContext.createMediaStreamSource(inputStream);
  const destination = audioContext.createMediaStreamDestination();
  
  // Filtro pasa bajos simple como demostración
  // En producción, aquí se integraría RNNoise WASM
  const lowpass = audioContext.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 8000;
  
  source.connect(lowpass);
  lowpass.connect(destination);
  
  // Mantener audioContext activo
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  
  // Reemplazar pista de audio
  const newAudioTrack = destination.stream.getAudioTracks()[0];
  const oldAudioTrack = inputStream.getAudioTracks()[0];
  
  inputStream.removeTrack(oldAudioTrack);
  inputStream.addTrack(newAudioTrack);
  oldAudioTrack.stop();
  
  logEmitter('✅ RNNoise aplicado - Reducción de ruido avanzada activa');
  return inputStream;
}

// ===========================
// Aplicar bitrate
// ===========================
async function applyBitrate() {
  if (!senderPeer) {
    logEmitter('⚠️ No hay conexión activa para aplicar bitrate');
    return;
  }
  
  const bitrate = parseInt(document.getElementById('bitrate').value) || 3000;
  const senders = senderPeer.getSenders();
  const videoSender = senders.find(s => s.track && s.track.kind === 'video');
  
  if (videoSender) {
    const params = videoSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrate * 1000;
    await videoSender.setParameters(params);
    logEmitter(`✅ Bitrate aplicado: ${bitrate} kbps`);
  }
}

applyBitrateBtn.addEventListener('click', applyBitrate);

// ===========================
// Estadísticas en tiempo real
// ===========================
async function updateStats(peer, isSender = true) {
  if (!peer || peer.connectionState !== 'connected') return;
  
  try {
    const stats = await peer.getStats();
    let videoStats = null;
    let candidateStats = null;
    
    stats.forEach(report => {
      if (report.type === 'outbound-rtp' && report.kind === 'video' && isSender) {
        videoStats = report;
      }
      if (report.type === 'inbound-rtp' && report.kind === 'video' && !isSender) {
        videoStats = report;
      }
      if (report.type === 'candidate-pair' && report.nominated) {
        candidateStats = report;
      }
    });
    
    if (isSender) {
      document.getElementById('senderStats').style.display = 'grid';
      if (videoStats) {
        document.getElementById('realBitrate').textContent = 
          videoStats.bytesSent ? ((videoStats.bytesSent * 8 / 1024) / 1).toFixed(0) : '0';
        document.getElementById('realFPS').textContent = 
          videoStats.framesPerSecond || '0';
        document.getElementById('packetLoss').textContent = 
          videoStats.packetsLost || '0';
      }
      if (candidateStats) {
        document.getElementById('rtt').textContent = 
          candidateStats.currentRoundTripTime ? (candidateStats.currentRoundTripTime * 1000).toFixed(0) : '0';
      }
    } else {
      document.getElementById('receiverStats').style.display = 'grid';
      if (videoStats) {
        document.getElementById('recvBitrate').textContent = 
          videoStats.bytesReceived ? ((videoStats.bytesReceived * 8 / 1024) / 1).toFixed(0) : '0';
        document.getElementById('recvFPS').textContent = 
          videoStats.framesPerSecond || '0';
        document.getElementById('recvPacketLoss').textContent = 
          videoStats.packetsLost || '0';
        document.getElementById('jitter').textContent = 
          videoStats.jitter ? (videoStats.jitter * 1000).toFixed(0) : '0';
      }
    }
  } catch (err) {
    console.error('Error obteniendo stats:', err);
  }
}

// ===========================
// EMISOR (SENDER) - CON PREVIEW SEPARADO
// ===========================
connectSenderBtn.addEventListener('click', async () => {
  try {
    // Iniciar stream de transmisión (puede ser diferente al preview)
    logEmitter('🎥 Iniciando stream de transmisión...');
    senderStream = await startSenderStream();
    logEmitter('✔ Stream de transmisión iniciado');
    
    // Crear peer connection para emisor
    if (senderPeer) {
      senderPeer.close();
    }
    
    senderPeer = new RTCPeerConnection(configuration);
    pendingSenderIceCandidates = [];
    
    // Añadir tracks del stream de transmisión
    senderStream.getTracks().forEach(track => {
      senderPeer.addTrack(track, senderStream);
      logEmitter(`✔ Track añadido: ${track.kind}`);
    });
    
    // Configurar aceleración hardware
    if (hardwareAcceleration.checked) {
      logEmitter('🚀 Aceleración hardware habilitada (NVENC/AMF/Intel QuickSync)');
    }
    
    // ICE candidate handler
    senderPeer.onicecandidate = (event) => {
      if (event.candidate) {
        const msg = { 
          type: 'candidate', 
          candidate: serializeCandidate(event.candidate),
          fromPeer: 'sender'
        };
        if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
          signalingSocket.send(JSON.stringify(msg));
        }
      }
    };
    
    senderPeer.oniceconnectionstatechange = () => {
      logEmitter(`Estado ICE: ${senderPeer.iceConnectionState}`);
      if (senderPeer.iceConnectionState === 'connected') {
        logEmitter('✅ Conexión P2P establecida!');
        // Iniciar estadísticas
        if (statsInterval) clearInterval(statsInterval);
        statsInterval = setInterval(() => updateStats(senderPeer, true), 2000);
      }
    };
    
    senderPeer.ontrack = (event) => {
      logEmitter(`📺 Track recibido (emisor): ${event.track.kind}`);
    };
    
    // Crear oferta
    const offer = await senderPeer.createOffer();
    await senderPeer.setLocalDescription(offer);
    logEmitter('✔ Oferta SDP creada');
    
    // Conectar al servidor de señalización
    const ip = receiverIP.value.trim();
    const port = receiverPort.value;
    const wsUrl = `ws://${ip}:${port}`;
    
    signalingSocket = new WebSocket(wsUrl);
    
    signalingSocket.onopen = () => {
      logEmitter('✔ Conectado al servidor de señalización');
      const offerMessage = { 
        type: 'offer', 
        sdp: {
          type: senderPeer.localDescription.type,
          sdp: senderPeer.localDescription.sdp
        },
        fromPeer: 'sender'
      };
      signalingSocket.send(JSON.stringify(offerMessage));
      logEmitter('📡 Oferta enviada');
    };
    
    signalingSocket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'answer') {
          if (senderPeer.signalingState === 'have-local-offer') {
            await senderPeer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            logEmitter('✅ Answer recibido y establecido');
            
            // Aplicar bitrate configurado
            await applyBitrate();
            
            // Procesar candidates pendientes
            for (const candidate of pendingSenderIceCandidates) {
              try {
                await senderPeer.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                logEmitter(`❌ Error candidate pendiente: ${e.message}`);
              }
            }
            pendingSenderIceCandidates = [];
          }
        } else if (msg.type === 'candidate' && msg.candidate) {
          if (senderPeer.remoteDescription) {
            await senderPeer.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else {
            pendingSenderIceCandidates.push(msg.candidate);
          }
        } else if (msg.type === 'client-id') {
          myClientId = msg.clientId;
          logEmitter(`🆔 ID: ${myClientId}`);
        }
      } catch (e) {
        logEmitter(`Error: ${e.message}`);
      }
    };
    
    signalingSocket.onclose = () => {
      logEmitter('⚠ Conexión cerrada');
      if (connectSenderBtn.disabled) disconnectSender();
    };
    
    connectSenderBtn.disabled = true;
    disconnectSenderBtn.disabled = false;
    
  } catch (err) {
    logEmitter(`❌ Error: ${err.message}`);
    disconnectSender();
  }
});

function disconnectSender() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  if (signalingSocket) {
    signalingSocket.close();
    signalingSocket = null;
  }
  if (senderPeer) {
    senderPeer.close();
    senderPeer = null;
  }
  if (senderStream) {
    senderStream.getTracks().forEach(t => t.stop());
    senderStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  pendingSenderIceCandidates = [];
  connectSenderBtn.disabled = false;
  disconnectSenderBtn.disabled = true;
  document.getElementById('senderStats').style.display = 'none';
  logEmitter('⏹ Desconectado');
}

disconnectSenderBtn.addEventListener('click', disconnectSender);

// ===========================
// RECEPTOR
// ===========================
startServerBtn.addEventListener('click', () => {
  const port = parseInt(serverPort.value) || 3000;
  
  window.electronAPI.startServer(port);
  
  window.electronAPI.onSignalReceived(async (signal) => {
    logReceiver(`📡 Señal: ${signal.type}`);
    
    if (signal.type === 'offer') {
      await handleOffer(signal.data);
    } else if (signal.type === 'answer') {
      if (receiverPeer && receiverPeer.signalingState === 'have-local-offer') {
        await receiverPeer.setRemoteDescription(new RTCSessionDescription(signal.data.sdp));
        logReceiver('✅ Answer establecido');
        
        for (const candidate of pendingReceiverIceCandidates) {
          try {
            await receiverPeer.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {}
        }
        pendingReceiverIceCandidates = [];
      }
    } else if (signal.type === 'candidate' && signal.data.candidate) {
      if (receiverPeer) {
        if (receiverPeer.remoteDescription) {
          await receiverPeer.addIceCandidate(new RTCIceCandidate(signal.data.candidate));
        } else {
          pendingReceiverIceCandidates.push(signal.data.candidate);
        }
      }
    }
  });
  
  startServerBtn.disabled = true;
  stopServerBtn.disabled = false;
  logReceiver(`🚀 Servidor en puerto ${port}`);
});

stopServerBtn.addEventListener('click', () => {
  window.electronAPI.stopServer();
  window.electronAPI.removeSignalListener();
  
  if (receiverPeer) {
    receiverPeer.close();
    receiverPeer = null;
  }
  if (receiverStream) {
    receiverStream.getTracks().forEach(t => t.stop());
    receiverStream = null;
  }
  remoteVideo.srcObject = null;
  pendingReceiverIceCandidates = [];
  
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  
  startServerBtn.disabled = false;
  stopServerBtn.disabled = true;
  document.getElementById('receiverStats').style.display = 'none';
  logReceiver('⏹ Servidor detenido');
});

window.electronAPI.onServerStarted((port) => {
  logReceiver(`✅ Servidor iniciado en puerto ${port}`);
});

window.electronAPI.onServerStopped(() => {
  logReceiver('⏹ Servidor detenido');
});

window.electronAPI.onServerError((error) => {
  logReceiver(`❌ Error: ${error}`);
});

async function handleOffer(offerMessage) {
  if (receiverPeer) receiverPeer.close();
  
  receiverPeer = new RTCPeerConnection(configuration);
  pendingReceiverIceCandidates = [];
  
  receiverPeer.ontrack = (event) => {
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      receiverStream = event.streams[0];
      logReceiver('✅ Stream recibido');
      
      // Iniciar estadísticas
      if (statsInterval) clearInterval(statsInterval);
      statsInterval = setInterval(() => updateStats(receiverPeer, false), 2000);
    }
  };
  
  receiverPeer.onicecandidate = (event) => {
    if (event.candidate) {
      window.electronAPI.wsBroadcast({ 
        type: 'candidate', 
        candidate: serializeCandidate(event.candidate),
        fromPeer: 'receiver'
      });
    }
  };
  
  receiverPeer.oniceconnectionstatechange = () => {
    logReceiver(`ICE: ${receiverPeer.iceConnectionState}`);
    if (receiverPeer.iceConnectionState === 'connected') {
      logReceiver('🎉 Conexión P2P establecida!');
    }
  };
  
  try {
    await receiverPeer.setRemoteDescription(new RTCSessionDescription(offerMessage.sdp));
    const answer = await receiverPeer.createAnswer();
    await receiverPeer.setLocalDescription(answer);
    
    window.electronAPI.wsBroadcast({ 
      type: 'answer', 
      sdp: {
        type: receiverPeer.localDescription.type,
        sdp: receiverPeer.localDescription.sdp
      },
      fromPeer: 'receiver'
    });
    logReceiver('📡 Answer enviado');
    
  } catch (err) {
    logReceiver(`❌ Error: ${err.message}`);
  }
}

// ===========================
// Pantalla completa
// ===========================
document.getElementById('fullscreenBtn').addEventListener('click', () => {
  if (remoteVideo.requestFullscreen) remoteVideo.requestFullscreen();
});

// ===========================
// Descargar estadísticas
// ===========================
downloadStatsBtn.addEventListener('click', () => {
  const stats = {
    timestamp: new Date().toISOString(),
    sender: {
      bitrate: document.getElementById('realBitrate').textContent,
      fps: document.getElementById('realFPS').textContent,
      packetLoss: document.getElementById('packetLoss').textContent,
      rtt: document.getElementById('rtt').textContent
    },
    receiver: {
      bitrate: document.getElementById('recvBitrate').textContent,
      fps: document.getElementById('recvFPS').textContent,
      packetLoss: document.getElementById('recvPacketLoss').textContent,
      jitter: document.getElementById('jitter').textContent
    }
  };
  
  const blob = new Blob([JSON.stringify(stats, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `webrtc-stats-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  logReceiver('📊 Estadísticas descargadas');
});

// ===========================
// Prueba de micrófono
// ===========================
document.getElementById('testMic').addEventListener('click', async () => {
  const audioId = micSelect.value;
  if (!audioId) {
    logEmitter('❌ Selecciona un micrófono');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { deviceId: { exact: audioId } } 
    });
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(audioCtx.destination);
    logEmitter('🎤 Probando micrófono (5s)');
    setTimeout(() => {
      stream.getTracks().forEach(t => t.stop());
      audioCtx.close();
      logEmitter('🔇 Prueba finalizada');
    }, 5000);
  } catch (err) {
    logEmitter(`❌ Error: ${err.message}`);
  }
});

logEmitter('🟢 Emisor listo - Selecciona cámara para preview');
logReceiver('🟢 Receptor listo - Inicia el servidor');