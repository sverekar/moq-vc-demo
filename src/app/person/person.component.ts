import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CicularAudioSharedBuffer, JitterBuffer, TimeBufferChecker, VideoRenderBuffer } from './common';

declare const MediaStreamTrackProcessor: any;

@Component({
  selector: 'app-person',
  standalone: true,
  imports: [
    CommonModule
  ],
  templateUrl: './person.component.html',
  styleUrl: './person.component.scss'
})
export class PersonComponent implements OnInit, OnChanges {

  @Input() url!: string;
  @Input() auth!: string;
  @Input() namespace!: string;
  @Input() self!: boolean;
  @Input() trackName!: string;

  //Required only for subscribers
  @Input() playerBufferMs: number | undefined
  @Input() playerMaxBufferMs: number | undefined
  @Input() audioJitterBufferMs: number | undefined
  @Input() videoJitterBufferMs: number | undefined

  // Required only for caller / me
  @Input() videoDeviceId: string | undefined;
  @Input() audioDeviceId: string | undefined;
  @Input() resolution!: { width: number; height: number; fps: number; level: number; }

  @Output() readyToPublishEvent = new EventEmitter<boolean>();

  @Output() destroy = new EventEmitter<string>()

  @ViewChild('videoplayer', { static: false }) videoPlayer!: ElementRef;

  videoFramePrinted = false;

  // Me variables
  private vStreamWorker!: Worker;
  private aStreamWorker!: Worker;
  private vEncoderWorker!: Worker;
  private aEncoderWorker!: Worker;
  private muxerSenderWorker!: Worker;

  private VERBOSE = true;
  private AUDIO_STOPPED = 0;
  private AUDIO_PLAYING = 1;
  private RENDER_VIDEO_EVERY_MS = 10;

  private videoEncoderConfig = {
    encoderConfig: {
        codec: 'avc1.42001e', // Baseline = 66, level 30 (see: https://en.wikipedia.org/wiki/Advanced_Video_Coding)
        width: 320,
        height: 180,
        bitrate: 1_000_000, // 1 Mbps
        framerate: 30,
        latencyMode: 'realtime', // Sends 1 chunk per frame
    },
    encoderMaxQueueSize: 2,
    keyframeEvery: 60,
  };

  private audioEncoderConfig = {
    encoderConfig: {
        codec: 'opus', // AAC NOT implemented YET (it is in their roadmap)
        sampleRate: 48000, // To fill later
        numberOfChannels: 1, // To fill later
        bitrate: 32000,
        opus: { // See https://www.w3.org/TR/webcodecs-opus-codec-registration/
            frameDuration: 10000 // In ns. Lower latency than default = 20000
        }
    },
    encoderMaxQueueSize: 10,
  };

  private muxerSenderConfig = {
    urlHostPort: '',
    urlPath: '',
    moqTracks: {
        "audio": {
            namespace: "vc",
            name: "-audio",
            maxInFlightRequests: 100,
            isHipri: true,
            authInfo: "secret",
            moqMapping: 'ObjPerStream',
        },
        "video": {
            namespace: "vc",
            name: "-video",
            maxInFlightRequests: 50,
            isHipri: false,
            authInfo: "secret",
            moqMapping: 'ObjPerStream',
        }
    },
  }

  private downloaderConfig = {
    urlHostPort: '',
    urlPath: '',
    moqTracks: {
        "audio": {
            alias: 0,
            namespace: "vc",
            name: "-audio",
            authInfo: "secret"
        },
        "video": {
            alias: 1,
            namespace: "vc",
            name: "-video",
            authInfo: "secret"
        }
    },
  }

  private timingInfo = {
    muxer: {
        currentAudioTs: -1,
        currentVideoTs: -1,
    },
    decoder: {
        currentAudioTs: -1,
        currentVideoTs: -1,
    },
    renderer: {
        // Estimated audio PTS (assumed PTS is microseconds, and audio and video uses same timescale)
        currentAudioTs: -1,
        currentVideoTs: -1,
    }
  };

  private buffersInfo = {
    decoder: {
        audio: { size: -1, lengthMs: -1, timestampCompensationOffset: -1 },
        video: { size: -1, lengthMs: -1 },
    },
    renderer: {
        audio: { size: -1, lengthMs: -1, sizeMs: -1, state: this.AUDIO_STOPPED },
        video: { size: -1, lengthMs: -1, },
    },
  }

  private currentVideoSize = {
    width: -1,
    height: -1
  }

  private videoTimeChecker!: TimeBufferChecker;
  private audioTimeChecker!: TimeBufferChecker;
  private currentAudioTs: number | undefined = undefined;
  private currentVideoTs: number | undefined = undefined;
  private videoOffsetTS: number | undefined = undefined;
  private audioOffsetTS: number | undefined = undefined;

