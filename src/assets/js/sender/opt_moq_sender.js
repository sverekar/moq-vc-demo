/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { StateEnum} from '../utils/utils.js'
import { moqCreate, moqClose, moqCloseWrttingStreams, moqParseMsg, moqCreateControlStream, moqSendSubscribeOk, moqSendSubscribeError, moqSendObjectPerStreamToWriter, moqSendObjectPerDatagramToWriter, moqSendSetup, moqSendUnAnnounce, MOQ_PARAMETER_ROLE_PUBLISHER, MOQ_PARAMETER_ROLE_SUBSCRIBER, MOQ_PARAMETER_ROLE_BOTH, moqSendAnnounce, getTrackFullName, moqSendSubscribeDone, MOQ_SUBSCRIPTION_ERROR_INTERNAL, MOQ_SUBSCRIPTION_RETRY_TRACK_ALIAS, MOQ_MESSAGE_SUBSCRIBE, MOQ_MESSAGE_UNSUBSCRIBE, MOQ_SUBSCRIPTION_DONE_ENDED, MOQ_MESSAGE_SERVER_SETUP, MOQ_MESSAGE_ANNOUNCE_OK, MOQ_MESSAGE_ANNOUNCE_ERROR, MOQ_MAPPING_OBJECT_PER_STREAM, MOQ_MAPPING_OBJECT_PER_DATAGRAM, MOQ_MAPPING_TRACK_PER_STREAM, moqSendTrackPerStreamHeader, moqSendTrackPerStreamToWriter, MOQ_MAPPING_GROUP_PER_STREAM, moqSendGroupPerStreamHeader, moqSendGroupPerStreamToWriter} from '../utils/moqt.js'
import { LocPackager } from '../packager/loc_packager.js'
import { RawPackager } from '../packager/raw_packager.js'

const WORKER_PREFIX = '[MOQ-SENDER]'

// Show verbose exceptions
const MOQT_DEV_MODE = true

let moqPublisherState = {}

let workerState = StateEnum.Created

let isSendingStats = false

let keepAlivesEveryMs = 0
let keepAliveInterval = null
let keepAliveNameSpace = ""

let lastObjectSentMs = 0

let tracks = {}
// Example
/* moqTracks: {
    "audio": {
        id: 0,
        maxInFlightRequests: 100,
        isHipri: true,
        authInfo: "secret",
        moqMapping: "ObjStream",
    },
    "video": {
        id: 1,
        maxInFlightRequests: 50,
        isHipri: false,
        authInfo: "secret",
        moqMapping: "ObjStream",
    },
} */

// Inflight req abort signal
const abortController = new AbortController()

// MOQT data
const moqt = moqCreate()

let videoPort = null;
let audioPort = null;


