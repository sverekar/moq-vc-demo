import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, NgZone } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-announce-stats',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule
  ],
  templateUrl: './announce-stats.component.html',
  styleUrl: './announce-stats.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnnounceStatsComponent {

  firstAts : number | undefined;
  firstVts : number | undefined;
  firstCompAts : number | undefined;
  firstCompVts : number | undefined;
  encodedAudioTs : number | undefined;
  encodedAudioCompensatedTs : number | undefined;
  encodedAudioLatencyMs : number | undefined;
  encodedVideoTs : number | undefined;
  encodedVideoCompensatedTs : number | undefined;
  encodedVideoLatencyMs : number | undefined;
  uploadStatsAudioInflight : string | undefined;
  uploadStatsVideoInflight : string | undefined;
  totalAudioChunksDropped : number = 0;
  totalVideoChunksDropped : number = 0;
  droppedFramesData: Array<string> = [];

  constructor(private ref: ChangeDetectorRef) { }

  updateAnounceStats(data: any) {
    for (const key of Object.keys(data)) {
      switch(key) {
        case 'encodedAudioTs': {
          this.encodedAudioTs = data['encodedAudioTs'];
          break;
        }
        case 'encodedAudioCompensatedTs': {
          this.encodedAudioCompensatedTs = data['encodedAudioCompensatedTs']
          break;
        }
        case 'encodedAudioLatencyMs': {
          this.encodedAudioLatencyMs = data['encodedAudioLatencyMs']
          break;
        }
        case 'encodedVideoTs': {
          this.encodedVideoTs = data['encodedVideoTs']
          break;
        }
        case 'encodedVideoCompensatedTs': {
          this.encodedVideoCompensatedTs = data['encodedVideoCompensatedTs']
          break;
        }
        case 'encodedVideoLatencyMs': {
          this.encodedVideoLatencyMs = data['encodedVideoLatencyMs']
          break;
        }
        case 'uploadStatsAudioInflight': {
          this.uploadStatsAudioInflight = data['uploadStatsAudioInflight']
          break;
        }
        case 'uploadStatsVideoInflight': {
          this.uploadStatsVideoInflight = data['uploadStatsVideoInflight']
          break;
        }
        case 'audioChunkDropped': {
          this.totalAudioChunksDropped++;
          break;
        }
        case 'videoChunkDropped': {
          this.totalVideoChunksDropped++;
          break;
        }
        case 'chunkDroppedMsg': {
          console.debug('Dropped frame: ', data['chunkDroppedMsg'])
          this.droppedFramesData.push(data['chunkDroppedMsg']);
          break;
        }
        case 'firstAts': {
          this.firstAts = data['firstAts']
          break;
        }
        case 'firstVts': {
          this.firstVts = data['firstVts']
          break;
        }
        case 'firstCompAts': {
          this.firstCompAts = data['firstCompAts']
          break;
        }
        case 'firstCompVts': {
          this.firstCompVts = data['firstCompVts']
          break;
        }
      }
    }
    this.ref.detectChanges();
  }

  clearAnounceStats() {
    this.encodedAudioTs = undefined;
    this.encodedAudioCompensatedTs = undefined;
    this.encodedAudioLatencyMs = undefined;
    this.encodedVideoTs = undefined;
    this.encodedVideoCompensatedTs = undefined;
    this.encodedVideoLatencyMs = undefined;
    this.uploadStatsAudioInflight = '0';
    this.uploadStatsVideoInflight = '0';
    this.totalAudioChunksDropped = 0;
    this.totalVideoChunksDropped = 0;
    this.firstAts = undefined;
    this.firstVts = undefined;
    this.firstCompAts = undefined;
    this.firstCompVts = undefined;
    this.droppedFramesData = [];
    this.ref.detectChanges();
  }
}