  // Subscriber / Guest Variable
  private videoRendererBuffer : VideoRenderBuffer | null = null;
  private wtVideoJitterBuffer : JitterBuffer | null = null;
  private wtAudioJitterBuffer : JitterBuffer | null = null;
  private latencyAudioChecker : TimeBufferChecker | null = null;
  private latencyVideoChecker : TimeBufferChecker | null = null;
  private muxerDownloaderWorker!: Worker;
  private audioDecoderWorker!: Worker;
  private videoDecoderWorker!: Worker;

  private audioCtx: any = null;
  private sourceBufferAudioWorklet:AudioWorkletNode | null = null;
  private systemAudioLatencyMs: number = 0;
  private audioSharedBuffer:CicularAudioSharedBuffer | null = null;
  private animFrame: number | null = null;
  private wcLastRender:number = 0;
  private videoPlayerCtx:CanvasRenderingContext2D | null = null;

  ngOnInit(): void {

    this.audioTimeChecker = new TimeBufferChecker("audio");
    this.videoTimeChecker = new TimeBufferChecker("video");

    if (window.crossOriginIsolated) {
      console.log("crossOriginIsolated enabled, we can use SharedArrayBuffer");
    } else {
      console.warn("crossOriginIsolated NOT enabled, we can NOT use SharedArrayBuffer");
    }
    // If subscriber, we have all the information required.
    if (!this.self) {
      this.loadPlayer();
    }

  }

  ngOnChanges(changes: SimpleChanges): void {

    // If me, we need deviceId for audio and video device, this is async and hence we need to check untill we have one.
    if (this.self) {
      if (changes['audioDeviceId']) {
        this.audioDeviceId = changes['audioDeviceId'].currentValue;
      }
      if (changes['videoDeviceId']) {
        this.videoDeviceId = changes['videoDeviceId'].currentValue;
      }
      if (this.audioDeviceId !== null && this.audioDeviceId !== undefined && this.videoDeviceId !== null && this.videoDeviceId !== undefined) {
        let constraints;
        //Remove old stream if present
        if (this.videoPlayer.nativeElement.srcObject != undefined && this.videoPlayer.nativeElement.srcObject != null) {
         const mediaStream = this.videoPlayer.nativeElement.srcObject;
         const videoTracks = mediaStream.getVideoTracks();
         videoTracks.forEach((vTrack: MediaStreamTrack) => {
             vTrack.stop();
         });
         const audioTracks = mediaStream.getAudioTracks();
         audioTracks.forEach((aTrack: MediaStreamTrack) =>{
             aTrack.stop();
         });
         this.videoPlayer.nativeElement.srcObject = null;
        }

       if (this.self) {
         constraints = {
           audio: {
             deviceId: { exact: this.audioDeviceId }
           },
           video: {
             deviceId:  { exact: this.videoDeviceId },
             height: { min: this.resolution?.height, ideal: this.resolution?.height},
             width : { min: this.resolution?.width, ideal: this.resolution?.width}
           }
         };
         navigator.mediaDevices.getUserMedia(constraints)
         .then(mediaStream => {
           // Connect the stream to the preview video element.
           this.videoPlayer.nativeElement.srcObject = mediaStream;
           this.videoFramePrinted = true;
         })
         .then(() => {
           this.videoPlayer.nativeElement.srcObject.getTracks().forEach((track: MediaStreamTrack)  => {
               console.info(`Started preview: ${this.videoDeviceId}, audio: ${this.audioDeviceId} - ${this.resolution?.width}x${this.resolution?.height} From track: ${JSON.stringify(track.getSettings())}`);
           });
         })
         .catch(err => {
           console.error(`Started video preview. Err: ${err}`);
         })
         .finally(() => {

           this.readyToPublishEvent.emit(true);
         });
       }
      }
    } else {
      if (changes['playerBufferMs']) {
        this.playerBufferMs = changes['playerBufferMs'].currentValue;
      }
      if (changes['playerMaxBufferMs']) {
        this.playerMaxBufferMs = changes['playerMaxBufferMs'].currentValue;

      }
      if (changes['audioJitterBufferMs']) {
        this.audioJitterBufferMs = changes['audioJitterBufferMs'].currentValue;
        if (this.wtAudioJitterBuffer !== null && this.wtAudioJitterBuffer !== undefined)  {
          this.wtAudioJitterBuffer.UpdateMaxSize(this.audioJitterBufferMs as number);
        }
      }
      if (changes['videoJitterBufferMs']) {
        this.videoJitterBufferMs = changes['videoJitterBufferMs'].currentValue;
        if (this.wtVideoJitterBuffer !== null && this.wtVideoJitterBuffer !== undefined) {
          this.wtVideoJitterBuffer.UpdateMaxSize(this.videoJitterBufferMs as number);
        }
      }
    }
  }

