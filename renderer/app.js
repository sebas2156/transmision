// ===========================
// Variables globales separadas
// ===========================
let senderStream = null;
let receiverStream = null;
let senderPeer = null;
let receiverPeer = null;
let signalingSocket = null;
let myClientId = null;

// Colas para ICE candidates que llegan antes que el remoteDescription
let pendingSenderIceCandidates = [];
let pendingReceiverIceCandidates = [];

const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
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

document.getElementById('refreshCameras').addEventListener('click', refreshDevices);
document.getElementById('refreshMics').addEventListener('click', refreshDevices);
refreshDevices();

// ===========================
// Helper: Serializar candidate manualmente (EVITA toJSON())
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
// EMISOR (SENDER)
// ===========================
connectSenderBtn.addEventListener('click', async () => {
  const videoId = cameraSelect.value;
  const audioId = micSelect.value;
  const includeAudio = document.getElementById('includeAudio').checked;
  const noiseReduction = document.getElementById('noiseReduction').checked;
  const fps = parseInt(document.getElementById('fps').value) || 30;
  const bitrate = parseInt(document.getElementById('bitrate').value) || 3000;

  if (!videoId) {
    logEmitter('❌ Selecciona una cámara.');
    return;
  }

  try {
    senderStream = await navigator.mediaDevices.getUserMedia({
      video: { 
        deviceId: { exact: videoId }, 
        width: { ideal: 1280 }, 
        height: { ideal: 720 }, 
        frameRate: { ideal: fps } 
      },
      audio: includeAudio ? { 
        deviceId: { exact: audioId }, 
        echoCancellation: false, 
        noiseSuppression: noiseReduction, 
        autoGainControl: false, 
        sampleRate: 48000, 
        channelCount: 1 
      } : false
    });
    logEmitter('✔ Captura local iniciada');
    
    // Preview local
    const localVideo = document.createElement('video');
    localVideo.srcObject = senderStream;
    localVideo.muted = true;
    localVideo.autoplay = true;
    localVideo.style.position = 'fixed';
    localVideo.style.bottom = '10px';
    localVideo.style.right = '10px';
    localVideo.style.width = '160px';
    localVideo.style.border = '2px solid #4CAF50';
    localVideo.style.borderRadius = '8px';
    localVideo.style.zIndex = '1000';
    document.body.appendChild(localVideo);
    
    setTimeout(() => {
      if (localVideo.parentNode) localVideo.parentNode.removeChild(localVideo);
    }, 5000);
    
  } catch (err) {
    logEmitter('❌ Error al capturar: ' + err.message);
    return;
  }

  // Crear peer connection para emisor
  senderPeer = new RTCPeerConnection(configuration);
  pendingSenderIceCandidates = [];
  
  senderStream.getTracks().forEach(track => {
    senderPeer.addTrack(track, senderStream);
    logEmitter(`✔ Track añadido: ${track.kind}`);
  });

  // Configurar bitrate
  const senderSenders = senderPeer.getSenders();
  senderSenders.forEach(sender => {
    if (sender.track && sender.track.kind === 'video') {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = bitrate * 1000;
      sender.setParameters(params);
      logEmitter(`✔ Bitrate configurado: ${bitrate} kbps`);
    }
  });

  senderPeer.onicecandidate = (event) => {
    if (event.candidate) {
      // Serialización manual - EVITA toJSON()
      const msg = { 
        type: 'candidate', 
        candidate: serializeCandidate(event.candidate),
        fromPeer: 'sender'
      };
      if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
        signalingSocket.send(JSON.stringify(msg));
        logEmitter(`📡 ICE candidate enviado`);
      }
    }
  };

  senderPeer.oniceconnectionstatechange = () => {
    logEmitter(`Estado ICE: ${senderPeer.iceConnectionState}`);
    if (senderPeer.iceConnectionState === 'connected') {
      logEmitter('✅ Conexión P2P establecida exitosamente!');
    } else if (senderPeer.iceConnectionState === 'failed') {
      logEmitter('❌ Falló la conexión ICE. Verifica firewall/red.');
    }
  };

  senderPeer.onconnectionstatechange = () => {
    logEmitter(`Estado conexión: ${senderPeer.connectionState}`);
  };

  try {
    const offer = await senderPeer.createOffer();
    await senderPeer.setLocalDescription(offer);
    logEmitter('✔ Oferta SDP creada');

    const ip = receiverIP.value.trim();
    const port = receiverPort.value;
    const wsUrl = `ws://${ip}:${port}`;
    
    logEmitter(`Conectando a servidor WebSocket: ${wsUrl}`);
    signalingSocket = new WebSocket(wsUrl);

    signalingSocket.onopen = () => {
      logEmitter('✔ Conectado al servidor de señalización');
      
      // Serialización manual del SDP - EVITA toJSON()
      const offerMessage = { 
        type: 'offer', 
        sdp: {
          type: senderPeer.localDescription.type,
          sdp: senderPeer.localDescription.sdp
        },
        fromPeer: 'sender'
      };
      signalingSocket.send(JSON.stringify(offerMessage));
      logEmitter('📡 Oferta enviada al servidor');
    };

    signalingSocket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'answer') {
          logEmitter(`📡 Respuesta recibida del receptor`);
          if (senderPeer.signalingState === 'have-local-offer') {
            await senderPeer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            logEmitter('✅ Respuesta establecida');
            
            // Procesar ICE candidates pendientes que llegaron antes del answer
            if (pendingSenderIceCandidates.length > 0) {
              logEmitter(`📦 Procesando ${pendingSenderIceCandidates.length} ICE candidates pendientes...`);
              for (const candidate of pendingSenderIceCandidates) {
                try {
                  await senderPeer.addIceCandidate(new RTCIceCandidate(candidate));
                  logEmitter(`📡 ICE candidate pendiente añadido`);
                } catch (e) {
                  logEmitter(`❌ Error añadiendo candidate pendiente: ${e.message}`);
                }
              }
              pendingSenderIceCandidates = [];
            }
          } else {
            logEmitter(`⚠ Estado incorrecto para recibir answer: ${senderPeer.signalingState}`);
          }
        } else if (msg.type === 'candidate' && msg.candidate) {
          // Verificar si ya tenemos remoteDescription
          if (senderPeer.remoteDescription) {
            try {
              await senderPeer.addIceCandidate(new RTCIceCandidate(msg.candidate));
              logEmitter(`📡 ICE candidate añadido inmediatamente`);
            } catch (e) {
              logEmitter(`❌ Error añadiendo ICE candidate: ${e.message}`);
            }
          } else {
            // Guardar en cola para después
            pendingSenderIceCandidates.push(msg.candidate);
            logEmitter(`📦 ICE candidate guardado en cola (${pendingSenderIceCandidates.length} pendientes)`);
          }
        } else if (msg.type === 'client-id') {
          myClientId = msg.clientId;
          logEmitter(`🆔 ID asignado: ${myClientId}`);
        }
      } catch (e) {
        logEmitter(`Error procesando mensaje: ${e.message}`);
      }
    };

    signalingSocket.onerror = (err) => {
      logEmitter(`❌ Error WebSocket: ${err.message}`);
    };
    
    signalingSocket.onclose = () => {
      logEmitter('⚠ Conexión con servidor cerrada');
      if (connectSenderBtn.disabled) {
        disconnectSender();
      }
    };

    connectSenderBtn.disabled = true;
    disconnectSenderBtn.disabled = false;
    
  } catch (err) {
    logEmitter(`❌ Error al conectar: ${err.message}`);
    disconnectSender();
  }
});

