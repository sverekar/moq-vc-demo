/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { StateEnum, deSerializeMetadata } from '../utils/utils.js'
import { TsQueue } from '../utils/ts_queue.js'
import { JitterBuffer } from '../utils/jitter_buffer.js'

const WORKER_PREFIX = '[VIDEO-DECO]'

const MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS = 500
const MAX_QUEUED_CHUNKS_DEFAULT = 60

let workerState = StateEnum.Created

let videoDecoder = null

let waitForKeyFrame = true
let discardedDelta = 0
let discardedBufferFull = 0
const maxQueuedChunks = MAX_QUEUED_CHUNKS_DEFAULT


// Unlike the  audio decoder video decoder tracks timestamps between input - output, so timestamps of RAW frames matches the timestamps of encoded frames

const ptsQueue = new TsQueue()

// const wtVideoJitterBuffer = new JitterBuffer(200, (data) =>  console.warn(`[VIDEO-JITTER] Dropped late video frame. seqId: ${data.seqId}, currentSeqId:${data.firstBufferSeqId}`));

const wtVideoJitterBuffer = new JitterBuffer(200);

function processVideoFrame (vFrame) {
  self.postMessage({ type: 'vframe', frame: vFrame, queueSize: ptsQueue.getPtsQueueLengthInfo().size, queueLengthMs: ptsQueue.getPtsQueueLengthInfo().lengthMs }, [vFrame])
}

function setWaitForKeyframe (a) {
  waitForKeyFrame = a
}

function isWaitingForKeyframe () {
  return waitForKeyFrame
}