  async announce(moqVideoQuicMapping: string, moqAudioQuicMapping: string,
    maxInflightVideoRequests: number, maxInflightAudioRequests: number, videoEncodingKeyFrameEvery: number,
    videoEncodingBitrateBps: number, audioEncodingBitrateBps: number
  ): Promise<boolean> {

    if (this.videoPlayer.nativeElement.srcObject == undefined || this.videoPlayer.nativeElement.srcObject == null) {
      console.error("Preview is not set, we can not start a publish session");
      return Promise.resolve(false);
    }
    const mediaStream = this.videoPlayer.nativeElement.srcObject
    if (mediaStream.getVideoTracks().length <= 0) {
        console.error("Publish session can not be started without video tracks in preview");
        return Promise.resolve(false);
    }
    if (mediaStream.getAudioTracks().length <= 0) {
        console.error("Publish session can not be started without audio tracks in preview");
        return Promise.resolve(false);
    }

    try {

      this.createWebWorkers();

      // Print messages from the worker in the console
      this.vStreamWorker.addEventListener('message', (e: MessageEvent<any>) => {
        this.encoderProcessWorkerMessage(e);
      });
      this.aStreamWorker.addEventListener('message', (e: MessageEvent<any>) =>  {
        this.encoderProcessWorkerMessage(e);
      });
      this.vEncoderWorker.addEventListener('message', (e: MessageEvent<any>) => {
        console.log('Message from vEncoderWorker: ', e)
        this.encoderProcessWorkerMessage(e);
      });
      this.aEncoderWorker.addEventListener('message', (e: MessageEvent<any>) => {
        console.log('Message from aEncoderWorker: ', e)
        this.encoderProcessWorkerMessage(e);
      });
      this.muxerSenderWorker.addEventListener('message', (e: MessageEvent<any>) => {
        console.log('Message from muxerSenderWorker: ', e)
        this.encoderProcessWorkerMessage(e);
      });

      const vTrack = mediaStream.getVideoTracks()[0];
      const vProcessor = new MediaStreamTrackProcessor(vTrack);
      const vFrameStream = vProcessor.readable;

      const aTrack = mediaStream.getAudioTracks()[0];
      const aProcessor = new MediaStreamTrackProcessor(aTrack);
      const aFrameStream = aProcessor.readable;

      // Load video encoding settings
      this.videoEncoderConfig.encoderConfig.width = this.resolution!.width;
      this.videoEncoderConfig.encoderConfig.height = this.resolution!.height;
      this.videoEncoderConfig.encoderConfig.framerate = this.resolution!.fps;
      this.videoEncoderConfig.encoderConfig.codec = this.getCodecString("avc1", 66, this.resolution!.level);
      this.videoEncoderConfig.encoderConfig.bitrate = videoEncodingBitrateBps;
      this.videoEncoderConfig.keyframeEvery = videoEncodingKeyFrameEvery;

      // Load audio encoding settings
      this.audioEncoderConfig.encoderConfig.bitrate = audioEncodingBitrateBps;

      this.vEncoderWorker.postMessage({ type: "vencoderini", encoderConfig: this.videoEncoderConfig.encoderConfig, encoderMaxQueueSize: this.videoEncoderConfig.encoderMaxQueueSize, keyframeEvery: this.videoEncoderConfig.keyframeEvery });
      this.aEncoderWorker.postMessage({ type: "aencoderini", encoderConfig: this.audioEncoderConfig.encoderConfig, encoderMaxQueueSize: this.audioEncoderConfig.encoderMaxQueueSize });

      // Transport
      // Get url data
      this.muxerSenderConfig.urlHostPort = this.url!;

      //Get max Inflight requests & auth info
      this.muxerSenderConfig.moqTracks["video"].namespace = this.namespace!;
      this.muxerSenderConfig.moqTracks["video"].name = this.trackName + "-video";
      this.muxerSenderConfig.moqTracks["video"].maxInFlightRequests = maxInflightVideoRequests;
      this.muxerSenderConfig.moqTracks["video"].authInfo = this.auth!;
      this.muxerSenderConfig.moqTracks["video"].moqMapping = moqVideoQuicMapping;

      this.muxerSenderConfig.moqTracks["audio"].namespace = this.namespace!;
      this.muxerSenderConfig.moqTracks["audio"].name = this.trackName  + "-audio";
      this.muxerSenderConfig.moqTracks["audio"].maxInFlightRequests = maxInflightAudioRequests;
      this.muxerSenderConfig.moqTracks["audio"].authInfo = this.auth!;
      this.muxerSenderConfig.moqTracks["audio"].moqMapping = moqAudioQuicMapping

      this.muxerSenderWorker.postMessage({ type: "muxersendini", muxerSenderConfig: this.muxerSenderConfig });

      // Transfer the readable stream to the worker.
      this.vStreamWorker.postMessage({ type: "stream", vStream: vFrameStream }, [vFrameStream]);
      this.aStreamWorker.postMessage({ type: "stream", aStream: aFrameStream }, [aFrameStream]);

      return Promise.resolve(true);

    } catch (error) {
      console.log('Failure while announcing: ', error);
      return Promise.resolve(false);
    }
  }