function handleEncodedFrames(e) {

  const type = e.data.type

  if (workerState !== StateEnum.Running) {
    console.error(WORKER_PREFIX + ` Dropped chunk because transport is NOT open yet`);
    return
  }

  if (!(type in tracks)) {
    console.error(WORKER_PREFIX + ` Invalid message received ${type} is NOT in tracks ${JSON.stringify(tracks)}`);
    return
  }

  if (!('subscribers' in tracks[type]) || (tracks[type].subscribers.length <= 0)) {
    // console.error(WORKER_PREFIX + ` Dropped chunk because there is NO subscribers for track`);
    return
  }

  // Send one object per every subscriber
  // Relay needs to aggregate subscriptions to avoid overload pub -> relay link
  const firstFrameClkms = (e.data.firstFrameClkms === undefined || e.data.firstFrameClkms < 0) ? 0 : e.data.firstFrameClkms
  const compensatedTs = (e.data.compensatedTs === undefined || e.data.compensatedTs < 0) ? 0 : e.data.compensatedTs
  const estimatedDuration = (e.data.estimatedDuration === undefined || e.data.estimatedDuration < 0) ? e.data.chunk.duration : e.data.estimatedDuration
  const seqId = (e.data.seqId === undefined) ? 0 : e.data.seqId
  const chunkData = { mediaType: type, firstFrameClkms, compensatedTs, estimatedDuration, seqId, chunk: e.data.chunk, metadata: e.data.metadata }
  const moqMapping = (e.data.moqMapping === undefined) ? tracks[type].moqMapping : e.data.moqMapping

  let i = 0
  while (i < tracks[type].subscribers.length) {
    const subscribeId = tracks[type].subscribers[i].subscribeId
    const trackAlias = tracks[type].subscribers[i].trackAlias

    sendChunkToTransport(chunkData, subscribeId, trackAlias, getNumInflightRequestByType(moqt, type), tracks[type].maxInFlightRequests, moqMapping)
    .then(val => {
      if (val !== undefined && val.dropped === true) {
        // console.warn(WORKER_PREFIX + ` Dropped CHUNK ${type} - message: ${val.message}`);
      }
    })
    .catch(err => {
      // if (MOQT_DEV_MODE) {throw err}
      console.error(WORKER_PREFIX + ` error sending chunk. For subscribeId: ${subscribeId}, trackAlias: ${trackAlias}. Err:  ${err.message}`)
    })
    i++
  }

  // Report stats
  if (isSendingStats) {
    self.postMessage({ type: 'sendstats', clkms: Date.now(), inFlightReq: getInflightRequestsReport(moqt) })
  }

}

self.addEventListener('message', async function (e) {
  if (workerState === StateEnum.Created) {
    workerState = StateEnum.Instantiated
  }

  if (workerState === StateEnum.Stopped) {
    console.error(WORKER_PREFIX + ' Muxer-send is stopped it does not accept messages')
    return
  }

  const type = e.data.type
  if (type === 'stop') {

    workerState = StateEnum.Stopped
    // Abort and wait for all inflight requests
    try {
      if (keepAliveInterval != null) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null
      }
      // TODO JOC finish abort controller
      abortController.abort()
      // await moqCloseWrttingStreams(moqt)
      await unAnnounceTracks(moqt)
      await moqClose(moqt)
      console.info(WORKER_PREFIX + ` Muxer stopped !!`)
    } catch (err) {
      // ) { throw err }
      // Expected to finish some promises with abort error
      // The abort "errors" are already sent to main "thead" by sendMessageToMain inside the promise
      console.info(WORKER_PREFIX + ` Aborting / closing streams while exiting. Err: ${err.message}`)
      // sendMessageToMain(WORKER_PREFIX, 'info', `Aborting / closing streams while exiting. Err: ${err.message}`)
    } finally {
      self.close();
    }
    return
  }

  if (type === 'muxersendini') {

    videoPort = e.ports[0];
    audioPort = e.ports[1];

    if (videoPort && audioPort) {
      videoPort.onmessage = handleEncodedFrames
      audioPort.onmessage = handleEncodedFrames
    } else {
      console.error(WORKER_PREFIX + ' Video and audio ports of message channels are not defined!.')
      return
    }

    if (workerState !== StateEnum.Instantiated) {
      console.error(WORKER_PREFIX + ' received ini message in wrong state. State: ' + workerState)
      return
    }

    let urlHostPortEp = ''

    if ('urlHostPort' in e.data.muxerSenderConfig) {
      urlHostPortEp = e.data.muxerSenderConfig.urlHostPort
    }
    if ('isSendingStats' in e.data.muxerSenderConfig) {
      isSendingStats = e.data.muxerSenderConfig.isSendingStats
    }
    if ('moqTracks' in e.data.muxerSenderConfig) {
      tracks = e.data.muxerSenderConfig.moqTracks
    }
    if ('keepAlivesEveryMs' in e.data.muxerSenderConfig) {
      keepAlivesEveryMs = e.data.muxerSenderConfig.keepAlivesEveryMs
    }

    if (urlHostPortEp === '') {
      console.error(WORKER_PREFIX + ' Empty host port')
      return
    }

    const errTrackStr = checkTrackData()
    if (errTrackStr !== '') {
      console.error(WORKER_PREFIX + ' ' + errTrackStr)
      return
    }

    try {

      // Reset state
      moqResetState()
      await moqClose(moqt)

      // WT needs https to establish connection
      const url = new URL(urlHostPortEp)
      // Replace protocol
      url.protocol = 'https'

      // Ini WT
      moqt.wt = new WebTransport(url.href)
      moqt.wt.closed.then(() => {
          console.info(WORKER_PREFIX + ' WT closed transport session');
      }).catch(err => {
          // if (MOQT_DEV_MODE) { throw err }
          console.error(WORKER_PREFIX + ` WT error, closed transport. Err: ${err}`);
        })

      await moqt.wt.ready
      await moqCreateControlStream(moqt)
      await moqCreatePublisherSession(moqt)

      console.log(WORKER_PREFIX + ' MOQ Initialized, waiting for subscriptions');
      workerState = StateEnum.Running

      self.postMessage({ type: 'started' });

      startLoopSubscriptionsLoop(moqt.controlReader, moqt.controlWriter)
        .then(() => {
          console.log(WORKER_PREFIX + ' Exited receiving subscription loop in control stream');
          // sendMessageToMain(WORKER_PREFIX, 'info', 'Exited receiving subscription loop in control stream')
        })
        .catch(err => {
          // if (MOQT_DEV_MODE) {throw err}
          if (workerState !== StateEnum.Stopped) {
            console.error(WORKER_PREFIX + ` Error in the subscription loop in control stream. Err: ${JSON.stringify(err)}`);
            // sendMessageToMain(WORKER_PREFIX, 'error', `Error in the subscription loop in control stream. Err: ${JSON.stringify(err)}`)
          } else {
            console.info(WORKER_PREFIX + `Exited receiving subscription loop in control stream. Err: ${JSON.stringify(err)}`);
            // sendMessageToMain(WORKER_PREFIX, 'info', `Exited receiving subscription loop in control stream. Err: ${JSON.stringify(err)}`)
          }
        })

      if (keepAlivesEveryMs > 0) {
        keepAliveNameSpace = Math.floor(Math.random() * 10000000) + "-keepAlive"
        keepAliveInterval = setInterval(sendKeepAlive, keepAlivesEveryMs, moqt.controlWriter);
      }
    } catch (err) {
      // if (MOQT_DEV_MODE) {throw err}
      console.error(WORKER_PREFIX + ` Initializing MOQ. Err: ${JSON.stringify(err)}`);
    }
    return
  }
});

