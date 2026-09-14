"use strict";
/*
==========================================================
 RADIO ACOUSTIC MODEM
==========================================================

 Protocolo:

   0 = 1800 Hz
   1 = 2400 Hz

   Bit duration:
		30 ms

   Aproximadamente:
		33 bits/s

 Estrutura do pacote:
   PREÂMBULO
   SYNC
   LENGTH
   SALT
   IV
   CIPHERTEXT
   CRC

 A mensagem é criptografada antes da transmissão.

 Criptografia:
   PBKDF2-SHA256
   200.000 iterações
   AES-256-GCM
*/
/* ======================================================
   CONFIGURAÇÃO DO MODEM
====================================================== */
const MODEM = {
    sampleRate: 48000,
    frequency0: 1800,
    frequency1: 2400,
    startFrequency: 3500,
    endFrequency: 5000,
    startDuration: 0.40,
    endDuration: 0.16,
    bitDuration: 0.030,
    amplitude: 0.50,
    preambleBits: 80,
    sync: [
        1, 0, 1, 0,
        1, 1, 0, 0,
        1, 1, 1, 0,
        0, 1, 0, 1
    ],
    maxMessageBytes: 2000,
    pbkdf2Iterations: 200000,
    minRms: 0.008,
    detectionRatio: 1.20,
    /*
     * Quantos ms um tom precisa permanecer
     * estável antes de ser considerado um bit.
     */
    minBitStableMs: 22,
    //Confirmação do tom START.
    startConfirmMs: 100,
    // Confirmação do tom END.   
    endConfirmMs: 40
};
/* ======================================================
   ELEMENTOS HTML
====================================================== */
const passwordInput = document.getElementById("password");
const messageInput = document.getElementById("message");
const sendButton = document.getElementById("sendButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const clearButton = document.getElementById("clearButton");
const sendStatus = document.getElementById("sendStatus");
const receiveStatus = document.getElementById("receiveStatus");
const meter = document.getElementById("meter");
const messages = document.getElementById("messages");
const encryptionToggle = document.getElementById("encryptionToggle");
const encryptionHint = document.getElementById("encryptionHint");
const encryptionToggleText = document.getElementById("encryptionToggleText");
const frequency0Input = document.getElementById("frequency0");
const frequency1Input = document.getElementById("frequency1");
const startFrequencyInput = document.getElementById("startFrequency");
const endFrequencyInput = document.getElementById("endFrequency");
const bitDurationInput = document.getElementById("bitDuration");
const resetModemButton = document.getElementById("resetModemButton");
/* ======================================================
   ESTADO
====================================================== */
let audioContext = null;
let microphoneStream = null;
let analyser = null;
let microphoneSource = null;
let receiving = false;
let receiveBuffer = [];
let receiveTimer = null;
/* ======================================================
   UTILIDADES BINÁRIAS
====================================================== */
function concatUint8(...arrays) {
    const total = arrays.reduce(
        (sum, a) => sum + a.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const array of arrays) {
        result.set(array, offset);
        offset += array.length;
    }
    return result;
}

function numberToBytes(number, size) {
    const result = new Uint8Array(size);
    for (let i = size - 1; i >= 0; i--) {
        result[i] = number & 255;
        number = Math.floor(number / 256);
    }
    return result;
}

function bytesToNumber(bytes) {
    let number = 0;
    for (const byte of bytes) {
        number = number * 256 + byte;
    }
    return number;
}

function bytesToBits(bytes) {
    const bits = [];
    for (const byte of bytes) {
        for (let i = 7; i >= 0; i--) {
            bits.push(
                (byte >> i) & 1);
        }
    }
    return bits;
}

function bitsToBytes(bits) {
    const byteCount = Math.floor(bits.length / 8);
    const bytes = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i++) {
        let value = 0;
        for (let j = 0; j < 8; j++) {
            value = (value << 1) | bits[i * 8 + j];
        }
        bytes[i] = value;
    }
    return bytes;
}

