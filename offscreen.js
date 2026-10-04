let audioCtx;
let oscillator;

function startAudioKeepAlive() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    // Volume a zero (silenzioso)
    gainNode.gain.value = 0;

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.start();
    console.log("[Offscreen] Web Audio API Keep-Alive avviato.");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target === 'offscreen' && msg.type === 'START_KEEP_ALIVE') {
        startAudioKeepAlive();
        sendResponse(true);
    }
});

// Avvia automaticamente appena creato
startAudioKeepAlive();
