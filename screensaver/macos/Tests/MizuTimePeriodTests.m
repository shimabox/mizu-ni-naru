#import <Foundation/Foundation.h>

#import "MizuTimePeriod.h"

static void AssertPeriod(NSInteger minute, MizuTimePeriod expected,
                         NSString *label) {
  MizuTimePeriod actual = MizuTimePeriodForMinuteOfDay(minute);
  if (actual != expected) {
    fprintf(stderr, "%s: minute=%ld expected=%ld actual=%ld\n",
            label.UTF8String, (long)minute, (long)expected, (long)actual);
    exit(1);
  }
}

int main(void) {
  @autoreleasepool {
    AssertPeriod(0, MizuTimePeriodNight, @"midnight");
    AssertPeriod(5 * 60 + 29, MizuTimePeriodNight, @"before morning");
    AssertPeriod(5 * 60 + 30, MizuTimePeriodMorning, @"morning start");
    AssertPeriod(9 * 60 + 59, MizuTimePeriodMorning, @"morning end");
    AssertPeriod(10 * 60, MizuTimePeriodDay, @"day start");
    AssertPeriod(16 * 60 + 29, MizuTimePeriodDay, @"day end");
    AssertPeriod(16 * 60 + 30, MizuTimePeriodEvening, @"evening start");
    AssertPeriod(20 * 60 + 29, MizuTimePeriodEvening, @"evening end");
    AssertPeriod(20 * 60 + 30, MizuTimePeriodNight, @"night start");
    AssertPeriod(24 * 60, MizuTimePeriodNight, @"positive wrap");
    AssertPeriod(-1, MizuTimePeriodNight, @"negative wrap");

    NSSet<NSString *> *expectedResources =
        [NSSet setWithArray:@[ @"morning", @"day", @"evening", @"night" ]];
    NSMutableSet<NSString *> *actualResources = [NSMutableSet set];
    for (NSInteger minute = 0; minute < 24 * 60; minute++) {
      NSString *resource =
          MizuVideoResourceName(MizuTimePeriodForMinuteOfDay(minute));
      if (resource.length == 0) {
        fprintf(stderr, "empty resource at minute=%ld\n", (long)minute);
        return 1;
      }
      [actualResources addObject:resource];
    }
    if (![actualResources isEqualToSet:expectedResources]) {
      fprintf(stderr, "unexpected resources: %s\n",
              actualResources.description.UTF8String);
      return 1;
    }
    printf("MizuTimePeriodTests: 1440 minutes and boundaries passed\n");
  }
  return 0;
}
