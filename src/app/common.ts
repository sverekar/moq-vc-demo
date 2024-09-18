const MAX_ELEMENTS_RENDERER = 60

export class VideoRenderBuffer {

  elementsList: Array<{ vFrame: VideoFrame, captureClkms: number}>;
  totalDiscarded: any;
  totalLengthMs: any;
  onlyVideo: boolean;

  constructor (onlyVideo?: boolean) {
    this.elementsList = []
    this.totalDiscarded = 0
    this.totalLengthMs = 0;
    if (onlyVideo === undefined) {
      this.onlyVideo = false;
    } else {
      this.onlyVideo = onlyVideo;
    }
  }

  AddItem (vFrame: any, captureClkms: number) {
    let r = true
    if (this.elementsList.length < MAX_ELEMENTS_RENDERER) {
      // Add at the end (ordered by timestamp)
      this.elementsList.push({vFrame, captureClkms})
      this.totalLengthMs += vFrame.duration / 1000
    } else {
      r = false
    }
    return r
  }

  GetFirstElement () {
    const ret = { vFrame: null, discarded: 0, totalDiscarded: 0, queueSize: this.elementsList.length, queueLengthMs: this.totalLengthMs, clkms: null }
    if (this.elementsList.length > 0) {
      const v = this.elementsList.shift();
      ret.vFrame = v!.vFrame as any;
      ret.clkms = v!.captureClkms as any;
      this.totalLengthMs -= (ret.vFrame as any).duration / 1000
      ret.queueSize = this.elementsList.length
      ret.queueLengthMs = this.totalLengthMs
    }

    return ret
  }

  GetItemByTs (ts: any) {
    const ret = { vFrame: null, discarded: 0, totalDiscarded: this.totalDiscarded, queueSize: this.elementsList.length, queueLengthMs: this.totalLengthMs, clkms: null }

    if (this.elementsList.length <= 0 || ts < this.elementsList[0].vFrame.timestamp) {
      return ret
    }

    let exit = false
    let lastFrameInThePastIndex = 0
    while ((lastFrameInThePastIndex < this.elementsList.length) && (exit === false)) {
      if (this.elementsList[lastFrameInThePastIndex].vFrame.timestamp >= ts) {
        exit = true
      } else {
        lastFrameInThePastIndex++
      }
    }

    // Remove items from 0..(lastFrameInThePastIndex-1)
    for (let n = 0; n < (lastFrameInThePastIndex - 1); n++) {
      const v = this.elementsList.shift()
      const vFrame = v!.vFrame as any
      ret.discarded++
      this.totalLengthMs -= vFrame.duration / 1000
      vFrame.close()
    }

    if (this.elementsList.length > 0) {
      const v = this.elementsList.shift()
      ret.vFrame = v!.vFrame as any;
      ret.clkms = v!.captureClkms as any;
      this.totalLengthMs -= (ret.vFrame as any).duration / 1000
    }

    this.totalDiscarded += ret.discarded
    ret.totalDiscarded = this.totalDiscarded
    ret.queueSize = this.elementsList.length
    ret.queueLengthMs = this.totalLengthMs

    return ret
  }

  Clear () {
    while (this.elementsList.length > 0) {
      const v = this.elementsList.shift()
      v!.vFrame.close()
    }
    this.totalLengthMs = 0
    this.totalDiscarded = 0
    this.elementsList = []
  }
}

const SharedStates = {
  AUDIO_BUFF_START: 0, // The reader only modifies this pointer
  AUDIO_BUFF_END: 1, // The writer (this) only modifies this pointer

  AUDIO_INSERTED_SILENCE_MS: 2,

  IS_PLAYING: 3 // Indicates playback state
}

// Keep only last 30 audio frames in the TS index
const MAX_ITEMS_IN_TS_INDEX = 30

export class CicularAudioSharedBuffer {

  sampleIndexToTS: any;
  sharedAudiobuffers: any;
  sharedCommBuffer: any;
  size: any;
  contextFrequency: any;
  sharedStates: any;
  onDropped: any;
  lastTimestamp: any;

