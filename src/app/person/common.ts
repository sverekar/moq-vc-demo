

export class TimeBufferChecker {

  mediaType: any;
  elementsList: Array<any>
  isVerbose: boolean;

  constructor (mediaType: string, isVerbose?: boolean | undefined) {
    this.mediaType = mediaType
    this.elementsList = []
    this.isVerbose = false
    if (isVerbose === true) {
      this.isVerbose = true
    }
  }

  AddItem (item: any) {
    if (('ts' in item) && ('clkms' in item)) {
      // Add at the end
      this.elementsList.push(item)
      if (this.isVerbose) {
        console.log(`TimeBufferChecker[${this.mediaType}] Added item: ${JSON.stringify(item)}, list: ${JSON.stringify(this.elementsList)}`)
      }
    }
  }

  GetItemByTs (ts: number, useExact: boolean) {
    let ret = { valid: false, ts: -1, compensatedTs: -1, estimatedDuration: -1, clkms: -1 }
    let i = 0
    let indexPastTs = -1
    let removedElements = 0

    // elementsList is sorted by arrival order
    while (i < this.elementsList.length) {
      if (useExact === true) {
        if (this.elementsList[i].ts === ts) {
          indexPastTs = i
        }
      } else {
        if (ts >= this.elementsList[i].ts) {
          indexPastTs = i
        } else if (ts < this.elementsList[i].ts) {
          break
        }
      }
      i++
    }
    if (indexPastTs >= 0) {
      ret = this.elementsList[indexPastTs]
      ret.valid = true
      removedElements = Math.min(indexPastTs + 1, this.elementsList.length)
      this.elementsList = this.elementsList.slice(indexPastTs + 1)
    }
    if (this.isVerbose) {
      console.log(`TimeBufferChecker[${this.mediaType}] removedElements: ${removedElements}, elements list: ${this.elementsList.length}, retTs: ${(ret === undefined) ? 'undefined' : JSON.stringify(ret)}, asked: ${ts}, list: ${JSON.stringify(this.elementsList)}`)
    }

    return ret
  }

  Clear () {
    this.elementsList = []
  }
}

const MAX_ELEMENTS_RENDERER = 600

export class VideoRenderBuffer {

  elementsList: Array<any>;
  totalDiscarded: number;
  totalLengthMs: number;

  constructor () {
    this.elementsList = []
    this.totalDiscarded = 0
    this.totalLengthMs = 0
  }

  AddItem (vFrame: any) {
    let r = true
    if (this.elementsList.length < MAX_ELEMENTS_RENDERER) {
      // Add at the end (ordered by timestamp)
      this.elementsList.push(vFrame)
      this.totalLengthMs += vFrame.duration / 1000
    } else {
      r = false
    }
    return r;
  }

  GetFirstElement () {
    const ret = { vFrame: null, discarded: 0, totalDiscarded: 0, queueSize: this.elementsList.length, queueLengthMs: this.totalLengthMs }
    if (this.elementsList.length > 0) {
      ret.vFrame = this.elementsList.shift();
      this.totalLengthMs -= (ret.vFrame as any).duration / 1000
      ret.queueSize = this.elementsList.length
      ret.queueLengthMs = this.totalLengthMs
    }

    return ret
  }

  GetItemByTs (ts: any) {
    const ret = { vFrame: null, discarded: 0, totalDiscarded: this.totalDiscarded, queueSize: this.elementsList.length, queueLengthMs: this.totalLengthMs }
    let exit = false
    let lastFrameInThePastIndex = 0
    while ((lastFrameInThePastIndex < this.elementsList.length) && (exit === false)) {
      const vFrameFirstTimestamp = this.elementsList[lastFrameInThePastIndex].timestamp
      if (vFrameFirstTimestamp > ts) {
        exit = true
      } else {
        lastFrameInThePastIndex++
      }
    }

    for (let n = 0; n < lastFrameInThePastIndex - 1; n++) {
      const vFrame = this.elementsList.shift()
      ret.discarded++
      this.totalLengthMs -= vFrame.duration / 1000
      vFrame.close()
    }

    if (this.elementsList.length > 0 && lastFrameInThePastIndex > 0) {
      ret.vFrame = this.elementsList.shift()
      this.totalLengthMs -= ret.vFrame.duration / 1000
    }

    this.totalDiscarded += ret.discarded
    ret.totalDiscarded = this.totalDiscarded
    ret.queueSize = this.elementsList.length
    ret.queueLengthMs = this.totalLengthMs
    return ret
  }

