#import <AVFoundation/AVFoundation.h>
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <ScreenSaver/ScreenSaver.h>

#import "MizuTimePeriod.h"

static const NSTimeInterval MizuClockInterval = 1.0;
static const NSTimeInterval MizuPeriodCrossfadeDuration = 3.0;
static const NSTimeInterval MizuVideoLoopDuration = 60.0;

@interface MizuVideoSlot : NSObject
@property(nonatomic, readonly) MizuTimePeriod period;
@property(nonatomic, strong, readonly) AVQueuePlayer *player;
@property(nonatomic, strong, readonly) AVPlayerLooper *looper;
@property(nonatomic, strong, readonly) AVPlayerLayer *layer;
- (nullable instancetype)initWithPeriod:(MizuTimePeriod)period
                                 bundle:(NSBundle *)bundle;
- (void)invalidate;
@end

@implementation MizuVideoSlot

- (nullable instancetype)initWithPeriod:(MizuTimePeriod)period
                                 bundle:(NSBundle *)bundle {
  self = [super init];
  if (!self) return nil;

  NSString *resource = MizuVideoResourceName(period);
  NSURL *videoURL = [bundle URLForResource:resource
                             withExtension:@"mp4"
                              subdirectory:@"Videos"];
  if (!videoURL) return nil;

  _period = period;
  AVPlayerItem *item = [AVPlayerItem playerItemWithURL:videoURL];
  _player = [AVQueuePlayer queuePlayerWithItems:@[]];
  _player.muted = YES;
  _player.actionAtItemEnd = AVPlayerActionAtItemEndNone;
  _player.automaticallyWaitsToMinimizeStalling = NO;
  _looper = [AVPlayerLooper playerLooperWithPlayer:_player templateItem:item];
  _layer = [AVPlayerLayer playerLayerWithPlayer:_player];
  _layer.videoGravity = AVLayerVideoGravityResizeAspectFill;
  _layer.backgroundColor = NSColor.blackColor.CGColor;
  return self;
}

- (void)invalidate {
  [self.player pause];
  [self.looper disableLooping];
  self.layer.player = nil;
  [self.layer removeFromSuperlayer];
}

@end

@interface MizuNiNaruScreenSaverView : ScreenSaverView
@property(nonatomic, strong) MizuVideoSlot *currentSlot;
@property(nonatomic, strong) MizuVideoSlot *transitioningSlot;
@property(nonatomic) MizuTimePeriod displayedPeriod;
@property(nonatomic) BOOL hasDisplayedPeriod;
@property(nonatomic, strong) NSTextField *timeLabel;
@property(nonatomic, strong) NSTextField *dateLabel;
@property(nonatomic, strong) NSTimer *clockTimer;
@property(nonatomic, strong) NSDateFormatter *timeFormatter;
@property(nonatomic, strong) NSDateFormatter *dateFormatter;
@property(nonatomic, strong) NSCalendar *calendar;
@property(nonatomic) BOOL animationRequested;
@property(nonatomic) BOOL playbackActive;
@property(nonatomic) BOOL startedWhileSystemSettingsRunning;
@property(nonatomic) BOOL playbackSuppressedAfterSettingsExit;
@property(nonatomic) BOOL windowClosing;
@end

@implementation MizuNiNaruScreenSaverView

- (instancetype)initWithFrame:(NSRect)frame isPreview:(BOOL)isPreview {
  NSRect effectiveFrame = frame;
  if (NSWidth(effectiveFrame) < 1.0 || NSHeight(effectiveFrame) < 1.0) {
    NSScreen *screen = NSScreen.mainScreen;
    effectiveFrame = screen ? screen.frame : NSMakeRect(0, 0, 1280, 720);
  }

  self = [super initWithFrame:effectiveFrame isPreview:isPreview];
  if (!self) return nil;

  self.animationTimeInterval = MizuClockInterval;
  self.wantsLayer = YES;
  self.layer.backgroundColor = NSColor.blackColor.CGColor;

  self.timeLabel = [self overlayLabel];
  self.dateLabel = [self overlayLabel];
  [self addSubview:self.timeLabel];
  [self addSubview:self.dateLabel];

  self.calendar = [NSCalendar autoupdatingCurrentCalendar];
  self.timeFormatter = [[NSDateFormatter alloc] init];
  self.timeFormatter.locale = [NSLocale autoupdatingCurrentLocale];
  self.timeFormatter.dateFormat = @"HH:mm:ss";
  self.dateFormatter = [[NSDateFormatter alloc] init];
  self.dateFormatter.locale = [NSLocale localeWithLocaleIdentifier:@"ja_JP"];
  self.dateFormatter.dateFormat = @"yyyy年M月d日 EEEE";

  NSNotificationCenter *notifications = NSNotificationCenter.defaultCenter;
  [notifications addObserver:self
                     selector:@selector(windowVisibilityDidChange:)
                         name:NSWindowDidMiniaturizeNotification
                       object:nil];
  [notifications addObserver:self
                     selector:@selector(windowVisibilityDidChange:)
                         name:NSWindowDidDeminiaturizeNotification
                       object:nil];
  [notifications addObserver:self
                     selector:@selector(windowVisibilityDidChange:)
                         name:NSWindowWillCloseNotification
                       object:nil];

  [self updateClockAndPeriod];
  [self layoutContent];
  return self;
}