  constructor () {
    this.sampleIndexToTS = null // In Us
    this.sharedAudiobuffers = null
    this.sharedCommBuffer = new SharedArrayBuffer(Object.keys(SharedStates).length * Int32Array.BYTES_PER_ELEMENT)
    this.size = -1
    this.contextFrequency = -1

    // Get TypedArrayView from SAB.
    this.sharedStates = new Int32Array(this.sharedCommBuffer)

    this.onDropped = null

    // Initialize |States| buffer.
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, -1)
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, -1)
    Atomics.store(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS, 0)

    // Last sent timestamp
    this.lastTimestamp = undefined
  }

  SetCallbacks (onDropped: any) {
    this.onDropped = onDropped
  }

  Init (numChannels: any, numSamples: any, contextFrequency: any) {
    if (this.sharedAudiobuffers != null) {
      throw new Error('Already initialized')
    }
    if ((numChannels <= 0) || (numChannels === undefined)) {
      throw new Error('Passed bad numChannels')
    }
    if ((numSamples <= 0) || (numSamples === undefined)) {
      throw new Error('Passed bad numSamples')
    }
    this.sharedAudiobuffers = []
    for (let c = 0; c < numChannels; c++) {
      this.sharedAudiobuffers.push(new SharedArrayBuffer(numSamples * Float32Array.BYTES_PER_ELEMENT))
    }

    this.contextFrequency = contextFrequency
    this.lastTimestamp = -1

    this.size = numSamples
    this.sampleIndexToTS = []

    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, 0)
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, 0)
  }

  Add (aFrame: any, overrideFrameTs: any) {
    const frameTimestamp = (overrideFrameTs === undefined) ? aFrame.timestamp : overrideFrameTs
    if (aFrame === undefined) {
      throw new Error('Passed undefined aFrame')
    }
    if (aFrame.numberOfChannels !== this.sharedAudiobuffers.length) {
      throw new Error(`Channels diffent than expected, expected ${this.sharedAudiobuffers.length}, passed: ${aFrame.numberOfChannels}`)
    }
    if (aFrame.sampleRate !== this.contextFrequency) {
      throw new Error('Error sampling frequency received does NOT match local audio renderer. sampleFrequency: ' + aFrame.sampleRate + ', contextSampleFrequency: ' + this.contextFrequency)
    }

    const samplesToAdd = aFrame.numberOfFrames

    const start = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_START)
    let end = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_END)

    if (samplesToAdd > this._getFreeSlots(start, end)) {
      if (this.onDropped != null) {
        this.onDropped({ clkms: Date.now(), mediaType: 'audio', ts: frameTimestamp, msg: 'Dropped PCM audio frame, ring buffer full' })
      }
    } else {
      // This will always return recent TS. This is a cicular buffer, we are indexing with numsample in the buffer, so things will get messy if we do not ask for GetStats for more than buffer size. And this happens when tab loses focus
      this._cleanUpIndex()
      this.sampleIndexToTS.push({ sampleIndex: end, ts: frameTimestamp })
      if (end + samplesToAdd <= this.size) {
        // All
        for (let c = 0; c < aFrame.numberOfChannels; c++) {
          const outputRingBuffer = new Float32Array(this.sharedAudiobuffers[c], (end as any) * Float32Array.BYTES_PER_ELEMENT)
          aFrame.copyTo(outputRingBuffer, { planeIndex: c, frameOffset: 0, frameCount: samplesToAdd })
        }
        end += samplesToAdd
      } else {
        const samplesToAddFirstHalf = this.size - end
        const samplesToAddSecondsHalf = samplesToAdd - samplesToAddFirstHalf
        for (let c = 0; c < aFrame.numberOfChannels; c++) {
          // First half
          const outputRingBuffer1 = new Float32Array(this.sharedAudiobuffers[c], (end as any) * Float32Array.BYTES_PER_ELEMENT, samplesToAddFirstHalf as any)
          aFrame.copyTo(outputRingBuffer1, { planeIndex: c, frameOffset: 0, frameCount: samplesToAddFirstHalf })

          // Second half
          const outputRingBuffer2 = new Float32Array(this.sharedAudiobuffers[c], 0, samplesToAddSecondsHalf as any)
          aFrame.copyTo(outputRingBuffer2, { planeIndex: c, frameOffset: samplesToAddFirstHalf, frameCount: samplesToAddSecondsHalf })
        }
        end = samplesToAddSecondsHalf
      }
      aFrame.close();
    }
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, end)
  }

  GetStats (): any {
    const start = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_START) // Reader
    const end = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_END) // Writer

    // Find the last sent timestamp
    let retIndexTs
    let n = 0
    let bExit = false
    while (n < this.sampleIndexToTS.length && !bExit) {
      if (this._isSentSample(this.sampleIndexToTS[n].sampleIndex, start, end)) {
        retIndexTs = n
      } else {
        if (retIndexTs !== undefined) {
          bExit = true
        }
      }
      n++
    }
    if (retIndexTs !== undefined) {
      const lastFrameTimestampSent = this.sampleIndexToTS[retIndexTs].ts
      const extraSamplesSent = start - this.sampleIndexToTS[retIndexTs].sampleIndex

      // Adjust at sample level
      // Assume ts in nanosec
      this.lastTimestamp = lastFrameTimestampSent + (extraSamplesSent as any * 1000 * 1000) / this.contextFrequency

      // Remove old indexes (already sent)
      this.sampleIndexToTS = this.sampleIndexToTS.slice(retIndexTs + 1)
    }

    const sizeSamples = this._getUsedSlots(start, end)
    const sizeMs = Math.floor((sizeSamples * 1000) / this.contextFrequency)
    const totalSilenceInsertedMs = Atomics.load(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS)
    const isPlaying = Atomics.load(this.sharedStates, SharedStates.IS_PLAYING)

    return { currentTimestamp: this.lastTimestamp, queueSize: sizeSamples, queueLengthMs: sizeMs, totalSilenceInsertedMs, isPlaying }
  }

  Play () {
    Atomics.store(this.sharedStates, SharedStates.IS_PLAYING, 1)
  }

  Stop () {
    Atomics.store(this.sharedStates, SharedStates.IS_PLAYING, 0)
  }

  GetSharedBuffers () {
    if (this.sharedAudiobuffers === null) {
      throw new Error('Not initialized yet')
    }
    return { sharedAudiobuffers: this.sharedAudiobuffers, sharedCommBuffer: this.sharedCommBuffer }
  }

  Clear () {
    this.sharedAudiobuffers = null
    this.size = -1
    this.sampleIndexToTS = null
    this.contextFrequency = -1
    this.lastTimestamp = undefined

    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, -1)
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, -1)
    Atomics.store(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS, 0)
    Atomics.store(this.sharedStates, SharedStates.IS_PLAYING, 0)
  }

  _cleanUpIndex() {
    if (this.sampleIndexToTS == null) {
      return
    }
    while (this.sampleIndexToTS.length > MAX_ITEMS_IN_TS_INDEX) {
      this.sampleIndexToTS.shift()
    }
  }

  _getUsedSlots (start: any, end: any) {
    if (start === end) {
      return 0
    } else if (end > start) {
      return end - start
    } else {
      return (this.size - start) + end
    }
  }

  _getFreeSlots (start: any, end: any) {
    return this.size - this._getUsedSlots(start, end)
  }

  _isSentSample (index: any, start: any, end: any) {
    if (start === end) {
      return false
    } else if (end > start) {
      return index <= start
    } else {
      return (index <= start && index > end)
    }
  }
}