  Clear () {
    while (this.elementsList.length > 0) {
      const vFrame = this.elementsList.shift()
      vFrame.close()
    }
    this.totalLengthMs = 0
    this.totalDiscarded = 0
  }
}

const DEFAULT_BUFFER_SIZE_MS = 200

export class JitterBuffer {

  bufferSizeMs: number;
  elementsList: Array<any>;
  droppedCallback: any;
  totalLengthMs: number;
  numTotalGaps: number;
  numTotalLostStreams: number;
  lastCorrectSeqId: number | undefined;

  constructor (maxSizeMs: number, droppedCallback: any) {
    this.bufferSizeMs = DEFAULT_BUFFER_SIZE_MS
    if (maxSizeMs !== undefined && maxSizeMs > 0) {
      this.bufferSizeMs = maxSizeMs
    }
    this.elementsList = []

    this.droppedCallback = droppedCallback
    this.totalLengthMs = 0
    this.numTotalGaps = 0
    this.numTotalLostStreams = 0
    this.lastCorrectSeqId = undefined
  }

  AddItem (chunk: any, seqId:number, extraData: any) {
    let r
    // Order by SeqID
    if (this.elementsList.length <= 0) {
      this.elementsList.push({ chunk, seqId, extraData })
      this.totalLengthMs += chunk.duration / 1000
    } else {
      // Anything later than 1st element will be dropped
      if (seqId <= this.elementsList[0].seqId) {
        // Arrived late to jitter buffer -> drop
        if (this.droppedCallback !== undefined) {
          this.droppedCallback({ seqId, firstBufferSeqId: this.elementsList[0].seqId })
        }
      } else {
        let n = 0
        let exit = false
        while ((n < this.elementsList.length) && (!exit)) {
          if (seqId < this.elementsList[n].seqId) {
            this.elementsList.splice(n, 0, { chunk, seqId, extraData })
            exit = true
          }
          n++
        }
        if (exit === false) {
          this.elementsList.push({ chunk, seqId, extraData })
        }
        this.totalLengthMs += chunk.duration / 1000
      }
    }

    // Get 1st element if jitter buffer full
    if (this.totalLengthMs >= this.bufferSizeMs) {
      r = this.elementsList.shift()

      // Check for discontinuities in the stream
      r.isDisco = false
      r.repeatedOrBackwards = false
      if (r.seqId >= 0) { // Init is -1
        if (this.lastCorrectSeqId !== undefined) {
          if (this.lastCorrectSeqId + 1 !== r.seqId) {
            r.isDisco = true
            this.numTotalGaps++
            this.numTotalLostStreams += Math.abs(r.seqId - this.lastCorrectSeqId)

            // Check for repeated and backwards seqID
            if (r.seqId <= this.lastCorrectSeqId) {
              r.repeatedOrBackwards = true
            } else {
              this.lastCorrectSeqId = r.seqId
            }
          } else {
            this.lastCorrectSeqId = r.seqId
          }
        } else {
          this.lastCorrectSeqId = r.seqId
        }
      }
      this.totalLengthMs -= r.chunk.duration / 1000
    }
    return r
  }

  GetStats () {
    return { numTotalGaps: this.numTotalGaps, numTotalLostStreams: this.numTotalLostStreams, totalLengthMs: this.totalLengthMs, size: this.elementsList.length, currentMaSizeMs: this.bufferSizeMs }
  }

  Clear () {
    this.elementsList = []
    this.totalLengthMs = 0
    this.numTotalGaps = 0
    this.numTotalLostStreams = 0
    this.lastCorrectSeqId = undefined
  }

