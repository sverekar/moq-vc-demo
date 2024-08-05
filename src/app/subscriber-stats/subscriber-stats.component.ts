import { ChangeDetectionStrategy, ChangeDetectorRef, Component } from '@angular/core';
import { SubscriberStats } from '../common';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-subscriber-stats',
  standalone: true,
  imports: [
    FormsModule,
    CommonModule
  ],
  templateUrl: './subscriber-stats.component.html',
  styleUrl: './subscriber-stats.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SubscriberStatsComponent {

  selectedSubscriberStats: any = undefined;
  subscriberStats: Map<string, any> = new Map();
  selectedSubscriberId: string | undefined = undefined;
  hideStats: boolean = true;

  constructor(private ref: ChangeDetectorRef){}

  onSubsStatsSelectionChange(id: any) {
    console.log(id);
    if (this.selectedSubscriberId !== id) {
      this.selectedSubscriberId = id;
      this.selectedSubscriberStats = this.subscriberStats.get(id);
      this.ref.detectChanges();
    }
  }

  updateSubscriberStats(data: any): void {
    const id = data['id']
    let notFound = false;
    if (id) {
      let stats = this.subscriberStats.get(id);
      if (!stats) {
        stats = {};
        notFound = true
      }
      stats = this.copySubscriberStats(stats, data);
      this.subscriberStats.set(data['id'], stats);
      if ((id === this.selectedSubscriberId || notFound) && !this.hideStats) {
        this.ref.detectChanges();
      }
      return;
    }
    console.warn('Found player stats without id: ', data)
  }

  private copySubscriberStats(stats: any, data: any) {
    // copy fields to stats
    for (const key of Object.keys(data)){
      if (key === 'droppedFramesData') {
        if (stats.droppedFramesData) {
          stats.droppedFramesData?.push(data[key]);
        } else {
          stats.droppedFramesData = [data[key]]
        }
      } else {
        stats[key] = data[key];
      }
      return stats;
    }
  }

  clearSubscriberStats(id: string) {
    if (id === this.selectedSubscriberId) {
      this.selectedSubscriberId = undefined
      this.selectedSubscriberStats = undefined;
      this.ref.detectChanges();
    }
    this.subscriberStats.delete(id);
  }
}
