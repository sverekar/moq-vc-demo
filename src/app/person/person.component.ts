import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnInit, Output, SimpleChanges, ViewChild, ViewEncapsulation } from '@angular/core';
import { CicularAudioSharedBuffer, VideoRenderBuffer } from '../common';

declare const MediaStreamTrackProcessor: any;

@Component({
  selector: 'app-person',
  standalone: true,
  imports: [
    CommonModule
  ],
  templateUrl: './person.component.html',
  styleUrls: ['./person.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom
})
export class PersonComponent implements OnInit {

  @Input() url!: string;
  @Input() auth!: string;
  @Input() namespace!: string;
  @Input() trackName!: string;

  //Required only for subscribers
  @Input() playerBufferMs: number | undefined
  @Input() playerMaxBufferMs: number | undefined
  @Input() audioJitterBufferMs: number | undefined
  @Input() videoJitterBufferMs: number | undefined

  @Input() onlyVideo: boolean | undefined

  @Output() destroy = new EventEmitter<string>()

  @ViewChild('videoplayer', { static: true }) videoPlayer!: ElementRef;

  videoFramePrinted = false;
  mute = true;

  private AUDIO_STOPPED = 0;

  private RENDER_VIDEO_EVERY_MS = 10;
  private wcLastRender: number = 0;

  private downloaderConfig: any = {
    urlHostPort: '',
    urlPath: '',
    moqTracks: {
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

  constructor(private ngZone: NgZone, private ref: ChangeDetectorRef) {}

  ngOnInit() {

    if (!window.crossOriginIsolated) {
      console.error("we can NOT use SharedArrayBuffer");
    }
    // If subscriber, we have all the information required.
    this.loadPlayer();
  }

  async stop () {

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
    if (this.audioCtx) {
      await this.audioCtx.close();
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
    this.playerInitializeAudioContext = this.playerInitializeAudioContext.bind(this);

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

    if (!this.onlyVideo) {
      this.downloaderConfig.moqTracks["audio"] = {}
      this.downloaderConfig.moqTracks["audio"].namespace = this.namespace;
      this.downloaderConfig.moqTracks["audio"].name = this.trackName + "-audio";
      this.downloaderConfig.moqTracks["audio"].authInfo = this.auth;
      this.downloaderConfig.moqTracks["audio"].alias = 0;
    }

    this.muxerDownloaderWorker.postMessage({ type: "downloadersendini", downloaderConfig: this.downloaderConfig }, [channel1.port2, channel2.port2]);

  }

  private async playerProcessWorkerMessage(e: MessageEvent<any>) {

    if (e.data.type === "aframe") {
      const aFrame = e.data.frame;
      // currentAudioTs needs to be compesated with GAPs more info in audio_decoder.js
      const curWCompTs = aFrame.timestamp + e.data.timestampCompensationOffset;
      if (this.audioCtx == null && this.sourceBufferAudioWorklet == null && aFrame.sampleRate != undefined && aFrame.sampleRate > 0) {
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
        if (retData && retData.vFrame) {
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
    return new Promise((resolve, reject) => {
      if (this.audioCtx === null) {
        this.audioCtx = new AudioContext({ latencyHint: "interactive", sampleRate: desiredSampleRate });
        this.audioCtx.audioWorklet.addModule('../assets/js/render/source_buffer_worklet.js').then((data: any) => {
          this.gain = this.audioCtx.createGain();
          (this.gain as GainNode).connect(this.audioCtx.destination);
          this.sourceBufferAudioWorklet = new AudioWorkletNode(this.audioCtx, 'source-buffer');
          this.sourceBufferAudioWorklet.connect(this.gain as GainNode);
          this.gain!.gain.value = 0;
          this.systemAudioLatencyMs = (this.audioCtx.outputLatency + this.audioCtx.baseLatency) * 1000
          return resolve(null);
        })
      } else {
        console.log('Audio context is null, this should never happen')
        return resolve(null);
      }
    })

  }
}
