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

// Colas para ICE candidates
let pendingSenderIceCandidates = [];
let pendingReceiverIceCandidates = [];



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
const fpsSlider = document.getElementById('fpsSlider');
const fpsDisplay = document.getElementById('fpsDisplay');

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
// Poblar lista de resoluciones disponibles
// ===========================
async function detectCameraResolutions(deviceId) {
  resolutionSelect.innerHTML = '';
  if (!deviceId) return;

  if (resolutionCache.has(deviceId)) {
    const cached = resolutionCache.get(deviceId);
    cached.forEach(r => {
      const label = r.native
        ? `🎯 Nativa ${r.w}x${r.h} @${r.fps}fps`
        : `${r.w}x${r.h} @${r.fps}fps`;
      resolutionSelect.add(new Option(label, `${r.w}x${r.h}@${r.fps}`));
    });
    logEmitter(`✔ ${cached.length} modos`);
    return;
  }

  logEmitter('🔍 Detectando resolución nativa...');

  let nw = 0, nh = 0, nfps = 30;
  let nativeStream = null;
  try {
    nativeStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
      audio: false
    });
    const s = nativeStream.getVideoTracks()[0].getSettings();
    nw = s.width; nh = s.height; nfps = Math.round(s.frameRate || 30);
  } catch (e) {
    logEmitter(`❌ Error accediendo a cámara: ${e.message}`);
    resolutionSelect.add(new Option('Automático', ''));
    return;
  } finally {
    if (nativeStream) nativeStream.getTracks().forEach(t => t.stop());
  }

  const ALL_RESOLUTIONS = [
    { w: 320, h: 240 },
    { w: 640, h: 480 },
    { w: 800, h: 600 },
    { w: 1024, h: 768 },
    { w: 1280, h: 720 },
    { w: 1366, h: 768 },
    { w: 1600, h: 900 },
    { w: 1920, h: 1080 },
    { w: 2560, h: 1440 },
    { w: 3840, h: 2160 },
  ];

  const found = [];
  const added = new Set();

  // Nativa siempre primero
  const nativeKey = `${nw}x${nh}@${nfps}`;
  added.add(nativeKey);
  found.push({ w: nw, h: nh, fps: nfps, native: true });

  for (const { w, h } of ALL_RESOLUTIONS) {
    if (w === nw && h === nh && nfps === 30) continue;
    // Para cada resolución, ofrecer FPS comunes
    for (const fps of [15, 24, 30, 60]) {
      const key = `${w}x${h}@${fps}`;
      if (!added.has(key)) {
        added.add(key);
        found.push({ w, h, fps, native: false });
      }
    }
  }

  found.sort((a, b) => a.w * a.h - b.w * b.h);

  resolutionSelect.innerHTML = '';
  found.forEach(r => {
    const label = r.native
      ? `🎯 Nativa ${r.w}x${r.h} @${r.fps}fps`
      : `${r.w}x${r.h} @${r.fps}fps`;
    resolutionSelect.add(new Option(label, `${r.w}x${r.h}@${r.fps}`));
  });

  resolutionCache.set(deviceId, found);
  logEmitter(`✅ ${found.length} resoluciones disponibles (nativa: ${nw}x${nh})`);
}

