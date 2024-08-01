import { CommonModule, Location } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, inject, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { NgbActiveModal, NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { from } from 'rxjs';
import { PersonComponent } from './person/person.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    NgbModule,
    FormsModule,
    CommonModule,
    RouterOutlet,
    PersonComponent
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
  uploadStatsAudioInflight: string | undefined = undefined;
  uploadStatsVideoInflight: string | undefined = undefined;
  totalAudioChunksDropped: number = 0;
  totalVideoChunksDropped: number = 0;
  firstAts: number | undefined = undefined;
  firstVts: number | undefined = undefined;
  firstCompAts: number | undefined = undefined;
  firstCompVts: number | undefined = undefined;
  encoderDroppedFrames: string[] = [];

  subscriptionList : Array<{ id:string, namespace: string, trackName: string, self: boolean}> = [];
  videoMediaDevices: Array<{deviceId: string, label: string}> = [];
  videoResolutions: Array<{width: number, height: number, fps: number, level: number}> = [];
  audioMediaDevices: Array<{deviceId: string, label: string}> = [];

  readyToPublish: boolean = false;
  isAnnounce: boolean = true;

  private modalService = inject(NgbModal);

  @ViewChild('me', { static: true }) me!: PersonComponent;

  constructor(private ref: ChangeDetectorRef, private location: Location) {

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
      this.me.stop();
      this.encodedAudioTs = undefined;
      this.encodedAudioCompensatedTs = undefined;
      this.encodedAudioLatencyMs = undefined;
      this.encodedVideoTs = undefined;
      this.encodedVideoCompensatedTs = undefined;
      this.encodedVideoLatencyMs = undefined;
      this.uploadStatsAudioInflight = undefined;
      this.uploadStatsVideoInflight = undefined;
      this.totalAudioChunksDropped = 0;
      this.totalVideoChunksDropped = 0;
      this.firstAts = undefined;
      this.firstVts = undefined;
      this.firstCompAts = undefined;
      this.firstCompVts = undefined;
      this.encoderDroppedFrames = [];
      // Workaround to enable re announce after 1 sec, wait for worker threads to stop.
      setTimeout(()=> {this.isAnnounce = true}, 1000);
    }
  }

  destroySubscriber(id: string) {
    this.subscriptionList = this.subscriptionList.filter(x => x.id !== id);
  }

  stats(data: any) {
    if ('publish' in data) {
      this.readyToPublish = data['publish'];
    }
    if ('encodedAudioTs' in data) {
      this.encodedAudioTs = data['encodedAudioTs'];
    }
    if ('encodedAudioTs' in data) {
      this.encodedAudioTs = data['encodedAudioTs']
    }
    if ('encodedAudioCompensatedTs' in data) {
      this.encodedAudioCompensatedTs = data['encodedAudioCompensatedTs']
    }
    if ('encodedAudioLatencyMs' in data) {
      this.encodedAudioLatencyMs = data['encodedAudioLatencyMs']
    }
    if ('encodedVideoTs' in data) {
      this.encodedVideoTs = data['encodedVideoTs']
    }
    if ('encodedVideoCompensatedTs' in data) {
      this.encodedVideoCompensatedTs = data['encodedVideoCompensatedTs']
    }
    if ('encodedVideoLatencyMs' in data) {
      this.encodedVideoLatencyMs = data['encodedVideoLatencyMs']
    }
    if ('uploadStatsAudioInflight' in data) {
      this.uploadStatsAudioInflight = data['uploadStatsAudioInflight']
    }
    if ('uploadStatsVideoInflight' in data) {
      this.uploadStatsVideoInflight = data['uploadStatsVideoInflight']
    }
    if ('audioChunkDropped' in data) {
      this.totalAudioChunksDropped++;
    }
    if ('videoChunkDropped' in data) {
      this.totalVideoChunksDropped++;
    }
    if ('chunkDroppedMsg' in data) {
      console.debug(data['chunkDroppedMsg'])
      this.encoderDroppedFrames.push(data['chunkDroppedMsg']);
    }
    if ('firstAts' in data) {
      this.firstAts = data['firstAts']
    }
    if ('firstVts' in data) {
      this.firstVts = data['firstVts']
    }
    if ('firstCompAts' in data) {
      this.firstCompAts = data['firstCompAts']
    }
    if ('firstCompVts' in data) {
      this.firstCompVts = data['firstCompVts']
    }
  }

  trackByFn(index: number, item: string) {
    return index;
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

