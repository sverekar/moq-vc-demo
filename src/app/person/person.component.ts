import { Component, ElementRef, EventEmitter, Input, OnInit, Output, ViewChild, ViewChildren } from '@angular/core';

@Component({
  selector: 'app-person',
  standalone: true,
  imports: [],
  templateUrl: './person.component.html',
  styleUrl: './person.component.scss'
})
export class PersonComponent implements OnInit {

  @Input() info: { displayName: string, audio: string, video: string, self: boolean, videoDeviceId?: string, audioDeviceId?: string} | undefined
  @Input() resolution: { width: number; height: number; fps: number; level: number; } | undefined

  @Output() readyToPublishEvent = new EventEmitter<boolean>();

  @ViewChild('videoplayer', {static: true}) videoPlayer!: ElementRef;

  ngOnInit(): void {

    console.log(this.info)
    console.log(this.resolution)

    let constraints;
     // Remove old stream if present
     if (this.videoPlayer.nativeElement.srcObject != undefined && this.videoPlayer.nativeElement.srcObject != null) {
      const mediaStream = this.videoPlayer.nativeElement.srcObject.srcObject;
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

    if (this.info?.self) {
      constraints = {
        audio: {
          deviceId: { exact: this.info?.audioDeviceId }
        },
        video: {
          deviceId:  { exact: this.info?.videoDeviceId },
          height: {min: this.resolution?.height, ideal: this.resolution?.height},
          width : {min: this.resolution?.width, ideal: this.resolution?.width}
        }
      };
      console.log(constraints)
      navigator.mediaDevices.getUserMedia(constraints)
      .then(mediaStream => {
        // Connect the stream to the preview video element.
        this.videoPlayer.nativeElement.srcObject = mediaStream;
        return mediaStream;
      })
      .then(mediaStream => {
        this.videoPlayer.nativeElement.srcObject.getTracks().forEach((track: MediaStreamTrack)  => {
            console.info(`Started preview: ${this.info?.videoDeviceId}, audio: ${this.info?.audioDeviceId} - ${this.resolution?.width}x${this.resolution?.width} From track: ${JSON.stringify(track.getSettings())}`);
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

}