- (NSTextField *)overlayLabel {
  NSTextField *label = [NSTextField labelWithString:@""];
  label.alignment = NSTextAlignmentRight;
  label.textColor = [NSColor colorWithWhite:1.0 alpha:0.92];
  label.drawsBackground = NO;
  label.bezeled = NO;
  label.editable = NO;
  label.selectable = NO;
  label.wantsLayer = YES;
  label.layer.shadowColor = NSColor.blackColor.CGColor;
  label.layer.shadowOpacity = 0.8;
  label.layer.shadowRadius = 8.0;
  label.layer.shadowOffset = CGSizeMake(0, -2);
  return label;
}

- (void)startAnimation {
  [super startAnimation];
  self.startedWhileSystemSettingsRunning = [self systemSettingsIsRunning];
  self.playbackSuppressedAfterSettingsExit = NO;
  self.windowClosing = NO;
  self.animationRequested = YES;
  [self updateClockAndPeriod];
  [self.clockTimer invalidate];
  self.clockTimer =
      [NSTimer scheduledTimerWithTimeInterval:MizuClockInterval
                                       target:self
                                     selector:@selector(updateClockAndPeriod)
                                     userInfo:nil
                                      repeats:YES];
  self.clockTimer.tolerance = 0.1;
}

- (void)stopAnimation {
  self.animationRequested = NO;
  self.playbackActive = NO;
  [self.clockTimer invalidate];
  self.clockTimer = nil;
  [self.currentSlot.player pause];
  [self.transitioningSlot.player pause];
  [super stopAnimation];
}

- (void)animateOneFrame {
  // 動画はAVPlayer、時刻と時間帯はNSTimerが駆動する。
}

- (void)setFrameSize:(NSSize)newSize {
  [super setFrameSize:newSize];
  [self layoutContent];
}

- (void)layout {
  [super layout];
  [self layoutContent];
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  self.windowClosing = NO;
  [self updatePlaybackState];
}

- (void)viewDidHide {
  [super viewDidHide];
  [self updatePlaybackState];
}

- (void)viewDidUnhide {
  [super viewDidUnhide];
  [self updatePlaybackState];
}

- (void)layoutContent {
  if (!self.layer) return;

  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  self.currentSlot.layer.frame = self.bounds;
  self.transitioningSlot.layer.frame = self.bounds;
  [CATransaction commit];

  const CGFloat width = NSWidth(self.bounds);
  const CGFloat height = NSHeight(self.bounds);
  if (width < 1.0 || height < 1.0) return;

  const CGFloat scale =
      MAX(0.45, MIN(1.25, MIN(width / 1440.0, height / 900.0)));
  const CGFloat margin = 44.0 * scale;
  const CGFloat labelWidth = MIN(width - margin * 2.0, 560.0 * scale);
  const CGFloat dateHeight = 30.0 * scale;
  const CGFloat timeHeight = 76.0 * scale;
  const CGFloat dateY = 38.0 * scale;
  const CGFloat timeY = dateY + dateHeight + 4.0 * scale;
  const CGFloat x = width - margin - labelWidth;

  self.timeLabel.font =
      [NSFont monospacedDigitSystemFontOfSize:58.0 * scale
                                      weight:NSFontWeightLight];
  self.dateLabel.font = [NSFont systemFontOfSize:18.0 * scale
                                         weight:NSFontWeightRegular];
  self.timeLabel.frame = NSMakeRect(x, timeY, labelWidth, timeHeight);
  self.dateLabel.frame = NSMakeRect(x, dateY, labelWidth, dateHeight);
}

- (void)updateClockAndPeriod {
  NSDate *now = [NSDate date];
  self.timeLabel.stringValue = [self.timeFormatter stringFromDate:now] ?: @"";
  self.dateLabel.stringValue = [self.dateFormatter stringFromDate:now] ?: @"";

  MizuTimePeriod period = MizuTimePeriodForDate(now, self.calendar);
  if (!self.hasDisplayedPeriod) {
    [self installInitialPeriod:period];
  } else if (period != self.displayedPeriod) {
    [self transitionToPeriod:period];
  }
  [self updatePlaybackState];
}

