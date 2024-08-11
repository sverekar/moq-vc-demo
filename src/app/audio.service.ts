import { Injectable } from '@angular/core';
import { CicularAudioSharedBuffer, VideoRenderBuffer } from './common';

@Injectable({
  providedIn: 'root'
})
export class AudioService {

  private audioCtxMap: Map<number, AudioContext> = new Map();

  async init(desiredSampleRate: number): Promise<AudioContext> {
    let audioCtx = this.audioCtxMap.get(desiredSampleRate);
    if (!audioCtx) {
      audioCtx = new AudioContext({ latencyHint: "interactive", sampleRate: desiredSampleRate });
      await audioCtx.audioWorklet.addModule('../assets/js/render/source_buffer_worklet.js')
      this.audioCtxMap.set(desiredSampleRate, audioCtx);
    }
    return audioCtx
  }

  getAudioContext(desiredSampleRate: number): AudioContext | undefined {
    return this.audioCtxMap.get(desiredSampleRate);
  }

}