function disconnectSender() {
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
  pendingSenderIceCandidates = [];
  connectSenderBtn.disabled = false;
  disconnectSenderBtn.disabled = true;
  logEmitter('⏹ Desconectado del receptor');
}

disconnectSenderBtn.addEventListener('click', disconnectSender);

// ===========================
// RECEPTOR (RECEIVER)
// ===========================
startServerBtn.addEventListener('click', () => {
  const port = parseInt(serverPort.value) || 3000;
  
  window.electronAPI.startServer(port);
  
  window.electronAPI.onSignalReceived(async (signal) => {
    logReceiver(`📡 Señal recibida: ${signal.type} de cliente ${signal.senderId}`);
    
    if (signal.type === 'offer') {
      await handleOffer(signal.data);
    } else if (signal.type === 'answer') {
      if (receiverPeer && receiverPeer.signalingState === 'have-local-offer') {
        await receiverPeer.setRemoteDescription(new RTCSessionDescription(signal.data.sdp));
        logReceiver('✅ Answer establecido');
        
        // Procesar ICE candidates pendientes
        if (pendingReceiverIceCandidates.length > 0) {
          logReceiver(`📦 Procesando ${pendingReceiverIceCandidates.length} ICE candidates pendientes...`);
          for (const candidate of pendingReceiverIceCandidates) {
            try {
              await receiverPeer.addIceCandidate(new RTCIceCandidate(candidate));
              logReceiver(`📡 ICE candidate pendiente añadido`);
            } catch (e) {
              logReceiver(`❌ Error añadiendo candidate pendiente: ${e.message}`);
            }
          }
          pendingReceiverIceCandidates = [];
        }
      }
    } else if (signal.type === 'candidate' && signal.data.candidate) {
      if (receiverPeer) {
        if (receiverPeer.remoteDescription) {
          try {
            await receiverPeer.addIceCandidate(new RTCIceCandidate(signal.data.candidate));
            logReceiver(`📡 ICE candidate añadido`);
          } catch (e) {
            logReceiver(`❌ Error añadiendo candidate: ${e.message}`);
          }
        } else {
          pendingReceiverIceCandidates.push(signal.data.candidate);
          logReceiver(`📦 ICE candidate guardado en cola (${pendingReceiverIceCandidates.length} pendientes)`);
        }
      }
    }
  });
  
  startServerBtn.disabled = true;
  stopServerBtn.disabled = false;
  logReceiver(`🚀 Iniciando servidor de señalización en puerto ${port}...`);
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
  
  startServerBtn.disabled = false;
  stopServerBtn.disabled = true;
  logReceiver('⏹ Servidor detenido');
});