function randomBytes(length) {
    const result = new Uint8Array(length);
    crypto.getRandomValues(result);
    return result;
}
/* ======================================================
   ABAS
====================================================== */
const tabButtons = document.querySelectorAll(".tab-button");
const tabPanels = document.querySelectorAll(".tab-panel");
tabButtons.forEach(button => {
    button.addEventListener("click", () => {
        const targetId = button.dataset.tab;
        tabButtons.forEach(tab => {
            tab.classList.remove("active");
        });
        tabPanels.forEach(panel => {
            panel.classList.remove("active");
        });
        button.classList.add("active");
        const targetPanel = document.getElementById(targetId);
        if (targetPanel) {
            targetPanel.classList.add("active");
        }
    });
});
/* ======================================================
   CONFIGURAÇÃO FSK
====================================================== */
const DEFAULT_MODEM = {
    frequency0: 1800,
    frequency1: 2400,
    startFrequency: 3500,
    endFrequency: 5000,
    bitDuration: 0.030
};

function updateModemInputs() {
    frequency0Input.value = MODEM.frequency0;
    frequency1Input.value = MODEM.frequency1;
    startFrequencyInput.value = MODEM.startFrequency;
    endFrequencyInput.value = MODEM.endFrequency;
    bitDurationInput.value = MODEM.bitDuration * 1000;
}

function updateModemFromInputs() {
    const frequency0 = Number(frequency0Input.value);
    const frequency1 = Number(frequency1Input.value);
    const startFrequency = Number(startFrequencyInput.value);
    const endFrequency = Number(endFrequencyInput.value);
    const bitDurationMs = Number(bitDurationInput.value);
    if (!Number.isFinite(frequency0) || frequency0 <= 0) {
        return;
    }
    if (!Number.isFinite(frequency1) || frequency1 <= 0) {
        return;
    }
    if (!Number.isFinite(startFrequency) || startFrequency <= 0) {
        return;
    }
    if (!Number.isFinite(endFrequency) || endFrequency <= 0) {
        return;
    }
    if (!Number.isFinite(bitDurationMs) || bitDurationMs <= 0) {
        return;
    }
    MODEM.frequency0 = frequency0;
    MODEM.frequency1 = frequency1;
    MODEM.startFrequency = startFrequency;
    MODEM.endFrequency = endFrequency;
    MODEM.bitDuration = bitDurationMs / 1000;
}

function resetModemConfiguration() {
    MODEM.frequency0 = DEFAULT_MODEM.frequency0;
    MODEM.frequency1 = DEFAULT_MODEM.frequency1;
    MODEM.startFrequency = DEFAULT_MODEM.startFrequency;
    MODEM.endFrequency = DEFAULT_MODEM.endFrequency;
    MODEM.bitDuration = DEFAULT_MODEM.bitDuration;
    updateModemInputs();
}
// Atualiza o MODEM quando altera os campos.
frequency0Input.addEventListener("change", updateModemFromInputs);
frequency1Input.addEventListener("change", updateModemFromInputs);
startFrequencyInput.addEventListener("change", updateModemFromInputs);
endFrequencyInput.addEventListener("change", updateModemFromInputs);
bitDurationInput.addEventListener("change", updateModemFromInputs);
resetModemButton.addEventListener("click", resetModemConfiguration);
updateModemInputs();
/* ======================================================
   CRIPTOGRAFIA
====================================================== */
function isEncryptionEnabled() {
    return encryptionToggle.checked;
}