// Handles control messages to keep the connection alive.
async function sendKeepAlive(controlWriter) {
  if((Date.now() - lastObjectSentMs) > keepAlivesEveryMs) {
    await moqSendAnnounce(controlWriter, keepAliveNameSpace, "")
    // sendMessageToMain(WORKER_PREFIX, 'info', `Sent keep alive (announce) for ns: ${keepAliveNameSpace}`)
  }
}

// Handles control messages such as subscribe and unsubscribe
async function startLoopSubscriptionsLoop (controlReader, controlWriter) {

  console.log(WORKER_PREFIX + ' Started subscription loop');
  // sendMessageToMain(WORKER_PREFIX, 'info', 'Started subscription loop')

  while (workerState === StateEnum.Running) {
    const moqMsg = await moqParseMsg(controlReader)
    if (moqMsg.type === MOQ_MESSAGE_SUBSCRIBE) {
      const subscribe = moqMsg.data
      console.log(WORKER_PREFIX + ` Received SUBSCRIBE: ${JSON.stringify(subscribe)}`);
      // sendMessageToMain(WORKER_PREFIX, 'info', `Received SUBSCRIBE: ${JSON.stringify(subscribe)}`)
      const fullTrackName = getTrackFullName(subscribe.namespace, subscribe.trackName)
      const track = getTrackFromFullTrackName(fullTrackName)
      if (track == null) {
        console.error(WORKER_PREFIX + ` Invalid subscribe received ${fullTrackName} is NOT in tracks ${JSON.stringify(tracks)}`);
        // sendMessageToMain(WORKER_PREFIX, 'error', `Invalid subscribe received ${fullTrackName} is NOT in tracks ${JSON.stringify(tracks)}`)
        continue
      }
      if (track.authInfo !== subscribe.parameters.authInfo) {
        const errorCode = MOQ_SUBSCRIPTION_ERROR_INTERNAL
        const errReason = `Invalid subscribe authInfo ${subscribe.parameters.authInfo}`
        console.error(WORKER_PREFIX + ` ${errReason} does not match with ${JSON.stringify(tracks)}`);
        // sendMessageToMain(WORKER_PREFIX, 'error', `${errReason} does not match with ${JSON.stringify(tracks)}`)
        await moqSendSubscribeError(controlWriter, subscribe.subscribeId, errorCode, errReason, subscribe.trackAlias)
        continue
      }
      if (!('subscribers' in track)) {
        track.subscribers = []
      }
      if (getSubscriberTrackFromTrackAlias(subscribe.trackAlias) != null) {
        const errorCode = MOQ_SUBSCRIPTION_RETRY_TRACK_ALIAS
        const errReason = `TrackAlias already in use ${subscribe.trackAlias}`
        console.error(WORKER_PREFIX + ` ${errReason}`);
        // sendMessageToMain(WORKER_PREFIX, 'error', `${errReason}`)
        await moqSendSubscribeError(controlWriter, subscribe.subscribeId, errorCode, errReason, subscribe.trackAlias)
        continue
      }
      if (getSubscriberTrackFromSubscribeID(subscribe.subscribeId) != null) {
        const errorCode = MOQ_SUBSCRIPTION_ERROR_INTERNAL
        const errReason = `SubscribeID already in use ${subscribe.subscribeId}`
        console.error(WORKER_PREFIX + ` ${errReason}`);
        // sendMessageToMain(WORKER_PREFIX, 'error', `${errReason}`)
        await moqSendSubscribeError(controlWriter, subscribe.subscribeId, errorCode, errReason, subscribe.trackAlias)
        continue
      }
      // Add subscribe
      track.subscribers.push(subscribe)
      console.log(WORKER_PREFIX + ` New subscriber for track ${subscribe.trackAlias}(${subscribe.namespace}/${subscribe.trackName}). Current num subscriber: ${track.subscribers.length}. AuthInfo MATCHED!`);
      // sendMessageToMain(WORKER_PREFIX, 'info', `New subscriber for track ${subscribe.trackAlias}(${subscribe.namespace}/${subscribe.trackName}). Current num subscriber: ${track.subscribers.length}. AuthInfo MATCHED!`)

      const lastSent = getLastSentFromTrackAlias(subscribe.trackAlias)
      await moqSendSubscribeOk(controlWriter, subscribe.subscribeId, 0, lastSent.group, lastSent.obj)
      console.log(WORKER_PREFIX + ` Sent SUBSCRIBE_OK for subscribeId: ${subscribe.subscribeId}, last: ${lastSent.group}/${lastSent.obj}`);
      // sendMessageToMain(WORKER_PREFIX, 'info', `Sent SUBSCRIBE_OK for subscribeId: ${subscribe.subscribeId}, last: ${lastSent.group}/${lastSent.obj}`)
    }
    else if (moqMsg.type === MOQ_MESSAGE_UNSUBSCRIBE) {
      const unsubscribe = moqMsg.data
      console.log(WORKER_PREFIX + ` Received UNSUBSCRIBE: ${JSON.stringify(unsubscribe)}`);
      // sendMessageToMain(WORKER_PREFIX, 'info', `Received UNSUBSCRIBE: ${JSON.stringify(unsubscribe)}`)
      const subscribe = removeSubscriberFromTrack(unsubscribe.subscribeId)
      if (subscribe != null) {
        console.log(WORKER_PREFIX + ` Removed subscriber for subscribeId: ${subscribe.subscribeId}`);
        // sendMessageToMain(WORKER_PREFIX, 'info', `Removed subscriber for subscribeId: ${subscribe.subscribeId}`)
      } else {
        console.error(WORKER_PREFIX + ` Removing subscriber. Could not find subscribeId: ${subscribe.subscribeId}`);
        // sendMessageToMain(WORKER_PREFIX, 'error', `Removing subscriber. Could not find subscribeId: ${subscribe.subscribeId}`)
      }
      const lastSent = getLastSentFromTrackAlias(subscribe.trackAlias)
      const errorCode = MOQ_SUBSCRIPTION_DONE_ENDED
      const errReason = "Subscription Ended, received unSubscribe"
      await moqSendSubscribeDone(controlWriter, subscribe.subscribeId, errorCode, errReason, lastSent.group, lastSent.obj)
      console.log(WORKER_PREFIX + ` Sent SUBSCRIBE_DONE for subscribeId: ${subscribe.subscribeId}, err: ${errorCode}(${errReason}), last: ${lastSent.group}/${lastSent.obj}`);
      // sendMessageToMain(WORKER_PREFIX, 'info', `Sent SUBSCRIBE_DONE for subscribeId: ${subscribe.subscribeId}, err: ${errorCode}(${errReason}), last: ${lastSent.group}/${lastSent.obj}`)
    }
    else if (moqMsg.type === MOQ_MESSAGE_ANNOUNCE_OK && moqMsg.data.namespace === keepAliveNameSpace) {
      // This is the keep alive answer
    }
    else {
      console.warn(WORKER_PREFIX + ` Unexpected message (type ${moqMsg.type} received, ignoring`);
      // sendMessageToMain(WORKER_PREFIX, 'warning', `Unexpected message (type ${moqMsg.type} received, ignoring`)
    }
  }
}

