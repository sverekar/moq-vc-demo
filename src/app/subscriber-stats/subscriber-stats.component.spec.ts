import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SubscriberStatsComponent } from './subscriber-stats.component';

describe('SubscriberStatsComponent', () => {
  let component: SubscriberStatsComponent;
  let fixture: ComponentFixture<SubscriberStatsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SubscriberStatsComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(SubscriberStatsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
