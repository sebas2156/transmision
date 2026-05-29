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
let currentSenderId = null;

let lastBytesSent = 0;
let lastBytesReceived = 0;
let lastStatsTime = 0;
let currentAdaptiveBitrate = 0;
const ADAPTIVE_RTT_THRESHOLD = 300;
const ADAPTIVE_LOSS_THRESHOLD = 10;
const ADAPTIVE_REDUCE = 0.85;
const ADAPTIVE_INCREASE = 1.10;

let currentScanningDeviceId = null;

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
const shield = document.getElementById('videoShield');

// ===========================
// Funciones de log
// ===========================
const MAX_LOG_LINES = 100;

function trimLog(el) {
  while (el.childElementCount > MAX_LOG_LINES) {
    el.removeChild(el.firstElementChild);
  }
}

function logEmitter(msg) { 
  const timestamp = new Date().toLocaleTimeString();
  senderLog.innerHTML += `[${timestamp}] ${msg}<br>`; 
  trimLog(senderLog);
  senderLog.scrollTop = senderLog.scrollHeight; 
}

function logReceiver(msg) { 
  const timestamp = new Date().toLocaleTimeString();
  receiverLog.innerHTML += `[${timestamp}] ${msg}<br>`; 
  trimLog(receiverLog);
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
// Escáner de resoluciones nativas (reemplaza FFmpeg)
// ===========================
const RESOLUTION_TEST_LIST = [
  { w: 320, h: 240 }, { w: 640, h: 480 }, { w: 800, h: 600 }, { w: 1024, h: 768 },
  { w: 1280, h: 720 }, { w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 1920, h: 1080 },
  { w: 2560, h: 1440 }, { w: 3840, h: 2160 },
  { w: 1280, h: 800 }, { w: 1920, h: 1200 }, { w: 2048, h: 1080 },
];

async function getActuallySupportedResolutions(deviceId) {
  currentScanningDeviceId = deviceId;

  if (resolutionCache.has(deviceId)) {
    return resolutionCache.get(deviceId);
  }

  const supported = [];
  logEmitter('🔍 Escaneando hardware con { exact }...');

  // Liberar preview para que la cámara no esté ocupada durante el escaneo
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }

  for (const res of RESOLUTION_TEST_LIST) {
    if (currentScanningDeviceId !== deviceId) {
      logEmitter('⏹ Escaneo abortado: cambio de cámara');
      return null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { exact: res.w },
          height: { exact: res.h }
        },
        audio: false,
      });
      const settings = stream.getVideoTracks()[0].getSettings();
      supported.push({
        w: settings.width,
        h: settings.height,
        fps: Math.round(settings.frameRate || 30),
      });
      stream.getTracks().forEach(t => t.stop());
    } catch (e) {
      // no es nativa, se ignora
    }
  }

  supported.sort((a, b) => a.w * a.h - b.w * b.h);
  resolutionCache.set(deviceId, supported);
  logEmitter(`✅ ${supported.length} resoluciones nativas detectadas`);
  return supported;
}

function populateResolutionSelect(modes) {
  resolutionSelect.innerHTML = '';
  if (modes.length === 0) {
    resolutionSelect.add(new Option('Automático', ''));
    return;
  }
  modes.forEach(m => {
    resolutionSelect.add(new Option(`${m.w}x${m.h} @${m.fps}fps`, `${m.w}x${m.h}@${m.fps}`));
  });
}

cameraSelect.addEventListener('change', async () => {
  const deviceId = cameraSelect.value;
  if (!deviceId) return;

  logEmitter('🔍 Analizando cámara...');
  const modes = await getActuallySupportedResolutions(deviceId);
  if (!modes) return; // cancelado por un escaneo más nuevo
  populateResolutionSelect(modes);
  syncFpsSlider();
  startLocalPreview();
});

document.getElementById('refreshCameras').addEventListener('click', refreshDevices);
document.getElementById('refreshMics').addEventListener('click', refreshDevices);

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
    videoConstraints.width = { exact: parseInt(width) };
    videoConstraints.height = { exact: parseInt(height) };
    const resFps = fpsPart ? parseInt(fpsPart) : 60;
    videoConstraints.frameRate = { ideal: Math.min(resFps, sliderFps), max: Math.min(resFps, sliderFps) };
  } else {
    videoConstraints.frameRate = { ideal: sliderFps, max: sliderFps };
  }

  const audioConstraints = includeAudio ? {
    deviceId: { exact: audioId },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  } : false;
  
  // Liberar preview viejo para evitar conflicto de hardware
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
  }
  
  // Crear stream de transmisión
  senderStream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: audioConstraints
  });
  
  // Reusar el stream como preview para que el video no se congele
  localPreview.srcObject = senderStream;
  
  return senderStream;
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

