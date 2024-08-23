/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

 import { sendMessageToMain } from '../utils/utils.js'

const WORKER_PREFIX = '[VIDEO-CAP]';

let stopped = false;
let mainLoopInterval = undefined;
let isMainLoopInExecution = false;

let timeCheck = undefined;
let estFps = 0

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
          const vFrame = result.value
          // Send frame to process
          self.postMessage({ type: 'vframe', clkms: Date.now(), data: vFrame }, [vFrame])
          // vFrame.close();

          estFps++
          if (timeCheck === undefined) {
            timeCheck = Date.now()
          }
          const nowMs = Date.now()
          if (nowMs >= timeCheck + 1000) {
            // sendMessageToMain(WORKER_PREFIX, 'debug', 'estimated fps last sec: ' + estFps)
            estFps = 0
            timeCheck = nowMs
          }

          isMainLoopInExecution = false
          return resolve(true)
        }
      })
  })
}

self.addEventListener('message', async function (e) {
  const type = e.data.type
  if (type === 'stop') {
    stopped = true
    return
  }
  if (type === 'stream') {
    if (mainLoopInterval !== undefined) {
      console.error(WORKER_PREFIX + ' Loop already running')
      return
    }
    const vFrameStream = e.data.vStream
    const vFrameReader = vFrameStream.getReader()
    mainLoopInterval = setInterval(mainLoop, 1, vFrameReader)
    return
  }
  console.error(WORKER_PREFIX, ' Invalid message received.')
})
