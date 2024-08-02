import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AnnounceStatsComponent } from './announce-stats.component';

describe('AnnounceStatsComponent', () => {
  let component: AnnounceStatsComponent;
  let fixture: ComponentFixture<AnnounceStatsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AnnounceStatsComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(AnnounceStatsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