window.electronAPI.onServerStarted((port) => {
  logReceiver(`✅ Servidor de señalización iniciado en puerto ${port}`);
  logReceiver(`📡 Esperando conexiones entrantes...`);
});

window.electronAPI.onServerStopped(() => {
  logReceiver('⏹ Servidor detenido');
});

window.electronAPI.onServerError((error) => {
  logReceiver(`❌ Error en servidor: ${error}`);
  startServerBtn.disabled = false;
  stopServerBtn.disabled = true;
});

window.electronAPI.onWsDisconnected((clientId) => {
  logReceiver(`⚠ Cliente ${clientId} desconectado`);
});

async function handleOffer(offerMessage) {
  logReceiver(`📡 Procesando oferta...`);
  
  if (receiverPeer) {
    receiverPeer.close();
  }
  
  receiverPeer = new RTCPeerConnection(configuration);
  pendingReceiverIceCandidates = [];
  
  receiverPeer.ontrack = (event) => {
    logReceiver(`✅ Stream remoto recibido! Pistas: ${event.streams[0].getTracks().length}`);
    // Evitar reasignar el mismo stream múltiples veces
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      receiverStream = event.streams[0];
    }
  };
  
  receiverPeer.onicecandidate = (event) => {
    if (event.candidate) {
      const candidateMessage = { 
        type: 'candidate', 
        candidate: serializeCandidate(event.candidate),
        fromPeer: 'receiver'
      };
      window.electronAPI.wsBroadcast(candidateMessage);
      logReceiver(`📡 Enviando ICE candidate`);
    }
  };
  
  receiverPeer.oniceconnectionstatechange = () => {
    logReceiver(`Estado ICE receptor: ${receiverPeer.iceConnectionState}`);
    if (receiverPeer.iceConnectionState === 'connected') {
      logReceiver('🎉 Conexión P2P establecida! Video en vivo');
    } else if (receiverPeer.iceConnectionState === 'failed') {
      logReceiver('❌ Falló conexión ICE del receptor');
    }
  };
  
  try {
    await receiverPeer.setRemoteDescription(new RTCSessionDescription(offerMessage.sdp));
    logReceiver(`✔ Remote description establecido`);
    
    const answer = await receiverPeer.createAnswer();
    await receiverPeer.setLocalDescription(answer);
    logReceiver(`✔ Answer creado y establecido`);
    
    // Serialización manual del SDP
    const answerMessage = { 
      type: 'answer', 
      sdp: {
        type: receiverPeer.localDescription.type,
        sdp: receiverPeer.localDescription.sdp
      },
      fromPeer: 'receiver'
    };
    window.electronAPI.wsBroadcast(answerMessage);
    logReceiver(`📡 Answer enviado al emisor`);
    
  } catch (err) {
    logReceiver(`❌ Error procesando oferta: ${err.message}`);
  }
}

// ===========================
// Pantalla completa
// ===========================
document.getElementById('fullscreenBtn').addEventListener('click', () => {
  if (remoteVideo.requestFullscreen) {
    remoteVideo.requestFullscreen();
  }
});

// ===========================
// Prueba de micrófono
// ===========================
document.getElementById('testMic').addEventListener('click', async () => {
  const audioId = micSelect.value;
  if (!audioId) {
    logEmitter('❌ No hay micrófono seleccionado.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { deviceId: { exact: audioId } } 
    });
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
    logEmitter(`❌ Error: ${err.message}`);
  }
});

logEmitter('🟢 Panel Emisor listo - Configura tu cámara y conecta');
logReceiver('🟢 Panel Receptor listo - Inicia el servidor de señalización');