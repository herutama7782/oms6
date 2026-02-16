/**
 * Initializes the AudioContext. Must be called after a user interaction.
 */
export function initAudioContext() {
    if (!window.app.audioContext) {
        try {
            window.app.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.error("Web Audio API is not supported in this browser");
        }
    }
}

/**
 * Memainkan satu nada audio pada waktu yang ditentukan.
 * @param {number} frequency - Frekuensi nada (Hz).
 * @param {number} duration - Durasi nada (detik).
 * @param {number} volume - Volume (0.0 hingga 1.0).
 * @param {string} waveType - Tipe gelombang ('sine', 'square', 'sawtooth', 'triangle').
 */
export function playTone(frequency, duration, volume, waveType) {
    if (!window.app.audioContext) {
        console.warn("AudioContext not initialized. Cannot play tone.");
        return;
    }

    try {
        // 1. Buat Oscillator (sumber suara)
        const oscillator = window.app.audioContext.createOscillator();
        // 2. Buat Gain Node (kontrol volume)
        const gainNode = window.app.audioContext.createGain();

        // 3. Hubungkan Node: Oscillator -> Gain -> Output Speaker
        oscillator.connect(gainNode);
        gainNode.connect(window.app.audioContext.destination);

        // Pengaturan
        oscillator.type = waveType;
        oscillator.frequency.value = frequency;
        gainNode.gain.setValueAtTime(volume, window.app.audioContext.currentTime);

        // Memulai dan Menghentikan oscillator pada waktu yang dijadwalkan
        const startTime = window.app.audioContext.currentTime;
        oscillator.start(startTime);
        oscillator.stop(startTime + duration);

    } catch (error) {
        console.error("Error playing tone:", error);
    }
}
