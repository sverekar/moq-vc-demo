import { CommonModule, Location } from '@angular/common';
import { ChangeDetectorRef, Component, inject, NgZone, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { NgbActiveModal, NgbModal, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { from } from 'rxjs';
import { PersonComponent } from './person/person.component';
import { SubscriberStats } from './person/common';
import { AnnounceStatsComponent } from './announce-stats/announce-stats.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    NgbModule,
    FormsModule,
    CommonModule,
    RouterOutlet,
    PersonComponent,
    AnnounceStatsComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {

  wtServerUrl: string = "https://moq-akamai-relay.akalab.ca:8443/moq";
  meNamespace: string = 'Guest' //crypto.randomUUID();
  trackName: string = 'Main';
  peerNamespace: string = 'Guest';
  peerTrackName: string = 'Main';
  authInfo: string = 'secret'
  moqVideoQuicMapping: string = 'ObjPerStream';
  moqAudioQuicMapping: string = 'ObjPerStream';

  // Video encoding configuration
  maxInflightVideoRequests: number  = 39;
  maxInflightAudioRequests: number  = 60;
  videoSources: { deviceId: string, label: string} | undefined;
  videoEncodingOptions: { width: number; height: number; fps: number; level: number; };
  videoEncodingKeyFrameEvery: number = 60;
  videoEncodingBitrateBps: number = 500000;

  // Audio encoding configuration
  audioSources: {deviceId: string, label: string} | undefined;
  audioEncodingBitrateBps: number = 32000;

  // Player configuration
  playerBufferMs: number = 100
  playerMaxBufferMs: number = 300
  audioJitterBufferMs: number = 200
  videoJitterBufferMs: number = 100

  // Debugging variables
  // Encoding variables
  encodedAudioTs: number | undefined = undefined;
  encodedAudioCompensatedTs: number | undefined = undefined;
  encodedAudioLatencyMs: number | undefined = undefined;
  encodedVideoTs: number | undefined = undefined;
  encodedVideoCompensatedTs: number | undefined = undefined;
  encodedVideoLatencyMs: number | undefined = undefined;
  uploadStatsAudioInflight: string = '0';
  uploadStatsVideoInflight: string  = '0';
  totalAudioChunksDropped: number = 0;
  totalVideoChunksDropped: number = 0;
  firstAts: number | undefined = undefined;
  firstVts: number | undefined = undefined;
  firstCompAts: number | undefined = undefined;
  firstCompVts: number | undefined = undefined;
  encoderDroppedFrames: string[] = [];

  //Debugging variables
  subscriberStats: Map<string, SubscriberStats> = new Map();
  selectedSubscriberStats: SubscriberStats | undefined = undefined;

  subscriptionList : Array<{ id:string, namespace: string, trackName: string, self: boolean}> = [];
  videoMediaDevices: Array<{deviceId: string, label: string}> = [];
  videoResolutions: Array<{width: number, height: number, fps: number, level: number}> = [];
  audioMediaDevices: Array<{deviceId: string, label: string}> = [];

  readyToPublish: boolean = false;

  isAnnounce: boolean = true;

  private modalService = inject(NgbModal);

  @ViewChild('me', { static: true }) me!: PersonComponent;

  @ViewChild('meStats', { static: true }) announceStats!: AnnounceStatsComponent;

  constructor(private ref: ChangeDetectorRef, private location: Location, private ngZone: NgZone) {

    this.videoResolutions.push({width: 320, height: 180, fps: 30, level: 13})
    this.videoResolutions.push({width: 320, height: 180, fps: 15, level: 12})
    this.videoResolutions.push({width: 854, height: 480, fps: 15, level: 30})
    this.videoResolutions.push({width: 854, height: 480, fps: 30, level: 31})
    this.videoResolutions.push({width: 1280, height: 720, fps: 15, level: 31})
    this.videoResolutions.push({width: 1280, height: 720, fps: 30, level: 31})
    this.videoResolutions.push({width: 1280, height: 720, fps: 30, level: 31})
    this.videoResolutions.push({width: 1920, height: 1080, fps: 15, level: 40})
    this.videoResolutions.push({width: 1920, height: 1080, fps: 30, level: 40})
    this.videoEncodingOptions = this.videoResolutions[0];
    // @ts-ignore
    navigator.getUserMedia({audio: true, video: true}, () =>{}, (error: any)=> {console.log(error)})
  }

  async ngOnInit(): Promise<void>{

    const self = this;
    // @ts-ignore
    navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
    // @ts-ignore
    if (navigator.getUserMedia) {
      from(navigator.mediaDevices
        .enumerateDevices())
        .subscribe({
          next: (devices: MediaDeviceInfo[]) => {
            for (let z=0; z < devices.length; z++) {
              const mediaDevice = devices[z];
              if (mediaDevice.kind === 'videoinput') {
                if (mediaDevice.deviceId != "") {
                    self.videoMediaDevices.push({deviceId: mediaDevice.deviceId, label: mediaDevice.label || `Camera ${z++}`})
                    console.log(`Video input device added: id=${mediaDevice.deviceId}, label=${mediaDevice.label}`);
                }
              } else if (mediaDevice.kind === 'audioinput') {
                if (mediaDevice.deviceId != "") {
                  self.audioMediaDevices.push({deviceId: mediaDevice.deviceId, label: mediaDevice.label || `Microphone ${z++}`})
                  console.log(`Audio input device added: id=${mediaDevice.deviceId}, label=${mediaDevice.label}`);
                }
              }
            }
            if (self.videoMediaDevices.length > 0) {
              self.videoSources = self.videoMediaDevices[0];
            }
            if (self.audioMediaDevices.length > 0) {
              self.audioSources = self.audioMediaDevices[0];
            }
          },
          error: (error: any) => {
            console.log(error)
            this.modalService.open(NgbdModalConfirm)
          },
          complete: () => {
            if (self.videoSources == undefined || self.audioSources == undefined) {
              this.modalService.open(NgbdModalConfirm)
            }
            // @ts-ignore
            navigator.getUserMedia({audio: true, video: true}, () =>{}, (error: any)=> {console.log(error)})
          }
        });

    } else {
      console.log('Media devices not supported')
      this.modalService.open(NgbdModalConfirm)
    }
  }

  subscribePeer(): void {
    this.subscriptionList.push({
      id: this.peerNamespace + '/' + this.trackName,
      namespace: this.peerNamespace,
      trackName: this.trackName,
      self: false
    })
    this.peerNamespace = 'Guest';
    this.peerTrackName = 'Main';
  }

  async announceOrStop(): Promise<void> {

    // trigger person (me) component to announce the frames to relay
    if (this.isAnnounce) {
        this.isAnnounce = false;
        const ans = await this.me.announce(this.moqVideoQuicMapping, this.moqAudioQuicMapping,
        this.maxInflightVideoRequests, this.maxInflightAudioRequests, this.videoEncodingKeyFrameEvery, this.videoEncodingBitrateBps,
        this.audioEncodingBitrateBps);
        if (!ans) {
          this.isAnnounce = true;
        }
    } else {

      this.announceStats.clearAnounceStats();
      this.subscriberStats.clear();
      // Workaround to enable re announce after 1 sec, wait for worker threads to stop.
      // Run outside of angular scope to avoid performance issue.
      this.ngZone.runOutsideAngular(() => {
        this.me.stop();
        setTimeout(() => {
          this.isAnnounce = true;
          this.ref.detectChanges();
        }, 1000);
      })
    }
  }

  destroySubscriber(id: string) {
    this.subscriptionList = this.subscriptionList.filter(x => x.id !== id);
    if (this.selectedSubscriberStats === this.subscriberStats.get(id)) {
      this.selectedSubscriberStats = undefined
    }
    this.subscriberStats.delete(id);

  }

  encoderStats(data: any) {

    this.announceStats.updateAnounceStats(data);
  }

  playerStats(data: any): void {
    if ('id' in data) {
      let stats = this.subscriberStats.get(data['id']);
      if (!stats) {
        stats = {};
      }
      stats = this.updatePlayerStats(stats, data);
      this.subscriberStats.set(data['id'], stats);
      return;
    }
    console.warn('Found player stats without id: ', data)
  }

  private updatePlayerStats(stats: SubscriberStats, data: any) {

    if ('latencyAudioMs' in data) {
      stats.latencyAudioMs = data['latencyAudioMs'];
    }
    if ('latencyVideoMs' in data) {
      stats.latencyVideoMs = data['latencyVideoMs'];
    }
    if ('currentChunkATS' in data) {
      stats.currentChunkATS = data['currentChunkATS'];
    }
    if ('currentChunkVTS' in data) {
      stats.currentChunkVTS = data['currentChunkVTS'];
    }
    if ('firstChunkAts' in data) {
      stats.firstChunkAts = data['firstChunkAts'];
    }
    if ('firstChunkVts' in data) {
      stats.firstChunkVts = data['firstChunkVts'];
    }
    if ('audioJitterCurrentMaxSize' in data) {
      stats.audioJitterCurrentMaxSize = data['audioJitterCurrentMaxSize'];
    }
    if ('audioJitterSize' in data) {
      stats.audioJitterSize = data['audioJitterSize'];
    }
    if ('audioJitterGaps' in data) {
      stats.audioJitterGaps = data['audioJitterGaps'];
    }
    if ('videoJitterCurrentMaxSize' in data) {
      stats.videoJitterCurrentMaxSize = data['videoJitterCurrentMaxSize'];
    }
    if ('videoJitterSize' in data) {
      stats.videoJitterSize = data['videoJitterSize'];
    }
    if ('videoJitterGaps' in data) {
      stats.videoJitterGaps = data['videoJitterGaps'];
    }
    if ('currentFrameATS' in data) {
      stats.currentFrameATS = data['currentFrameATS'];
    }
    if ('currentDecoABuffer' in data) {
      stats.currentDecoABuffer = data['currentDecoABuffer'];
    }
    if ('currentDecoCompAOffset' in data) {
      stats.currentDecoCompAOffset = data['currentDecoCompAOffset'];
    }
    if ('currentFrameVTS' in data) {
      stats.currentFrameVTS = data['currentFrameVTS'];
    }
    if ('currentDecoVBuffer' in data) {
      stats.currentDecoVBuffer = data['currentDecoVBuffer'];
    }
    if ('currentRendererATS' in data) {
      stats.currentRendererATS = data['currentRendererATS'];
    }
    if ('currentRendererABuffer' in data) {
      stats.currentRendererABuffer = data['currentRendererABuffer'];
    }
    if ('currentRendererASilenceInserted' in data) {
      stats.currentRendererASilenceInserted = data['currentRendererASilenceInserted'];
    }
    if ('currentRendererVTS' in data) {
      stats.currentRendererVTS = data['currentRendererVTS'];
    }
    if ('currentRendererVBuffer' in data) {
      stats.currentRendererVBuffer = data['currentRendererVBuffer'];
    }
    if ('currentRendererVDiscarded' in data) {
      stats.currentRendererVDiscarded = data['currentRendererVDiscarded'];
    }
    if ('droppedFramesData' in data) {
      if (stats.droppedFramesData) {
        stats.droppedFramesData?.push(data['currentRendererVDiscarded']);
      } else {
        stats.droppedFramesData = [data['currentRendererVDiscarded']]
      }
    }
    return stats;
  }

}

@Component({
	selector: 'ngbd-modal-confirm',
	standalone: true,
	template: `
		<div class="modal-header">
			<h4 class="modal-title" id="modal-title" style="font-family: 'Montserrat600'; font-size: small;">Video / Audio Devices Permission Required</h4>
		</div>
		<div class="modal-body">
			<p style="font-family: 'Montserrat'; font-size: smaller;">
				<strong>This applications requies permission to device camera and microphone.!! <br><br> Kindly reload once required permissions are granted.</strong>
			</p>
		</div>
		<div class="modal-footer">
			<button style="font-family: 'Montserrat600'; font-size: smaller;" type="button" class="btn btn-danger" (click)="modal.close()">Ok</button>
		</div>
	`,
})

export class NgbdModalConfirm {
	modal = inject(NgbActiveModal);
}