async function sendChunkToTransport (chunkData, subscribeId, trackAlias, numInflightReqType, maxFlightRequests, moqMapping) {
  if (chunkData == null) {
    return { dropped: true, message: 'chunkData is null' }
  }
  if (numInflightReqType >= maxFlightRequests) {
    return { dropped: true, message: 'too many inflight requests' }
  }
  return createRequest(chunkData, subscribeId, trackAlias, moqMapping)
}

async function createRequest (chunkData, subscribeId, trackAlias, moqMapping) {
  let packet = null

  if (chunkData.mediaType === 'data') {
    // Simple
    packet = new RawPackager()
    packet.SetData('key', chunkData.seqId, chunkData.chunk)
  } else {
    // Media LOC packager
    packet = new LocPackager()
    // actual bytes of encoded data
    const chunkDataBuffer = new Uint8Array(chunkData.chunk.byteLength)
    chunkData.chunk.copyTo(chunkDataBuffer)
    packet.SetData(chunkData.compensatedTs, chunkData.estimatedDuration, chunkData.chunk.type, chunkData.seqId, chunkData.firstFrameClkms, chunkData.metadata, chunkDataBuffer)
  }
  const isHiPri = (chunkData.mediaType === 'audio')

  return createSendPromise(packet, subscribeId, trackAlias, moqMapping, isHiPri)
}