  async stop () {

    if (this.self) {
      // Clear me / announce variables
      const stopMsg = { type: "stop" };
      if (this.aStreamWorker) {
        this.aStreamWorker.postMessage(stopMsg);
        this.aStreamWorker.terminate();
      }
      if (this.vStreamWorker) {
        this.vStreamWorker.postMessage(stopMsg);
        this.vStreamWorker.terminate();
      }
      if (this.vEncoderWorker) {
        this.vEncoderWorker.postMessage(stopMsg);
        this.vEncoderWorker.terminate();
      }
      if (this.aEncoderWorker) {
        this.aEncoderWorker.postMessage(stopMsg);
        this.aEncoderWorker.terminate();
      }
      if (this.muxerSenderWorker) {
        this.muxerSenderWorker.postMessage(stopMsg);
        this.muxerSenderWorker.terminate();
      }
      this.currentAudioTs = undefined;
      this.currentVideoTs = undefined;
      this.videoOffsetTS = undefined;
      this.audioOffsetTS = undefined;
      if (this.audioTimeChecker !== null) {
        this.audioTimeChecker.Clear();
      }
      if (this.videoTimeChecker !== null) {
        this.videoTimeChecker.Clear();
      }
    } else {
      // Clear subsbcriber variables
      if (this.animFrame != null) {
        cancelAnimationFrame(this.animFrame);
      }
      // stop workers
      const stopMsg = { type: "stop" };
      if (this.muxerDownloaderWorker) {
        this.muxerDownloaderWorker.postMessage(stopMsg);
        this.muxerDownloaderWorker.terminate();
      }
      if (this.videoDecoderWorker) {
        this.videoDecoderWorker.postMessage(stopMsg);
        this.videoDecoderWorker.terminate();
      }
      if (this.audioDecoderWorker) {
        this.audioDecoderWorker.postMessage(stopMsg);
        this.audioDecoderWorker.terminate();
      }
      if (this.audioCtx) {
        await this.audioCtx.close();
      }
      this.audioCtx = null;
      this.sourceBufferAudioWorklet = null;
      if (this.audioSharedBuffer) {
        this.audioSharedBuffer.Clear();
        this.audioSharedBuffer = null;
      }
      // clear timing information
      this.timingInfo.muxer.currentAudioTs = -1;
      this.timingInfo.muxer.currentVideoTs = -1;

      this.timingInfo.decoder.currentAudioTs = -1;
      this.timingInfo.decoder.currentVideoTs = -1;

      this.timingInfo.renderer.currentAudioTs = -1;
      this.timingInfo.renderer.currentVideoTs = -1;

      // clear buffer info
      this.buffersInfo.decoder.audio.size = -1;
      this.buffersInfo.decoder.audio.lengthMs = -1;
      this.buffersInfo.decoder.video.size = -1;
      this.buffersInfo.decoder.video.lengthMs = -1;

      this.buffersInfo.renderer.audio.size = -1;
      this.buffersInfo.renderer.audio.lengthMs = -1;
      this.buffersInfo.renderer.audio.state = this.AUDIO_STOPPED;
      this.buffersInfo.renderer.video.size = -1;
      this.buffersInfo.renderer.video.lengthMs = -1;

      this.currentVideoSize.width = -1;
      this.currentVideoSize.height = -1;

      this.videoPlayerCtx = null;
      this.animFrame = null;
      // clear jitter buffer
      if (this.wtAudioJitterBuffer) {
        this.wtAudioJitterBuffer.Clear();
      }
      if (this.wtVideoJitterBuffer) {
        this.wtVideoJitterBuffer.Clear();
      }
      //clear time checker
      if (this.latencyAudioChecker) {
        this.latencyAudioChecker.Clear();
      }
      if (this.latencyVideoChecker) {
        this.latencyVideoChecker.Clear();
      }
      //clear video renderer
      if (this.videoRendererBuffer) {
        this.videoRendererBuffer.Clear();
      }
      this.videoRendererBuffer = null;
      this.destroy.emit(this.namespace + '/' + this.trackName);
      this.videoFramePrinted = false;
    }

  }

