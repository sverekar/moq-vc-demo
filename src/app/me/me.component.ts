import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnInit, Output, SimpleChanges, ViewChild } from '@angular/core';
import { TimeBufferChecker } from '../common';

@Component({
  selector: 'app-me',
  standalone: true,
  imports: [],
  templateUrl: './me.component.html',
  styleUrl: './me.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MeComponent implements OnInit, OnChanges  {


  @Input() url!: string;
  @Input() auth!: string;
  @Input() namespace!: string;
  @Input() trackName!: string;

  // Required only for caller / me
  @Input() videoDeviceId: string | undefined;
  @Input() audioDeviceId: string | undefined;
  @Input() resolution!: { width: number; height: number; fps: number; level: number; }

  @Input() onlyVideo: boolean | undefined

  @Output() publish = new EventEmitter<boolean>()

  @ViewChild('videoplayer', { static: true }) videoPlayer!: ElementRef;

  videoFramePrinted = false;

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

  private muxerSenderConfig: any = {
    urlHostPort: '',
    urlPath: '',
    moqTracks: {
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

  // Me variables
  private vStreamWorker!: Worker;
  private aStreamWorker!: Worker;
  private muxerSenderWorker!: Worker;
  private vEncoderWorker!: Worker;
  private aEncoderWorker!: Worker;

  private currentAudioTs: any = undefined;
  private currentVideoTs: any = undefined;
  private videoOffsetTS: any = undefined;
  private audioOffsetTS: any = undefined;

  private audioTimeChecker : TimeBufferChecker;
  private videoTimeChecker : TimeBufferChecker;


  constructor(private ngZone: NgZone, private ref: ChangeDetectorRef) {
    this.audioTimeChecker = new TimeBufferChecker("audio");
    this.videoTimeChecker = new TimeBufferChecker("video");
  }

  ngOnInit(): void {
    if (!window.crossOriginIsolated) {
      console.error("we can NOT use SharedArrayBuffer");
    }

  }

  ngOnChanges(changes: SimpleChanges): void {

    // If me, we need deviceId for audio and video device, this is async and hence we need to check untill we have one.
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

  async stop () {

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

    if (this.vEncoderWorker) {
      this.vEncoderWorker.postMessage(stopMsg);
      this.vEncoderWorker.terminate();
    }

    if (this.aEncoderWorker) {
      this.aEncoderWorker.postMessage(stopMsg);
      this.aEncoderWorker.terminate();
    }

    this.audioTimeChecker.Clear();
    this.videoTimeChecker.Clear();

    // Reset muxer config and me component is not destroyed. user can reconfigure onlyVideo.
    this.muxerSenderConfig = {
      urlHostPort: '',
      urlPath: '',
      moqTracks: {
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

      const self = this;

      this.encoderProcessWorkerMessage = this.encoderProcessWorkerMessage.bind(this);
      // const channel1 = new MessageChannel();
      // const channel2 = new MessageChannel();

      // this.ngZone.runOutsideAngular(() => {
      //   self.muxerSenderWorker.addEventListener('message', (e: MessageEvent<any>) => {
      //     if (e.data.type === 'started') {
      //       self.initalizeWorkers(videoEncodingBitrateBps,videoEncodingKeyFrameEvery, audioEncodingBitrateBps, mediaStream, channel1, channel2);
      //     }
      //   });
      // });

      this.ngZone.runOutsideAngular(() => {
        self.vStreamWorker.addEventListener('message', function (e) {
          self.encoderProcessWorkerMessage(e);
        });
        self.vEncoderWorker.addEventListener('message', function (e) {
          self.encoderProcessWorkerMessage(e);
        });
        if (!self.onlyVideo) {
          self. aStreamWorker.addEventListener('message', function (e) {
            self.encoderProcessWorkerMessage(e);
          });
          self.aEncoderWorker.addEventListener('message', function (e) {
            self.encoderProcessWorkerMessage(e);
          });
        }
        self.muxerSenderWorker.addEventListener('message', function (e) {
          self.encoderProcessWorkerMessage(e);
        });
      });

      this.videoEncoderConfig.encoderConfig.width = this.resolution!.width;
      this.videoEncoderConfig.encoderConfig.height = this.resolution!.height;
      this.videoEncoderConfig.encoderConfig.framerate = this.resolution!.fps;
      this.videoEncoderConfig.encoderConfig.codec = this.getCodecString("avc1", 66, this.resolution!.level);
      this.videoEncoderConfig.encoderConfig.bitrate = videoEncodingBitrateBps;
      this.videoEncoderConfig.keyframeEvery = videoEncodingKeyFrameEvery;

      // Load audio encoding settings
      this.audioEncoderConfig.encoderConfig.bitrate = audioEncodingBitrateBps;

      // as a ReadableStream of VideoFrames.
      const vTrack = mediaStream.getVideoTracks()[0];
      //@ts-ignore
      const vProcessor = new MediaStreamTrackProcessor(vTrack);
      const vFrameStream = vProcessor.readable;

      const aTrack = mediaStream.getAudioTracks()[0];
      //@ts-ignore
      const aProcessor = new MediaStreamTrackProcessor(aTrack);
      const aFrameStream = aProcessor.readable;

      // Initialize encoders
      self.vEncoderWorker.postMessage({ type: "vencoderini", encoderConfig: this.videoEncoderConfig.encoderConfig, encoderMaxQueueSize: self.videoEncoderConfig.encoderMaxQueueSize, keyframeEvery: self.videoEncoderConfig.keyframeEvery });
      if (!self.onlyVideo) {
        self.aEncoderWorker.postMessage({ type: "aencoderini", encoderConfig: this.audioEncoderConfig.encoderConfig, encoderMaxQueueSize: self.audioEncoderConfig.encoderMaxQueueSize });
      }

      // Print messages from the worker in the console

      this.muxerSenderConfig.moqTracks["video"].namespace = this.namespace!;
      this.muxerSenderConfig.moqTracks["video"].name = this.trackName + "-video";
      this.muxerSenderConfig.moqTracks["video"].maxInFlightRequests = maxInflightVideoRequests;
      this.muxerSenderConfig.moqTracks["video"].authInfo = this.auth!;
      this.muxerSenderConfig.moqTracks["video"].moqMapping = moqVideoQuicMapping;

      if (!this.onlyVideo) {
        this.muxerSenderConfig.moqTracks["audio"] = {}
        this.muxerSenderConfig.moqTracks["audio"].namespace = this.namespace!;
        this.muxerSenderConfig.moqTracks["audio"].name = this.trackName  + "-audio";
        this.muxerSenderConfig.moqTracks["audio"].maxInFlightRequests = maxInflightAudioRequests;
        this.muxerSenderConfig.moqTracks["audio"].authInfo = this.auth!;
        this.muxerSenderConfig.moqTracks["audio"].moqMapping = moqAudioQuicMapping
        this.muxerSenderConfig.moqTracks["audio"].isHipri = true;
      }

      this.muxerSenderConfig.urlHostPort = this.url!;

      // this.muxerSenderWorker.postMessage({ type: "muxersendini", muxerSenderConfig: this.muxerSenderConfig }, [channel1.port2, channel2.port2]);
      this.muxerSenderWorker.postMessage({ type: "muxersendini", muxerSenderConfig: this.muxerSenderConfig });

      // Transfer the readable stream to the worker.
      this.vStreamWorker.postMessage({ type: "stream", vStream: vFrameStream }, [vFrameStream]);
      if (!this.onlyVideo) {
        this.aStreamWorker.postMessage({ type: "stream", aStream: aFrameStream }, [aFrameStream]);
      }
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
    //@ts-ignore
    const vProcessor = new MediaStreamTrackProcessor(vTrack);
    const vFrameStream = vProcessor.readable;

    const aTrack = mediaStream.getAudioTracks()[0];
    //@ts-ignore
    const aProcessor = new MediaStreamTrackProcessor(aTrack);
    const aFrameStream = aProcessor.readable;

    const sharedBuffer = new SharedArrayBuffer( 4 * BigInt64Array.BYTES_PER_ELEMENT);

    this.vStreamWorker.postMessage({ type: "stream", vStream: vFrameStream, sharedBuffer }, [vFrameStream]);
    if (!this.onlyVideo) {
      this.aStreamWorker.postMessage({ type: "stream", aStream: aFrameStream, sharedBuffer }, [aFrameStream]);
    }
  }

  private getCodecString(codec: string, profile: number, level: number) {
    return codec + "." + profile.toString(16).toUpperCase().padStart(2, '0') + "00" + level.toString(16).toUpperCase().padStart(2, '0');
  }

  private createWebWorkers() {

    // this.muxerSenderWorker = new Worker("../../assets/js/sender/opt_moq_sender.js", { type: "module" });
    // this.vStreamWorker = new Worker("../../assets/js/capture/opt_v_capture.js", { type: "module" });
    // if (!this.onlyVideo) {
    //   this.aStreamWorker = new Worker("../../assets/js/capture/opt_a_capture.js", { type: "module" });
    // }

    this.vStreamWorker = new Worker("../../assets/js/capture/v_capture.js", { type: "module" });
    this.vEncoderWorker = new Worker("../../assets/js/encode/v_encoder.js", { type: "module" });

    if (!this.onlyVideo) {
      this.aStreamWorker = new Worker("../../assets/js/capture/a_capture.js", { type: "module" });
      this.aEncoderWorker = new Worker("../../assets/js/encode/a_encoder.js", { type: "module" });
    }
    // Create send worker
    this.muxerSenderWorker = new Worker("../../assets/js/sender/moq_sender.js", { type: "module" });
  }

  private encoderProcessWorkerMessage(e: MessageEvent<any>) {
    // LOGGING
    if (e.data.type === "info") {
      // logging info
      console.log(e.data.data);

    } else if (e.data.type === "error") {
      // logging error
      console.error(e.data.data);

    } else if (e.data.type === "vframe") {
        const vFrame = e.data.data;
        let estimatedDuration = -1;
        if (this.currentVideoTs == undefined) {
          if (this.audioOffsetTS == undefined) {
              // Start video at 0
              this.videoOffsetTS = -vFrame.timestamp; // Comp video starts 0
          } else {
              // Adjust video offset to last audio seen (most probable case since audio startsup faster)
              this.videoOffsetTS = -vFrame.timestamp + this.currentAudioTs + this.audioOffsetTS; // Comp video starts last audio seen
          }
        } else {
          estimatedDuration = vFrame.timestamp - this.currentVideoTs;
        }
        this.currentVideoTs = vFrame.timestamp;
        this.videoTimeChecker.AddItem({ ts: this.currentVideoTs, compensatedTs: this.currentVideoTs + this.videoOffsetTS, estimatedDuration: estimatedDuration, clkms: e.data.clkms });
        // Encode video frame
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
                this.audioOffsetTS = -aFrame.timestamp + this.currentVideoTs + this.videoOffsetTS; // Comp audio starts last video seen
            }
        } else {
            estimatedDuration = aFrame.timestamp - this.currentAudioTs;
        }
        this.currentAudioTs = aFrame.timestamp;
        this.audioTimeChecker.AddItem({ ts: this.currentAudioTs, compensatedTs: this.currentAudioTs + this.audioOffsetTS, estimatedDuration: estimatedDuration, clkms: e.data.clkms });
        // Encode audio frame
        this.aEncoderWorker.postMessage({ type: "aframe", aframe: aFrame });

    } else if (e.data.type === "vchunk") {

        const chunk = e.data.chunk;
        const metadata = e.data.metadata;
        const seqId = e.data.seqId;
        const itemTsClk = this.videoTimeChecker.GetItemByTs(chunk.timestamp);
        if (!itemTsClk.valid) {
            // console.warn(`Not found clock time <-> TS for that video frame, this should not happen.  ts: ${chunk.timestamp}, id:${seqId}`);
        }
        this.muxerSenderWorker.postMessage({ type: "video", firstFrameClkms: itemTsClk.clkms, compensatedTs: itemTsClk.compensatedTs, estimatedDuration: itemTsClk.estimatedDuration, seqId: seqId, chunk: chunk, metadata: metadata });
    } else if (e.data.type === "achunk") {
        const chunk = e.data.chunk;
        const metadata = e.data.metadata;
        const seqId = e.data.seqId;
        const itemTsClk = this.audioTimeChecker.GetItemByTs(chunk.timestamp);
        if (!itemTsClk.valid) {
            console.info(`Not found clock time <-> TS for audio frame, this could happen. ts: ${chunk.timestamp}, id:${seqId}`);
        }
        this.muxerSenderWorker.postMessage({ type: "audio", firstFrameClkms: itemTsClk.clkms, compensatedTs: itemTsClk.compensatedTs, seqId: seqId, chunk: chunk, metadata: metadata });
        // CHUNKS STATS
    } else {
        console.error("unknown message: " + e.data);
    }
  }
}