async function createSendPromise (packet, subscribeId, trackAlias, moqMapping, isHiPri) {

  let isFirstObject = false
  if (moqt.wt === null) {
    return { dropped: true, message: `Dropped Object for subscribeId: ${subscribeId}, trackAlias: ${trackAlias}, because transport is NOT open. SeqId: ${packet.GetData().seqId}` }
  }
  if (!(trackAlias in moqPublisherState)) {
    if (packet.GetData().chunkType === 'delta') {
      return { dropped: true, message: `Dropped Object for subscribeId: ${subscribeId}, trackAlias: ${trackAlias}, because first object can not be delta, data: ${packet.GetDataStr()}` }
    }
    moqPublisherState[trackAlias] = createTrackState()
    isFirstObject = true
  }

  const sendOrder = moqCalculateSendOrder(packet, isHiPri)

  // Group sequence, Using it as a joining point
  if (packet.GetData().chunkType !== 'delta') {
    if (!isFirstObject) {
      moqPublisherState[trackAlias].currentGroupSeq++
    }
    moqPublisherState[trackAlias].currentObjectSeq = 0
  }

  const groupSeq = moqPublisherState[trackAlias].currentGroupSeq
  const objSeq = moqPublisherState[trackAlias].currentObjectSeq

  let p = null;
  if (moqMapping === MOQ_MAPPING_OBJECT_PER_DATAGRAM) {
    // Get datagram writer
    const datagramWriter = moqt.wt.datagrams.writable.getWriter();

    // sendMessageToMain(WORKER_PREFIX, 'debug', `Sending Object per datagram. subscribeId: ${subscribeId}, trackAlias: ${trackAlias} ${groupSeq}/${objSeq}(${sendOrder}). Data: ${packet.GetDataStr()}`)

    moqSendObjectPerDatagramToWriter(datagramWriter, subscribeId, trackAlias, groupSeq, objSeq, sendOrder, packet.ToBytes())

    datagramWriter.releaseLock()

    moqPublisherState[trackAlias].currentObjectSeq++
  } else if (moqMapping === MOQ_MAPPING_OBJECT_PER_STREAM) {

    // Get stream writer
    const writterId = createMultiObjectHash('obj', trackAlias, groupSeq, objSeq)
    const uniStream = await moqt.wt.createUnidirectionalStream({ options: { sendOrder } })
    const uniStreamWritter = uniStream.getWriter()

    moqt.multiObjectWritter[writterId] = uniStreamWritter

    // sendMessageToMain(WORKER_PREFIX, 'debug', `Sending Object per stream. subscribeId: ${subscribeId}, trackAlias: ${trackAlias} ${groupSeq}/${objSeq}(${sendOrder}). Data: ${packet.GetDataStr()}`)

    moqSendObjectPerStreamToWriter(uniStreamWritter, subscribeId, trackAlias, groupSeq, objSeq, sendOrder, packet.ToBytes())

    moqPublisherState[trackAlias].currentObjectSeq++

    // Write async
    p = uniStreamWritter.close()
    p.writteId = writterId
  } else if (moqMapping === MOQ_MAPPING_TRACK_PER_STREAM || moqMapping === MOQ_MAPPING_GROUP_PER_STREAM) {
    let writterId = undefined
    let lastWriteId = undefined
    if (moqMapping === MOQ_MAPPING_TRACK_PER_STREAM) {
      writterId = createMultiObjectHash('track', trackAlias)
    } else {
      writterId = createMultiObjectHash('group', trackAlias, groupSeq)
      lastWriteId = createMultiObjectHash('group', trackAlias, groupSeq - 1)
    }

    let uniStreamWritter = null
    if (moqt.multiObjectWritter[writterId] === null || moqt.multiObjectWritter[writterId] === undefined) {
      // Send order will be the sendorder of the 1st obj in that track / group
      const uniStream = await moqt.wt.createUnidirectionalStream({ options: { sendOrder } })
      uniStreamWritter = uniStream.getWriter()
      moqt.multiObjectWritter[writterId] = uniStreamWritter

      // sendMessageToMain(WORKER_PREFIX, 'debug', `Created new multi object ${writterId} writter with sendOrder: ${sendOrder}.`)

      if (moqMapping === MOQ_MAPPING_TRACK_PER_STREAM) {
        moqSendTrackPerStreamHeader(uniStreamWritter, subscribeId, trackAlias, sendOrder)
      } else {
        moqSendGroupPerStreamHeader(uniStreamWritter, subscribeId, trackAlias, groupSeq, sendOrder)
      }

      // Close previous group
      const lastGroupUniStreamWritter = moqt.multiObjectWritter[lastWriteId]
      if (lastGroupUniStreamWritter != undefined) {
        p = lastGroupUniStreamWritter.close()
        p.writteId = lastWriteId
      }
    } else {
      uniStreamWritter = moqt.multiObjectWritter[writterId]
    }

    // Stream already opened
    if (moqMapping === MOQ_MAPPING_TRACK_PER_STREAM) {
      moqSendTrackPerStreamToWriter(uniStreamWritter, groupSeq, objSeq, packet.ToBytes())
    } else {
      moqSendGroupPerStreamToWriter(uniStreamWritter, objSeq, packet.ToBytes())
    }

    moqPublisherState[trackAlias].currentObjectSeq++
  }
  else {
    throw new Error(`Unexpected MOQ - QUIC mapping, received ${moqMapping} - ${MOQ_MAPPING_OBJECT_PER_STREAM}`)
  }

  lastObjectSentMs = Date.now()
  if (p instanceof Promise) {
    p.finally(() => {
      if (moqt.multiObjectWritter[p.writteId] != undefined) {
        delete moqt.multiObjectWritter[p.writteId]
      }
      return { dropped: false, message: `Sent object for subscribeId: ${subscribeId}, trackAlias: ${trackAlias}` }
    })
  }
}