  UpdateMaxSize(bufferSizeMs: number) {
    if (bufferSizeMs > 0) {
      this.bufferSizeMs = bufferSizeMs;
    }
  }
}


/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// const SharedStates = {
//   AUDIO_BUFF_START: 0, // The reader only modifies this pointer
//   AUDIO_BUFF_END: 1, // The writer (this) only modifies this pointer
//   AUDIO_INSERTED_SILENCE_MS: 2,
//   IS_PLAYING: 3 // Indicates playback state
// }

// export class CicularAudioSharedBuffer {

//   sampleIndexToTS: any;
//   sharedAudiobuffers: any;
//   sharedCommBuffer: any;
//   size: number;
//   contextFrequency: number;
//   sharedStates: Int32Array;
//   onDropped: any;
//   lastTimestamp: any;

//   constructor () {
//     this.sampleIndexToTS = null // In Us
//     this.sharedAudiobuffers = null
//     this.sharedCommBuffer = new SharedArrayBuffer(Object.keys(SharedStates).length * Int32Array.BYTES_PER_ELEMENT)
//     this.size = -1

//     this.contextFrequency = -1

//     // Get TypedArrayView from SAB.
//     this.sharedStates = new Int32Array(this.sharedCommBuffer)

//     this.onDropped = null

//     // Initialize |States| buffer.
//     Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, -1)
//     Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, -1)
//     Atomics.store(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS, 0)

//     // Last sent timestamp
//     this.lastTimestamp = undefined
//   }

//   SetCallbacks (onDropped: any) {
//     this.onDropped = onDropped
//   }

//   Init (numChannels: any, numSamples: any, contextFrequency: any) {
//     if (this.sharedAudiobuffers != null) {
//       throw new Error('Already initialized')
//     }
//     if ((numChannels <= 0) || (numChannels === undefined)) {
//       throw new Error('Passed bad numChannels')
//     }
//     if ((numSamples <= 0) || (numSamples === undefined)) {
//       throw new Error('Passed bad numSamples')
//     }
//     this.sharedAudiobuffers = []
//     for (let c = 0; c < numChannels; c++) {
//       this.sharedAudiobuffers.push(new SharedArrayBuffer(numSamples * Float32Array.BYTES_PER_ELEMENT))
//     }

//     this.contextFrequency = contextFrequency
//     this.lastTimestamp = -1

//     this.size = numSamples
//     this.sampleIndexToTS = []

//     Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, 0)
//     Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, 0)
//   }

//   Add (aFrame: any, overrideFrameTs: any) {
//     const frameTimestamp = (overrideFrameTs === undefined) ? aFrame.timestamp : overrideFrameTs
//     if (aFrame === undefined) {
//       throw new Error('Passed undefined aFrame')
//     }
//     if (aFrame.numberOfChannels !== this.sharedAudiobuffers.length) {
//       throw new Error(`Channels diffent than expected, expected ${this.sharedAudiobuffers.length}, passed: ${aFrame.numberOfChannels}`)
//     }
//     if (aFrame.sampleRate !== this.contextFrequency) {
//       throw new Error('Error sampling frequency received does NOT match local audio renderer. sampleFrequency: ' + this.sampleFrequency + ', contextSampleFrequency: ' + this.contextSampleFrequency)
//     }

//     const samplesToAdd = aFrame.numberOfFrames

//     const start = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_START)
//     let end = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_END)

//     if (samplesToAdd > this._getFreeSlots(start, end)) {
//       if (this.onDropped != null) {
//         this.onDropped({ clkms: Date.now(), mediaType: 'audio', ts: frameTimestamp, msg: 'Dropped PCM audio frame, ring buffer full' })
//       }
//     } else {
//       this.sampleIndexToTS.push({ sampleIndex: end, ts: frameTimestamp })
//       if (end + samplesToAdd <= this.size) {
//         // All
//         for (let c = 0; c < aFrame.numberOfChannels; c++) {
//           const outputRingBuffer = new Float32Array(this.sharedAudiobuffers[c], end * Float32Array.BYTES_PER_ELEMENT)
//           aFrame.copyTo(outputRingBuffer, { planeIndex: c, frameOffset: 0, frameCount: samplesToAdd })
//         }
//         end += samplesToAdd
//       } else {
//         const samplesToAddFirstHalf = this.size - end
//         const samplesToAddSecondsHalf = samplesToAdd - samplesToAddFirstHalf
//         for (let c = 0; c < aFrame.numberOfChannels; c++) {
//           // First half
//           const outputRingBuffer1 = new Float32Array(this.sharedAudiobuffers[c], end * Float32Array.BYTES_PER_ELEMENT, samplesToAddFirstHalf)
//           aFrame.copyTo(outputRingBuffer1, { planeIndex: c, frameOffset: 0, frameCount: samplesToAddFirstHalf })