  // ME / ANNOUNCE FUNCTIONS
  private encoderProcessWorkerMessage(e: MessageEvent<any>): void {

    // LOGGING
    if ((e.data.type === "debug") && (this.VERBOSE === true)) {
        console.debug(e.data.data);
    } else if (e.data.type === "info") {
        console.log(e.data.data);
    } else if (e.data.type === "error") {
        console.error(e.data.data);
    } else if (e.data.type === "warning") {
        console.warn(e.data.data);
    // ENCODING
    } else if (e.data.type === "vframe") {
        const vFrame = e.data.data;
        let estimatedDuration = -1;
        if (this.currentVideoTs == undefined) {
          if (this.audioOffsetTS == undefined) {
              // Start video at 0
              this.videoOffsetTS = -vFrame.timestamp; // Comp video starts 0
          } else {
              // Adjust video offset to last audio seen (most probable case since audio startsup faster)
              this.videoOffsetTS = -vFrame.timestamp + this.currentAudioTs! + this.audioOffsetTS; // Comp video starts last audio seen
          }
        } else {
          estimatedDuration = vFrame.timestamp - this.currentVideoTs;
        }
        this.currentVideoTs = vFrame.timestamp;
        this.videoTimeChecker.AddItem({ ts: this.currentVideoTs, compensatedTs: this.currentVideoTs! + this.videoOffsetTS!, estimatedDuration: estimatedDuration, clkms: e.data.clkms });
        // Send the video frame obtained from v_capture.js to video encoder
        this.vEncoderWorker.postMessage({ type: "vframe", vframe: vFrame }, [vFrame]);
    } else if (e.data.type === "aframe") {
        const aFrame = e.data.data;
        let estimatedDuration = -1;
        if (this.currentAudioTs == undefined) {
            if (this.videoOffsetTS == undefined) {
                // Start audio at 0
                this.audioOffsetTS = -aFrame.timestamp; // Comp audio starts 0
            } else {
                // Adjust audio offset to last video seen
                this.audioOffsetTS = -aFrame.timestamp + this.currentVideoTs! + this.videoOffsetTS; // Comp audio starts last video seen
            }
        } else {
            estimatedDuration = aFrame.timestamp - this.currentAudioTs;
        }
        this.currentAudioTs = aFrame.timestamp;
        this.audioTimeChecker.AddItem({ ts: this.currentAudioTs, compensatedTs: this.currentAudioTs! + this.audioOffsetTS!, estimatedDuration: estimatedDuration, clkms: e.data.clkms });
        // Send the frame obtained from a_capture.js to audio encoder
        this.aEncoderWorker.postMessage({ type: "aframe", aframe: aFrame });

    // DROPPED frames by encoders
    } else if (e.data.type === "dropped") {

      // As of now, just logging the dropped frame.
      const droppedFrameData = e.data.data;
      console.log("Dropped Event: ", droppedFrameData)

    // CHUNKS from encoders
    } else if (e.data.type === "vchunk") {
        const chunk = e.data.chunk;
        const metadata = e.data.metadata;
        const seqId = e.data.seqId;
        const itemTsClk = this.videoTimeChecker.GetItemByTs(chunk.timestamp);
        if (!itemTsClk.valid) {
            console.warn(`Not found clock time <-> TS for that video frame, this should not happen.  ts: ${chunk.timestamp}, id:${seqId}`);
        }
        // Send the encoded video chunk obtained from v_encoder.js to moq_sender.js
        this.muxerSenderWorker.postMessage({ type: "video", firstFrameClkms: itemTsClk.clkms, compensatedTs: itemTsClk.compensatedTs, estimatedDuration: itemTsClk.estimatedDuration, seqId: seqId, chunk: chunk, metadata: metadata });

    } else if (e.data.type === "achunk") {
        const chunk = e.data.chunk;
        const metadata = e.data.metadata;
        const seqId = e.data.seqId;
        const itemTsClk = this.audioTimeChecker.GetItemByTs(chunk.timestamp);
        if (!itemTsClk.valid) {
            console.info(`Not found clock time <-> TS for audio frame, this could happen. ts: ${chunk.timestamp}, id:${seqId}`);
        }
          // Send the encoded audio chunk obtained from a_encoder.js to moq_sender.js
        this.muxerSenderWorker.postMessage({ type: "audio", firstFrameClkms: itemTsClk.clkms, compensatedTs: itemTsClk.compensatedTs, seqId: seqId, chunk: chunk, metadata: metadata });

    // CHUNKS STATS
    } else if (e.data.type === "sendstats") {

      // Stats from moq_sender.js
      console.log("sendstats", this.currentAudioTs, this.currentVideoTs, e.data);

    // UNKNOWN
    } else {
        console.error("unknown message: " + e.data);
    }
  }

  private getCodecString(codec: string, profile: number, level: number) {
    return codec + "." + profile.toString(16).toUpperCase().padStart(2, '0') + "00" + level.toString(16).toUpperCase().padStart(2, '0');
  }

  private createWebWorkers() {

    this.vStreamWorker = new Worker("../../assets/js/capture/v_capture.js", { type: "module" });
    this.aStreamWorker = new Worker("../../assets/js/capture/a_capture.js", { type: "module" });

    // Create a new workers for video / audio frames encode
    this.vEncoderWorker = new Worker("../../assets/js/encode/v_encoder.js", { type: "module" });
    this.aEncoderWorker = new Worker("../../assets/js/encode/a_encoder.js", { type: "module" });

    // Create send worker
    this.muxerSenderWorker = new Worker("../../assets/js/sender/moq_sender.js", { type: "module" });
  }