function createMultiObjectHash(mappingType, trackAlias, groupId, objId) {
  return `${mappingType}-${trackAlias}-${groupId}-${objId}`
}

// MOQT

async function moqCreatePublisherSession (moqt) {
  // SETUP
  await moqSendSetup(moqt.controlWriter, MOQ_PARAMETER_ROLE_PUBLISHER)

  const moqMsg = await moqParseMsg(moqt.controlReader)
  if (moqMsg.type !== MOQ_MESSAGE_SERVER_SETUP) {
    throw new Error(`Expected MOQ_MESSAGE_SERVER_SETUP, received ${moqMsg.type}`)
  }
  const setupResponse = moqMsg.data
  // sendMessageToMain(WORKER_PREFIX, 'info', `Received SETUP response: ${JSON.stringify(setupResponse)}`)
  if (setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_SUBSCRIBER && setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_BOTH) {
    throw new Error(`role not supported. Supported  ${MOQ_PARAMETER_ROLE_SUBSCRIBER}, got from server ${JSON.stringify(setupResponse.parameters.role)}`)
  }

  // ANNOUNCE
  const announcedNamespaces = []
  for (const [trackType, trackData] of Object.entries(tracks)) {
    if (!announcedNamespaces.includes(trackData.namespace)) {
      await moqSendAnnounce(moqt.controlWriter, trackData.namespace, trackData.authInfo)
      const moqMsg = await moqParseMsg(moqt.controlReader)
      if (moqMsg.type !== MOQ_MESSAGE_ANNOUNCE_OK && moqMsg.type !== MOQ_MESSAGE_ANNOUNCE_ERROR) {
        throw new Error(`Expected MOQ_MESSAGE_ANNOUNCE_OK or MOQ_MESSAGE_ANNOUNCE_ERROR, received ${moqMsg.type}`)
      }
      if (moqMsg.type === MOQ_MESSAGE_ANNOUNCE_ERROR) {
        throw new Error(`Received ANNOUNCE_ERROR response for ${trackData.namespace}/${trackData.name}-(type: ${trackType}): ${JSON.stringify(moqMsg.data)}`)
      }
      const announceResp = moqMsg.data
      // sendMessageToMain(WORKER_PREFIX, 'info', `Received ANNOUNCE_OK response for ${trackData.id}-${trackType}-${trackData.namespace}: ${JSON.stringify(announceResp)}`)
      if (trackData.namespace !== announceResp.namespace) {
        throw new Error(`expecting namespace ${trackData.namespace}, got ${JSON.stringify(announceResp)}`)
      }
      announcedNamespaces.push(trackData.namespace)
    }
  }

  lastObjectSentMs = Date.now()
}