export function cosineDistanceBetweenPoints(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3;
  const p1 = lat1 * Math.PI/180;
  const p2 = lat2 * Math.PI/180;
  const deltaP = p2 - p1;
  const deltaLon = lon2 - lon1;
  const deltaLambda = (deltaLon * Math.PI) / 180;
  const a = Math.sin(deltaP/2) * Math.sin(deltaP/2) +
            Math.cos(p1) * Math.cos(p2) *
            Math.sin(deltaLambda/2) * Math.sin(deltaLambda/2);
  const d = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * R;
  return d;
}

export class MediaStreamTrackProcessor {
  //@ts-ignore
  constructor({track}) {
    if (track.kind == "video") {
      //@ts-ignore
      this.readable = new ReadableStream({
        async start(controller) {
          //@ts-ignore
          this.video = document.createElement("video");
          //@ts-ignore
          this.video.srcObject = new MediaStream([track]);
          //@ts-ignore
          await Promise.all([this.video.play(), new Promise(r => this.video.onloadedmetadata = r)]);
          //@ts-ignore
          this.track = track;
          //@ts-ignore
          this.canvas = new OffscreenCanvas(this.video.videoWidth, this.video.videoHeight);
          //@ts-ignore
          this.ctx = this.canvas.getContext('2d', { desynchronized: true });
          //@ts-ignore
          this.t1 = performance.now();
        },
        async pull(controller) {
          //@ts-ignore
          while (performance.now() - this.t1 < 1000 / track.getSettings().frameRate) {
            await new Promise(r => requestAnimationFrame(r));
          }
          //@ts-ignore
          this.t1 = performance.now();
          //@ts-ignore
          this.ctx.drawImage(this.video, 0, 0);
          //@ts-ignore
          controller.enqueue(new VideoFrame(this.canvas, { timestamp: this.t1 * 1000 }));
        }
      });
    } else if (track.kind == "audio") {
      //@ts-ignore
      this.readable = new ReadableStream({
        async start(controller) {
          //@ts-ignore
          this.ac = new AudioContext;
          //@ts-ignore
          this.buffered = [];
          function worklet() {
            //@ts-ignore
            registerProcessor("mstp-shim", class Processor extends AudioWorkletProcessor {
              //@ts-ignore
                process(input) { this.port.postMessage(input); return true; }
            });
          }
          //@ts-ignore
          await this.ac.audioWorklet.addModule(`data:text/javascript,(${worklet.toString()})()`);
          //@ts-ignore
          this.node = new AudioWorkletNode(this.ac, "mstp-shim");
          //@ts-ignore
          this.ac.createMediaStreamSource(new MediaStream([track])).connect(this.node);
          //@ts-ignore
          this.node.port.addEventListener("message", ({data}) => data[0][0] && this.buffered.push(data));
        },
        async pull(controller) {
          //@ts-ignore
          while (!this.buffered.length) await new Promise(r => this.node.port.onmessage = r);
          //@ts-ignore
          const [channels] = this.buffered.shift();
          //@ts-ignore
          const joined = new Float32Array(channels.reduce((a, b) => a + b.length, 0));
          //@ts-ignore
          channels.reduce((offset, a) => (joined.set(a, offset), offset + a.length), 0);
          //@ts-ignore
          controller.enqueue(new AudioData({
            format: "f32-planar",
            //@ts-ignore
            sampleRate: this.ac.sampleRate,
            numberOfFrames: channels[0].length,
            numberOfChannels:  channels.length,
            //@ts-ignore
            timestamp: this.ac.currentTime * 1e6 | 0,
            data: joined
          }));
        }
      });
    }
  }
};
