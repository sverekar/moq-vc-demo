/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { StateEnum, serializeMetadata } from '../utils/utils.js'

import { TimeBufferChecker} from '../utils/time_buffer_checker.js'

const WORKER_PREFIX = '[VIDEO-CAP/ENC]';

let stopped = false;
let mainLoopInterval = undefined;
let isMainLoopInExecution = false;
let timeCheck = undefined;
let estFps = 0

let sharedBuffer = null;
let currentVideoTs = undefined
let currentAudioTs = undefined;
let videoOffsetTS = undefined;
let audioOffsetTS = undefined;
let estimatedDuration = -1;


let frameDeliveredCounter = 0
let chunkDeliveredCounter = 0
let workerState = StateEnum.Created

// Default values
let encoderMaxQueueSize = 5
let keyframeEvery = 60
let insertNextKeyframe = false

let onlyVideo = false;

// Encoder
const initVideoEncoder = {
  output: handleChunk,
  error: (e) => {
    console.error(e.message)
  }
}
let vEncoder = null

const videoTimeChecker = new TimeBufferChecker("video");

let port = null;

function handleChunk (chunk, metadata) {

  const msg = { type: 'vchunk', seqId: chunkDeliveredCounter++, chunk, metadata: serializeMetadata(metadata) }
  const itemTsClk = videoTimeChecker.GetItemByTs(chunk.timestamp);
  if (!itemTsClk.valid) {
    // console.error(WORKER_PREFIX + ` Not found clock time <-> TS for that video frame, this should not happen.  ts: ${chunk.timestamp}, id:${msg.seqId}`);
  }
  // send to moq_sender.js
  port.postMessage({ type: "video", firstFrameClkms: itemTsClk.clkms, compensatedTs: itemTsClk.compensatedTs, estimatedDuration: itemTsClk.estimatedDuration, seqId: msg.seqId, chunk: msg.chunk, metadata: msg.metadata });

}

function mainLoop (frameReader) {

  return new Promise(function (resolve) {

    if (isMainLoopInExecution) {
      return resolve(false)
    }
    isMainLoopInExecution = true

    if (stopped === true) {
      if (mainLoopInterval !== undefined) {
        clearInterval(mainLoopInterval)
        mainLoopInterval = undefined
      }
      console.log(WORKER_PREFIX + ' Exited!')
      isMainLoopInExecution = false
      return resolve(false)
    }

    frameReader.read()
      .then(result => {
        if (result.done) {
          console.log(WORKER_PREFIX + ' Stream is done!')
          return frameReader.cancel('ended')
        } else {
          return new Promise(function (resolve) { return resolve(result) })
        }
      }).then(result => {
        if (result === 'ended') {
          isMainLoopInExecution = false
          return resolve(false)
        } else {
          const vFrame = new VideoFrame(result.value)
          result.value.close();
          if (!onlyVideo) {
            if (currentVideoTs === undefined) {
              const arr = new BigInt64Array(sharedBuffer);
              audioOffsetTS = Number(Atomics.load(arr, 1));
              if (audioOffsetTS === 0 ){
                // Skip this frame as we wait for the audio frame first. i.e audio frame always start from 0
                vFrame.close();
                isMainLoopInExecution = false
                return;
              }
              currentAudioTs = Number(Atomics.load(arr, 0));
              videoOffsetTS = -vFrame.timestamp + currentAudioTs + audioOffsetTS;
            } else {
              estimatedDuration = vFrame.timestamp - currentVideoTs;
            }
          } else {
            if (currentVideoTs === undefined) {
              videoOffsetTS = -vFrame.timestamp
            } else {
              estimatedDuration = vFrame.timestamp - currentVideoTs;
            }
          }
          currentVideoTs = vFrame.timestamp;
          videoTimeChecker.AddItem({ ts: currentVideoTs, compensatedTs: currentVideoTs + videoOffsetTS, estimatedDuration: estimatedDuration, clkms: Date.now()});
          // encode the frame
          if (vEncoder.encodeQueueSize > encoderMaxQueueSize) {
            // Too many frames in the encoder queue, encoder is overwhelmed let's not add this frame
            // console.error(WORKER_PREFIX + ' Dropped encoding video frame due to encodeQueueSize is full');
            vFrame.close()
            // Insert a keyframe after dropping
            insertNextKeyframe = true
          } else {
            const frameNum = frameDeliveredCounter++
            const insertKeyframe = (frameNum % keyframeEvery) === 0 || (insertNextKeyframe === true)
            vEncoder.encode(vFrame, { keyFrame: insertKeyframe })
            vFrame.close()
            insertNextKeyframe = false
            frameDeliveredCounter++
          }
          // encoding can be handled async
          isMainLoopInExecution = false
          estFps++
          if (timeCheck === undefined) {
            timeCheck = Date.now()
          }
          const nowMs = Date.now()
          if (nowMs >= timeCheck + 1000) {
            // console.log(WORKER_PREFIX + 'estimated fps last sec: ' + estFps)
            estFps = 0
            timeCheck = nowMs
          }
          return resolve(true)
        }
      })
  })
}

self.addEventListener('message', async function (e) {

  if (workerState === StateEnum.Created) {
    workerState = StateEnum.Instantiated
  }

  if (workerState === StateEnum.Stopped) {
    console.log(WORKER_PREFIX + ' Encoder is stopped it does not accept messages')
    return
  }

  const type = e.data.type

  if (type === 'stop') {

    // stop video frame reader
    stopped = true
    // stop encoder
    workerState = StateEnum.Stopped
    await vEncoder.flush()
    vEncoder.close()
    console.log(WORKER_PREFIX + ' Encoder is stopped!!')
    return

  } else if (type === 'vencoderini'){

    port = e.ports[0];

    const encoderConfig = e.data.encoderConfig
    vEncoder = new VideoEncoder(initVideoEncoder)
    vEncoder.configure(encoderConfig)
    if ('encoderMaxQueueSize' in e.data) {
      encoderMaxQueueSize = e.data.encoderMaxQueueSize
    }
    if ('keyframeEvery' in e.data) {
      keyframeEvery = e.data.keyframeEvery
    }
    onlyVideo = e.data.onlyVideo;
    console.log(WORKER_PREFIX + 'Encoder initialized');
    return
  }

  if (type === 'stream') {
    if (mainLoopInterval !== undefined) {
      console.error(WORKER_PREFIX + ' Loop already running')
      return
    }
    const vFrameStream = e.data.vStream
    sharedBuffer = e.data.sharedBuffer;
    const vFrameReader = vFrameStream.getReader()
    mainLoopInterval = setInterval(mainLoop, 1, vFrameReader)
    return
  }

  console.error(WORKER_PREFIX, ' Invalid message received.')
})
