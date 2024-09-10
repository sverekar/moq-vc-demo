import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AudioService {

  private audioCtx: AudioContext | null = null;
  private isModuleLoaded: boolean = false;

  constructor() { }

  getAudioCtx () {
    return this.audioCtx;
  }
  setAudioCtx (audioCtx: AudioContext) {
    this.audioCtx = audioCtx;
  }
}
