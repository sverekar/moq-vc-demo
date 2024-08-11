import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, OnInit, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CicularAudioSharedBuffer, JitterBuffer, TimeBufferChecker, VideoRenderBuffer } from '../common';
import { AudioService } from '../audio.service';

declare const MediaStreamTrackProcessor: any;

@Component({
  selector: 'app-person',
  standalone: true,
  imports: [
    CommonModule
  ],
  templateUrl: './person.component.html',
  styleUrl: './person.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonComponent implements OnInit, OnChanges, OnDestroy {

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

  @Input() index!: number

  // Required only for caller / me
  @Input() videoDeviceId: string | undefined;
  @Input() audioDeviceId: string | undefined;
  @Input() resolution!: { width: number; height: number; fps: number; level: number; }

  @Output() stats = new EventEmitter<any>();
  @Output() destroy = new EventEmitter<string>()
  @Output() publish = new EventEmitter<boolean>()

  @ViewChild('videoplayer', { static: false }) videoPlayer!: ElementRef;

  videoFramePrinted = false;
  mute = true;

  // Me variables
  private vStreamWorker!: Worker;
  private aStreamWorker!: Worker;
  private vEncoderWorker!: Worker;
  private aEncoderWorker!: Worker;
  private muxerSenderWorker!: Worker;

  private AUDIO_STOPPED = 0;


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
  private muxerDownloaderWorker!: Worker;
  private audioDecoderWorker!: Worker;
  private videoDecoderWorker!: Worker;

  private audioCtx: any  = null;
  private sourceBufferAudioWorklet:AudioWorkletNode | null = null;
  gain: GainNode | null  = null;
  private systemAudioLatencyMs: number = 0;
  private audioSharedBuffer:CicularAudioSharedBuffer | null = null;
  private videoPlayerCtx:CanvasRenderingContext2D | null = null;

  constructor(private ngZone: NgZone, private ref: ChangeDetectorRef, private audioService: AudioService ) {}

  ngOnDestroy(): void {
    this.stop();
  }

  ngOnInit(): void {

    if (window.crossOriginIsolated) {
      console.log("crossOriginIsolated enabled, we can use SharedArrayBuffer");
    } else {
      console.warn("crossOriginIsolated NOT enabled, we can NOT use SharedArrayBuffer");
    }
    // If subscriber, we have all the information required.
    if (!this.self) {
      this.loadPlayer();
    } else {
      this.audioTimeChecker = new TimeBufferChecker("audio");
      this.videoTimeChecker = new TimeBufferChecker("video");
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
           this.publish.emit(true);
         });
       }
      }
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
      this.audioCtx = null;
      this.gain = null;
      this.mute = true;
      this.sourceBufferAudioWorklet = null;
      if (this.audioSharedBuffer) {
        this.audioSharedBuffer.Clear();
        this.audioSharedBuffer = null;
      }

      this.currentVideoSize.width = -1;
      this.currentVideoSize.height = -1;
      this.videoPlayerCtx = null;

      // clear jitter buffer
      if (this.wtAudioJitterBuffer) {
        this.wtAudioJitterBuffer.Clear();
      }
      if (this.wtVideoJitterBuffer) {
        this.wtVideoJitterBuffer.Clear();
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

      this.ngZone.runOutsideAngular(() => {
        this.muxerSenderWorker.addEventListener('message', (e: MessageEvent<any>) => {
          if (e.data.type === 'started') {
            this.initalizeWorkers(videoEncodingBitrateBps,videoEncodingKeyFrameEvery, audioEncodingBitrateBps, mediaStream);
          } else {
            this.encoderProcessWorkerMessage(e);
          }
        });
        this.vStreamWorker.addEventListener('message', (e: MessageEvent<any>) => {
          this.encoderProcessWorkerMessage(e);
        });
        this.aStreamWorker.addEventListener('message', (e: MessageEvent<any>) =>  {
          this.encoderProcessWorkerMessage(e);
        });
        this.vEncoderWorker.addEventListener('message', (e: MessageEvent<any>) => {
          this.encoderProcessWorkerMessage(e);
        });
        this.aEncoderWorker.addEventListener('message', (e: MessageEvent<any>) => {
          this.encoderProcessWorkerMessage(e);
        });
      });

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

      this.muxerSenderConfig.urlHostPort = this.url!;

      this.muxerSenderWorker.postMessage({ type: "muxersendini", muxerSenderConfig: this.muxerSenderConfig });

      return Promise.resolve(true);

    } catch (error) {
      console.log('Failure while announcing: ', error);
      return Promise.resolve(false);
    }
  }

  private initalizeWorkers(videoEncodingBitrateBps: number, videoEncodingKeyFrameEvery: number, audioEncodingBitrateBps: number, mediaStream: any) {

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

    const vTrack = mediaStream.getVideoTracks()[0];
    const vProcessor = new MediaStreamTrackProcessor(vTrack);
    const vFrameStream = vProcessor.readable;

    const aTrack = mediaStream.getAudioTracks()[0];
    const aProcessor = new MediaStreamTrackProcessor(aTrack);
    const aFrameStream = aProcessor.readable;

    // Transfer the readable stream to the worker.
    this.vStreamWorker.postMessage({ type: "stream", vStream: vFrameStream }, [vFrameStream]);
    this.aStreamWorker.postMessage({ type: "stream", aStream: aFrameStream }, [aFrameStream]);

  }

  private encoderProcessWorkerMessage(e: MessageEvent<any>): void {

    // LOGGING
    if (e.data.type === "vframe") {
        const vFrame = e.data.data;
        let estimatedDuration = -1;
        if (this.currentVideoTs == undefined) {
          if (this.audioOffsetTS == undefined) {
              // Start video at 0
              this.videoOffsetTS = -vFrame.timestamp; // Comp video starts 0
          } else {
              // Adjust video offset to last audio seen (most probable case since audio startsup faster)
              this.videoOffsetTS = -vFrame.timestamp + (this.currentAudioTs || 0) + (this.audioOffsetTS || 0); // Comp video starts last audio seen
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
            console.warn(`Not found clock time <-> TS for audio frame, this could happen. ts: ${chunk.timestamp}, id:${seqId}`);
        }
        // Send the encoded audio chunk obtained from a_encoder.js to moq_sender.js
        this.muxerSenderWorker.postMessage({ type: "audio", firstFrameClkms: itemTsClk.clkms, compensatedTs: itemTsClk.compensatedTs, seqId: seqId, chunk: chunk, metadata: metadata });
    } else {
      console.error("unknown message: ", e.data);
    }
  }

  private getCodecString(codec: string, profile: number, level: number) {
    return codec + "." + profile.toString(16).toUpperCase().padStart(2, '0') + "00" + level.toString(16).toUpperCase().padStart(2, '0');
  }

  private createWebWorkers() {

    // Create send worker
    this.muxerSenderWorker = new Worker("../../assets/js/sender/moq_sender.js", { type: "module" });

    // Create a new workers for video / audio frames encode
    this.vEncoderWorker = new Worker("../../assets/js/encode/v_encoder.js", { type: "module" });
    this.aEncoderWorker = new Worker("../../assets/js/encode/a_encoder.js", { type: "module" });

    this.vStreamWorker = new Worker("../../assets/js/capture/v_capture.js", { type: "module" });
    this.aStreamWorker = new Worker("../../assets/js/capture/a_capture.js", { type: "module" });
  }

  // SUBCRIBER Functions

  private loadPlayer() {

    this.videoRendererBuffer = new VideoRenderBuffer();
    this.wtVideoJitterBuffer = new JitterBuffer(this.videoJitterBufferMs!, (data: any) =>  console.warn(`[VIDEO-JITTER] Dropped late video frame. seqId: ${data.seqId}, currentSeqId:${data.firstBufferSeqId}`));
    this.wtAudioJitterBuffer = new JitterBuffer(this.audioJitterBufferMs!, (data: any) =>  console.warn(`[AUDIO-JITTER] Dropped late audio frame. seqId: ${data.seqId}, currentSeqId:${data.firstBufferSeqId}`));

    this.muxerDownloaderWorker = new Worker("../../assets/js/receiver/moq_demuxer_downloader.js", {type: "module"});
    this.audioDecoderWorker = new Worker("../../assets/js/decode/audio_decoder.js", {type: "module"});
    this.videoDecoderWorker = new Worker("../../assets/js/decode/video_decoder.js", {type: "module"});

    const self =  this;

    this.ngZone.runOutsideAngular(() => {
      self.muxerDownloaderWorker.addEventListener('message', (e: MessageEvent<any>) => {
        self.playerProcessWorkerMessage(e);
      });
      self.videoDecoderWorker.addEventListener('message', (e: MessageEvent<any>) => {
        self.playerProcessWorkerMessage(e);
      });
      self.audioDecoderWorker.addEventListener('message', (e: MessageEvent<any>) => {
        self.playerProcessWorkerMessage(e);
      });
    });

    this.downloaderConfig.urlHostPort = this.url;
    this.downloaderConfig.moqTracks["video"].namespace = this.namespace;
    this.downloaderConfig.moqTracks["video"].name = this.trackName + "-video";
    this.downloaderConfig.moqTracks["video"].authInfo = this.auth;

    this.downloaderConfig.moqTracks["audio"].namespace = this.namespace;
    this.downloaderConfig.moqTracks["audio"].name = this.trackName + "-audio";
    this.downloaderConfig.moqTracks["audio"].authInfo = this.auth;

    this.muxerDownloaderWorker.postMessage({ type: "downloadersendini", downloaderConfig: this.downloaderConfig});
  }

  private async playerProcessWorkerMessage(e: MessageEvent<any>) {

    if (e.data.type === "videochunk") {
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
                  this.audioDecoderWorker.postMessage({ type: "audiochunk", seqId: orderedAudioData.seqId, chunk: orderedAudioData.chunk, metadata: orderedAudioData.extraData.metadata, isDisco: orderedAudioData.isDisco });
              }
          }
      }
    // FRAME
    } else if (e.data.type === "aframe") {

      const aFrame = e.data.frame;

      // currentAudioTs needs to be compesated with GAPs more info in audio_decoder.js
      const curWCompTs = aFrame.timestamp + e.data.timestampCompensationOffset;

      //playerUpdateDecoderUI('audio', timingInfo.decoder.currentAudioTs, buffersInfo.decoder.audio);

      if (this.sourceBufferAudioWorklet == null && aFrame.sampleRate != undefined && aFrame.sampleRate > 0) {
          // Initialize the audio worklet node when we know sampling freq used in the capture
          this.playerInitializeAudioContext(aFrame.sampleRate);
      }
      // If audioSharedBuffer not initialized and is in start (render) state -> Initialize
      if (this.sourceBufferAudioWorklet != null && this.audioSharedBuffer === null) {
          const bufferSizeSamples = Math.floor((Math.max(this.playerMaxBufferMs!, this.playerBufferMs! * 2, 100) * aFrame.sampleRate) / 1000);
          this.audioSharedBuffer = new CicularAudioSharedBuffer();
          this.audioSharedBuffer.Init(aFrame.numberOfChannels, bufferSizeSamples, this.audioCtx.sampleRate);
          this.audioSharedBuffer.SetCallbacks((droppedFrameData: any) => {
            console.log(`Audio shared buffer dropped frame `, droppedFrameData)
          });
          // Set the audio context sampling freq, and pass buffers
          this.sourceBufferAudioWorklet.port.postMessage({ type: 'iniabuffer', config: { contextSampleFrequency: this.audioCtx.sampleRate, circularBufferSizeSamples: bufferSizeSamples, cicularAudioSharedBuffers: this.audioSharedBuffer.GetSharedBuffers(), sampleFrequency: aFrame.sampleRate } });
      }

      if (this.audioSharedBuffer != null) {
          // Uses compensated TS
          this.audioSharedBuffer.Add(aFrame, curWCompTs);
      }
    } else if (e.data.type === "vframe") {
      const vFrame = e.data.frame;
      if (this.videoRendererBuffer !== null && this.videoRendererBuffer.AddItem(vFrame) === false) {
          console.warn("Dropped video frame because video renderer is full");
          vFrame.close();
      }

    // Downloader STATS
    } else {
      console.error("unknown message: " + JSON.stringify(e.data));
    }
  }

  animate() {

    let data;
    if (this.audioSharedBuffer != null) {
      data = this.audioSharedBuffer.GetStats()
      if (data.queueLengthMs >= this.playerBufferMs! && data.isPlaying === this.AUDIO_STOPPED) {
        this.audioSharedBuffer.Play();
      }
    }
    if (data !== undefined && this.videoRendererBuffer != null && data.currentTimestamp >= 0) {
      // Assuming audioTS in microseconds
      const compensatedAudioTS = Math.max(0, data.currentTimestamp - (this.systemAudioLatencyMs * 1000));
      const retData = this.videoRendererBuffer.GetItemByTs(compensatedAudioTS);
      //console.log(retData)
      if (retData.vFrame != null) {
          this.playerSetVideoSize(retData.vFrame);
          if (!this.videoFramePrinted) {
            this.videoFramePrinted = true;
            this.ref.detectChanges();
          }
          this.videoPlayerCtx!.drawImage(retData.vFrame, 0, 0, (retData.vFrame as VideoFrame).displayWidth, (retData.vFrame as VideoFrame).displayHeight);
          (retData.vFrame as VideoFrame).close();
      } else {
         // console.debug("NO FRAME to paint", this.videoRendererBuffer.elementsList.length);
      }
    }

    // // Only printing video frames and no audio frames.
    // const retData = this.videoRendererBuffer?.GetFirstElement()!;
    // if (retData.vFrame != null) {
    //     this.playerSetVideoSize(retData.vFrame);
    //     if (!this.videoFramePrinted) {
    //       this.videoFramePrinted = true;
    //       this.ref.detectChanges();
    //     }
    //     this.videoPlayerCtx!.drawImage(retData.vFrame, 0, 0, (retData.vFrame as VideoFrame).displayWidth, (retData.vFrame as VideoFrame).displayHeight);
    //     (retData.vFrame as VideoFrame).close();
    // } else {
    //    // console.debug("NO FRAME to paint", this.videoRendererBuffer!.elementsList.length);
    // }
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

  private async playerInitializeAudioContext(desiredSampleRate: number) {
    this.audioCtx = await this.audioService.init(desiredSampleRate);
    this.gain = this.audioCtx.createGain();
    (this.gain as GainNode).connect(this.audioCtx.destination);
    this.sourceBufferAudioWorklet = new AudioWorkletNode(this.audioCtx, 'source-buffer');
    this.sourceBufferAudioWorklet.onprocessorerror = (event) => {
      console.error('Audio worklet error. Err: ' + JSON.stringify(event));
    };
    this.sourceBufferAudioWorklet.connect(this.gain as GainNode);
    this.gain!.gain.value = 0;
    this.systemAudioLatencyMs = (this.audioCtx.outputLatency + this.audioCtx.baseLatency) * 1000;
  }

}