function optimizeVideoSDP(sdp) {
  return sdp.replace('useinbandfec=1', 'useinbandfec=1;video_signal_type=video;x-google-min-bitrate=2000;x-google-max-bitrate=6000');
}

function forceHighQuality(sdp, bitrateKbps) {
  sdp = sdp.replace(/a=mid:video\r\n/g, `a=mid:video\r\nb=AS:${bitrateKbps}\r\nb=TIAS:${bitrateKbps * 1000}\r\n`);
  sdp = sdp.replace("packetization-mode=1", "packetization-mode=1;profile-level-id=64001f");
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
    const now = performance.now();
    let videoStats = null;
    let candidateStats = null;
    
    stats.forEach(report => {
      if (report.type === 'outbound-rtp' && report.kind === 'video' && isSender) videoStats = report;
      if (report.type === 'inbound-rtp' && report.kind === 'video' && !isSender) videoStats = report;
      if (report.type === 'candidate-pair' && report.nominated) candidateStats = report;
    });
    
    if (videoStats) {
      const timeDiff = (now - lastStatsTime) / 1000;
      
      if (isSender) {
        const bytes = videoStats.bytesSent;
        const bitrate = Math.round(((bytes - lastBytesSent) * 8) / timeDiff / 1024);
        document.getElementById('senderStats').style.display = 'grid';
        document.getElementById('realBitrate').textContent = bitrate > 0 ? bitrate : 0;
        document.getElementById('realFPS').textContent = Math.round(videoStats.framesPerSecond || 0);
        document.getElementById('packetLoss').textContent = videoStats.packetsLost || 0;
        lastBytesSent = bytes;
      } else {
        const bytes = videoStats.bytesReceived;
        const bitrate = Math.round(((bytes - lastBytesReceived) * 8) / timeDiff / 1024);
        document.getElementById('receiverStats').style.display = 'grid';
        document.getElementById('recvBitrate').textContent = bitrate > 0 ? bitrate : 0;
        document.getElementById('recvFPS').textContent = Math.round(videoStats.framesPerSecond || 0);
        document.getElementById('recvPacketLoss').textContent = videoStats.packetsLost || 0;
        document.getElementById('jitter').textContent = (videoStats.jitter * 1000).toFixed(2);
        lastBytesReceived = bytes;
      }
      
      if (candidateStats && isSender) {
        const rttMs = candidateStats.currentRoundTripTime ? candidateStats.currentRoundTripTime * 1000 : 0;
        document.getElementById('rtt').textContent = rttMs.toFixed(0);
        
        // Modo adaptativo
        if (document.getElementById('adaptiveBitrate').checked && videoStats) {
          const loss = videoStats.packetsLost || 0;
          const targetBitrate = parseInt(document.getElementById('bitrate').value) || 3000;
          if (currentAdaptiveBitrate === 0) currentAdaptiveBitrate = targetBitrate;
          
          if (rttMs > ADAPTIVE_RTT_THRESHOLD || loss > ADAPTIVE_LOSS_THRESHOLD) {
            currentAdaptiveBitrate = Math.round(currentAdaptiveBitrate * ADAPTIVE_REDUCE);
            logEmitter(`⚡ Red adaptativa: bajando a ${currentAdaptiveBitrate} kbps (RTT:${rttMs.toFixed(0)}ms pérdida:${loss})`);
          } else if (rttMs < 100 && loss === 0 && currentAdaptiveBitrate < targetBitrate) {
            currentAdaptiveBitrate = Math.min(targetBitrate, Math.round(currentAdaptiveBitrate * ADAPTIVE_INCREASE));
            logEmitter(`⚡ Red estable: subiendo a ${currentAdaptiveBitrate} kbps`);
          }
          
          const senders = peer.getSenders();
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          if (videoSender && currentAdaptiveBitrate > 0) {
            const params = videoSender.getParameters();
            if (!params.encodings) params.encodings = [{}];
            const currentVal = (params.encodings[0].maxBitrate || 0) / 1000;
            if (Math.abs(currentVal - currentAdaptiveBitrate) > 50) {
              params.encodings[0].maxBitrate = currentAdaptiveBitrate * 1000;
              await videoSender.setParameters(params);
            }
          }
        }
      }
      
      lastStatsTime = now;
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
      const hint = document.getElementById('contentHintSelect').value;
      if ('contentHint' in senderVideoTrack) {
        senderVideoTrack.contentHint = hint;
      }
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
    
    // Cola de candidatos salientes
    let pendingOutgoingCandidates = [];
    
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
        } else {
          pendingOutgoingCandidates.push(msg);
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
    offer.sdp = optimizeVideoSDP(offer.sdp);
    const bitrateVal = parseInt(document.getElementById('bitrate').value) || 5000;
    offer.sdp = forceHighQuality(offer.sdp, bitrateVal);
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
      // Vaciar cola de candidatos generados antes de abrir el socket
      pendingOutgoingCandidates.forEach(msg => signalingSocket.send(JSON.stringify(msg)));
      pendingOutgoingCandidates = [];
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
    // Deshabilitar controles de cámara mientras se transmite
    cameraSelect.disabled = true;
    resolutionSelect.disabled = true;
    fpsSlider.disabled = true;
    
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
  cameraSelect.disabled = false;
  resolutionSelect.disabled = false;
  fpsSlider.disabled = false;
  document.getElementById('senderStats').style.display = 'none';
  logEmitter('⏹ Desconectado');
  startLocalPreview();
}

disconnectSenderBtn.addEventListener('click', disconnectSender);

// ===========================
// RECEPTOR
// ===========================
// Listener de señalización registrado UNA vez (fuera del botón)
window.electronAPI.onSignalReceived(async (signal) => {
  logReceiver(`📡 Señal: ${signal.type}`);
  
  if (signal.type === 'offer') {
    await handleOffer(signal.data, signal.senderId);
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

startServerBtn.addEventListener('click', () => {
  const port = parseInt(serverPort.value) || 3000;
  
  window.electronAPI.startServer(port);
  
  startServerBtn.disabled = true;
  stopServerBtn.disabled = false;
  logReceiver(`🚀 Servidor en puerto ${port}`);
});

stopServerBtn.addEventListener('click', () => {
  window.electronAPI.stopServer();
  
  if (receiverPeer) {
    receiverPeer.close();
    receiverPeer = null;
  }
  if (receiverStream) {
    receiverStream.getTracks().forEach(t => t.stop());
    receiverStream = null;
  }
  remoteVideo.srcObject = null;
  currentSenderId = null;
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

async function handleOffer(offerMessage, senderId) {
  if (receiverPeer) receiverPeer.close();
  
  currentSenderId = senderId;
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
    if (event.candidate && currentSenderId) {
      window.electronAPI.wsSendTo(currentSenderId, { 
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
    } else if (receiverPeer.iceConnectionState === 'failed') {
      logReceiver('❌ Conexión fallida');
      remoteVideo.srcObject = null;
    }
    // 'disconnected' no se toca: el video permanece congelado
  };
  
  try {
    await receiverPeer.setRemoteDescription(new RTCSessionDescription(offerMessage.sdp));
    const answer = await receiverPeer.createAnswer();
    await receiverPeer.setLocalDescription(answer);
    
    window.electronAPI.wsSendTo(currentSenderId, { 
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
// Pantalla completa modo kiosko
// ===========================
document.getElementById('fullscreenBtn').addEventListener('click', () => {
  if (remoteVideo.requestFullscreen) {
    remoteVideo.requestFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) {
    remoteVideo.classList.add('video-locked');
    remoteVideo.controls = false;
    shield.style.display = 'block';
    shield.className = 'full-screen-shield';
    remoteVideo.style.cursor = 'none';
    document.body.style.cursor = 'none';
    if (window.electronAPI && window.electronAPI.hideCursor) {
      window.electronAPI.hideCursor(true);
    }
  } else {
    remoteVideo.classList.remove('video-locked');
    shield.style.display = 'none';
    remoteVideo.style.cursor = 'default';
    document.body.style.cursor = 'default';
    if (window.electronAPI && window.electronAPI.hideCursor) {
      window.electronAPI.hideCursor(false);
    }
  }
});

window.addEventListener('contextmenu', (e) => {
  if (document.fullscreenElement) e.preventDefault();
}, false);

window.addEventListener('keydown', (e) => {
  if (document.fullscreenElement) {
    const forbidden = [' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'f'];
    if (forbidden.includes(e.key)) e.preventDefault();
  }
}, true);

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

// ===========================
// Auto-inicialización al cargar
// ===========================
window.addEventListener('DOMContentLoaded', async () => {
  await refreshDevices();

  if (cameraSelect.options.length > 0) {
    const defaultCam = cameraSelect.value;
    const modes = await getActuallySupportedResolutions(defaultCam);
    if (!modes) return;
    populateResolutionSelect(modes);
    if (resolutionSelect.options.length > 0) {
      resolutionSelect.selectedIndex = resolutionSelect.options.length - 1;
    }
    syncFpsSlider();
    startLocalPreview();
    logEmitter('🚀 Autoconfiguración completada.');
  } else {
    logEmitter('⚠ No se detectaron cámaras.');
  }
});

logEmitter('🟢 Emisor listo');
logReceiver('🟢 Receptor listo - Inicia el servidor');