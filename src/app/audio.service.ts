import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AudioService {

  private audioCtx: AudioContext | undefined = undefined;

  async init(desiredSampleRate: number) {
    this.audioCtx = new AudioContext({ latencyHint: "interactive", sampleRate: desiredSampleRate });
    await this.audioCtx.audioWorklet.addModule('../assets/js/render/source_buffer_worklet.js')
  }

  getAudioContext(): AudioContext | undefined {
    return this.audioCtx;
  }

  async close() {
    await this.audioCtx!.close()
    this.audioCtx = undefined;
  }
}