  // SUBCRIBER Functions

  private loadPlayer() {

    const self =  this;

    self.videoRendererBuffer = new VideoRenderBuffer();
    self.latencyAudioChecker = new TimeBufferChecker("audio");
    self.latencyVideoChecker = new TimeBufferChecker("video");
    self.wtVideoJitterBuffer = new JitterBuffer(self.videoJitterBufferMs!, (data: any) =>  console.warn(`[VIDEO-JITTER] Dropped late video frame. seqId: ${data.seqId}, currentSeqId:${data.firstBufferSeqId}`));
    self.wtAudioJitterBuffer = new JitterBuffer(self.audioJitterBufferMs!, (data: any) =>  console.warn(`[AUDIO-JITTER] Dropped late audio frame. seqId: ${data.seqId}, currentSeqId:${data.firstBufferSeqId}`));

    self.muxerDownloaderWorker = new Worker("../../assets/js/receiver/moq_demuxer_downloader.js", {type: "module"});
    self.audioDecoderWorker = new Worker("../../assets/js/decode/audio_decoder.js", {type: "module"});
    self.videoDecoderWorker = new Worker("../../assets/js/decode/video_decoder.js", {type: "module"});

    this.playerAudioTimestamps = this.playerAudioTimestamps.bind(this);

    self.muxerDownloaderWorker.addEventListener('message', function (e) {
      self.playerProcessWorkerMessage(e);
    });
    self.videoDecoderWorker.addEventListener('message', function (e) {
      self.playerProcessWorkerMessage(e);
    });
    self.audioDecoderWorker.addEventListener('message', function (e) {
      self.playerProcessWorkerMessage(e);
    });

    self.downloaderConfig.urlHostPort = this.url;
    self.downloaderConfig.moqTracks["video"].namespace = this.namespace;
    self.downloaderConfig.moqTracks["video"].name = this.trackName + "-video";
    self.downloaderConfig.moqTracks["video"].authInfo = this.auth;

    self.downloaderConfig.moqTracks["audio"].namespace = this.namespace;
    self.downloaderConfig.moqTracks["audio"].name = this.trackName + "-audio";
    self.downloaderConfig.moqTracks["audio"].authInfo = this.auth;

    self.muxerDownloaderWorker.postMessage({ type: "downloadersendini", downloaderConfig: this.downloaderConfig});
  }