function updateEncryptionUI() {
    const enabled = isEncryptionEnabled();
    passwordInput.disabled = !enabled;
    passwordInput.placeholder = enabled ? "Digite a senha compartilhada" : "Senha desativada";
    encryptionToggleText.textContent = enabled ? "🔒 Criptografia ativada" : "🔓 Criptografia desativada";
    encryptionHint.textContent = enabled ? "As mensagens serão criptografadas com AES-256-GCM." : "Criptografia desativada. A mensagem será transmitida sem criptografia.";
}
encryptionToggle.addEventListener("change", updateEncryptionUI);
updateEncryptionUI();
async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const passwordBytes = encoder.encode(password);
    const baseKey = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false,
        ["deriveKey"]);
    return crypto.subtle.deriveKey({
            name: "PBKDF2",
            salt: salt,
            iterations: MODEM.pbkdf2Iterations,
            hash: "SHA-256"
        }, baseKey, {
            name: "AES-GCM",
            length: 256
        }, false,
        ["encrypt", "decrypt"]);
}
async function encryptMessage(text, password) {
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(text);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(password, salt);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM",
        iv: iv
    }, key, plaintext));
    return {
        salt,
        iv,
        ciphertext
    };
}
async function decryptMessage(salt, iv, ciphertext, password) {
    const key = await deriveKey(password, salt);
    try {
        const plaintext = await crypto.subtle.decrypt({
            name: "AES-GCM",
            iv: iv
        }, key, ciphertext);
        return new TextDecoder().decode(plaintext);
    } catch (error) {
        throw new Error("Senha incorreta ou dados corrompidos.");
    }
}
/* ======================================================
   CRC32
====================================================== */
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ 0xedb88320;
            } else {
                crc >>>= 1;
            }
        }
    }
    return (
        (crc ^ 0xffffffff) >>> 0);
}
/* ======================================================
   CONSTRUÇÃO DO PACOTE
====================================================== */
async function createPacket(text, password) {
    if (!text) {
        throw new Error("Digite uma mensagem.");
    }
    const encryptionEnabled = isEncryptionEnabled();
    let salt = null;
    let iv = null;
    let payload;
    /* ==================================================
       CRIPTOGRAFADO
    ================================================== */
    if (encryptionEnabled) {
        if (!password) {
            throw new Error("Digite uma senha.");
        }
        const encrypted = await encryptMessage(text, password);
        salt = encrypted.salt;
        iv = encrypted.iv;
        payload = encrypted.ciphertext;
    }
    /* ==================================================
       SEM CRIPTOGRAFIA
    ================================================== */
    else {
        payload = new TextEncoder().encode(text);
    }
    if (payload.length > MODEM.maxMessageBytes) {
        throw new Error("Mensagem muito grande.");
    }
    /*
       HEADER BÁSICO:

       2 bytes = magic
       1 byte  = flags
       1 byte  = reservado
       2 bytes = tamanho payload
    */
    const flags = encryptionEnabled ? 0x01 : 0x00;
    const basicHeader = concatUint8(new Uint8Array([
        0x52,
        0x4D
    ]), new Uint8Array([
        flags
    ]), new Uint8Array([
        0x00
    ]), numberToBytes(payload.length, 2));
    /*
       Se estiver criptografado,
       adicionamos SALT + IV.

       Se não estiver criptografado,
       esses 28 bytes não existem no pacote.
    */
    const header = encryptionEnabled ? concatUint8(basicHeader, salt, iv) : basicHeader;
    const body = concatUint8(header, payload);
    const crc = crc32(body);
    const crcBytes = new Uint8Array(4);
    crcBytes[0] = (crc >>> 24) & 255;
    crcBytes[1] = (crc >>> 16) & 255;
    crcBytes[2] = (crc >>> 8) & 255;
    crcBytes[3] = crc & 255;
    return concatUint8(body, crcBytes);
}
/* ======================================================
   TRANSFORMA PACOTE EM BITS
====================================================== */
function packetToBits(packet) {
    const preamble = [];
    for (let i = 0; i < MODEM.preambleBits; i++) {
        preamble.push(i % 2);
    }
    const sync = MODEM.sync;
    const dataBits = bytesToBits(packet);
    return [...preamble, ...sync, ...dataBits];
}
/* ======================================================
   GERADOR DE ÁUDIO FSK
====================================================== */
function generateFSK(bits) {
    const sampleRate = MODEM.sampleRate;
    const samplesPerBit = Math.floor(sampleRate * MODEM.bitDuration);
    const startSamples = Math.floor(sampleRate * MODEM.startDuration);
    const endSamples = Math.floor(sampleRate * MODEM.endDuration);
    const totalSamples = startSamples + (samplesPerBit * bits.length) + endSamples;
    const audio = new Float32Array(totalSamples);
    let position = 0;
    let phase = 0;
    // Gera um trecho de áudio mantendo a fase contínua.
    function writeTone(frequency, sampleCount) {
        const phaseIncrement = 2 * Math.PI * frequency / sampleRate;
        for (let i = 0; i < sampleCount; i++) {
            audio[position++] = Math.sin(phase) * MODEM.amplitude;
            phase += phaseIncrement;
            if (phase >= Math.PI * 2) {
                phase -= Math.PI * 2;
            }
        }
    }
    // START 3500 Hz
    writeTone(MODEM.startFrequency, startSamples);
    // DADOS 1800 / 2400 Hz
    for (const bit of bits) {
        const frequency = bit ? MODEM.frequency1 : MODEM.frequency0;
        writeTone(frequency, samplesPerBit);
    }
    // END 5000 Hz
    writeTone(MODEM.endFrequency, endSamples);
    // Fade somente no início e no fim da transmissão inteira.
    const fadeSamples = Math.min(240, Math.floor(totalSamples / 20));
    for (let i = 0; i < fadeSamples; i++) {
        const factor = i / fadeSamples;
        audio[i] *= factor;
        audio[totalSamples - 1 - i] *= factor;
    }
    return audio;
}
/* ======================================================
   CRIA BUFFER DE ÁUDIO
====================================================== */
function createAudioBuffer(context, samples) {
    const buffer = context.createBuffer(1, samples.length, MODEM.sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
}
/* ======================================================
   TRANSMISSÃO
====================================================== */
async function transmit() {
    try {
        const password = passwordInput.value;
        const text = messageInput.value;
        sendButton.disabled = true;
        sendStatus.textContent = "Criptografando...";
        const packet = await createPacket(text, password);
        const bits = packetToBits(packet);
        sendStatus.textContent = `Transmitindo ${bits.length} bits...`;
        if (!audioContext) {
            audioContext = new(window.AudioContext || window.webkitAudioContext)({
                sampleRate: MODEM.sampleRate
            });
        }
        if (audioContext.state === "suspended") {
            await audioContext.resume();
        }
        const samples = generateFSK(bits);
        const buffer = createAudioBuffer(audioContext, samples);
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        /*
         * Gain para controlar volume.
         */
        const gain = audioContext.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(audioContext.destination);
        source.onended = () => {
            sendStatus.textContent = "✓ Transmissão concluída.";
            sendButton.disabled = false;
        };
        source.start();
    } catch (error) {
        console.error(error);
        sendStatus.textContent = "Erro: " + error.message;
        sendButton.disabled = false;
    }
}
/* ======================================================
   MICROFONE
====================================================== */
async function startMicrophone() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Seu navegador não suporta acesso ao microfone.");
        }
        receiveStatus.textContent = "Solicitando acesso ao microfone...";
        microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });
        audioContext = audioContext || new(window.AudioContext || window.webkitAudioContext)({
            sampleRate: MODEM.sampleRate
        });
        if (audioContext.state === "suspended") {
            await audioContext.resume();
        }
        microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0;
        microphoneSource.connect(analyser);
        receiving = true;
        console.clear();
        startButton.disabled = true;
        stopButton.disabled = false;
        receiveStatus.textContent = "🎤 Escutando...";
        processMicrophone();
    } catch (error) {
        console.error(error);
        receiveStatus.textContent = "Erro: " + error.message;
    }
}
/* ======================================================
   PARAR MICROFONE
====================================================== */
function stopMicrophone() {
    receiving = false;
    if (microphoneStream) {
        microphoneStream.getTracks().forEach(track => track.stop());
        microphoneStream = null;
    }
    if (microphoneSource) {
        microphoneSource.disconnect();
        microphoneSource = null;
    }
    if (receiveTimer) {
        cancelAnimationFrame(receiveTimer);
        receiveTimer = null;
    }
    resetDecoder();
    lastBitSampleTime = 0;
    startButton.disabled = false;
    stopButton.disabled = true;
    receiveStatus.textContent = "Microfone parado.";
    meter.style.width = "0%";
}
/* ======================================================
   ANÁLISE DE FREQUÊNCIA
====================================================== */
function detectFrequency() {
    if (!analyser) {
        return {
            frequency: 0,
            level: 0,
            power0: 0,
            power1: 0,
            powerStart: 0,
            powerEnd: 0
        };
    }
    const bufferLength = analyser.fftSize;
    const data = new Float32Array(bufferLength);
    analyser.getFloatTimeDomainData(data);
    /*
     * RMS
     */
    let sum = 0;
    for (const sample of data) {
        sum += sample * sample;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(100, rms * 400);
    /*
     * Silêncio
     */
    if (rms < MODEM.minRms) {
        return {
            frequency: 0,
            level,
            power0: 0,
            power1: 0,
            powerStart: 0,
            powerEnd: 0
        };
    }
    /*
     * Detecta todas as frequências.
     */
    const power0 = goertzel(data, MODEM.frequency0, MODEM.sampleRate);
    const power1 = goertzel(data, MODEM.frequency1, MODEM.sampleRate);
    const powerStart = goertzel(data, MODEM.startFrequency, MODEM.sampleRate);
    const powerEnd = goertzel(data, MODEM.endFrequency, MODEM.sampleRate);
    const powers = [{
        frequency: MODEM.frequency0,
        power: power0
    }, {
        frequency: MODEM.frequency1,
        power: power1
    }, {
        frequency: MODEM.startFrequency,
        power: powerStart
    }, {
        frequency: MODEM.endFrequency,
        power: powerEnd
    }];
    powers.sort(
        (a, b) => b.power - a.power);
    const strongest = powers[0];
    const second = powers[1];
    /*
     * Se a frequência dominante
     * não for suficientemente maior
     * que a segunda, tratamos como ruído.
     */
    if (second.power > 0 && strongest.power / second.power < MODEM.detectionRatio) {
        return {
            frequency: 0,
            level,
            power0,
            power1,
            powerStart,
            powerEnd
        };
    }
    return {
        frequency: strongest.frequency,
        level,
        power0,
        power1,
        powerStart,
        powerEnd
    };
}
/* ======================================================
   GOERTZEL
====================================================== */
function goertzel(samples, targetFrequency, sampleRate) {
    const k = Math.round(0.5 + (samples.length * targetFrequency / sampleRate));
    const omega = 2 * Math.PI * k / samples.length;
    const cosine = Math.cos(omega);
    const coeff = 2 * cosine;
    let q0 = 0;
    let q1 = 0;
    let q2 = 0;
    for (let i = 0; i < samples.length; i++) {
        q0 = coeff * q1 - q2 + samples[i];
        q2 = q1;
        q1 = q0;
    }
    return (q1 * q1 + q2 * q2 - coeff * q1 * q2);
}
/* ======================================================
   RECEPÇÃO
====================================================== */
let bitAccumulator = [];
let decoderState = "WAIT_START";
let currentBit = null;
let bitStartTime = 0;
let startToneStartTime = 0;
let endToneStartTime = 0;
let lastBitSampleTime = 0;
/* ======================================================
   RESET DO DECODIFICADOR
====================================================== */
function resetDecoder() {
    bitAccumulator = [];
    decoderState = "WAIT_START";
    currentBit = null;
    bitStartTime = 0;
    startToneStartTime = 0;
    endToneStartTime = 0;
}
/* ======================================================
   PROCESSAMENTO DO MICROFONE
====================================================== */
function processMicrophone() {
    if (!receiving) {
        return;
    }
    const now = performance.now();
    /*
     * Faz uma análise a cada aproximadamente
     * 8 ms.
     */
    if (now - lastBitSampleTime >= 8) {
        lastBitSampleTime = now;
        const result = detectFrequency();
        meter.style.width = result.level + "%";
        processDetectedSignal(result, now);
    }
    receiveTimer = requestAnimationFrame(processMicrophone);
}
/* ======================================================
   DECODIFICADOR
====================================================== */
function processDetectedSignal(result, now) {
    const frequency = result.frequency;
    /*
     * ==========================================
     * AGUARDANDO START
     * ==========================================
     */
    if (decoderState === "WAIT_START") {
        if (frequency === MODEM.startFrequency) {
            if (startToneStartTime === 0) {
                startToneStartTime = now;
            }
            const elapsed = now - startToneStartTime;
            receiveStatus.textContent = `📡 START ${Math.min(
                    100,
                    Math.round(
                        elapsed /
                        MODEM.startConfirmMs *
                        100
                    )
                )}%`;
            if (elapsed >= MODEM.startConfirmMs) {
                bitAccumulator = [];
                decoderState = "WAIT_FIRST_BIT";
                currentBit = null;
                bitStartTime = 0;
                startToneStartTime = 0;
            }
        } else {
            startToneStartTime = 0;
        }
        return;
    }
    /*
     * ==========================================
     * ESPERANDO PRIMEIRO BIT
     * ==========================================
     */
    if (decoderState === "WAIT_FIRST_BIT") {
        if (frequency === MODEM.frequency0 || frequency === MODEM.frequency1) {
            currentBit = frequency === MODEM.frequency1 ? 1 : 0;
            bitStartTime = now;
            decoderState = "READ_BITS";
            receiveStatus.textContent = currentBit === 1 ? "🔊 2400 Hz" : "🔊 1800 Hz";
        }
        return;
    }
    /*
     * ==========================================
     * LENDO BITS
     * ==========================================
     */
    if (decoderState === "READ_BITS") {
        /*
         * END
         */
        if (frequency === MODEM.endFrequency) {
            if (endToneStartTime === 0) {
                endToneStartTime = now;
            }
            /*
             * O END só é aceito depois
             * de permanecer estável.
             */
            if (now - endToneStartTime >= MODEM.endConfirmMs) {
                /*
                 * Commit do último bit,
                 * caso necessário.
                 */
                const elapsed = now - bitStartTime;
                if (elapsed >= MODEM.bitDuration * 1000 * 0.60) {
                    bitAccumulator.push(currentBit);
                }
                /*
                 * Tenta processar o pacote.
                 */
                searchForPacket();
                resetDecoder();
            }
            return;
        }
        /*
         * Se não for END, zeramos o contador.
         */
        endToneStartTime = 0;
        /*
         * ======================================
         * RELÓGIO DE BITS
         * ======================================
         *
         * O bit dura 40 ms.
         *
         * Mesmo que o próximo bit tenha
         * exatamente a mesma frequência,
         * devemos criar outro bit.
         */
        const elapsed = now - bitStartTime;
        if (elapsed >= MODEM.bitDuration * 1000) {
            /*
             * Adiciona o bit atual.
             */
            bitAccumulator.push(currentBit);
            /*
             * Avança exatamente uma duração
             * de bit, evitando acumular erro.
             */
            bitStartTime += MODEM.bitDuration * 1000;
            /*
             * Verifica se o pacote já pode
             * ser encontrado.
             */
            searchForPacket();
            /*
             * Lê a frequência atual para
             * descobrir o PRÓXIMO bit.
             */
            if (frequency === MODEM.frequency0) {
                currentBit = 0;
            } else if (frequency === MODEM.frequency1) {
                currentBit = 1;
            } else {
                /*
                 * Se nesse instante não
                 * houver uma frequência válida,
                 * mantemos o bit atual.
                 *
                 * A próxima leitura pode
                 * corrigir isso.
                 */
                console.warn("[MODEM] Frequência perdida durante bit.");
            }
            /*
             * A cada 8 bits mostra o byte.
             */
            if (bitAccumulator.length % 8 === 0) {
                const lastByte = bitsToBytes(bitAccumulator.slice(-8));
            }
            receiveStatus.textContent = currentBit === 1 ? `🎤 2400 Hz | ${result.level.toFixed(0)}%` : `🎤 1800 Hz | ${result.level.toFixed(0)}%`;
        }
    }
}
/* ======================================================
   PROCURA PACOTE
====================================================== */
function searchForPacket() {
    const sync = MODEM.sync;
    if (bitAccumulator.length < sync.length) {
        return;
    }
    for (let i = 0; i <= bitAccumulator.length - sync.length; i++) {
        let matches = true;
        for (let j = 0; j < sync.length; j++) {
            if (bitAccumulator[i + j] !== sync[j]) {
                matches = false;
                break;
            }
        }
        if (!matches) {
            continue;
        }
        const dataStart = i + sync.length;
        /*
         * ==================================================
         * HEADER BÁSICO
         *
         * 2 bytes = MAGIC
         * 1 byte  = FLAGS
         * 1 byte  = RESERVED
         * 2 bytes = LENGTH
         *
         * Total = 6 bytes
         * ==================================================
         */
        const basicHeaderBits = 6 * 8;
        if (bitAccumulator.length < dataStart + basicHeaderBits) {
            return;
        }
        const basicHeader = bitsToBytes(bitAccumulator.slice(dataStart, dataStart + basicHeaderBits));
        /*
         * ==================================================
         * MAGIC
         * ==================================================
         */
        if (basicHeader[0] !== 0x52 || basicHeader[1] !== 0x4D) {
            continue;
        }
        /*
         * ==================================================
         * FLAGS
         * ==================================================
         */
        const flags = basicHeader[2];
        const encryptionEnabled = (flags & 0x01) !== 0;
        /*
         * ==================================================
         * TAMANHO DO PAYLOAD
         * ==================================================
         */
        const payloadLength = bytesToNumber(basicHeader.slice(4, 6));
        if (payloadLength <= 0 || payloadLength > MODEM.maxMessageBytes) {
            continue;
        }
        /*
         * ==================================================
         * TAMANHO DO HEADER
         *
         * SEM CRIPTOGRAFIA:
         *
         * 6 bytes
         *
         * COM CRIPTOGRAFIA:
         *
         * 6 + 16 salt + 12 IV
         * = 34 bytes
         * ==================================================
         */
        const headerBytes = encryptionEnabled ? 34 : 6;
        const headerBits = headerBytes * 8;
        /*
         * ==================================================
         * AGUARDAR HEADER COMPLETO
         * ==================================================
         */
        if (bitAccumulator.length < dataStart + headerBits) {
            return;
        }
        /*
         * ==================================================
         * TAMANHO TOTAL DO PACOTE
         *
         * HEADER
         * + PAYLOAD
         * + CRC32
         * ==================================================
         */
        const totalBytes = headerBytes + payloadLength + 4;
        const totalBits = totalBytes * 8;
        /*
         * ==================================================
         * VERIFICAR SE O PACOTE ESTÁ COMPLETO
         * ==================================================
         */
        if (bitAccumulator.length < dataStart + totalBits) {
            return;
        }
        /*
         * ==================================================
         * EXTRAIR PACOTE COMPLETO
         * ==================================================
         */
        const packet = bitsToBytes(bitAccumulator.slice(dataStart, dataStart + totalBits));
        /*
         * Remove pacote já processado
         */
        bitAccumulator = bitAccumulator.slice(dataStart + totalBits);
        /*
         * Processa pacote
         */
        handlePacket(packet);
        return;
    }
}
/* ======================================================
   PROCESSAR PACOTE
====================================================== */
async function handlePacket(packet) {
    try {
        receiveStatus.textContent = "📦 Pacote recebido. Verificando...";
        /*
         * ==================================================
         * CRC
         * ==================================================
         */
        const dataWithoutCRC = packet.slice(0, packet.length - 4);
        const receivedCRC = bytesToNumber(packet.slice(packet.length - 4));
        const calculatedCRC = crc32(dataWithoutCRC);
        if (receivedCRC !== calculatedCRC) {
            throw new Error("CRC inválido.");
        }
        /*
         * ==================================================
         * MAGIC
         * ==================================================
         */
        if (packet[0] !== 0x52 || packet[1] !== 0x4D) {
            throw new Error("Magic inválido.");
        }
        /*
         * ==================================================
         * FLAGS
         * ==================================================
         */
        const flags = packet[2];
        const encryptionEnabled = (flags & 0x01) !== 0;
        /*
         * ==================================================
         * TAMANHO DO PAYLOAD
         * ==================================================
         */
        const payloadLength = bytesToNumber(packet.slice(4, 6));
        /*
         * ==================================================
         * HEADER
         * ==================================================
         */
        let salt = null;
        let iv = null;
        let payload;
        if (encryptionEnabled) {
            /*
             * Layout:
             *
             * 0-1   MAGIC
             * 2     FLAGS
             * 3     RESERVED
             * 4-5   LENGTH
             * 6-21  SALT
             * 22-33 IV
             * 34..  PAYLOAD
             */
            salt = packet.slice(6, 22);
            iv = packet.slice(22, 34);
            payload = packet.slice(34, packet.length - 4);
        } else {
            /*
             * Layout:
             *
             * 0-1   MAGIC
             * 2     FLAGS
             * 3     RESERVED
             * 4-5   LENGTH
             * 6..   PAYLOAD
             */
            payload = packet.slice(6, packet.length - 4);
        }
        /*
         * Verificação adicional do tamanho.
         */
        if (payload.length !== payloadLength) {
            throw new Error("Tamanho do payload inválido.");
        }
        /*
         * ==================================================
         * DESCRIPTOGRAFAR
         * ==================================================
         */
        let text;
        if (encryptionEnabled) {
            const password = passwordInput.value;
            if (!password) {
                throw new Error("Digite a senha para receber esta mensagem.");
            }
            text = await decryptMessage(salt, iv, payload, password);
        } else {
            text = new TextDecoder().decode(payload);
        }
        /*
         * ==================================================
         * MENSAGEM
         * ==================================================
         */
        addReceivedMessage(text);
        receiveStatus.textContent = encryptionEnabled ? "✓ Mensagem criptografada recebida com sucesso." : "✓ Mensagem recebida sem criptografia.";
    } catch (error) {
        receiveStatus.textContent = "⚠️ Pacote ignorado: " + error.message;
    }
}
/* ======================================================
   EXIBIR MENSAGEM
====================================================== */
function addReceivedMessage(text) {
    const empty = messages.querySelector(".empty");
    if (empty) {
        empty.remove();
    }
    const element = document.createElement("div");
    element.className = "message";
    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = new Date().toLocaleString("pt-BR");
    const content = document.createElement("div");
    content.textContent = text;
    element.appendChild(time);
    element.appendChild(content);
    messages.prepend(element);
}
/* ======================================================
   LIMPAR
====================================================== */
function clearMessages() {
    messages.innerHTML = `
        <div class="empty">
            Nenhuma mensagem recebida.
        </div>
    `;
}
/* ======================================================
   EVENTOS
====================================================== */
sendButton.addEventListener("click", transmit);
startButton.addEventListener("click", startMicrophone);
stopButton.addEventListener("click", stopMicrophone);
clearButton.addEventListener("click", clearMessages);
/* ======================================================
   INICIALIZAÇÃO
====================================================== */
window.addEventListener("beforeunload", stopMicrophone);
/* ======================================================
   Service Worker
====================================================== */
if ("serviceWorker" in navigator) {

    window.addEventListener("load", () => {

        navigator.serviceWorker.register("./sw.js")
            .then(() => {
                console.log(
                    "[PWA] Service Worker registrado."
                );
            })
            .catch(error => {
                console.error(
                    "[PWA] Erro:",
                    error
                );
            });

    });
}