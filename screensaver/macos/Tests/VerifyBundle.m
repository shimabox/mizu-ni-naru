#import <Cocoa/Cocoa.h>
#import <ScreenSaver/ScreenSaver.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) {
      fprintf(stderr, "usage: VerifyBundle /path/to/MizuNiNaru.saver\n");
      return 64;
    }
    NSString *path = [NSString stringWithUTF8String:argv[1]];
    NSBundle *bundle = [NSBundle bundleWithPath:path];
    NSError *error = nil;
    if (!bundle || ![bundle loadAndReturnError:&error]) {
      fprintf(stderr, "bundle load failed: %s\n",
              error.localizedDescription.UTF8String ?: "unknown error");
      return 1;
    }
    Class principalClass = bundle.principalClass;
    if (!principalClass ||
        ![principalClass isSubclassOfClass:ScreenSaverView.class]) {
      fprintf(stderr, "principal class is not a ScreenSaverView\n");
      return 2;
    }
    ScreenSaverView *view =
        [[principalClass alloc] initWithFrame:NSMakeRect(0, 0, 640, 360)
                                   isPreview:YES];
    if (!view) {
      fprintf(stderr, "principal class initialization failed\n");
      return 3;
    }
    [view startAnimation];
    [[NSRunLoop currentRunLoop]
        runUntilDate:[NSDate dateWithTimeIntervalSinceNow:1.0]];
    [view stopAnimation];
    printf("principalClass=%s frame=%.0fx%.0f preview=%s\n",
           NSStringFromClass(principalClass).UTF8String, NSWidth(view.frame),
           NSHeight(view.frame), view.isPreview ? "yes" : "no");
  }
  return 0;
}
