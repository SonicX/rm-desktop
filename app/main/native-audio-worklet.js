// Native-audio-worklet.js - AudioWorklet processor for native audio
// This runs in the AudioWorklet thread

class NativeAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioQueue = [];
    this.sampleRate = 48_000;
    this.channels = 2;
    this.samplesPerFrame = 960; // 20ms at 48kHz

    // Receive audio data from main thread
    this.port.addEventListener("message", (event) => {
      if (event.data.type === "audio") {
        // Event.data.samples is Float32Array with interleaved stereo
        this.audioQueue.push(event.data.samples);
      } else if (event.data.type === "config") {
        this.sampleRate = event.data.sampleRate ?? 48_000;
        this.channels = event.data.channels ?? 2;
      }
    });
  }

  process(inputs, outputs, _parameters) {
    const output = outputs[0];
    const leftChannel = output[0];
    const rightChannel = output[1];

    if (!leftChannel) return true;

    const frameSamples = leftChannel.length; // Usually 128 samples

    // If we have queued audio, use it
    if (this.audioQueue.length > 0) {
      const audioData = this.audioQueue[0];

      // De-interleave stereo to separate channels
      for (let i = 0; i < frameSamples; i++) {
        const sourceIndex = i * 2;
        if (sourceIndex < audioData.length) {
          leftChannel[i] = audioData[sourceIndex];
          if (rightChannel && sourceIndex + 1 < audioData.length) {
            rightChannel[i] = audioData[sourceIndex + 1];
          }
        } else {
          leftChannel[i] = 0;
          if (rightChannel) rightChannel[i] = 0;
        }
      }

      // Remove used samples from the buffer
      const usedSamples = frameSamples * 2; // Stereo
      if (usedSamples >= audioData.length) {
        this.audioQueue.shift();
      } else {
        this.audioQueue[0] = audioData.slice(usedSamples);
      }
    } else {
      // No audio available - output silence
      for (let i = 0; i < frameSamples; i++) {
        leftChannel[i] = 0;
        if (rightChannel) rightChannel[i] = 0;
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor("native-audio-processor", NativeAudioProcessor); // ESM export for AudioWorklet