  private async playerProcessWorkerMessage(e: MessageEvent<any>) {

    if ((e.data.type === "debug") && (this.VERBOSE === true)) {
      console.debug(e.data.data);
    } else if (e.data.type === "info") {
      console.log(e.data.data);
    } else if (e.data.type === "error") {
      console.error(e.data.data);
    } else if (e.data.type === "warning") {
      console.warn(e.data.data);
    // CHUNKS
    } else if (e.data.type === "videochunk") {
      const chunk = e.data.chunk;
      const seqId = e.data.seqId;
      const extraData = { captureClkms: e.data.captureClkms, metadata: e.data.metadata }
      if (this.wtVideoJitterBuffer != null) {
          const orderedVideoData = this.wtVideoJitterBuffer.AddItem(chunk, seqId, extraData);
          if (orderedVideoData !== undefined) {
              // Download is sequential
              if (orderedVideoData.isDisco) {
                  console.warn(`VIDEO DISCO detected in seqId: ${orderedVideoData.seqId}`);
              }
              if (orderedVideoData.repeatedOrBackwards) {
                  console.warn(`VIDEO Repeated or backwards chunk, discarding, seqId: ${orderedVideoData.seqId}`);
              } else {
                  // Adds pts to wallClk info
                  this.latencyVideoChecker!.AddItem({ ts: orderedVideoData.chunk.timestamp, clkms: orderedVideoData.extraData.captureClkms});
                  this.timingInfo.muxer.currentVideoTs = orderedVideoData.chunk.timestamp;
                  this.videoDecoderWorker.postMessage({ type: "videochunk", seqId: orderedVideoData.seqId, chunk: orderedVideoData.chunk, metadata: orderedVideoData.extraData.metadata, isDisco: orderedVideoData.isDisco });
              }
          }
      }
    } else if (e.data.type === "audiochunk") {
      const chunk = e.data.chunk;
      const seqId = e.data.seqId;
      const extraData = {captureClkms: e.data.captureClkms, metadata: e.data.metadata}
      if (this.wtAudioJitterBuffer != null) {
          const orderedAudioData = this.wtAudioJitterBuffer.AddItem(chunk, seqId, extraData);
          if (orderedAudioData !== undefined) {
              // Download is sequential
              if (orderedAudioData.isDisco) {
                  console.warn(`AUDIO DISCO detected in seqId: ${orderedAudioData.seqId}`);
              }
              if (orderedAudioData.repeatedOrBackwards) {
                  console.warn(`AUDIO Repeated or backwards chunk, discarding, seqId: ${orderedAudioData.seqId}`);
              } else {
                  // Adds pts to wallClk info
                  this.latencyAudioChecker!.AddItem({ ts: orderedAudioData.chunk.timestamp, clkms: orderedAudioData.extraData.captureClkms});
                  this.timingInfo.muxer.currentAudioTs = orderedAudioData.chunk.timestamp;
                  this.audioDecoderWorker.postMessage({ type: "audiochunk", seqId: orderedAudioData.seqId, chunk: orderedAudioData.chunk, metadata: orderedAudioData.extraData.metadata, isDisco: orderedAudioData.isDisco });
              }
          }
      }
      // FRAME
    } else if (e.data.type === "aframe") {

      const aFrame = e.data.frame;

      // currentAudioTs needs to be compesated with GAPs more info in audio_decoder.js
      this.timingInfo.decoder.currentAudioTs = aFrame.timestamp + e.data.timestampCompensationOffset;
      this.buffersInfo.decoder.audio.timestampCompensationOffset = e.data.timestampCompensationOffset;

      this.buffersInfo.decoder.audio.size = e.data.queueSize;
      this.buffersInfo.decoder.audio.lengthMs = e.data.queueLengthMs;

      if (this.audioCtx == null && aFrame.sampleRate != undefined && aFrame.sampleRate > 0) {
          // Initialize the audio when we know sampling freq used in the capture
          await this.playerInitializeAudioContext(aFrame.sampleRate);
      }
      // If audioSharedBuffer not initialized and is in start (render) state -> Initialize
      if (this.audioCtx != null && this.sourceBufferAudioWorklet != null && this.audioSharedBuffer === null) {
          this.buffersInfo.renderer.audio.sizeMs = Math.max(this.playerMaxBufferMs!, this.playerBufferMs! * 2, 100);
          const bufferSizeSamples = Math.floor((this.buffersInfo.renderer.audio.sizeMs * aFrame.sampleRate) / 1000);

          this.audioSharedBuffer = new CicularAudioSharedBuffer();
          this.audioSharedBuffer.Init(aFrame.numberOfChannels, bufferSizeSamples, this.audioCtx.sampleRate);
          this.audioSharedBuffer.SetCallbacks((droppedFrameData: any) => {
            const clkms = droppedFrameData.clkms;
            const ts = droppedFrameData.ts;
            const msg = droppedFrameData.msg;
            let seqId = droppedFrameData.msg;
            if ('seqId' in droppedFrameData) {
                seqId = droppedFrameData.seqId;
            }
            const str = new Date(clkms).toISOString() + " (" + ts + ")(" + seqId + ") " + msg;
            console.log('Dropped frame data in circular audio shared buffer: ' + str, droppedFrameData)
          });
          // Set the audio context sampling freq, and pass buffers
          this.sourceBufferAudioWorklet.port.postMessage({ type: 'iniabuffer', config: { contextSampleFrequency: this.audioCtx.sampleRate, circularBufferSizeSamples: bufferSizeSamples, cicularAudioSharedBuffers: this.audioSharedBuffer.GetSharedBuffers(), sampleFrequency: aFrame.sampleRate } });
      }

      if (this.audioSharedBuffer != null) {
          // Uses compensated TS
          this.audioSharedBuffer.Add(aFrame, this.timingInfo.decoder.currentAudioTs);

          if (this.animFrame === null) {
              this.animFrame = requestAnimationFrame(this.playerAudioTimestamps);
          }
      }
  } else if (e.data.type === "vframe") {
      const vFrame = e.data.frame;
      this.timingInfo.decoder.currentVideoTs = vFrame.timestamp;

      this.buffersInfo.decoder.video.size = e.data.queueSize;
      this.buffersInfo.decoder.video.lengthMs = e.data.queueLengthMs;

      if (this.videoRendererBuffer != null && this.videoRendererBuffer.AddItem(vFrame) === false) {
          console.warn("Dropped video frame because video renderer is full");
          vFrame.close();
      }

  // Downloader STATS
  } else if (e.data.type === "downloaderstats") {
      const downloaderData = e.data.data;
      console.log('Downloader data: ', downloaderData)

  // Dropped
  } else if (e.data.type === "dropped") {
      console.log("Dropped Event: ", e.data.type)

  // UNKNOWN
  } else {
      console.error("unknown message: " + JSON.stringify(e.data));
  }

  }