//           // Second half
//           const outputRingBuffer2 = new Float32Array(this.sharedAudiobuffers[c], 0, samplesToAddSecondsHalf)
//           aFrame.copyTo(outputRingBuffer2, { planeIndex: c, frameOffset: samplesToAddFirstHalf, frameCount: samplesToAddSecondsHalf })
//         }
//         end = samplesToAddSecondsHalf
//       }
//     }
//     Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, end)
//   }

//   GetStats () {
//     const start = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_START) // Reader
//     const end = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_END) // Writer

//     // Find the last sent timestamp
//     let retIndexTs
//     let n = 0
//     let bExit = false
//     while (n < this.sampleIndexToTS.length && !bExit) {
//       if (this._isSentSample(this.sampleIndexToTS[n].sampleIndex, start, end)) {
//         retIndexTs = n
//       } else {
//         if (retIndexTs !== undefined) {
//           bExit = true
//         }
//       }
//       n++
//     }
//     if (retIndexTs !== undefined) {
//       const lastFrameTimestampSent = this.sampleIndexToTS[retIndexTs].ts
//       const extraSamplesSent = start - this.sampleIndexToTS[retIndexTs].sampleIndex

//       // Adjust at sample level
//       // Assume ts in nanosec
//       this.lastTimestamp = lastFrameTimestampSent + (extraSamplesSent * 1000 * 1000) / this.contextFrequency

//       // Remove old indexes (already sent)
//       this.sampleIndexToTS = this.sampleIndexToTS.slice(retIndexTs + 1)
//     }

//     const sizeSamples = this._getUsedSlots(start, end)
//     const sizeMs = Math.floor((sizeSamples * 1000) / this.contextFrequency)
//     const totalSilenceInsertedMs = Atomics.load(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS)
//     const isPlaying = Atomics.load(this.sharedStates, SharedStates.IS_PLAYING)

//     return { currentTimestamp: this.lastTimestamp, queueSize: sizeSamples, queueLengthMs: sizeMs, totalSilenceInsertedMs, isPlaying }
//   }

//   Play () {
//     Atomics.store(this.sharedStates, SharedStates.IS_PLAYING, 1)
//   }

//   GetSharedBuffers () {
//     if (this.sharedAudiobuffers === null) {
//       throw new Error('Not initialized yet')
//     }
//     return { sharedAudiobuffers: this.sharedAudiobuffers, sharedCommBuffer: this.sharedCommBuffer }
//   }

//   Clear () {
//     this.sharedAudiobuffers = null
//     this.size = -1
//     this.sampleIndexToTS = null
//     this.contextFrequency = -1
//     this.lastTimestamp = undefined

//     Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, -1)
//     Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, -1)
//     Atomics.store(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS, 0)
//     Atomics.store(this.sharedStates, SharedStates.IS_PLAYING, 0)
//   }

//   _getUsedSlots (start, end) {
//     if (start === end) {
//       return 0
//     } else if (end > start) {
//       return end - start
//     } else {
//       return (this.size - start) + end
//     }
//   }

//   _getFreeSlots (start, end) {
//     return this.size - this._getUsedSlots(start, end)
//   }

//   _isSentSample (index, start, end) {
//     if (start === end) {
//       return false
//     } else if (end > start) {
//       return index <= start
//     } else {
//       return (index <= start && index > end)
//     }
//   }
// }
