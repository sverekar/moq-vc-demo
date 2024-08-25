import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnInit, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CicularAudioSharedBuffer, VideoRenderBuffer } from '../common';
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
  @Input() onlyVideo: boolean | undefined

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
  private muxerSenderWorker!: Worker;

  private AUDIO_STOPPED = 0;

  private RENDER_VIDEO_EVERY_MS = 10;
  private wcLastRender: number = 0;

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

  private videoRendererBuffer : VideoRenderBuffer | null = null;
  private muxerDownloaderWorker!: Worker;
  private audioDecoderWorker!: Worker;
  private videoDecoderWorker!: Worker;

  private audioCtx: any  = null;
  private sourceBufferAudioWorklet:AudioWorkletNode | null = null;
  gain: GainNode | null  = null;
  private systemAudioLatencyMs: number = 0;
  private audioSharedBuffer:CicularAudioSharedBuffer | null = null;
  private videoPlayerCtx:CanvasRenderingContext2D | null = null;

  private animFrame: number | null = null;

  private isAudioContextSet = false;

  constructor(private ngZone: NgZone, private ref: ChangeDetectorRef, private audioService: AudioService ) {}

  ngOnInit(): void {

    if (!window.crossOriginIsolated) {
      console.error("we can NOT use SharedArrayBuffer");
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
      if (this.muxerSenderWorker) {
        this.muxerSenderWorker.postMessage(stopMsg);
      }
      if (this.aStreamWorker) {
        this.aStreamWorker.postMessage(stopMsg);
        this.aStreamWorker.terminate();
      }
      if (this.vStreamWorker) {
        this.vStreamWorker.postMessage(stopMsg);
        this.vStreamWorker.terminate();
      }
    } else {

      // stop workers
      const stopMsg = { type: "stop" };
      if (this.muxerDownloaderWorker) {
        this.muxerDownloaderWorker.postMessage(stopMsg);
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

      const self = this;

      const channel1 = new MessageChannel();
      const channel2 = new MessageChannel();

      this.ngZone.runOutsideAngular(() => {
        self.muxerSenderWorker.addEventListener('message', (e: MessageEvent<any>) => {
          if (e.data.type === 'started') {
            self.initalizeWorkers(videoEncodingBitrateBps,videoEncodingKeyFrameEvery, audioEncodingBitrateBps, mediaStream, channel1, channel2);
          }
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

      this.muxerSenderWorker.postMessage({ type: "muxersendini", muxerSenderConfig: this.muxerSenderConfig }, [channel1.port2, channel2.port2]);

      return Promise.resolve(true);

    } catch (error) {
      console.log('Failure while announcing: ', error);
      return Promise.resolve(false);
    }
  }

  private initalizeWorkers(videoEncodingBitrateBps: number, videoEncodingKeyFrameEvery: number, audioEncodingBitrateBps: number, mediaStream: any, channel1: MessageChannel, channel2: MessageChannel) {

    this.videoEncoderConfig.encoderConfig.width = this.resolution!.width;
    this.videoEncoderConfig.encoderConfig.height = this.resolution!.height;
    this.videoEncoderConfig.encoderConfig.framerate = this.resolution!.fps;
    this.videoEncoderConfig.encoderConfig.codec = this.getCodecString("avc1", 66, this.resolution!.level);
    this.videoEncoderConfig.encoderConfig.bitrate = videoEncodingBitrateBps;
    this.videoEncoderConfig.keyframeEvery = videoEncodingKeyFrameEvery;

    // Load audio encoding settings
    this.audioEncoderConfig.encoderConfig.bitrate = audioEncodingBitrateBps;

    this.vStreamWorker.postMessage({ type: "vencoderini", encoderConfig: this.videoEncoderConfig.encoderConfig, encoderMaxQueueSize: this.videoEncoderConfig.encoderMaxQueueSize, keyframeEvery: this.videoEncoderConfig.keyframeEvery, onlyVideo: this.onlyVideo }, [channel1.port1]);
    if (!this.onlyVideo) {
      this.aStreamWorker.postMessage({ type: "aencoderini", encoderConfig: this.audioEncoderConfig.encoderConfig, encoderMaxQueueSize: this.audioEncoderConfig.encoderMaxQueueSize }, [channel2.port1]);
    }

    const vTrack = mediaStream.getVideoTracks()[0];
    const vProcessor = new MediaStreamTrackProcessor(vTrack);
    const vFrameStream = vProcessor.readable;

    const aTrack = mediaStream.getAudioTracks()[0];
    const aProcessor = new MediaStreamTrackProcessor(aTrack);
    const aFrameStream = aProcessor.readable;

    const sharedBuffer = new SharedArrayBuffer( 2 * BigInt64Array.BYTES_PER_ELEMENT);

    this.vStreamWorker.postMessage({ type: "stream", vStream: vFrameStream, sharedBuffer }, [vFrameStream]);
    if (!this.onlyVideo) {
      this.aStreamWorker.postMessage({ type: "stream", aStream: aFrameStream, sharedBuffer }, [aFrameStream]);
    }
  }

  private getCodecString(codec: string, profile: number, level: number) {
    return codec + "." + profile.toString(16).toUpperCase().padStart(2, '0') + "00" + level.toString(16).toUpperCase().padStart(2, '0');
  }

  private createWebWorkers() {

    this.muxerSenderWorker = new Worker("../../assets/js/sender/opt_moq_sender.js", { type: "module" });

    // // Create send worker
    // this.muxerSenderWorker = new Worker("../../assets/js/sender/moq_sender.js", { type: "module" });

    // // Create a new workers for video / audio frames encode
    // this.vEncoderWorker = new Worker("../../assets/js/encode/v_encoder.js", { type: "module" });
    // this.aEncoderWorker = new Worker("../../assets/js/encode/a_encoder.js", { type: "module" });

    // this.vStreamWorker = new Worker("../../assets/js/capture/v_capture.js", { type: "module" });
    // this.aStreamWorker = new Worker("../../assets/js/capture/a_capture.js", { type: "module" });

    this.vStreamWorker = new Worker("../../assets/js/capture/opt_v_capture.js", { type: "module" });
    if (!this.onlyVideo) {
      this.aStreamWorker = new Worker("../../assets/js/capture/opt_a_capture.js", { type: "module" });
    }
  }

  // SUBCRIBER Functions

  private loadPlayer() {

    this.videoRendererBuffer = new VideoRenderBuffer(this.onlyVideo);

    const channel1 = new MessageChannel();
    const channel2 = new MessageChannel();

    this.muxerDownloaderWorker = new Worker("../../assets/js/receiver/moq_demuxer_downloader.js", {type: "module"});
    if (!this.onlyVideo) {
      this.audioDecoderWorker = new Worker("../../assets/js/decode/audio_decoder.js", {type: "module"});
    }
    this.videoDecoderWorker = new Worker("../../assets/js/decode/video_decoder.js", {type: "module"});

    const self =  this;

    this.animate = this.animate.bind(this);

    this.ngZone.runOutsideAngular(() => {
      self.videoDecoderWorker.addEventListener('message', (e: MessageEvent<any>) => {
        self.playerProcessWorkerMessage(e);
      });
      if (!self.onlyVideo) {
        self.audioDecoderWorker.addEventListener('message', (e: MessageEvent<any>) => {
          self.playerProcessWorkerMessage(e);
        });
      }
    });

    this.videoDecoderWorker.postMessage( {type: 'connect', jitterBufferSize: this.videoJitterBufferMs!}, [channel1.port1]);

    if (!self.onlyVideo){
      this.audioDecoderWorker.postMessage( {type: 'connect', jitterBufferSize: this.audioJitterBufferMs!}, [channel2.port1]);
    }

    this.downloaderConfig.urlHostPort = this.url;
    this.downloaderConfig.moqTracks["video"].namespace = this.namespace;
    this.downloaderConfig.moqTracks["video"].name = this.trackName + "-video";
    this.downloaderConfig.moqTracks["video"].authInfo = this.auth;

    this.downloaderConfig.moqTracks["audio"].namespace = this.namespace;
    this.downloaderConfig.moqTracks["audio"].name = this.trackName + "-audio";
    this.downloaderConfig.moqTracks["audio"].authInfo = this.auth;

    this.muxerDownloaderWorker.postMessage({ type: "downloadersendini", downloaderConfig: this.downloaderConfig }, [channel1.port2, channel2.port2]);

  }

  private async playerProcessWorkerMessage(e: MessageEvent<any>) {

    if (e.data.type === "aframe") {
      const aFrame = e.data.frame;
      // currentAudioTs needs to be compesated with GAPs more info in audio_decoder.js
      const curWCompTs = aFrame.timestamp + e.data.timestampCompensationOffset;
      if (!this.isAudioContextSet && this.sourceBufferAudioWorklet == null && aFrame.sampleRate != undefined && aFrame.sampleRate > 0) {
          this.isAudioContextSet = true;
          // Initialize the audio worklet node when we know sampling freq used in the capture
          await this.playerInitializeAudioContext(aFrame.sampleRate);
      }
      // If audioSharedBuffer not initialized and is in start (render) state -> Initialize
      if (this.sourceBufferAudioWorklet != null && this.audioSharedBuffer === null) {
          const bufferSizeSamples = Math.floor((Math.max(this.playerMaxBufferMs!, this.playerBufferMs! * 2, 100) * aFrame.sampleRate) / 1000);
          this.audioSharedBuffer = new CicularAudioSharedBuffer();
          this.audioSharedBuffer.Init(aFrame.numberOfChannels, bufferSizeSamples, this.audioCtx.sampleRate);
          // Set the audio context sampling freq, and pass buffers
          this.sourceBufferAudioWorklet.port.postMessage({ type: 'iniabuffer', config: { contextSampleFrequency: this.audioCtx.sampleRate, circularBufferSizeSamples: bufferSizeSamples, cicularAudioSharedBuffers: this.audioSharedBuffer.GetSharedBuffers(), sampleFrequency: aFrame.sampleRate } });
      }
      if (this.audioSharedBuffer != null) {
          // uses compensated TS
          this.audioSharedBuffer.Add(aFrame, curWCompTs);
          if (this.animFrame === null) {
            this.animFrame = requestAnimationFrame(this.animate);
          }
      }
    } else if (e.data.type === "vframe") {
      const vFrame = e.data.frame;
      if (this.videoRendererBuffer !== null && this.videoRendererBuffer.AddItem(vFrame) === false) {
          // console.warn("Dropped video frame because video renderer is full");
          vFrame.close();
      }
      if (this.onlyVideo && this.animFrame === null) {
        this.animFrame = requestAnimationFrame(this.animate);
      }
    // Downloader STATS
    } else {
      console.error("unknown message: " + JSON.stringify(e.data));
    }
  }

  animate(wcTimestamp: number) {
    const wcInterval = wcTimestamp - this.wcLastRender;
    if (wcInterval > this.RENDER_VIDEO_EVERY_MS) {
      this.wcLastRender = wcTimestamp;

      if (this.onlyVideo) {
        const retData = this.videoRendererBuffer?.GetFirstElement()!;
        if (retData.vFrame != null) {
            this.playerSetVideoSize(retData.vFrame);
            if (!this.videoFramePrinted) {
              this.videoFramePrinted = true;
              this.ref.detectChanges();
            }
            this.videoPlayerCtx!.drawImage(retData.vFrame, 0, 0, (retData.vFrame as VideoFrame).displayWidth, (retData.vFrame as VideoFrame).displayHeight);
            (retData.vFrame as VideoFrame).close();
        }
      } else {
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
          }
        }
      }
    }
    this.animFrame = requestAnimationFrame(this.animate);
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