  private async playerInitializeAudioContext(desiredSampleRate: number) {
    return new Promise((resolve, reject) => {
        if (this.audioCtx == null) {
            this.audioCtx = new AudioContext({ latencyHint: "interactive", sampleRate: desiredSampleRate });
            this.audioCtx.transitioning = false;
            // Add worklet
            this.audioCtx.audioWorklet.addModule('../../assets/js/render/source_buffer_worklet.js')
                .then(() => {
                    this.sourceBufferAudioWorklet = new AudioWorkletNode(this.audioCtx, 'source-buffer');
                    // AudioWorkletNode can be interoperable with other native AudioNodes.
                    this.sourceBufferAudioWorklet.port.onmessage = (e) => {
                        // Handling data from the processor.
                        this.playerProcessWorkerMessage(e);
                    };
                    this.sourceBufferAudioWorklet.onprocessorerror = (event) => {
                        console.error('Audio worklet error. Err: ' + JSON.stringify(event));
                    };

                    // Connect to audio renderer
                    this.sourceBufferAudioWorklet.connect(this.audioCtx.destination);
                    this.systemAudioLatencyMs = (this.audioCtx.outputLatency + this.audioCtx.baseLatency) * 1000;
                    console.debug('Audio system latency (ms): ' + this.systemAudioLatencyMs);
                    return resolve(null);
                });
        }
        else {
            return resolve(null);
        }
    });
  }

  private playerAudioTimestamps(wcTimestamp: number) {
    console.log(this)
    const wcInterval = wcTimestamp - this.wcLastRender;

    if (this.audioSharedBuffer != null) {
      const data = this.audioSharedBuffer.GetStats();
      // Audio render stats
      this.timingInfo.renderer.currentAudioTs = data.currentTimestamp;
      this.buffersInfo.renderer.audio.size = data.queueSize; // In samples
      this.buffersInfo.renderer.audio.lengthMs = data.queueLengthMs; // In ms
      if (data.isPlaying) {
          this.buffersInfo.renderer.audio.state = this.AUDIO_PLAYING;
      }
      if (this.buffersInfo.renderer.audio.lengthMs >= this.playerBufferMs! && this.buffersInfo.renderer.audio.state === this.AUDIO_STOPPED) {
        this.audioSharedBuffer.Play();
      }
    }

    // Update every 10ms
    if ((this.audioCtx != null) && (wcInterval > this.RENDER_VIDEO_EVERY_MS)) {
        this.wcLastRender = wcTimestamp;

        if (this.videoRendererBuffer != null && this.timingInfo.renderer.currentAudioTs >= 0) {
            // Assuming audioTS in microseconds
            const compensatedAudioTS = Math.max(0, this.timingInfo.renderer.currentAudioTs - (this.systemAudioLatencyMs * 1000));
            const retData = this.videoRendererBuffer.GetItemByTs(compensatedAudioTS);
            if (retData.vFrame != null) {
                this.videoFramePrinted = true;
                this.playerSetVideoSize(retData.vFrame);
                this.videoPlayerCtx?.drawImage(retData.vFrame, 0, 0, (retData.vFrame as VideoFrame).displayWidth, (retData.vFrame as VideoFrame).displayHeight);
                this.timingInfo.renderer.currentVideoTs = (retData.vFrame as VideoFrame).timestamp;
                this.buffersInfo.renderer.video.size = retData.queueSize;
                this.buffersInfo.renderer.video.lengthMs = retData.queueLengthMs;
                if (this.latencyVideoChecker != null) {
                    const frameClosestData = this.latencyVideoChecker.GetItemByTs(this.timingInfo.renderer.currentVideoTs, true);
                    if (frameClosestData.valid) {
                        const currentLatencyMs = (Date.now() - Number(frameClosestData.clkms));
                        console.log('latencyVideoMs: ', currentLatencyMs)
                    }
                }
                (retData.vFrame as VideoFrame).close();
            } else {
                console.debug("NO FRAME to paint");
            }
        }
    }

    if (this.latencyAudioChecker != null) {
        const frameClosestData = this.latencyAudioChecker.GetItemByTs(Math.floor(this.timingInfo.renderer.currentAudioTs), false);
        if (frameClosestData.valid) {
            const currentLatencyMs = this.systemAudioLatencyMs + (Date.now() - Number(frameClosestData.clkms));
            console.log('latencyAudioMs: ',`${currentLatencyMs.toFixed(0)} ms (System: ${this.systemAudioLatencyMs.toFixed(0)} ms)`)
        }
    }
    this.animFrame = requestAnimationFrame(this.playerAudioTimestamps);
  }

  private playerSetVideoSize(vFrame: VideoFrame) {
    let needsSet = false;

    if (vFrame.displayWidth != this.currentVideoSize.width) {
        this.currentVideoSize.width = vFrame.displayWidth;
        needsSet = true;
    }
    if (vFrame.displayHeight != this.currentVideoSize.height) {
        this.currentVideoSize.height = vFrame.displayHeight;
        needsSet = true;
    }
    if (needsSet) {
        this.videoPlayer.nativeElement.width = this.currentVideoSize.width;
        this.videoPlayer.nativeElement.height = this. currentVideoSize.height;

        // Video player ctx
        this.videoPlayerCtx = this.videoPlayer.nativeElement.getContext('2d');
    }
  }

}