function checkTrackData () {
  if (Object.entries(tracks).length <= 0) {
    return 'Number of Track Ids to announce needs to be > 0'
  }
  for (const [, track] of Object.entries(tracks)) {
    if (!('namespace' in track) || !('name' in track) || !('authInfo' in track)) {
      return 'Track malformed, needs to contain namespace, name, and authInfo'
    }
  }
  return ''
}

function moqResetState () {
  moqPublisherState = {}
}

function moqCalculateSendOrder (packet, isHiPri) {
  // Prioritize:
  // Audio over video
  // New over old

  let ret = packet.GetData().seqId
  if (ret < 0) {
    // Send now
    ret = Number.MAX_SAFE_INTEGER
  } else {
    if (isHiPri) {
      ret += Math.floor(ret + Number.MAX_SAFE_INTEGER / 2)
    }
  }
  return ret
}

// Create a track state when first object for the track (i.e audio or video) is recieved
function createTrackState () {
  return {
    currentGroupSeq: 0,
    currentObjectSeq: 0,
  }
}

// Get track details from full track name. fullTrackName argument is obtained from subscription request
function getTrackFromFullTrackName (fullTrackName) {
  for (const [, trackData] of Object.entries(tracks)) {
    if (getTrackFullName(trackData.namespace, trackData.name) === fullTrackName) {
      return trackData
    }
  }
  return null
}

