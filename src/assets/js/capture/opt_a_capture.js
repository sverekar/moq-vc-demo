/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { StateEnum, isMetadataValid, serializeMetadata } from '../utils/utils.js'
import { TimeBufferChecker} from '../utils/time_buffer_checker.js'

const WORKER_PREFIX = '[AUDIO-CAP/ENC]'

let stopped = false
let mainLoopInterval
let isMainLoopInExecution = false

let sharedBuffer = null;
let currentAudioTs = undefined;
let audioOffsetTS = undefined;
let videoOffsetTS = undefined;
let currentVideoTs = undefined
let estimatedDuration = -1;
let arr = null;

const INSERT_METADATA_EVERY_AUDIO_FRAMES = 20
let frameDeliveredCounter = 0
let chunkDeliveredCounter = 0
let workerState = StateEnum.Created
// Default values
let encoderMaxQueueSize = 5
// Last received metadata
let lastAudioMetadata
// Encoder
const initAudioEncoder = {
  output: handleChunk,
  error: (e) => {
    console.error(e.message)
  }
}
let aEncoder = null

const audioTimeChecker = new TimeBufferChecker("audio");

let port = null;

function handleChunk (chunk, metadata) {


  // Save last metadata and insert it if it is new
  let insertMetadata
  if (isMetadataValid(metadata)) {
    lastAudioMetadata = metadata
    insertMetadata = lastAudioMetadata
  } else {
    // Inject last received metadata every few secs following video IDR behavior
    if (chunkDeliveredCounter % INSERT_METADATA_EVERY_AUDIO_FRAMES === 0) {
      insertMetadata = lastAudioMetadata
    }
  }
  const msg = { type: 'achunk', seqId: chunkDeliveredCounter++, chunk, metadata: serializeMetadata(insertMetadata) }
  // console.log('Encoded Audio Chunk: ', chunk.timestamp)
  const itemTsClk = audioTimeChecker.GetItemByTs(chunk.timestamp);
  // console.log('Encoded Audio Chunk Retrived: ', itemTsClk.compensatedTs)
  if (!itemTsClk.valid) {
    // console.warn(WORKER_PREFIX + ` Not found clock time <-> TS for audio frame, this could happen. ts: ${chunk.timestamp}, id:${msg.seqId}`);
  }
  // send to moq_sender.js
  // console.log('Audio', {compensatedTs: itemTsClk.compensatedTs, seqId: msg.seqId })
  port.postMessage({ type: "audio", firstFrameClkms: itemTsClk.clkms, compensatedTs: itemTsClk.compensatedTs, seqId: msg.seqId, chunk: msg.chunk, metadata: msg.metadata });

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
      // sendMessageToMain(WORKER_PREFIX, 'info', 'Exited!')
      isMainLoopInExecution = false
      return resolve(false)
    }
    frameReader.read()
      .then(result => {
        if (result.done) {
          console.log(WORKER_PREFIX + ' Stream is done!')
          // sendMessageToMain(WORKER_PREFIX, 'info', 'Stream is done')
          return frameReader.cancel('ended')
        } else {
          return new Promise(function (resolve) { return resolve(result) })
        }
      }).then(result => {
        if (result === 'ended') {
          isMainLoopInExecution = false
          return resolve(false)
        } else {
          const aFrame = result.value
          // console.log('Audio Frame: ', aFrame.timestamp)
          if (currentAudioTs === undefined) {
            videoOffsetTS = Number(Atomics.load(arr, 3));
            // console.log('videoOffsetTS in audio: ', videoOffsetTS)
            if (videoOffsetTS === 0 ){
              // console.log('Audio first: ', aFrame.timestamp)
              audioOffsetTS = -aFrame.timestamp;
              Atomics.store(arr, 1, BigInt(audioOffsetTS));
            } else {
              // console.log('Audio second: ', aFrame.timestamp)
              currentVideoTs = Number(Atomics.load(arr, 2));
              // console.log('currentVideoTs in Audio: ', currentVideoTs)
              audioOffsetTS = -aFrame.timestamp + currentVideoTs + videoOffsetTS;
            }
          } else {
            estimatedDuration = aFrame.timestamp - currentAudioTs;
          }
          currentAudioTs = aFrame.timestamp;
          Atomics.store(arr, 0, BigInt(aFrame.timestamp));
          // console.log('Adding audio Frame: ', {  ts: currentAudioTs, compensatedTs: currentAudioTs + audioOffsetTS, estimatedDuration: estimatedDuration })
          audioTimeChecker.AddItem({ ts: currentAudioTs, compensatedTs: currentAudioTs + audioOffsetTS, estimatedDuration: estimatedDuration, clkms: Date.now()});
          if (aEncoder.encodeQueueSize > encoderMaxQueueSize) {
            // Too many frames in the encoder, encoder is overwhelmed let's drop this frame.
            // console.error(WORKER_PREFIX + 'Dropped encoding audio frame due to encodeQueueSize is full');
            aFrame.close()
          } else {
            frameDeliveredCounter++;
            aEncoder.encode(aFrame)
            aFrame.close()
          }
          isMainLoopInExecution = false
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
    // stop frames reader
    stopped = true
    // stop encoder
    workerState = StateEnum.Stopped
    // Make sure all requests has been processed
    await aEncoder.flush()
    aEncoder.close()
    lastAudioMetadata = undefined
    console.log(WORKER_PREFIX + ' Encoder is stopped!!')
    return

  } else if (type === 'aencoderini') {

    port = e.ports[0];

    const encoderConfig = e.data.encoderConfig
    // eslint-disable-next-line no-undef
    aEncoder = new AudioEncoder(initAudioEncoder)
    aEncoder.configure(encoderConfig)
    if ('encoderMaxQueueSize' in e.data) {
      encoderMaxQueueSize = e.data.encoderMaxQueueSize
    }
    console.log(WORKER_PREFIX + 'Encoder initialized');
    workerState = StateEnum.Running
    return
  }

  if (type === 'stream') {
    if (mainLoopInterval !== undefined) {
      console.error(WORKER_PREFIX + ' Loop already running')
      // sendMessageToMain(WORKER_PREFIX, 'error', 'Loop already running')
      return
    }

    const aFrameStream = e.data.aStream
    sharedBuffer = e.data.sharedBuffer;
    arr = new BigInt64Array(sharedBuffer);
    const aFrameReader = aFrameStream.getReader()
    mainLoopInterval = setInterval(mainLoop, 1, aFrameReader)
    return
  }
  console.error(WORKER_PREFIX, ' Invalid message received.')
})
