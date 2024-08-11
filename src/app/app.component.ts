import { CommonModule, Location } from '@angular/common';
import { ChangeDetectorRef, Component, EventEmitter, inject, NgZone, OnInit, Output, QueryList, ViewChild, ViewChildren } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { NgbActiveModal, NgbModal, NgbModule } from '@ng-bootstrap/ng-bootstrap';
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

  // Announcer common configuration
  wtServerUrl: string = "https://moq-akamai-relay.akalab.ca:8843/moq";
  meNamespace: string = 'Guest' //crypto.randomUUID();
  trackName: string = 'Main';
  peerNamespace: string = 'Guest';
  peerTrackName: string = 'Main';
  authInfo: string = 'secret'
  moqVideoQuicMapping: string = 'ObjPerStream';
  moqAudioQuicMapping: string = 'ObjPerStream';

  // Announcer video encoding configuration
  maxInflightVideoRequests: number  = 39;
  maxInflightAudioRequests: number  = 60;
  videoSources: { deviceId: string, label: string} | undefined;
  videoEncodingOptions: { width: number; height: number; fps: number; level: number; };
  videoEncodingKeyFrameEvery: number = 60;
  videoEncodingBitrateBps: number = 500000;

  // Announcer audio encoding configuration
  audioSources: {deviceId: string, label: string} | undefined;
  audioEncodingBitrateBps: number = 32000;

  // Subscriber player configuration
  playerBufferMs: number = 100
  playerMaxBufferMs: number = 200
  audioJitterBufferMs: number = 200
  videoJitterBufferMs: number = 100

  subscriptionList : Array<{ id:string, namespace: string, trackName: string, self: boolean}> = [];
  videoMediaDevices: Array<{deviceId: string, label: string}> = [];
  videoResolutions: Array<{width: number, height: number, fps: number, level: number}> = [];
  audioMediaDevices: Array<{deviceId: string, label: string}> = [];

  readyToPublish: boolean = false;
  isAnnounce: boolean = true;

  private animFrame: number | undefined = undefined;
  private RENDER_VIDEO_EVERY_MS = 10;
  private wcLastRender: number = 0;

  private modalService = inject(NgbModal);

  // Announcer video view
  @ViewChild('me', { static: true }) me!: PersonComponent;

  @ViewChildren('subsriber') subscribers!: QueryList<PersonComponent>;

  constructor(private ref: ChangeDetectorRef, private location: Location, private ngZone: NgZone) {

    this.videoResolutions.push({width: 320, height: 180, fps: 30, level: 13})
    this.videoResolutions.push({width: 320, height: 180, fps: 15, level: 12})
    this.videoResolutions.push({width: 854, height: 480, fps: 15, level: 30})
    this.videoResolutions.push({width: 854, height: 480, fps: 30, level: 31})
    this.videoResolutions.push({width: 1280, height: 720, fps: 15, level: 31})
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
    if (this.subscriptionList.length === 0) {
      this.ngZone.runOutsideAngular(() => requestAnimationFrame(this.handleVideoAnimationPlay.bind(this)));
    }

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
    if (this.subscriptionList.length === 0 ) {
      if (this.animFrame) {
        cancelAnimationFrame(this.animFrame)
      }
    }
  }

  getPersonId(index: number, item: any){
    return item.id;
  }

  handleVideoAnimationPlay(wcTimestamp: number) {
    const wcInterval = wcTimestamp - this.wcLastRender;
    if (wcInterval > this.RENDER_VIDEO_EVERY_MS) {
      this.wcLastRender = wcTimestamp;
      for (let i= 0; i < this.subscribers.length; ++i) {
        const c = this.subscribers.get(i);
        if (c) {
          c.animate();
        }
      }
    }
    this.animFrame = requestAnimationFrame(this.handleVideoAnimationPlay.bind(this));
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