// Get track details from track alias. trackAlias argument is obtained from subscription request. No two subscription request has same trackAlias
function getSubscriberTrackFromTrackAlias (trackAlias) {
  for (const [, trackData] of Object.entries(tracks)) {
    if ("subscribers" in trackData && trackData.subscribers.length > 0) {
      let i = 0
      while (i < trackData.subscribers.length) {
        if (trackData.subscribers[i].trackAlias === trackAlias) {
          return trackData
        }
        i++
      }
    }
  }
  return null
}

// Get track details from subscription ID. subscribeId argument is obtained from subscription request. No two subscription request has same Id.
function getSubscriberTrackFromSubscribeID (subscribeId) {
  for (const [, trackData] of Object.entries(tracks)) {
    if ("subscribers" in trackData && trackData.subscribers.length > 0) {
      let i = 0
      while (i < trackData.subscribers.length) {
        if (trackData.subscribers[i].subscribeId === subscribeId) {
          return trackData
        }
        i++
      }
    }
  }
  return null
}

// Remove subscriber by Id during unsubscribe
function removeSubscriberFromTrack (subscribeId) {
  for (const trackData of Object.values(tracks)) {
    if ("subscribers" in trackData && trackData.subscribers.length > 0) {
      let i = 0
      if ('subscribers' in trackData) {
        while (i < trackData.subscribers.length) {
          if (trackData.subscribers[i].subscribeId === subscribeId) {
            const ret = trackData.subscribers[i]
            trackData.subscribers.splice(i, 1)
            return ret
          }
          i++
        }
      }
    }
  }
  return null
}

function getNumInflightRequestByType(moqt, trackType) {
  let ret = 0
  for (const key of Object.keys(moqt.multiObjectWritter)) {
    if (key.startsWith(trackType)) {
      ret++
    }
  }
  return ret
}

function getInflightRequestsReport (moqt) {
  const ret = {}
  for (const [trackType] of Object.entries(tracks)) {
    ret[trackType] = getNumInflightRequestByType(moqt, trackType)
  }
  return ret
}

// Get last object and group sent for trackAlias
function getLastSentFromTrackAlias(trackAlias) {
  const ret = {group: undefined, obj: undefined}
  if (trackAlias in moqPublisherState) {
    ret.group = moqPublisherState[trackAlias].currentGroupSeq
    ret.obj = moqPublisherState[trackAlias].currentObjectSeq
  }
  return ret
}

async function unAnnounceTracks() {
  for (const trackData of Object.values(tracks)) {
      try {
        if (moqt.controlWriter) {
          await moqSendUnAnnounce(moqt.controlWriter, trackData.namespace)
          console.log(WORKER_PREFIX + `Sent UnAnnounce for ${trackData.namespace}`)
        }
        // sendMessageToMain(WORKER_PREFIX, 'info', `Sent UnAnnounce for ${trackData.namespace}`)
      }
      catch (err) {
        // if (MOQT_DEV_MODE) {throw err}
        console.error(WORKER_PREFIX + `on UnAnnounce. Err: ${err}`)
        // sendMessageToMain(WORKER_PREFIX, 'error', `on UnAnnounce. Err: ${err}`)
      }
  }
}
