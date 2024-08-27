/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { StateEnum, deSerializeMetadata} from '../utils/utils.js'
import { TsQueue } from '../utils/ts_queue.js'
import { JitterBuffer } from '../utils/jitter_buffer.js'

const WORKER_PREFIX = '[AUDIO-DECO]'

const MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS = 200

let workerState = StateEnum.Created

let audioDecoder = null

// The Audio decoder does NOT track timestamps (bummer), it just uses the 1st one sent and at every decoded audio sample adds 1/fs (so sample time)
// That means if we drop and audio packet those timestamps will be collapsed creating A/V out of sync
let timestampOffset = 0
let lastChunkSentTimestamp = -1

const ptsQueue = new TsQueue()

//const wtAudioJitterBuffer = new JitterBuffer(200, (data) =>  console.warn(`[VIDEO-JITTER] Dropped late video frame. seqId: ${data.seqId}, currentSeqId:${data.firstBufferSeqId}`));

const wtAudioJitterBuffer = new JitterBuffer(200);


function processAudioFrame (aFrame) {
  self.postMessage({ type: 'aframe', frame: aFrame, queueSize: ptsQueue.getPtsQueueLengthInfo().size, queueLengthMs: ptsQueue.getPtsQueueLengthInfo().lengthMs, timestampCompensationOffset: timestampOffset }, [aFrame])
}

function processAChunk(event) {

  const chunk = event.data.chunk;
  const seqId = event.data.seqId;
  const extraData = {captureClkms: event.data.captureClkms, metadata: event.data.metadata}
  if (wtAudioJitterBuffer != null) {
    const orderedAudioData = wtAudioJitterBuffer.AddItem(chunk, seqId, extraData);
    if (orderedAudioData !== undefined) {
      // Download is sequential
      if (orderedAudioData.isDisco) {
          // console.warn(WORKER_PREFIX + ` AUDIO DISCO detected in seqId: ${orderedAudioData.seqId}`);
      }
      if (orderedAudioData.repeatedOrBackwards) {
          // console.warn(WORKER_PREFIX + ` AUDIO Repeated or backwards chunk, discarding, seqId: ${orderedAudioData.seqId}`);
      } else {
          // Adds pts to wallClk info
          if (orderedAudioData.extraData.metadata !== undefined && orderedAudioData.extraData.metadata !== null) {
            // sendMessageToMain(WORKER_PREFIX, 'debug', `audio-${e.data.seqId} Received chunk, chunkSize: ${e.data.chunk.byteLength}, metadataSize: ${e.data.metadata.byteLength}`)
            if (audioDecoder != null) {
              // sendMessageToMain(WORKER_PREFIX, 'debug', `audio-${e.data.seqId} Received init, but AudioDecoder already initialized`)
            } else {
              // Initialize audio decoder
              // eslint-disable-next-line no-undef
              audioDecoder = new AudioDecoder({
                output: frame => {
                  processAudioFrame(frame)
                },
                error: err => {
                  console.error(WORKER_PREFIX + ` Audio decoder. err: ${err.message}`);
                  // sendMessageToMain(WORKER_PREFIX, 'error', 'Audio decoder. err: ' + err.message)
                }
              })

              audioDecoder.addEventListener('dequeue', () => {
                if (audioDecoder != null) {
                  ptsQueue.removeUntil(audioDecoder.decodeQueueSize)
                }
              })

              const config = deSerializeMetadata(orderedAudioData.extraData.metadata)
              audioDecoder.configure(config)

              workerState = StateEnum.Running

              console.log(WORKER_PREFIX + ' Initialized and configured')
              // sendMessageToMain(WORKER_PREFIX, 'info', 'Initialized and configured')
            }
          } else {
            // sendMessageToMain(WORKER_PREFIX, 'debug', `audio-${e.data.seqId} Received chunk, chunkSize: ${e.data.chunk.byteLength}, metadataSize: -`)
          }

          if (workerState !== StateEnum.Running) {
            // console.warn(WORKER_PREFIX + ' Received audio chunk, but NOT running state')
            // sendMessageToMain(WORKER_PREFIX, 'warning', 'Received audio chunk, but NOT running state')
            return
          }

          ptsQueue.addToPtsQueue(orderedAudioData.chunk.timestamp, orderedAudioData.chunk.duration)

          if (orderedAudioData.isDisco && lastChunkSentTimestamp >= 0) {
            const addTs = orderedAudioData.chunk.timestamp - lastChunkSentTimestamp
            // sendMessageToMain(WORKER_PREFIX, 'warning', `disco at seqId: ${e.data.seqId}, ts: ${e.data.chunk.timestamp}, added: ${addTs}`)
            timestampOffset += addTs
          }
          lastChunkSentTimestamp = orderedAudioData.chunk.timestamp + orderedAudioData.chunk.duration
          audioDecoder.decode(orderedAudioData.chunk)

          // const decodeQueueInfo = ptsQueue.getPtsQueueLengthInfo()
          // if (decodeQueueInfo.lengthMs > MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS) {
          //   sendMessageToMain(WORKER_PREFIX, 'warning', 'Decode queue size is ' + decodeQueueInfo.lengthMs + 'ms (' + decodeQueueInfo.size + ' frames), audioDecoder: ' + audioDecoder.decodeQueueSize)
          // } else {
          //   sendMessageToMain(WORKER_PREFIX, 'debug', 'Decode queue size is ' + decodeQueueInfo.lengthMs + 'ms (' + decodeQueueInfo.size + ' frames), audioDecoder: ' + audioDecoder.decodeQueueSize)
          // }
      }
    }
  }
}

self.addEventListener('message', async function (e) {

  if (workerState === StateEnum.Created) {
    workerState = StateEnum.Instantiated
  }

  if (workerState === StateEnum.Stopped) {
    console.log(WORKER_PREFIX + ' Decoder is stopped, it does not accept messages')
    // sendMessageToMain(WORKER_PREFIX, 'info', 'Encoder is stopped it does not accept messages')
    return
  }

  const type = e.data.type

  if (type === 'connect') {

    wtAudioJitterBuffer.UpdateMaxSize(e.data.jitterBufferSize);
    var port = e.ports[0];
    port.onmessage = processAChunk;

  } else if (type === 'stop') {

    workerState = StateEnum.Stopped
    try {
      if (audioDecoder != null) {
        await audioDecoder.flush()
        audioDecoder.close()
      }
    } catch(error) {
      console.error(WORKER_PREFIX + ` Failed to flush and close due to ${err.message}`)
    } finally {
      audioDecoder = null
      ptsQueue.clear()
      timestampOffset = 0
      lastChunkSentTimestamp = -1
      workerState = StateEnum.Created
      self.close()
    }
  } else {
    console.error(WORKER_PREFIX + ' Invalid message received')
    // sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid message received')
  }
})