- (void)installInitialPeriod:(MizuTimePeriod)period {
  MizuVideoSlot *slot = [[MizuVideoSlot alloc]
      initWithPeriod:period
              bundle:[NSBundle bundleForClass:self.class]];
  if (!slot) {
    NSLog(@"MizuNiNaru: missing video resource for %@",
          MizuTimePeriodDescription(period));
    return;
  }
  self.currentSlot = slot;
  self.displayedPeriod = period;
  self.hasDisplayedPeriod = YES;
  slot.layer.frame = self.bounds;
  slot.layer.opacity = 1.0;
  [self.layer insertSublayer:slot.layer atIndex:0];
}

- (void)transitionToPeriod:(MizuTimePeriod)period {
  if (self.transitioningSlot || period == self.displayedPeriod) return;
  MizuVideoSlot *next = [[MizuVideoSlot alloc]
      initWithPeriod:period
              bundle:[NSBundle bundleForClass:self.class]];
  if (!next) {
    NSLog(@"MizuNiNaru: missing video resource for %@",
          MizuTimePeriodDescription(period));
    return;
  }

  self.displayedPeriod = period;
  self.transitioningSlot = next;
  next.layer.frame = self.bounds;
  next.layer.opacity = 0.0;
  [self.layer insertSublayer:next.layer above:self.currentSlot.layer];

  NSTimeInterval currentSeconds =
      CMTimeGetSeconds(self.currentSlot.player.currentTime);
  if (!isfinite(currentSeconds) || currentSeconds < 0) currentSeconds = 0;
  CMTime synchronizedTime = CMTimeMakeWithSeconds(
      fmod(currentSeconds, MizuVideoLoopDuration), 600);
  __weak typeof(self) weakSelf = self;
  [next.player seekToTime:synchronizedTime
          toleranceBefore:kCMTimeZero
           toleranceAfter:kCMTimeZero
        completionHandler:^(BOOL finished) {
          dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) strongSelf = weakSelf;
            if (!strongSelf || strongSelf.transitioningSlot != next) return;
            if (!finished) {
              [next invalidate];
              strongSelf.transitioningSlot = nil;
              strongSelf.displayedPeriod = strongSelf.currentSlot.period;
              return;
            }
            [strongSelf beginCrossfadeToSlot:next];
          });
        }];
}

- (void)beginCrossfadeToSlot:(MizuVideoSlot *)next {
  MizuVideoSlot *previous = self.currentSlot;
  if (self.playbackActive) [next.player play];

  __weak typeof(self) weakSelf = self;
  [CATransaction begin];
  [CATransaction setAnimationDuration:MizuPeriodCrossfadeDuration];
  [CATransaction setAnimationTimingFunction:[CAMediaTimingFunction
                                                functionWithName:
                                                    kCAMediaTimingFunctionEaseInEaseOut]];
  [CATransaction setCompletionBlock:^{
    dispatch_async(dispatch_get_main_queue(), ^{
      typeof(self) strongSelf = weakSelf;
      if (!strongSelf || strongSelf.transitioningSlot != next) return;
      [previous invalidate];
      strongSelf.currentSlot = next;
      strongSelf.transitioningSlot = nil;
      [strongSelf updatePlaybackState];
    });
  }];
  previous.layer.opacity = 0.0;
  next.layer.opacity = 1.0;
  [CATransaction commit];
}

- (void)windowVisibilityDidChange:(NSNotification *)notification {
  if (notification.object != self.window) return;
  if ([notification.name isEqualToString:NSWindowWillCloseNotification]) {
    self.windowClosing = YES;
  } else if ([notification.name
                 isEqualToString:NSWindowDidDeminiaturizeNotification]) {
    self.windowClosing = NO;
  }
  [self updatePlaybackState];
}

- (void)updatePlaybackState {
  if (self.startedWhileSystemSettingsRunning &&
      ![self systemSettingsIsRunning]) {
    self.playbackSuppressedAfterSettingsExit = YES;
  }
  const BOOL viewIsVisible = !self.isHiddenOrHasHiddenAncestor;
  const BOOL windowIsUsable = !self.windowClosing && !self.window.miniaturized;
  const BOOL shouldPlay = self.animationRequested &&
                          !self.playbackSuppressedAfterSettingsExit &&
                          viewIsVisible && windowIsUsable;

  if (shouldPlay != self.playbackActive) {
    self.playbackActive = shouldPlay;
    if (shouldPlay) {
      [self.currentSlot.player play];
      [self.transitioningSlot.player play];
    } else {
      [self.currentSlot.player pause];
      [self.transitioningSlot.player pause];
    }
  }
  if (self.playbackSuppressedAfterSettingsExit && self.clockTimer) {
    [self.clockTimer invalidate];
    self.clockTimer = nil;
  }
}

- (BOOL)systemSettingsIsRunning {
  return [NSRunningApplication
             runningApplicationsWithBundleIdentifier:@"com.apple.systempreferences"]
             .count > 0;
}

- (BOOL)hasConfigureSheet {
  return NO;
}

- (NSWindow *)configureSheet {
  return nil;
}

- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [self.clockTimer invalidate];
  [self.currentSlot invalidate];
  [self.transitioningSlot invalidate];
}

@end