cameraSelect.addEventListener('change', async () => {
  const deviceId = cameraSelect.value;
  if (!deviceId) return;

  logEmitter('🔍 Analizando cámara...');
  await detectCameraResolutions(deviceId);
  syncFpsSlider();
  startLocalPreview();
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
  
  const sliderFps = parseInt(fpsSlider.value) || 30;

  let videoConstraints = {
    deviceId: { exact: videoId }
  };
  
  if (resolution && resolution.includes('x')) {
    const [resPart, fpsPart] = resolution.split('@');
    const [width, height] = resPart.split('x');
    videoConstraints.width = { ideal: parseInt(width) };
    videoConstraints.height = { ideal: parseInt(height) };
    const resFps = fpsPart ? parseInt(fpsPart) : 60;
    videoConstraints.frameRate = { ideal: Math.min(resFps, sliderFps) };
  } else {
    videoConstraints.frameRate = { ideal: sliderFps };
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

    const settings = previewStream.getVideoTracks()[0].getSettings();
    document.getElementById('realResolution').textContent = `${settings.width}x${settings.height}`;
    logEmitter(`📷 Resolución REAL activa: ${settings.width}x${settings.height}`);

    return true;
    
  } catch (err) {
    logEmitter(`❌ Error en preview: ${err.message}`);
    return false;
  }
}

// Sincronizar slider FPS con la resolución seleccionada
function syncFpsSlider() {
  const val = resolutionSelect.value;
  if (val && val.includes('@')) {
    const [, fpsPart] = val.split('@');
    const maxFps = parseInt(fpsPart) || 30;
    fpsSlider.max = maxFps;
    if (parseInt(fpsSlider.value) > maxFps) {
      fpsSlider.value = maxFps;
    }
  } else {
    fpsSlider.max = 60;
  }
  fpsDisplay.textContent = fpsSlider.value;
}

resolutionSelect.addEventListener('change', () => {
  syncFpsSlider();
  startLocalPreview();
});

fpsSlider.addEventListener('input', () => {
  fpsDisplay.textContent = fpsSlider.value;
  startLocalPreview();
});

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
  const resolution = resolutionSelect.value;
  
  if (!videoId) {
    throw new Error('Selecciona una cámara');
  }
  
  const sliderFps = parseInt(fpsSlider.value) || 30;

  let videoConstraints = {
    deviceId: { exact: videoId }
  };

  if (resolution && resolution.includes('x')) {
    const [resPart, fpsPart] = resolution.split('@');
    const [width, height] = resPart.split('x');
    videoConstraints.width = { ideal: parseInt(width) };
    videoConstraints.height = { ideal: parseInt(height) };
    const resFps = fpsPart ? parseInt(fpsPart) : 60;
    videoConstraints.frameRate = { ideal: Math.min(resFps, sliderFps) };
  } else {
    videoConstraints.frameRate = { ideal: sliderFps };
  }

  const audioConstraints = includeAudio ? {
    deviceId: { exact: audioId },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  } : false;
  
  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: audioConstraints
  });
  
  return stream;
}

// ===========================
// Configurar Opus baja latencia vía SDP
// ===========================
function setOpusLowLatency(sdp) {
  const opusRegex = /a=rtpmap:(\d+) opus\/48000(\/\d+)?/g;
  let match;
  while ((match = opusRegex.exec(sdp)) !== null) {
    const pt = match[1];
    const fmtpRegex = new RegExp(`a=fmtp:${pt} (.*?)(\\r?\\n)`, 'g');
    const fmtpMatch = fmtpRegex.exec(sdp);
    const params = 'stereo=0;maxplaybackrate=16000;usedtx=1;maxaveragebitrate=16000';
    if (fmtpMatch) {
      sdp = sdp.replace(fmtpMatch[0], `a=fmtp:${pt} ${fmtpMatch[1]};${params}${fmtpMatch[2]}`);
    } else {
      sdp = sdp.replace(match[0], `${match[0]}\r\na=fmtp:${pt} ${params}`);
    }
  }
  return sdp;
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
    const senderVideoTrack = senderStream.getVideoTracks()[0];
    if (senderVideoTrack) {
      const s = senderVideoTrack.getSettings();
      document.getElementById('realResolution').textContent = `${s.width}x${s.height}`;
      logEmitter(`📷 Resolución REAL: ${s.width}x${s.height}`);
    }
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
    
    // Crear oferta con Opus baja latencia
    const offer = await senderPeer.createOffer();
    offer.sdp = setOpusLowLatency(offer.sdp);
    await senderPeer.setLocalDescription(offer);
    logEmitter('✔ Oferta SDP creada (Opus low-latency)');
    
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
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
  pendingSenderIceCandidates = [];
  connectSenderBtn.disabled = false;
  disconnectSenderBtn.disabled = true;
  document.getElementById('senderStats').style.display = 'none';
  logEmitter('⏹ Desconectado');
  startLocalPreview();
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