function processVChunk(e) {

  const chunk = e.data.chunk;
  const seqId = e.data.seqId;
  const extraData = { captureClkms: e.data.captureClkms, metadata: e.data.metadata }
  if (wtVideoJitterBuffer != null) {
    const orderedVideoData = wtVideoJitterBuffer.AddItem(chunk, seqId, extraData);
    if (orderedVideoData !== undefined) {
      // Download is sequential
      if (orderedVideoData.isDisco) {
         // console.warn(WORKER_PREFIX + ` VIDEO DISCO detected in seqId: ${orderedVideoData.seqId}`);
      }
      if (orderedVideoData.repeatedOrBackwards) {
          // console.warn(WORKER_PREFIX + ` VIDEO Repeated or backwards chunk, discarding, seqId: ${orderedVideoData.seqId}`);
      } else {
        // this.videoDecoderWorker.postMessage({ type: "videochunk", seqId: orderedVideoData.seqId, chunk: orderedVideoData.chunk, metadata: orderedVideoData.extraData.metadata, isDisco: orderedVideoData.isDisco });
        if (orderedVideoData.extraData.metadata !== undefined && orderedVideoData.extraData.metadata != null) {
          // sendMessageToMain(WORKER_PREFIX, 'debug', `SeqId: ${e.data.seqId} Received chunk, chunkSize: ${e.data.chunk.byteLength}, metadataSize: ${e.data.metadata.byteLength}`)
          if (videoDecoder != null) {
            // sendMessageToMain(WORKER_PREFIX, 'debug', `SeqId: ${e.data.seqId} Received init, but VideoDecoder already initialized`)
          } else {
            // Initialize video decoder
            // eslint-disable-next-line no-undef
            videoDecoder = new VideoDecoder({
              output: frame => {
                processVideoFrame(frame)
              },
              error: err => {
                console.error(WORKER_PREFIX + `Video decoder. err: ${err.message}`)
                // sendMessageToMain(WORKER_PREFIX, 'error', 'Video decoder. err: ' + err.message)
              }
            })

            videoDecoder.addEventListener('dequeue', () => {
              if (videoDecoder != null) {
                ptsQueue.removeUntil(videoDecoder.decodeQueueSize)
              }
            })

            // Override values
            const config = deSerializeMetadata(orderedVideoData.extraData.metadata)
            config.optimizeForLatency = true
            // In my test @2022/11 with hardware accel could NOT get real time decoding,
            // switching to soft decoding fixed everything (h264)
            config.hardwareAcceleration = 'prefer-software'
            videoDecoder.configure(config)

            workerState = StateEnum.Running
            setWaitForKeyframe(true)
            console.log(WORKER_PREFIX + ' Initialized and configured')
          }
        } else {
          // sendMessageToMain(WORKER_PREFIX, 'debug', `SeqId: ${e.data.seqId} Received chunk, chunkSize: ${e.data.chunk.byteLength}, metadataSize: -`)
        }

        if (workerState !== StateEnum.Running) {
          // console.warn(WORKER_PREFIX + ' Received video chunk, but NOT running state')
          // sendMessageToMain(WORKER_PREFIX, 'warning', 'Received video chunk, but NOT running state')
          return
        }

        if (videoDecoder.decodeQueueSize >= maxQueuedChunks) {
          discardedBufferFull++
          // console.warn(WORKER_PREFIX + ' Discarded video chunks because decoder buffer is full')
          // sendMessageToMain(WORKER_PREFIX, 'warning', 'Discarded ' + discardedBufferFull + ' video chunks because decoder buffer is full')
          return
        }

        discardedBufferFull = 0

        // If there is a disco, we need to wait for a new key
        if (orderedVideoData.isDisco) {
          // console.warn(WORKER_PREFIX + ` Disco detected at seqId: ${e.data.seqId}`);
          setWaitForKeyframe(true)
        }

        // The message is video chunk
        if (isWaitingForKeyframe() && (orderedVideoData.chunk.type !== 'key')) {
          // Discard Frame
          discardedDelta++
        } else {
          if (discardedDelta > 0) {
            // console.warn(WORKER_PREFIX + ` Discarded ${discardedDelta} video chunks before key`)
            // sendMessageToMain(WORKER_PREFIX, 'warning', 'Discarded ' + discardedDelta + ' video chunks before key')
          }
          discardedDelta = 0
          setWaitForKeyframe(false)
          ptsQueue.removeUntil(videoDecoder.decodeQueueSize)
          ptsQueue.addToPtsQueue(orderedVideoData.chunk.timestamp, orderedVideoData.chunk.duration)
          videoDecoder.decode(orderedVideoData.chunk)
          // const decodeQueueInfo = ptsQueue.getPtsQueueLengthInfo()
          // if (decodeQueueInfo.lengthMs > MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS) {
          //   sendMessageToMain(WORKER_PREFIX, 'warning', 'Decode queue size is ' + decodeQueueInfo.lengthMs + 'ms (' + decodeQueueInfo.size + ' frames), videoDecoder: ' + videoDecoder.decodeQueueSize)
          // } else {
          //   sendMessageToMain(WORKER_PREFIX, 'debug', 'Decode queue size is ' + decodeQueueInfo.lengthMs + 'ms (' + decodeQueueInfo.size + ' frames), videoDecoder: ' + videoDecoder.decodeQueueSize)
          // }
        }
      }
    }
  }
}

self.addEventListener('message', async function (e) {
  if (workerState === StateEnum.Created) {
    workerState = StateEnum.Instantiated
  }

  if (workerState === StateEnum.Stopped) {
    console.log(WORKER_PREFIX + ' Decoder is stopped it does not accept messages')
    // sendMessageToMain(WORKER_PREFIX, 'info', 'Encoder is stopped it does not accept messages')
    return
  }

  const type = e.data.type
  if (type === 'connect') {
    wtVideoJitterBuffer.UpdateMaxSize(e.data.jitterBufferSize);
    var port = e.ports[0];
    port.onmessage = processVChunk;

  } else if (type === 'stop') {
    workerState = StateEnum.Stopped
    if (videoDecoder != null) {
      await videoDecoder.flush()
      videoDecoder.close()
      videoDecoder = null

      ptsQueue.clear()
    }
    workerState = StateEnum.Created
  } else {
    console.error(WORKER_PREFIX + ' Invalid message received')
    // sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid message received')
  }
})
